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
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// RosterColumns: canonical required column order. github_id is tool-managed —
// `GET /users/{username}` on add/import, else the classroom team's own
// membership on sync; the immutable numeric ID defends against mid-class
// username changes. Email may be empty. role is best-effort recorded metadata
// (teacher/hta/ta/student, or ""), refreshed from the classroom's GitHub teams
// by the web's sync and recorded here only on a row `roster sync` appends — the
// teams, not this column, remain the enrollment/role authority; nothing reads it
// for logic.
var RosterColumns = []string{"username", "first_name", "last_name", "email", "section", "github_id", "role"}

// identityColumns are the reserved columns that can identify a student. A
// roster or import header must carry at least one; every other reserved column
// is optional on read because every writer emits the full RosterColumns header,
// so a file only lacks a column when hand-edited or written before that column
// existed (role).
var identityColumns = []string{"github_id", "username", "email"}

// FullRosterHeader is the on-disk roster.csv header (RosterColumns,
// comma-joined). The single shared fixture the Go, Python, and web suites
// assert against, so column-order drift is caught by CI. Any other column on an
// existing file, wherever it sits, round-trips via RosterRow.Extra.
var FullRosterHeader = strings.Join(RosterColumns, ",")

// trimHeaderName strips the whitespace both readers ignore around a header
// name. Go's unicode.IsSpace and JS's `\s` differ by exactly two code points
// (U+0085 is only in Go's set, U+FEFF only in JS's), and Papa also strips a BOM
// from every header cell, so the CLI adds U+FEFF and the web adds U+0085
// (util/csv.ts trimCsvHeader). Without that, a stray BOM inside a header made
// `email` an identity column for the web and an extra column for the CLI, and a
// CLI rewrite then emitted a file the web refused.
func trimHeaderName(raw string) string {
	return strings.TrimFunc(raw, func(r rune) bool {
		return unicode.IsSpace(r) || r == '\uFEFF'
	})
}

// isCanonicalColumn reports whether name is a CLI-managed RosterColumn (the
// rest are carried through RosterRow.Extra).
func isCanonicalColumn(name string) bool {
	return slices.Contains(RosterColumns, name)
}

// rosterLayout is a parsed roster.csv header: where each reserved column sits
// (absent when the file lacks it) and the extra columns in file order. Reading
// is keyed by header NAME, so a teacher may reorder columns or insert their own
// anywhere; only the names in RosterColumns are ever interpreted.
type rosterLayout struct {
	width     int
	canonical map[string]int
	// extraNames[k] sits at record index extraIndex[k]. extraNames doubles as
	// every row's ExtraOrder, so it is shared rather than rebuilt per row.
	extraNames []string
	extraIndex []int
}

// canonicalLayout is the layout of a file whose header is exactly RosterColumns.
var canonicalLayout = func() rosterLayout {
	l, err := parseRosterLayout(RosterColumns)
	if err != nil {
		panic(err)
	}
	return l
}()

// parseRosterLayout validates a stored roster.csv header. It mirrors the web
// reader's rules (parseRosterCsv) so neither tool writes a file the other
// refuses: names are trimmed, at least one identity column must be present,
// and a duplicate name or a formula-leading extra name is rejected rather than
// mangled on round-trip.
func parseRosterLayout(header []string) (rosterLayout, error) {
	layout := rosterLayout{width: len(header), canonical: make(map[string]int, len(RosterColumns))}
	seenExtra := make(map[string]bool)
	for i, raw := range header {
		name := trimHeaderName(raw)
		if isCanonicalColumn(name) {
			if _, dup := layout.canonical[name]; dup {
				return rosterLayout{}, fmt.Errorf("unexpected header: reserved column %q appears more than once", name)
			}
			layout.canonical[name] = i
			continue
		}
		if seenExtra[name] {
			return rosterLayout{}, fmt.Errorf("unexpected header: duplicate column %q", name)
		}
		if name != "" && isFormulaTrigger(name[0]) {
			return rosterLayout{}, fmt.Errorf("unexpected header: extra column %q begins with a spreadsheet formula trigger", name)
		}
		seenExtra[name] = true
		layout.extraNames = append(layout.extraNames, name)
		layout.extraIndex = append(layout.extraIndex, i)
	}
	if !hasIdentityColumn(layout.canonical) {
		return rosterLayout{}, fmt.Errorf("unexpected header: no identity column; add at least one of %s (got %v)", strings.Join(identityColumns, ", "), header)
	}
	return layout, nil
}

// hasIdentityColumn reports whether a parsed header carries at least one of
// identityColumns.
func hasIdentityColumn(columns map[string]int) bool {
	return slices.ContainsFunc(identityColumns, func(name string) bool {
		_, ok := columns[name]
		return ok
	})
}

// cell returns the record's value for a reserved column, or "" when the header
// lacks it.
func (l rosterLayout) cell(record []string, name string) string {
	if i, ok := l.canonical[name]; ok {
		return record[i]
	}
	return ""
}

// columnName labels record index i for an error message.
func (l rosterLayout) columnName(i int) string {
	for name, idx := range l.canonical {
		if idx == i {
			return name
		}
	}
	if k := slices.Index(l.extraIndex, i); k >= 0 {
		return fmt.Sprintf("column %d (%s)", i+1, l.extraNames[k])
	}
	return fmt.Sprintf("column %d", i+1)
}

// canonicalize reorders a raw record into EncodeRoster's column order
// (RosterColumns, then extras in file order), filling absent reserved columns
// with "", so a lenient-preserved row stays aligned with the rewritten header.
// A record whose width doesn't match the header can't be mapped and is kept
// verbatim.
func (l rosterLayout) canonicalize(record []string) []string {
	if len(record) != l.width {
		return record
	}
	out := make([]string, 0, len(RosterColumns)+len(l.extraIndex))
	for _, name := range RosterColumns {
		out = append(out, l.cell(record, name))
	}
	for _, idx := range l.extraIndex {
		out = append(out, record[idx])
	}
	return out
}

// prefixOfRewrite reports whether every source column sits at the same index
// in EncodeRoster's header (RosterColumns, then extras). True for a canonical
// file and for a pre-role file that stops at github_id: a verbatim raw row
// then reads back under the same names it was written under, so a rewrite that
// widens the header is safe for it. False once a column is reordered, skipped,
// or an extra precedes a reserved column.
func (l rosterLayout) prefixOfRewrite() bool {
	rewritten := append(append([]string(nil), RosterColumns...), l.extraNames...)
	if l.width > len(rewritten) {
		return false
	}
	for name, idx := range l.canonical {
		if rewritten[idx] != name {
			return false
		}
	}
	for k, idx := range l.extraIndex {
		if rewritten[idx] != l.extraNames[k] {
			return false
		}
	}
	return true
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

// TrimUTF8BOM drops the byte-order mark Excel and Notepad prepend when saving
// UTF-8. Every reader of a teacher-supplied file needs it: the BOM is invisible
// in an editor but makes the first line of the file unparseable.
func TrimUTF8BOM(data []byte) []byte {
	return bytes.TrimPrefix(data, utf8BOM)
}

// NormalizeTeacherText converts a teacher-supplied local file to UTF-8. Bytes
// that already validate as UTF-8 (after BOM strip) pass through; anything else
// is decoded as Windows-1252 — Excel's plain "CSV" export on a Western-locale
// Windows box — which accepts every byte sequence, matching the web app's
// fallback. transcoded reports the fallback ran, so a caller can tell the
// teacher to double-check non-ASCII names.
func NormalizeTeacherText(data []byte) (out []byte, transcoded bool) {
	data = TrimUTF8BOM(data)
	if utf8.Valid(data) {
		return data, false
	}
	decoded, err := charmap.Windows1252.NewDecoder().Bytes(data)
	if err != nil {
		// Windows-1252 decodes every byte sequence; unreachable in practice.
		return data, false
	}
	return decoded, true
}

// RosterRow is one student in the roster. GitHubID == 0 means unresolved — a
// pending email-invite row, an import row whose file had no github_id column
// (before GET /users/{username}), or a cell we couldn't use.
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
	// Role is best-effort recorded metadata: "teacher", "hta", "ta", "student",
	// or "" (unknown / a pre-role file). Never consulted for enrollment
	// decisions — the classroom's teams are the authority.
	Role string
	// Line is the 1-based CSV line this row was read from. Recorded by
	// ParseImportCSV (an import reports failures per line, and a file with a bad
	// line has no row for it) and on a raw row (so a refused rewrite can name it).
	Line int
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
	// rawUnaligned marks a raw row whose width didn't match the header AND
	// whose source header is not a prefix of the rewritten one, so its cells
	// would land under different names if the rewritten header were as wide.
	rawUnaligned bool
}

// isRaw reports whether the row is a preserved-but-unparsed record.
func (r RosterRow) isRaw() bool { return r.raw != nil }

// IsPendingEmailInvite reports whether the row is an email-ONLY invite row: no
// username, no github_id that addresses an account, and an address to key on. A
// present-but-unresolved cell (0, negative, past 2^53 — see parseGitHubID) is
// NOT identity: it addresses nobody, so treating it as one would strand the row
// forever, unfoldable and unreapable by either tool.
//
// This is the single source of the claimable-row rule every pending-row helper
// below enforces (findPendingEmailRow, UpsertRosterRow's email fallback), so a
// caller deciding what to plan and the helper applying it agree — a planner
// guessing at the rule plans edits these helpers then refuse, which a --write
// pass would report and silently skip forever. The set is deliberately NARROW
// because every caller either rewrites or drops the row it matches: a student
// who already has an account, and a classmate merely sharing a contact address,
// must never be touched. Mirrors the web's removeEmailInviteRows filter: no
// username and resolveGitHubId() === null.
func (r RosterRow) IsPendingEmailInvite() bool {
	return !r.isRaw() && r.Username == "" &&
		r.GitHubID == 0 &&
		NormalizeInviteEmail(r.Email) != ""
}

// ParseRoster decodes the roster CSV under the header rules of
// parseRosterLayout: reserved columns are read by name, any other column is
// preserved verbatim in RosterRow.Extra so a teacher's own data survives a
// rewrite. Empty input is rejected. Any malformed data row is an error.
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
	data = TrimUTF8BOM(data)
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
	layout, err := parseRosterLayout(header)
	if err != nil {
		return nil, err
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
		row, err := recordToRow(record, layout, line)
		if err != nil {
			if lenient {
				rows = append(rows, RosterRow{
					raw:          layout.canonicalize(record),
					rawUnaligned: len(record) != layout.width && !layout.prefixOfRewrite(),
					Line:         line,
				})
				continue
			}
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// recordToRow maps a data record onto a RosterRow through the header layout:
// canonical cells by name (role "" when the header lacks it), extra cells into
// Extra in header order.
func recordToRow(record []string, layout rosterLayout, line int) (RosterRow, error) {
	// Guard the width before indexing: lenient parsing leaves FieldsPerRecord
	// unenforced, so a mis-widthed row reaches here — error (the caller
	// preserves it raw) rather than panicking on an out-of-range index.
	if len(record) != layout.width {
		return RosterRow{}, fmt.Errorf("line %d: wrong number of fields (got %d, want %d)", line, len(record), layout.width)
	}
	if err := checkFieldLengths(line, record, layout); err != nil {
		return RosterRow{}, err
	}
	row := RosterRow{
		Username:  strings.TrimSpace(undefangCSVCell(layout.cell(record, "username"))),
		FirstName: undefangCSVCell(layout.cell(record, "first_name")),
		LastName:  undefangCSVCell(layout.cell(record, "last_name")),
		Email:     strings.TrimSpace(undefangCSVCell(layout.cell(record, "email"))),
		Section:   undefangCSVCell(layout.cell(record, "section")),
		Role:      strings.TrimSpace(undefangCSVCell(layout.cell(record, "role"))),
	}
	githubIDCell := layout.cell(record, "github_id")
	// A row needs at least one cell that identifies or DESCRIBES a student. An
	// identity column (username, github_id, email) has always sufficed; a row
	// with only a NAME is kept too — the teacher-kept "unlinked" row the web
	// renders for manual reconciliation. A row with none of these (blank, or
	// only section/role noise) addresses and describes nobody: it stays an
	// error (lenient parsing preserves it raw). An email-only row is valid and
	// deliberate: the web writes it when a teacher invites by email, and fills
	// in the account once the student accepts. Keep-rule mirrors the web's
	// parseRosterCsv filter (web/src/util/rosterCsv.ts); shared cases:
	// cli/shared/testdata/roster_row_cases.json.
	hasName := strings.TrimSpace(row.FirstName) != "" || strings.TrimSpace(row.LastName) != ""
	if row.Username == "" && row.Email == "" && strings.TrimSpace(githubIDCell) == "" && !hasName {
		return RosterRow{}, fmt.Errorf("line %d: row has no username, github_id, email, or name; at least one is required to identify a student", line)
	}
	if trimmed := strings.TrimSpace(githubIDCell); trimmed != "" {
		id, err := parseGitHubID(trimmed)
		if err != nil {
			return RosterRow{}, fmt.Errorf("line %d: invalid github_id %q: %w", line, githubIDCell, err)
		}
		// id == 0 means readable but unusable: leave GitHubID unresolved and keep
		// the cell so a rewrite doesn't discard what the teacher typed.
		if id == 0 {
			row.githubIDRaw = githubIDCell
		}
		row.GitHubID = id
	}
	if len(layout.extraIndex) > 0 {
		row.Extra = make(map[string]string, len(layout.extraIndex))
		row.ExtraOrder = layout.extraNames
		for k, idx := range layout.extraIndex {
			row.Extra[layout.extraNames[k]] = undefangCSVCell(record[idx])
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
			// Preserve a lenient-parsed malformed row verbatim (defanged). It was
			// reordered into this header's column order at parse time when its
			// width allowed; otherwise its cells are still in the source header's
			// order and the write path re-reads leniently so the mismatch
			// round-trips. That only holds while the widths keep differing: a
			// header that omitted reserved columns is rewritten wider, and a row
			// with exactly that many surplus cells would read back as a valid row
			// with every cell under the wrong column. Refuse rather than realign.
			if row.rawUnaligned && len(row.raw) == len(header) {
				return nil, fmt.Errorf("line %d: malformed row has %d fields, the same as the rewritten %d-column header, so it would be read back as a valid row with cells under the wrong columns; fix or delete that row in roster.csv first", row.Line, len(row.raw), len(header))
			}
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

// UpsertRosterRow completes the row whose GitHubID matches when its username is
// blank or stale (the id is the immutable identity, so the login is corrected
// from it), else replaces by Username (case-insensitive), else claims a pending
// email-invite row with the same email, else appends. Position preserved on
// replace. Returns the slice and whether a row was replaced.
//
// The id completion is borrow-only: a name, email, or section cell the incoming
// row leaves blank keeps the stored value, so a bare `roster add <login>`
// against a row a hand edit left id-only fills the login in rather than wiping
// teacher-entered metadata. A row that already carries the incoming login falls
// through to the username replace, whose whole-row semantics `roster import`
// relies on to clear a cell.
//
// The email fallback finishes what an email invite started: that row carries
// only the invited address until the student accepts, so adding them by username
// would otherwise leave a second row for the same person. Claimable means
// exactly RosterRow.IsPendingEmailInvite, and a username match always wins. An
// email claim does NOT inherit the pending row's Role (an email invite may have
// been for staff; the team is the role authority), whereas an id or username
// match does.
//
// On replace, the existing row's Extra is carried over UNLESS the incoming row
// supplies its own — so a CLI `roster add` (canonical fields only) never wipes
// web-written extra columns. The same guard applies to Role: an incoming empty
// Role (a caller that doesn't know the team-derived role) preserves the
// existing recorded role rather than blanking it.
//
// Callers that resolved the account from a login must run RosterIdentityConflict
// first: this function never refuses, so on a recycled login the username pass
// would repoint the stored row onto the new holder.
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
	if row.GitHubID != 0 {
		for i := range rows {
			if rows[i].isRaw() || rows[i].GitHubID != row.GitHubID ||
				strings.EqualFold(rows[i].Username, row.Username) {
				continue
			}
			keepStored(&row.FirstName, rows[i].FirstName)
			keepStored(&row.LastName, rows[i].LastName)
			keepStored(&row.Email, rows[i].Email)
			keepStored(&row.Section, rows[i].Section)
			return claim(i, true)
		}
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
	// A blank incoming email matches nothing.
	if row.Email != "" {
		for i := range rows {
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

func keepStored(incoming *string, stored string) {
	if strings.TrimSpace(*incoming) == "" {
		*incoming = stored
	}
}

// RosterIdentityConflict reports the stored row that makes writing login for
// githubID bind one identity to two people: a row carrying the login for a
// DIFFERENT resolved account (a recycled login), or a row carrying the login
// while another row already records githubID (the login would end up on two
// rows). Mirrors the web's RosterIdentityConflictError; UpsertRosterRow does
// not check this itself.
func RosterIdentityConflict(rows []RosterRow, login string, githubID int64) (holder RosterRow, conflict bool) {
	login = strings.TrimSpace(login)
	if login == "" || githubID <= 0 {
		return RosterRow{}, false
	}
	idRow := -1
	for i := range rows {
		if !rows[i].isRaw() && rows[i].GitHubID == githubID {
			idRow = i
			break
		}
	}
	for i := range rows {
		if rows[i].isRaw() || !strings.EqualFold(rows[i].Username, login) {
			continue
		}
		if rows[i].GitHubID != 0 && rows[i].GitHubID != githubID {
			return rows[i], true
		}
		if idRow != -1 && idRow != i {
			return rows[i], true
		}
	}
	return RosterRow{}, false
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
// email (normalized: trimmed, case-insensitive), or -1. Claimable is
// RosterRow.IsPendingEmailInvite — see there for why the set is this narrow.
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

// RemovePendingEmailRow drops the pending email-invite row for email — used by
// the EXPLICIT cancel/retire paths only. The sync never removes rows: an
// email-only row nothing backs stays on the roster (the web renders it as
// "unlinked" for the teacher to link or delete by hand).
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

// RecordRosterEmail fills email onto the row this recovery identifies — the
// first naming login (case-insensitive), else the first carrying githubID — and
// ONLY when its email cell is blank. Returns the slice and whether a cell was
// filled.
//
// This is the other half of the acceptance fold: a recovery whose row already
// names the account but records no address has nowhere for the recovered address
// to land, and the invite team holding it is retired right after. The login-then-
// id order matches the web's fold. Deliberately fill-only — an address the
// teacher entered is theirs and is never replaced by the invited one.
func RecordRosterEmail(rows []RosterRow, login string, githubID int64, email string) (out []RosterRow, recorded bool) {
	email = strings.TrimSpace(email)
	login = strings.TrimSpace(login)
	if email == "" {
		return rows, false
	}
	fill := func(i int) ([]RosterRow, bool) {
		if strings.TrimSpace(rows[i].Email) != "" {
			return rows, false
		}
		rows[i].Email = email
		return rows, true
	}
	if login != "" {
		for i := range rows {
			if !rows[i].isRaw() && strings.EqualFold(strings.TrimSpace(rows[i].Username), login) {
				return fill(i)
			}
		}
	}
	if githubID > 0 {
		for i := range rows {
			if !rows[i].isRaw() && rows[i].GitHubID == githubID {
				return fill(i)
			}
		}
	}
	return rows, false
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

// BackfillRosterUsername writes login onto the row whose GitHubID matches when
// its username is blank or differs. The mirror of BackfillRosterGitHubID: keyed
// by the immutable id, it can only correct a row's spelling of its own account.
// The caller sources login from the classroom's own team membership and skips
// a login another row already carries.
func BackfillRosterUsername(rows []RosterRow, githubID int64, login string) (out []RosterRow, filled bool) {
	login = strings.TrimSpace(login)
	if githubID <= 0 || login == "" {
		return rows, false
	}
	for i := range rows {
		if rows[i].isRaw() || rows[i].GitHubID != githubID {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(rows[i].Username), login) {
			return rows, false
		}
		rows[i].Username = login
		return rows, true
	}
	return rows, false
}

// CanonicalRosterEmail validates a roster email and returns the address
// mail.ParseAddress actually parsed, normalized (trim + lowercase). Empty is
// valid and returns empty — the column is optional per row. Non-empty must
// parse as bare `local@domain`; the display-name form is rejected so name
// metadata doesn't sneak into the email column. No TLD requirement, no DNS
// check.
//
// It deliberately returns the parsed value rather than only an error, and there
// is no validate-only variant: a caller that validated and then used its RAW
// input silently kept forms mail.ParseAddress accepts but GitHub does not
// (`<a@b.edu>`), which surfaced later as a roster join that never matches or an
// invitation GitHub 422s — read as "already invited". Returning the canonical
// form is what forecloses that.
func CanonicalRosterEmail(email string) (string, error) {
	if email == "" {
		return "", nil
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil {
		return "", fmt.Errorf("invalid email %q: %w", email, err)
	}
	if parsed.Name != "" {
		return "", fmt.Errorf("invalid email %q: include only the address (like alice@example.edu), not a display name", email)
	}
	return NormalizeInviteEmail(parsed.Address), nil
}

// checkFieldLengths rejects cells over maxFieldBytes. Errors name the column
// from the header layout.
func checkFieldLengths(line int, record []string, layout rosterLayout) error {
	for i, v := range record {
		if len(v) <= maxFieldBytes {
			continue
		}
		return fmt.Errorf("line %d: %s exceeds maximum length of %d bytes", line, layout.columnName(i), maxFieldBytes)
	}
	return nil
}

// parseGitHubID reads a github_id cell. It returns (0, nil) for a value that is
// readable but not a usable id — the "unresolved" case, so a stricter reading
// than before can't fail a roster an older release wrote (notably "0", which
// this type has always used to mean unresolved). A hard error is reserved for a
// cell strconv itself rejects, which was fatal before this change too.
//
// The usable set mirrors the web app's resolveGitHubId
// (web/src/util/identity.ts): a run of digits, positive, and <= 2^53-1, past
// which the web side can no longer represent an id exactly. Leading zeros are
// the one tolerated non-canonical spelling — the web strips exactly those, and
// EncodeRoster writes the cell back canonically, so a rewrite repairs it. Any
// other spelling strconv would happily read (a leading `+`, a sign) must stay
// UNRESOLVED here: the web's join reads such a row as a pending email invite,
// and resolving it would make the same row identity to one tool and claimable
// to the other.
func parseGitHubID(s string) (int64, error) {
	trimmed := strings.TrimSpace(s)
	id, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil {
		return 0, err
	}
	if id <= 0 || id > maxSafeGitHubID || !isDigits(trimmed) {
		return 0, nil
	}
	return id, nil
}

// isDigits reports whether s is a non-empty run of ASCII digits.
func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
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
