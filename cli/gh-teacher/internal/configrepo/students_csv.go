package configrepo

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/mail"
	"slices"
	"strconv"
	"strings"
)

// RosterColumns: canonical required column order. github_id is CLI-managed
// (from `GET /users/{username}`); the immutable numeric ID defends against
// mid-class username changes. Email may be empty. role is best-effort recorded
// metadata (teacher/ta/student, or "") refreshed from the classroom's GitHub
// teams on sync — the teams, not this column, remain the enrollment/role
// authority; nothing reads it for logic.
var RosterColumns = []string{"username", "first_name", "last_name", "email", "section", "github_id", "role"}

// legacyRequiredColumns is the canonical prefix a pre-role roster.csv carries.
// role was appended additively, so a file written before it (ending at
// github_id) is still valid; ParseRoster tolerates a header missing exactly the
// trailing role column and reads role as "". Everything before role is required
// in order.
var legacyRequiredColumns = RosterColumns[:len(RosterColumns)-1]

// FullRosterHeader is the on-disk roster.csv header (RosterColumns,
// comma-joined). The single shared fixture the Go, Python, and web suites
// assert against, so column-order drift is caught by CI. A legacy trailing
// column on an existing file still round-trips via RosterRow.Extra.
var FullRosterHeader = strings.Join(RosterColumns, ",")

// isCanonicalColumn reports whether name is a CLI-managed RosterColumn (the
// rest are carried through RosterRow.Extra).
func isCanonicalColumn(name string) bool {
	return slices.Contains(RosterColumns, name)
}

// maxFieldBytes caps each cell at RFC 5321's email max so a hand-edit can't
// push the file past the contents API's 1 MB ceiling.
const maxFieldBytes = 320

// maxSafeGitHubID is JavaScript's Number.MAX_SAFE_INTEGER: beyond it the web
// app can't represent an id exactly, so it would address the wrong account.
const maxSafeGitHubID = 1<<53 - 1

// utf8BOM is what Excel prepends to "CSV UTF-8" exports. encoding/csv doesn't
// strip it, so without trimming the first header field becomes "\ufeffusername"
// and the header check fails on two identical-looking slices.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// RosterRow is one student in the roster. GitHubID == 0 means unresolved (a
// 5-column import row before GET /users/{username}, or a cell we couldn't use).
type RosterRow struct {
	Username  string
	FirstName string
	LastName  string
	Email     string
	Section   string
	GitHubID  int64
	// githubIDRaw holds a github_id cell that read as unresolved, so a rewrite
	// preserves the teacher's value instead of silently clearing it.
	githubIDRaw string
	// Role is best-effort recorded metadata: "teacher", "ta", "student", or
	// "" (unknown / a pre-role file). Refreshed from team membership on sync;
	// never consulted for enrollment decisions.
	Role string
	// Extra carries non-canonical columns keyed by header name, so a
	// read/modify/write round-trips them. nil for a plain canonical file.
	Extra map[string]string
	// ExtraOrder is the on-disk order of Extra columns for deterministic
	// encoding. INVARIANT: it lists exactly the keys of Extra.
	ExtraOrder []string
	// raw is the original CSV record of a row that failed strict validation but
	// was preserved by ParseRosterLenient, so a write can round-trip it instead
	// of dropping a student. When set, the parsed fields are unpopulated:
	// EncodeRoster writes raw verbatim; mutation helpers skip it (no username).
	raw []string
}

// isRaw reports whether the row is a preserved-but-unparsed record.
func (r RosterRow) isRaw() bool { return r.raw != nil }

// UnresolvedGitHubID returns the github_id cell of a row whose cell was
// readable but addresses no account (see parseGitHubID), else "". Exported so a
// caller can name the offending value when reporting a row it must leave alone.
func (r RosterRow) UnresolvedGitHubID() string { return r.githubIDRaw }

// IsPendingEmailInvite reports whether the row is an email-ONLY invite row: no
// username, no github_id cell at all (a present-but-unresolved one counts as
// identity), and an address to key on.
//
// This is the single source of the claimable-row rule the pending-row helpers
// below enforce (findPendingEmailRow, UpsertRosterRow's email fallback), so a
// caller deciding what to plan and the helper applying it agree — a planner
// guessing at the rule plans edits these helpers then refuse, which a --write
// pass would report and silently skip forever.
func (r RosterRow) IsPendingEmailInvite() bool {
	return !r.isRaw() && r.Username == "" &&
		r.GitHubID == 0 && r.githubIDRaw == "" &&
		NormalizeInviteEmail(r.Email) != ""
}

// ParseRoster decodes the roster CSV. The header MUST begin with the canonical
// RosterColumns in order; a file written before the trailing `role` column was
// added (ending at github_id) is still accepted (role reads as ""). Additional
// trailing columns beyond the canonical set are preserved verbatim in
// RosterRow.Extra. Empty input is rejected. Any malformed data row is an error.
func ParseRoster(data []byte) ([]RosterRow, error) {
	return parseRoster(data, false)
}

// ParseRosterLenient is ParseRoster for the read-modify-write path: a malformed
// data row (empty username, wrong field count) is preserved verbatim as a raw
// RosterRow instead of aborting, so a write command can round-trip pre-existing
// bad data. Header and empty-input errors still hard-fail — a broken header
// can't be safely round-tripped.
func ParseRosterLenient(data []byte) ([]RosterRow, error) {
	return parseRoster(data, true)
}

// parseRoster is the shared core; lenient preserves a bad row as raw rather
// than erroring (see ParseRoster / ParseRosterLenient).
func parseRoster(data []byte, lenient bool) ([]RosterRow, error) {
	data = bytes.TrimPrefix(data, utf8BOM)
	r := csv.NewReader(bytes.NewReader(data))
	// Read header without field-count enforcement so a renamed/short header
	// gets our message, not csv's generic "wrong number of fields".
	r.FieldsPerRecord = -1

	header, err := r.Read()
	if err == io.EOF {
		return nil, errors.New("roster CSV is empty (expected at least the header row)")
	}
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	// The header must begin with the canonical columns in order. `role` is a
	// trailing additive column, so a legacy file that stops at github_id is
	// accepted too; anything after the matched canonical prefix is an extra
	// column carried through verbatim.
	var canonicalLen int
	switch {
	case len(header) >= len(RosterColumns) && slices.Equal(header[:len(RosterColumns)], RosterColumns):
		canonicalLen = len(RosterColumns)
	case len(header) == len(legacyRequiredColumns) && slices.Equal(header, legacyRequiredColumns):
		// Pre-role file: exactly the canonical columns through github_id, no
		// trailing columns. role reads as "".
		canonicalLen = len(legacyRequiredColumns)
	case len(header) < len(RosterColumns) || !slices.Equal(header[:len(legacyRequiredColumns)], legacyRequiredColumns):
		return nil, fmt.Errorf("unexpected header: got %v, want %v followed by any optional columns", header, RosterColumns)
	default:
		// Header begins with the legacy prefix but the 7th column is not `role`
		// — treat the whole tail (including that 7th column) as extras and read
		// role as "". Keeps a pre-role file that already carried its own extra
		// columns working.
		canonicalLen = len(legacyRequiredColumns)
	}
	extraColumns := append([]string(nil), header[canonicalLen:]...)
	// Reject a malformed extra-column header rather than mangling it on
	// round-trip: a duplicate clobbers on read and collapses on write; a name
	// reusing a canonical one produces a file the web's header-keyed parser
	// mis-reads; and since EncodeRoster writes header names verbatim, a
	// formula-trigger name would re-inject CSV formulas. Only fences off a
	// hand-edit — the web produces none of these.
	seenExtra := make(map[string]bool, len(extraColumns))
	for _, name := range extraColumns {
		if isCanonicalColumn(name) {
			return nil, fmt.Errorf("unexpected header: extra column %q reuses a reserved column name", name)
		}
		if seenExtra[name] {
			return nil, fmt.Errorf("unexpected header: duplicate column %q", name)
		}
		if name != "" && isFormulaTrigger(name[0]) {
			return nil, fmt.Errorf("unexpected header: extra column %q begins with a spreadsheet formula trigger", name)
		}
		seenExtra[name] = true
	}
	// Strict mode fixes the field count so a short/long row errors; lenient
	// leaves it unenforced so a mis-widthed row still reads into a preservable
	// record.
	if !lenient {
		r.FieldsPerRecord = len(header)
	}

	var rows []RosterRow
	for line := 2; ; line++ {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			if lenient {
				// A quoting-level error yields no usable record to preserve.
				continue
			}
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		row, err := recordToRow(record, canonicalLen, extraColumns, line)
		if err != nil {
			if lenient {
				rows = append(rows, RosterRow{raw: record})
				continue
			}
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// ParseImportCSV decodes a teacher-supplied import CSV. It accepts the full
// stored roster shape (RosterColumns), the pre-role 6-column form, or the
// 5-column hand-edit form without github_id — so a roster.csv the web wrote
// (including pending email-only invite rows) imports as-is. Rows follow the
// stored-file identity rule: at least one of username, github_id, or email.
// github_id and role are parsed onto the returned rows so the import command
// can cross-check the id against the resolved account and round-trip role;
// neither is applied here. Extra trailing columns are rejected: import
// carries no extra-column state, so a wider file would silently drop the tail.
//
// Row errors are collected across the whole file and returned joined (one
// `line %d: ...` per bad row), so the caller can print a full report before
// refusing the file.
func ParseImportCSV(data []byte) ([]RosterRow, error) {
	data = bytes.TrimPrefix(data, utf8BOM)
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1

	header, err := r.Read()
	if err == io.EOF {
		return nil, errors.New("import CSV is empty (expected at least a header row)")
	}
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}

	importShort := legacyRequiredColumns[:5] // username..section
	switch {
	case slices.Equal(header, RosterColumns),
		slices.Equal(header, legacyRequiredColumns),
		slices.Equal(header, importShort):
	default:
		return nil, fmt.Errorf("unexpected header: got %v, want %v optionally followed by github_id (%v) or by github_id,role (%v); no other columns are import input",
			header, importShort, legacyRequiredColumns, RosterColumns)
	}
	r.FieldsPerRecord = len(header)

	var (
		rows    []RosterRow
		rowErrs []error
	)
	for line := 2; ; line++ {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			rowErrs = append(rowErrs, fmt.Errorf("line %d: %w", line, err))
			continue
		}
		// Pad the 5/6-column forms to the full width so recordToRow stays the
		// single source of the identity rule and github_id/role parsing.
		for len(record) < len(RosterColumns) {
			record = append(record, "")
		}
		row, err := recordToRow(record, len(RosterColumns), nil, line)
		if err != nil {
			rowErrs = append(rowErrs, err)
			continue
		}
		if err := ValidateRosterEmail(row.Email); err != nil {
			rowErrs = append(rowErrs, fmt.Errorf("line %d: %w", line, err))
			continue
		}
		rows = append(rows, row)
	}
	if len(rowErrs) > 0 {
		return nil, errors.Join(rowErrs...)
	}
	return rows, nil
}

// recordToRow maps a data record onto a RosterRow. canonicalLen is the matched
// canonical prefix width (7 with role, 6 for a pre-role file); extraColumns (in
// header order) name the values beyond it, carried through Extra.
func recordToRow(record []string, canonicalLen int, extraColumns []string, line int) (RosterRow, error) {
	// Guard the width before indexing: lenient parsing leaves FieldsPerRecord
	// unenforced, so a mis-widthed row reaches here — error (the caller
	// preserves it raw) rather than panicking on an out-of-range index.
	if want := canonicalLen + len(extraColumns); len(record) != want {
		return RosterRow{}, fmt.Errorf("line %d: wrong number of fields (got %d, want %d)", line, len(record), want)
	}
	if err := checkFieldLengths(line, record); err != nil {
		return RosterRow{}, err
	}
	row := RosterRow{
		Username:  strings.TrimSpace(undefangCSVCell(record[0])),
		FirstName: undefangCSVCell(record[1]),
		LastName:  undefangCSVCell(record[2]),
		Email:     strings.TrimSpace(undefangCSVCell(record[3])),
		Section:   undefangCSVCell(record[4]),
	}
	// A row needs at least ONE identity column. An identity-less row addresses
	// nobody, so it stays an error (lenient parsing preserves it raw). A row
	// with only an email is valid and deliberate: the web writes it when a
	// teacher invites by email, and fills in the account once the student
	// accepts. Rejecting it would abort the whole file for `roster list` while
	// any invite is outstanding. Keep-rule mirrors the web's parseRosterCsv
	// filter (web/src/util/rosterCsv.ts) — non-empty raw cell, not a resolvable
	// id, so a present-but-unusable github_id (0, or above 2^53) still counts.
	// Note an UNPARSEABLE github_id still hard-errors just below, for any row:
	// that predates this rule and is deliberate. Shared cases:
	// cli/shared/testdata/roster_row_cases.json.
	if row.Username == "" && row.Email == "" && strings.TrimSpace(record[5]) == "" {
		return RosterRow{}, fmt.Errorf("line %d: row has no username, github_id, or email — at least one is required to identify a student", line)
	}
	if trimmed := strings.TrimSpace(record[5]); trimmed != "" {
		id, err := parseGitHubID(trimmed)
		if err != nil {
			return RosterRow{}, fmt.Errorf("line %d: invalid github_id %q: %w", line, record[5], err)
		}
		// id == 0 means readable but unusable: leave GitHubID unresolved and keep
		// the cell so a rewrite doesn't discard what the teacher typed.
		if id == 0 {
			row.githubIDRaw = record[5]
		}
		row.GitHubID = id
	}
	// role is present only when the header carried the full canonical set; a
	// pre-role file (canonicalLen == 6) leaves it "".
	if canonicalLen == len(RosterColumns) {
		row.Role = strings.TrimSpace(undefangCSVCell(record[len(RosterColumns)-1]))
	}
	if len(extraColumns) > 0 {
		// Every row's extra order IS the header's, so share that slice instead
		// of rebuilding an identical one per row. Read-only after parse.
		row.Extra = make(map[string]string, len(extraColumns))
		row.ExtraOrder = extraColumns
		for i, name := range extraColumns {
			row.Extra[name] = undefangCSVCell(record[canonicalLen+i])
		}
	}
	return row, nil
}

// EncodeRoster writes rows back as RFC 4180 roster.csv (trailing newline).
// The header is RosterColumns followed by any extra columns present on the rows
// (ordered by collectExtraColumns), preserving web-written extras.
func EncodeRoster(rows []RosterRow) ([]byte, error) {
	extraColumns := collectExtraColumns(rows)

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)

	header := append(append([]string(nil), RosterColumns...), extraColumns...)
	if err := w.Write(header); err != nil {
		return nil, fmt.Errorf("write header: %w", err)
	}
	for _, row := range rows {
		if row.isRaw() {
			// Preserve a lenient-parsed malformed row verbatim (defanged). Its
			// width may differ from the header; the write path re-reads
			// leniently, so a mismatch round-trips.
			record := make([]string, len(row.raw))
			for i, cell := range row.raw {
				record[i] = defangCSVCell(cell)
			}
			if err := w.Write(record); err != nil {
				return nil, fmt.Errorf("write preserved row: %w", err)
			}
			continue
		}
		githubID := row.githubIDRaw
		if row.GitHubID != 0 {
			githubID = strconv.FormatInt(row.GitHubID, 10)
		}
		// Defang formula-trigger cells; a resolved github_id is numeric so never
		// matches, and a preserved raw one must round-trip byte-exact.
		record := []string{
			defangCSVCell(row.Username),
			defangCSVCell(row.FirstName),
			defangCSVCell(row.LastName),
			defangCSVCell(row.Email),
			defangCSVCell(row.Section),
			githubID,
			defangCSVCell(row.Role),
		}
		for _, name := range extraColumns {
			record = append(record, defangCSVCell(row.Extra[name]))
		}
		if err := w.Write(record); err != nil {
			return nil, fmt.Errorf("write row %q: %w", row.Username, err)
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, fmt.Errorf("flush csv: %w", err)
	}
	return buf.Bytes(), nil
}

// collectExtraColumns returns the union of non-canonical column names across
// rows in first-seen order (across rows, then within each ExtraOrder), keeping
// the written header stable regardless of map iteration order.
func collectExtraColumns(rows []RosterRow) []string {
	var ordered []string
	seen := make(map[string]bool)
	for _, row := range rows {
		for _, name := range row.ExtraOrder {
			if !seen[name] {
				ordered = append(ordered, name)
				seen[name] = true
			}
		}
	}
	return ordered
}

// UpsertRosterRow replaces by Username (case-insensitive), else claims a pending
// email-invite row with the same email, else appends. Position preserved on
// replace. Returns the slice and whether a row was replaced.
//
// The email fallback finishes what an email invite started: that row carries
// only the invited address until the student accepts, so adding them by username
// would otherwise leave a second row for the same person. It is deliberately
// narrow — only a row with NO username and NO github_id cell at all is
// claimable, so two students sharing a contact email can never overwrite each
// other, and a username match always wins. An email claim does NOT inherit the
// pending row's Role (an email invite may have been for staff; the team is the
// role authority), whereas a username match does.
//
// On replace, the existing row's Extra is carried over UNLESS the incoming row
// supplies its own — so a CLI `roster add` (canonical fields only) never wipes
// web-written extra columns. The same guard applies to Role: an incoming empty
// Role (a caller that doesn't know the team-derived role) preserves the
// existing recorded role rather than blanking it.
func UpsertRosterRow(rows []RosterRow, row RosterRow) ([]RosterRow, bool) {
	claim := func(i int, keepRole bool) ([]RosterRow, bool) {
		if row.Extra == nil && rows[i].Extra != nil {
			row.Extra = rows[i].Extra
			row.ExtraOrder = rows[i].ExtraOrder
		}
		if keepRole && row.Role == "" && rows[i].Role != "" {
			row.Role = rows[i].Role
		}
		rows[i] = row
		return rows, true
	}
	for i := range rows {
		if rows[i].isRaw() {
			continue // preserved malformed row: no usable username to match
		}
		// Guard the empty-vs-empty case: an incoming row with no username must
		// not match an identity-less pending row just because both are blank.
		if row.Username != "" && strings.EqualFold(rows[i].Username, row.Username) {
			return claim(i, true)
		}
	}
	// No username match: claim a pending email-invite row for the same address.
	// Only an identity-less row qualifies (see the doc comment), and a blank
	// incoming email matches nothing.
	if row.Email != "" {
		for i := range rows {
			// "Identity-less" here means exactly what the reader means, via the
			// shared rule: a present github_id cell counts even when it didn't
			// resolve, so a claim can't silently discard what the teacher typed.
			if !rows[i].IsPendingEmailInvite() {
				continue
			}
			if strings.EqualFold(strings.TrimSpace(rows[i].Email), strings.TrimSpace(row.Email)) {
				// Do NOT inherit the pending row's Role: an email invite can be
				// sent for staff, and carrying that role onto whoever the
				// teacher names here would silently grant it. The team is the
				// authority for role; a later sync refreshes it.
				return claim(i, false)
			}
		}
	}
	return append(rows, row), false
}

// RemoveRosterRow drops by Username (case-insensitive). Returns the slice and
// whether a row was removed.
func RemoveRosterRow(rows []RosterRow, username string) ([]RosterRow, bool) {
	for i := range rows {
		if rows[i].isRaw() {
			continue // preserved malformed row: no usable username to match
		}
		if strings.EqualFold(rows[i].Username, username) {
			return append(rows[:i], rows[i+1:]...), true
		}
	}
	return rows, false
}

// RosterPatch carries the fields a roster update may change. A nil field
// is left untouched; username and github_id are never changed.
type RosterPatch struct {
	FirstName *string
	LastName  *string
	Email     *string
	Section   *string
}

// UpdateRosterRow applies p to the row matching username (case-insensitive),
// leaving username and github_id untouched. Returns the slice, whether a row
// matched, and whether any value changed (so the caller can no-op).
func UpdateRosterRow(rows []RosterRow, username string, p RosterPatch) (out []RosterRow, found, changed bool) {
	for i := range rows {
		if rows[i].isRaw() {
			continue // preserved malformed row: no usable username to match
		}
		if !strings.EqualFold(rows[i].Username, username) {
			continue
		}
		if p.FirstName != nil && rows[i].FirstName != *p.FirstName {
			rows[i].FirstName = *p.FirstName
			changed = true
		}
		if p.LastName != nil && rows[i].LastName != *p.LastName {
			rows[i].LastName = *p.LastName
			changed = true
		}
		if p.Email != nil && rows[i].Email != *p.Email {
			rows[i].Email = *p.Email
			changed = true
		}
		if p.Section != nil && rows[i].Section != *p.Section {
			rows[i].Section = *p.Section
			changed = true
		}
		return rows, true, changed
	}
	return rows, false, false
}

// findPendingEmailRow returns the index of the pending email-invite row for
// email (normalized: trimmed, case-insensitive), or -1.
//
// The claimable set is deliberately NARROW (RosterRow.IsPendingEmailInvite) —
// no username and no github_id cell at all, so a present-but-unresolved cell
// still protects a row — because every caller either rewrites or drops the row
// it finds: a student who already has an account, and a classmate merely
// sharing a contact address, must never be touched. Mirrors the web's
// removeEmailInviteRows filter.
func findPendingEmailRow(rows []RosterRow, email string) int {
	key := NormalizeInviteEmail(email)
	if key == "" {
		return -1
	}
	for i := range rows {
		if !rows[i].IsPendingEmailInvite() {
			continue
		}
		if NormalizeInviteEmail(rows[i].Email) == key {
			return i
		}
	}
	return -1
}

// UpdatePendingEmailRow patches metadata onto the pending email-invite row for
// email, leaving the address itself and role alone (RosterPatch.Email is
// ignored). Returns the slice and whether a row matched.
//
// It deliberately never appends: the caller (`roster import`) may only correct
// a row an invitation already created, since creating an identity-less row
// without sending the invitation would strand it.
func UpdatePendingEmailRow(rows []RosterRow, email string, p RosterPatch) (out []RosterRow, found bool) {
	i := findPendingEmailRow(rows, email)
	if i < 0 {
		return rows, false
	}
	if p.FirstName != nil {
		rows[i].FirstName = *p.FirstName
	}
	if p.LastName != nil {
		rows[i].LastName = *p.LastName
	}
	if p.Section != nil {
		rows[i].Section = *p.Section
	}
	return rows, true
}

// RemovePendingEmailRow drops the pending email-invite row for email. Returns
// the slice and whether a row was removed.
//
// The narrow claimable set (see findPendingEmailRow) is what keeps a cancel from
// dropping a student who already accepted, or a classmate who merely shares a
// contact address.
func RemovePendingEmailRow(rows []RosterRow, email string) (out []RosterRow, removed bool) {
	i := findPendingEmailRow(rows, email)
	if i < 0 {
		return rows, false
	}
	return append(rows[:i], rows[i+1:]...), true
}

// ClaimPendingEmailRow fills a recovered identity onto the pending email-invite
// row for email IN PLACE, leaving every other cell — the teacher's
// name/section, the address, the recorded role, and any web-written extra
// column — exactly as it was. Returns the slice and whether a row matched.
//
// This is the acceptance half of the email-invite lifecycle: the row carried
// only the address until the student accepted, and the invite team's record is
// what maps that address to their new account. Borrow-only on purpose (unlike
// UpsertRosterRow, which replaces the whole row): a recovery contributes
// identity, never metadata, so a re-run can't clobber teacher-owned fields.
// Never appends: a recovery with no row is the caller's decision.
func ClaimPendingEmailRow(rows []RosterRow, email, login string, githubID int64) (out []RosterRow, claimed bool) {
	if strings.TrimSpace(login) == "" {
		return rows, false
	}
	i := findPendingEmailRow(rows, email)
	if i < 0 {
		return rows, false
	}
	rows[i].Username = strings.TrimSpace(login)
	if githubID > 0 {
		rows[i].GitHubID = githubID
		// The recovered id supersedes an unusable cell, which by the claimable
		// filter is the only kind that can be here.
		rows[i].githubIDRaw = ""
	}
	return rows, true
}

// BackfillRosterGitHubID records githubID on the row matching username
// (case-insensitive) when its github_id cell addresses no account. Returns the
// slice and whether a cell was filled.
//
// A cell that already resolves is NEVER overwritten: a login GitHub let someone
// else recycle would otherwise repoint the row onto a different person. An
// unusable cell is safe to replace, since repointing it can't hijack an
// account. The caller must source githubID from the classroom's own team
// membership, never a global user lookup, for the same reason.
func BackfillRosterGitHubID(rows []RosterRow, username string, githubID int64) (out []RosterRow, filled bool) {
	if strings.TrimSpace(username) == "" || githubID <= 0 {
		return rows, false
	}
	for i := range rows {
		if rows[i].isRaw() || !strings.EqualFold(rows[i].Username, username) {
			continue
		}
		if rows[i].GitHubID != 0 {
			return rows, false
		}
		rows[i].GitHubID = githubID
		rows[i].githubIDRaw = ""
		return rows, true
	}
	return rows, false
}

// ValidateRosterEmail: empty is valid. Non-empty must parse as bare
// `local@domain`; the display-name form is rejected so name metadata doesn't
// sneak into the email column. No TLD requirement, no DNS check.
func ValidateRosterEmail(email string) error {
	if email == "" {
		return nil
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil {
		return fmt.Errorf("invalid email %q: %w", email, err)
	}
	if parsed.Name != "" {
		return fmt.Errorf("invalid email %q: include only the address (e.g., alice@example.edu), not a display name", email)
	}
	return nil
}

// checkFieldLengths rejects cells over maxFieldBytes. Errors name the column
// from RosterColumns when possible.
func checkFieldLengths(line int, record []string) error {
	for i, v := range record {
		if len(v) <= maxFieldBytes {
			continue
		}
		col := fmt.Sprintf("column %d", i+1)
		if i < len(RosterColumns) {
			col = RosterColumns[i]
		}
		return fmt.Errorf("line %d: %s exceeds maximum length of %d bytes", line, col, maxFieldBytes)
	}
	return nil
}

// parseGitHubID reads a github_id cell. It returns (0, nil) for a value that is
// readable but not a usable id — the "unresolved" case, so a stricter reading
// than before can't fail a roster an older release wrote (notably "0", which
// this type has always used to mean unresolved). A hard error is reserved for a
// cell strconv itself rejects, which was fatal before this change too.
//
// The usable set mirrors the web app's parseGitHubId (web/src/util/identity.ts):
// positive, and <= 2^53-1, past which the web side can no longer represent an id
// exactly. A zero-padded cell is the one deliberate difference: the web rejects
// it (its id-keyed joins compare the raw string, which padding breaks) while Go
// resolves it and EncodeRoster writes it back canonically — so a rewrite repairs
// the cell instead of stranding it, and the two readers converge.
func parseGitHubID(s string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0, err
	}
	if id <= 0 || id > maxSafeGitHubID {
		return 0, nil
	}
	return id, nil
}

// isFormulaTrigger reports whether `b` would be parsed as a formula prefix by
// Excel/LibreOffice. The defang/undefang pair guards CSV injection at the
// disk-write boundary.
func isFormulaTrigger(b byte) bool {
	switch b {
	case '=', '+', '-', '@', '\t', '\r':
		return true
	}
	return false
}

// defangCSVCell prepends `'` when the first byte is a formula trigger so a
// roster row can't smuggle a payload to a co-teacher opening it in Excel.
func defangCSVCell(s string) string {
	if s == "" || !isFormulaTrigger(s[0]) {
		return s
	}
	return "'" + s
}

// undefangCSVCell inverts defangCSVCell. Cells without the exact `'<trigger>`
// pattern pass through (preserving user-typed apostrophes).
func undefangCSVCell(s string) string {
	if len(s) >= 2 && s[0] == '\'' && isFormulaTrigger(s[1]) {
		return s[1:]
	}
	return s
}
