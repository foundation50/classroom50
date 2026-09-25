package configrepo

// The teacher-supplied import CSV reader (`gh teacher roster import`). It has
// its own header vocabulary (case-insensitive, `name` alias, unknown columns
// ignored) and shares the row model, identity rule, and github_id/role parsing
// with the stored roster.csv reader in students_csv.go.

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
)

// importMetadataColumns are read when present. `name` is split into first/last
// for a file that lacks those columns. Every other column is ignored: an SIS or
// LMS export carries plenty the import has no use for. Mirrors the web's
// rosterImportHeaders.ts.
var importMetadataColumns = []string{"first_name", "last_name", "name", "section", "role"}

// parseImportLayout validates a teacher-supplied import header. Names are
// trimmed and lowercased so a spreadsheet's `Username` or `EMAIL` reads as
// ours. A recognized name appearing twice is ambiguous and rejected; unknown
// names are ignored.
func parseImportLayout(header []string) (map[string]int, error) {
	recognized := make(map[string]int, len(identityColumns)+len(importMetadataColumns))
	for i, raw := range header {
		name := strings.ToLower(trimHeaderName(raw))
		if !slices.Contains(identityColumns, name) && !slices.Contains(importMetadataColumns, name) {
			continue
		}
		if _, dup := recognized[name]; dup {
			return nil, fmt.Errorf("unexpected header: column %q appears more than once", name)
		}
		recognized[name] = i
	}
	if !hasIdentityColumn(recognized) {
		return nil, fmt.Errorf("unexpected header: no identity column; add at least one of %s (got %v; other columns are ignored)", strings.Join(identityColumns, ", "), header)
	}
	return recognized, nil
}

// importRecordToCanonical projects an import record onto RosterColumns order,
// reading only the recognized columns. `name` fills first_name/last_name only
// when that split column is ABSENT from the header (not merely empty), so a
// deliberately blank first_name is never overwritten.
func importRecordToCanonical(record []string, columns map[string]int) []string {
	cells := make(map[string]string, len(columns))
	for name, idx := range columns {
		cells[name] = record[idx]
	}
	if full, ok := cells["name"]; ok {
		first, last := splitFullName(full)
		if _, ok := columns["first_name"]; !ok {
			cells["first_name"] = first
		}
		if _, ok := columns["last_name"]; !ok {
			cells["last_name"] = last
		}
	}
	out := make([]string, len(RosterColumns))
	for i, name := range RosterColumns {
		out[i] = cells[name]
	}
	return out
}

// splitFullName splits on whitespace: the first token is the first name, the
// rest the last name. Mirrors the web's splitName.
func splitFullName(name string) (first, last string) {
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return "", ""
	}
	return parts[0], strings.Join(parts[1:], " ")
}

// ParseImportCSV decodes a teacher-supplied import CSV under the header rules
// of parseImportLayout, so a roster.csv the web wrote (including pending
// email-only invite rows) imports as-is, and so does an SIS export carrying its
// own columns. github_id and role are parsed onto the returned rows so the
// import command can cross-check the id against the resolved account and
// round-trip role; neither is applied here.
//
// Row errors are collected across the whole file and returned joined (one
// `line %d: ...` per bad row), ALONGSIDE the rows that did parse, so the caller
// can add its own per-row failures (a username that resolves to no account) to
// them and refuse once with every unusable line named.
func ParseImportCSV(data []byte) ([]RosterRow, error) {
	data = TrimUTF8BOM(data)
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1

	header, err := r.Read()
	if err == io.EOF {
		return nil, errors.New("import CSV is empty (expected at least a header row)")
	}
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	columns, err := parseImportLayout(header)
	if err != nil {
		return nil, err
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
		// Project onto the canonical width so recordToRow stays the single
		// source of the identity rule and github_id/role parsing.
		record = importRecordToCanonical(record, columns)
		row, err := recordToRow(record, canonicalLayout, line)
		if err != nil {
			rowErrs = append(rowErrs, err)
			continue
		}
		// Import input must IDENTIFY a student: the stored-file keep-rule also
		// admits name-only/unlinked rows (recordToRow), but the CLI import has
		// no action for a row it can't address, so those stay per-line errors
		// here rather than silently passing through.
		if row.Username == "" && row.Email == "" && strings.TrimSpace(canonicalLayout.cell(record, "github_id")) == "" {
			rowErrs = append(rowErrs, fmt.Errorf("line %d: row has no username, github_id, or email; at least one is required to identify a student", line))
			continue
		}
		// Canonicalize rather than only validate: the parsed address is what a
		// later invite, join, or team-name hash uses.
		canonical, err := CanonicalRosterEmail(row.Email)
		if err != nil {
			rowErrs = append(rowErrs, fmt.Errorf("line %d: %w", line, err))
			continue
		}
		row.Email = canonical
		row.Line = line
		rows = append(rows, row)
	}
	if len(rowErrs) > 0 {
		return rows, errors.Join(rowErrs...)
	}
	return rows, nil
}
