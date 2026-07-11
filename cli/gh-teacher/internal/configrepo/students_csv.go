package configrepo

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/mail"
	"strconv"
	"strings"
)

// RosterColumns: canonical required column order. github_id is CLI-managed
// (from `GET /users/{username}`); the immutable numeric ID defends against
// mid-class username changes. Email may be empty. role is best-effort recorded
// metadata (instructor/ta/student, or "") refreshed from the classroom's GitHub
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
	for _, c := range RosterColumns {
		if c == name {
			return true
		}
	}
	return false
}

// maxFieldBytes caps each cell at RFC 5321's email max so a hand-edit can't
// push the file past the contents API's 1 MB ceiling.
const maxFieldBytes = 320

// utf8BOM is what Excel prepends to "CSV UTF-8" exports. encoding/csv doesn't
// strip it, so without trimming the first header field becomes "\ufeffusername"
// and the header check fails on two identical-looking slices.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// RosterRow is one student in the roster. GitHubID == 0 means unresolved (a
// 5-column import row before GET /users/{username}).
type RosterRow struct {
	Username  string
	FirstName string
	LastName  string
	Email     string
	Section   string
	GitHubID  int64
	// Role is best-effort recorded metadata: "instructor", "ta", "student", or
	// "" (unknown / a pre-role file). Refreshed from team membership on sync;
	// never consulted for enrollment decisions.
	Role string
	// Extra carries non-canonical columns keyed by header name, so a
	// read/modify/write round-trips them. nil for a plain canonical file.
	Extra map[string]string
	// ExtraOrder is the on-disk order of Extra columns for deterministic
	// encoding. INVARIANT: it lists exactly the keys of Extra.
	ExtraOrder []string
}

// ParseRoster decodes the roster CSV. The header MUST begin with the canonical
// RosterColumns in order; a file written before the trailing `role` column was
// added (ending at github_id) is still accepted (role reads as ""). Additional
// trailing columns beyond the canonical set are preserved verbatim in
// RosterRow.Extra. Empty input is rejected.
func ParseRoster(data []byte) ([]RosterRow, error) {
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
	case len(header) >= len(RosterColumns) && equalSlices(header[:len(RosterColumns)], RosterColumns):
		canonicalLen = len(RosterColumns)
	case len(header) == len(legacyRequiredColumns) && equalSlices(header, legacyRequiredColumns):
		// Pre-role file: exactly the canonical columns through github_id, no
		// trailing columns. role reads as "".
		canonicalLen = len(legacyRequiredColumns)
	case len(header) < len(RosterColumns) || !equalSlices(header[:len(legacyRequiredColumns)], legacyRequiredColumns):
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
	// Fix the field count to the full header width so a short/long row errors.
	r.FieldsPerRecord = len(header)

	var rows []RosterRow
	for line := 2; ; line++ {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		row, err := recordToRow(record, canonicalLen, extraColumns, line)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// ParseImportCSV decodes a teacher-supplied import CSV: the identity/metadata
// columns through github_id (github_id ignored; re-resolved) or the 5-column
// hand-edit shape without github_id. `role` is NOT an import column — it is
// team-derived metadata written by sync, never hand-imported.
//
// Unlike ParseRoster, import rejects a wider file with extra trailing columns
// (including a stray role): it re-resolves github_id and carries no extra
// state, so a wider file would silently drop the tail. The error points at the
// canonical shape.
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

	// Import accepts the identity columns through github_id, or the 5-column
	// form without it. role and any other trailing column are not import input.
	importFull := legacyRequiredColumns      // username..github_id (6)
	importShort := legacyRequiredColumns[:5] // username..section  (5)
	if !equalSlices(header, importFull) && !equalSlices(header, importShort) {
		// Common mistake: feeding a wider roster CSV (with role and/or legacy
		// extra columns) straight into import.
		if len(header) > len(importFull) && equalSlices(header[:len(importFull)], importFull) {
			return nil, fmt.Errorf("unexpected header: got %v — import takes only the canonical %v (or its 5-column form without github_id). "+
				"This looks like a roster with extra columns appended; drop the columns after github_id before importing "+
				"(roster add/update preserve those columns, import does not)", header, importShort)
		}
		return nil, fmt.Errorf("unexpected header: got %v, want %v (with optional trailing github_id; github_id ignored on input — the CLI re-resolves it)", header, importShort)
	}
	r.FieldsPerRecord = len(header)

	var rows []RosterRow
	for line := 2; ; line++ {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		if err := checkFieldLengths(line, record); err != nil {
			return nil, err
		}
		row := RosterRow{
			Username:  strings.TrimSpace(undefangCSVCell(record[0])),
			FirstName: undefangCSVCell(record[1]),
			LastName:  undefangCSVCell(record[2]),
			Email:     strings.TrimSpace(undefangCSVCell(record[3])),
			Section:   undefangCSVCell(record[4]),
		}
		if row.Username == "" {
			return nil, fmt.Errorf("line %d: username column is empty", line)
		}
		if err := ValidateRosterEmail(row.Email); err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		// record[5] (github_id) ignored; the CLI re-resolves it.
		rows = append(rows, row)
	}
	return rows, nil
}

// recordToRow maps a data record onto a RosterRow. canonicalLen is the matched
// canonical prefix width (7 with role, 6 for a pre-role file); extraColumns (in
// header order) name the values beyond it, carried through Extra.
func recordToRow(record []string, canonicalLen int, extraColumns []string, line int) (RosterRow, error) {
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
	if row.Username == "" {
		return RosterRow{}, fmt.Errorf("line %d: username column is empty", line)
	}
	if record[5] != "" {
		id, err := strconv.ParseInt(record[5], 10, 64)
		if err != nil {
			return RosterRow{}, fmt.Errorf("line %d: invalid github_id %q: %w", line, record[5], err)
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
		githubID := ""
		if row.GitHubID != 0 {
			githubID = strconv.FormatInt(row.GitHubID, 10)
		}
		// Defang formula-trigger cells; github_id is numeric so never matches.
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

// UpsertRosterRow replaces by Username (case-insensitive) or appends. Position
// preserved on replace. Returns the slice and whether a row was replaced.
//
// On replace, the existing row's Extra is carried over UNLESS the incoming row
// supplies its own — so a CLI `roster add` (canonical fields only) never wipes
// web-written extra columns. The same guard applies to Role: an incoming empty
// Role (a caller that doesn't know the team-derived role) preserves the
// existing recorded role rather than blanking it.
func UpsertRosterRow(rows []RosterRow, row RosterRow) ([]RosterRow, bool) {
	for i := range rows {
		if strings.EqualFold(rows[i].Username, row.Username) {
			if row.Extra == nil && rows[i].Extra != nil {
				row.Extra = rows[i].Extra
				row.ExtraOrder = rows[i].ExtraOrder
			}
			if row.Role == "" && rows[i].Role != "" {
				row.Role = rows[i].Role
			}
			rows[i] = row
			return rows, true
		}
	}
	return append(rows, row), false
}

// RemoveRosterRow drops by Username (case-insensitive). Returns the slice and
// whether a row was removed.
func RemoveRosterRow(rows []RosterRow, username string) ([]RosterRow, bool) {
	for i := range rows {
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
		return fmt.Errorf("invalid email %q: include only the address (e.g. alice@example.edu), not a display name", email)
	}
	return nil
}

func equalSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
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
