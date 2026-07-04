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
// (populated from `GET /users/{username}`); the immutable numeric ID
// defends against mid-class username changes. Email may be empty.
var RosterColumns = []string{"username", "first_name", "last_name", "email", "section", "github_id"}

// OnboardingColumns: the email-first onboarding tail the web app once appended
// (enrollment_status/method, email_hash, invite_token, invited_at, enrolled_at)
// was PRUNED — the classroom GitHub team is the source of truth for enrollment,
// so students.csv is now just the identity/metadata columns. Kept as an empty
// slice so FullRosterHeader stays "RosterColumns + OnboardingColumns" and any
// legacy tail on an existing file still round-trips via RosterRow.Extra.
var OnboardingColumns = []string{}

// FullRosterHeader is the complete on-disk students.csv header the CLI writes
// when all onboarding columns are present: the canonical RosterColumns followed
// by OnboardingColumns, comma-joined. It is the single shared fixture that both
// the Go and Python test suites assert against (and that classroom50-web's
// STUDENT_CSV_FIELDS must match) so column-order drift between the three
// codebases is caught by CI rather than surfacing as live file churn.
var FullRosterHeader = strings.Join(append(append([]string{}, RosterColumns...), OnboardingColumns...), ",")

// isCanonicalColumn reports whether name is one of the CLI-managed RosterColumns
// (the rest are carried through RosterRow.Extra).
func isCanonicalColumn(name string) bool {
	for _, c := range RosterColumns {
		if c == name {
			return true
		}
	}
	return false
}

// maxFieldBytes caps each parsed cell at RFC 5321's email max so a
// hand-edit can't push the file past the contents API's 1 MB
// ceiling and wedge future reads with encoding:"none".
const maxFieldBytes = 320

// utf8BOM is what Excel prepends to "CSV UTF-8" exports.
// encoding/csv doesn't strip it, so without trimming the first
// header field becomes "\ufeffusername" and the header check fails
// with two identical-looking slices in the terminal.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// RosterRow is one student in students.csv. GitHubID == 0 means
// unresolved (a 5-column import row before GET /users/{username}).
type RosterRow struct {
	Username  string
	FirstName string
	LastName  string
	Email     string
	Section   string
	GitHubID  int64
	// Extra carries non-canonical columns (the web app's onboarding columns,
	// and any other unknown columns) keyed by header name, so a CLI
	// read/modify/write round-trips them instead of dropping them. nil for a
	// plain 6-column file.
	Extra map[string]string
	// ExtraOrder is the on-disk order of the Extra columns, so encoding is
	// deterministic and stable across round-trips. INVARIANT: it lists exactly
	// the keys of Extra (recordToRow and UpsertRosterRow keep them in lockstep);
	// collectExtraColumns relies on it as the sole enumeration of which extra
	// columns a row has.
	ExtraOrder []string
}

// ParseRoster decodes students.csv. The header MUST begin with the canonical
// RosterColumns in order (so a hand-edit can't silently drop or shift the
// CLI-managed data); additional trailing columns (the web app's onboarding
// columns, or any other extras) are accepted and preserved verbatim in
// RosterRow.Extra. Empty input is rejected.
func ParseRoster(data []byte) ([]RosterRow, error) {
	data = bytes.TrimPrefix(data, utf8BOM)
	r := csv.NewReader(bytes.NewReader(data))
	// Read header without field-count enforcement so a renamed or
	// short header surfaces our message instead of csv's generic
	// "wrong number of fields".
	r.FieldsPerRecord = -1

	header, err := r.Read()
	if err == io.EOF {
		return nil, errors.New("students.csv is empty (expected at least the header row)")
	}
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	// The header must begin with the canonical columns in order; anything after
	// them is an extra column carried through verbatim.
	if len(header) < len(RosterColumns) || !equalSlices(header[:len(RosterColumns)], RosterColumns) {
		return nil, fmt.Errorf("unexpected header: got %v, want %v followed by any optional columns", header, RosterColumns)
	}
	extraColumns := append([]string(nil), header[len(RosterColumns):]...)
	// Reject a malformed extra-column header rather than silently mangling it on
	// round-trip: a duplicate name clobbers on read and collapses on write (data
	// loss); a name reusing a canonical one emits a duplicate-header file the web
	// app's header-keyed parser mis-reads; and because EncodeRoster writes header
	// names verbatim (no defangCSVCell), a formula-trigger name would re-inject
	// CSV formulas into a CLI-written file opened in Excel. The web app produces
	// none of these — this only fences off a hand-edit.
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
	// Fix the field count to the full header width so a short/long data row errors.
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
		row, err := recordToRow(record, extraColumns, line)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// ParseImportCSV decodes a teacher-supplied import CSV. Accepts the
// 6-column canonical shape (github_id ignored; the CLI re-resolves
// it) or the 5-column hand-edit shape.
//
// Unlike ParseRoster, import deliberately rejects the web app's wider
// onboarding-column shape: it re-resolves github_id and carries no onboarding
// state, so accepting a wider file would silently drop the tail (breaking
// ParseRoster's preservation guarantee). The error points the teacher at the
// canonical shape so they trim the tail first.
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

	if !equalSlices(header, RosterColumns) && !equalSlices(header, RosterColumns[:5]) {
		// Call out the common mistake of feeding a web-augmented students.csv
		// (canonical six + onboarding tail) straight into import.
		if len(header) > len(RosterColumns) && equalSlices(header[:len(RosterColumns)], RosterColumns) {
			return nil, fmt.Errorf("unexpected header: got %v — import takes only the canonical %v (or its 5-column form without github_id). "+
				"This looks like a roster with the web app's onboarding columns appended; drop the columns after github_id before importing "+
				"(roster add/update preserve those columns, import does not)", header, RosterColumns[:5])
		}
		return nil, fmt.Errorf("unexpected header: got %v, want %v (with optional trailing github_id; github_id ignored on input — the CLI re-resolves it)", header, RosterColumns[:5])
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
		// checkFieldLengths still bounds the oversized case.
		rows = append(rows, row)
	}
	return rows, nil
}

// recordToRow maps a data record onto a RosterRow. extraColumns (in header
// order) name the values beyond the canonical 6, carried through RosterRow.Extra
// so a round-trip preserves them.
func recordToRow(record, extraColumns []string, line int) (RosterRow, error) {
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
	if len(extraColumns) > 0 {
		// The row's extra-column order IS the header's extra order (same for
		// every row), so share that slice instead of rebuilding an identical
		// one per row. It's read-only after parse.
		row.Extra = make(map[string]string, len(extraColumns))
		row.ExtraOrder = extraColumns
		for i, name := range extraColumns {
			row.Extra[name] = undefangCSVCell(record[len(RosterColumns)+i])
		}
	}
	return row, nil
}

// EncodeRoster writes rows back as RFC 4180 students.csv (trailing
// newline) to match the scaffold shape. The header is RosterColumns followed by
// any extra columns present on the rows (ordered by collectExtraColumns), so the
// CLI preserves web-written onboarding state instead of stripping it.
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
		// Defang formula-trigger cells (=/+/-/@/\t/\r prefix).
		// github_id is numeric so it never matches.
		record := []string{
			defangCSVCell(row.Username),
			defangCSVCell(row.FirstName),
			defangCSVCell(row.LastName),
			defangCSVCell(row.Email),
			defangCSVCell(row.Section),
			githubID,
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
// rows, ordered deterministically: the known OnboardingColumns first (in their
// canonical order) when present on any row, then any other extra columns in
// first-seen order. This keeps the written header stable across round-trips
// regardless of Go map iteration order. Each row's ExtraOrder is the sole
// enumeration of its extra columns (it lists exactly the keys of Extra).
func collectExtraColumns(rows []RosterRow) []string {
	present := make(map[string]bool)
	for _, row := range rows {
		for _, name := range row.ExtraOrder {
			present[name] = true
		}
	}
	if len(present) == 0 {
		return nil
	}
	var ordered []string
	seen := make(map[string]bool, len(present))
	for _, name := range OnboardingColumns {
		if present[name] && !seen[name] {
			ordered = append(ordered, name)
			seen[name] = true
		}
	}
	// Any remaining extras (not in OnboardingColumns) follow in first-seen order.
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

// UpsertRosterRow replaces by Username (case-insensitive, matching
// GitHub's username rules) or appends. Position preserved on
// replace. Returns the slice and whether a row was replaced.
//
// On replace, the existing row's Extra (the web app's onboarding columns) is
// carried over to the incoming row UNLESS the incoming row supplies its own
// Extra — so a CLI `roster add` (which only knows the canonical fields) never
// silently wipes a student's onboarding state written by the web app.
func UpsertRosterRow(rows []RosterRow, row RosterRow) ([]RosterRow, bool) {
	for i := range rows {
		if strings.EqualFold(rows[i].Username, row.Username) {
			if row.Extra == nil && rows[i].Extra != nil {
				row.Extra = rows[i].Extra
				row.ExtraOrder = rows[i].ExtraOrder
			}
			rows[i] = row
			return rows, true
		}
	}
	return append(rows, row), false
}

// RemoveRosterRow drops by Username (case-insensitive). Returns the
// slice and whether a row was removed.
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

// UpdateRosterRow applies p to the row matching username (case-insensitive,
// like UpsertRosterRow/RemoveRosterRow), leaving username and github_id
// untouched. Returns the slice, whether a row matched, and whether any value
// actually changed (so the caller can no-op a patch that already matches).
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

// ValidateRosterEmail: empty is valid. Non-empty must parse via
// net/mail.ParseAddress in bare `local@domain` form; the display-name
// form (`Alice <alice@example.edu>`) is rejected so name metadata
// doesn't sneak into the email column. No TLD requirement (internal
// `*.local` domains are common in classrooms), no DNS check.
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

// checkFieldLengths rejects cells over maxFieldBytes so a hand-edit
// can't push the file past the contents API's 1 MB ceiling. Errors
// name the column from RosterColumns when possible.
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

// isFormulaTrigger reports whether `b` would be parsed as a formula
// prefix by Excel/LibreOffice. The defang/undefang pair guards
// against CSV-injection at the disk-write boundary.
func isFormulaTrigger(b byte) bool {
	switch b {
	case '=', '+', '-', '@', '\t', '\r':
		return true
	}
	return false
}

// defangCSVCell prepends `'` when the first byte is a formula
// trigger so a roster row can't smuggle an executable payload to a
// co-teacher who opens the file in Excel.
func defangCSVCell(s string) string {
	if s == "" || !isFormulaTrigger(s[0]) {
		return s
	}
	return "'" + s
}

// undefangCSVCell inverts defangCSVCell so parse/encode round-trips.
// Cells without the exact `'<trigger>` pattern pass through
// (preserves user-typed apostrophes).
func undefangCSVCell(s string) string {
	if len(s) >= 2 && s[0] == '\'' && isFormulaTrigger(s[1]) {
		return s[1:]
	}
	return s
}
