package configrepo

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseRoster_Canonical(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
		"alice,Alice,Andersson,alice@example.edu,section-1,12345,instructor\n" +
		"bob,Bob,Baker,,,67890,ta\n" +
		"carol,,,carol@example.edu,section-2,11111,student\n")

	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	want := []RosterRow{
		{Username: "alice", FirstName: "Alice", LastName: "Andersson", Email: "alice@example.edu", Section: "section-1", GitHubID: 12345, Role: "instructor"},
		{Username: "bob", FirstName: "Bob", LastName: "Baker", Email: "", Section: "", GitHubID: 67890, Role: "ta"},
		{Username: "carol", FirstName: "", LastName: "", Email: "carol@example.edu", Section: "section-2", GitHubID: 11111, Role: "student"},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows = %#v, want %#v", rows, want)
	}
}

// A pre-role roster.csv (canonical columns ending at github_id, no role column)
// must still parse — role was added additively — with Role reading as "".
func TestParseRoster_LegacyNoRoleColumn(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section,github_id\n" +
		"alice,Alice,Andersson,alice@example.edu,section-1,12345\n")
	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster (pre-role file): %v", err)
	}
	want := []RosterRow{
		{Username: "alice", FirstName: "Alice", LastName: "Andersson", Email: "alice@example.edu", Section: "section-1", GitHubID: 12345, Role: ""},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows = %#v, want %#v", rows, want)
	}
}

func TestParseRoster_HeaderOnly(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section,github_id,role\n")
	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("expected 0 rows for header-only input, got %d: %#v", len(rows), rows)
	}
}

func TestParseRoster_RejectsBadInputs(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		wantErrPart string
	}{
		{"empty input", "", "empty"},
		{"missing github_id column", "username,first_name,last_name,email,section\nalice,A,A,a@x,s\n", "unexpected header"},
		{"missing email column", "username,first_name,last_name,section,github_id\nalice,A,A,s,1\n", "unexpected header"},
		{"renamed first column", "user,first_name,last_name,email,section,github_id,role\nalice,A,A,,s,1,student\n", "unexpected header"},
		{"username empty", "username,first_name,last_name,email,section,github_id,role\n,A,A,,s,1,student\n", "username column is empty"},
		{"non-numeric github_id", "username,first_name,last_name,email,section,github_id,role\nalice,A,A,,s,nope,student\n", "invalid github_id"},
		{"wrong field count", "username,first_name,last_name,email,section,github_id,role\nalice,A,A\n", "wrong number"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseRoster([]byte(tc.in))
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
			}
			if !strings.Contains(err.Error(), tc.wantErrPart) {
				t.Fatalf("error = %q, want substring %q", err.Error(), tc.wantErrPart)
			}
		})
	}
}

func TestParseImportCSV_BothHeaderShapes(t *testing.T) {
	t.Run("5-column header (recommended hand-authored shape)", func(t *testing.T) {
		in := []byte("username,first_name,last_name,email,section\nalice,Alice,A,alice@x,s-1\nbob,Bob,B,,\n")
		rows, err := ParseImportCSV(in)
		if err != nil {
			t.Fatalf("ParseImportCSV: %v", err)
		}
		if len(rows) != 2 {
			t.Fatalf("got %d rows, want 2", len(rows))
		}
		if rows[0].Email != "alice@x" {
			t.Errorf("expected alice's email to thread through, got %q", rows[0].Email)
		}
		if rows[1].Email != "" {
			t.Errorf("expected bob's empty email to round-trip, got %q", rows[1].Email)
		}
		if rows[0].GitHubID != 0 || rows[1].GitHubID != 0 {
			t.Errorf("5-column import should leave GitHubID zero (CLI resolves it), got %d / %d", rows[0].GitHubID, rows[1].GitHubID)
		}
	})

	t.Run("6-column header ignores github_id", func(t *testing.T) {
		in := []byte("username,first_name,last_name,email,section,github_id\nalice,Alice,A,a@x,s,99999\n")
		rows, err := ParseImportCSV(in)
		if err != nil {
			t.Fatalf("ParseImportCSV: %v", err)
		}
		if len(rows) != 1 {
			t.Fatalf("got %d rows, want 1", len(rows))
		}
		// ParseImportCSV ignores any incoming github_id; the CLI
		// re-resolves from GitHub at import time.
		if rows[0].GitHubID != 0 {
			t.Errorf("import should ignore github_id column, got %d", rows[0].GitHubID)
		}
		if rows[0].Email != "a@x" {
			t.Errorf("expected email to round-trip, got %q", rows[0].Email)
		}
	})
}

func TestParseImportCSV_Rejects(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		wantErrPart string
	}{
		{"empty input", "", "empty"},
		{"wrong header", "user,first,last,section\nalice,A,A,s\n", "unexpected header"},
		{"4-column without email", "username,first_name,last_name,section\nalice,A,A,s\n", "unexpected header"},
		{"empty username", "username,first_name,last_name,email,section\n,A,A,,s\n", "username column is empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseImportCSV([]byte(tc.in))
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
			}
			if !strings.Contains(err.Error(), tc.wantErrPart) {
				t.Fatalf("error = %q, want substring %q", err.Error(), tc.wantErrPart)
			}
		})
	}
}

func TestEncodeRoster_RoundTrip(t *testing.T) {
	original := []RosterRow{
		{Username: "alice", FirstName: "Alice", LastName: "Andersson", Email: "alice@example.edu", Section: "section-1", GitHubID: 12345, Role: "instructor"},
		{Username: "bob", FirstName: "Bob, Jr.", LastName: `"Baker"`, Email: "bob+tag@example.org", Section: "section, 2", GitHubID: 67890, Role: "ta"},
		{Username: "carol", FirstName: "", LastName: "", Email: "", Section: "", GitHubID: 11111, Role: "student"},
	}
	encoded, err := EncodeRoster(original)
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}

	// Canonical column order, no quoting on the header row.
	wantHeader := "username,first_name,last_name,email,section,github_id,role\n"
	if !strings.HasPrefix(string(encoded), wantHeader) {
		t.Fatalf("encoded output should start with canonical header.\ngot:\n%s\nwant prefix:\n%s", encoded, wantHeader)
	}

	// Re-parse must yield the same rows — RFC 4180 round-trip.
	round, err := ParseRoster(encoded)
	if err != nil {
		t.Fatalf("re-parse of encoded output failed: %v\nencoded:\n%s", err, encoded)
	}
	if !reflect.DeepEqual(round, original) {
		t.Fatalf("round-trip mismatch:\noriginal: %#v\nround:    %#v\nencoded:\n%s", original, round, encoded)
	}
}

func TestEncodeRoster_EmptyGitHubID(t *testing.T) {
	rows := []RosterRow{{Username: "alice", FirstName: "A", LastName: "A", Email: "a@x", Section: "s", GitHubID: 0, Role: "student"}}
	encoded, err := EncodeRoster(rows)
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	// GitHubID == 0 must serialize as an empty github_id column,
	// not "0". ParseRoster reads "" as 0 but treats "0" as a valid
	// numeric ID, so the encoded shape matters.
	if !strings.Contains(string(encoded), "alice,A,A,a@x,s,,student\n") {
		t.Errorf("GitHubID == 0 should encode as empty column, got:\n%s", encoded)
	}
}

func TestUpsertRosterRow_AppendAndReplace(t *testing.T) {
	rows := []RosterRow{
		{Username: "alice", GitHubID: 1},
		{Username: "bob", GitHubID: 2},
	}

	// Append new.
	rows, replaced := UpsertRosterRow(rows, RosterRow{Username: "carol", GitHubID: 3})
	if replaced {
		t.Errorf("appending carol should not report replace")
	}
	if len(rows) != 3 || rows[2].Username != "carol" {
		t.Errorf("expected carol appended at end, got %#v", rows)
	}

	// Replace existing — preserves position.
	rows, replaced = UpsertRosterRow(rows, RosterRow{Username: "alice", FirstName: "A-new", Email: "new@x", GitHubID: 1})
	if !replaced {
		t.Errorf("replacing alice should report replace")
	}
	if rows[0].Username != "alice" || rows[0].FirstName != "A-new" || rows[0].Email != "new@x" {
		t.Errorf("alice row should be in position 0 with new fields, got %#v", rows[0])
	}
}

func TestUpsertRosterRow_CaseInsensitive(t *testing.T) {
	rows := []RosterRow{{Username: "Alice", GitHubID: 1}}
	rows, replaced := UpsertRosterRow(rows, RosterRow{Username: "ALICE", FirstName: "case-test", GitHubID: 1})
	if !replaced {
		t.Fatalf("case-insensitive upsert should match Alice/ALICE as the same row")
	}
	if len(rows) != 1 {
		t.Fatalf("expected 1 row after case-insensitive replace, got %d", len(rows))
	}
}

func TestRemoveRosterRow(t *testing.T) {
	rows := []RosterRow{
		{Username: "alice", GitHubID: 1},
		{Username: "bob", GitHubID: 2},
		{Username: "carol", GitHubID: 3},
	}

	rows, removed := RemoveRosterRow(rows, "BOB") // case-insensitive
	if !removed {
		t.Errorf("expected BOB to be removed")
	}
	if len(rows) != 2 || rows[0].Username != "alice" || rows[1].Username != "carol" {
		t.Errorf("expected [alice, carol] after remove, got %#v", rows)
	}

	_, removed = RemoveRosterRow(rows, "dave")
	if removed {
		t.Errorf("removing absent username should report not removed")
	}
}

func TestUpdateRosterRow(t *testing.T) {
	base := []RosterRow{
		{Username: "alice", FirstName: "Alice", LastName: "A", Email: "a@x", Section: "s1", GitHubID: 1},
		{Username: "bob", FirstName: "Bob", LastName: "B", Email: "b@x", Section: "s1", GitHubID: 2},
	}
	// RosterRow is all value fields, so a shallow copy is independent —
	// UpdateRosterRow's in-place edits won't leak across subtests.
	clone := func() []RosterRow { return append([]RosterRow(nil), base...) }
	strptr := func(s string) *string { return &s }

	t.Run("partial patch leaves other fields and github_id intact", func(t *testing.T) {
		out, found, changed := UpdateRosterRow(clone(), "alice", RosterPatch{Email: strptr("new@x")})
		if !found || !changed {
			t.Fatalf("found=%v changed=%v, want both true", found, changed)
		}
		got := out[0]
		if got.Email != "new@x" {
			t.Errorf("email = %q, want new@x", got.Email)
		}
		if got.Username != "alice" || got.FirstName != "Alice" || got.LastName != "A" || got.Section != "s1" || got.GitHubID != 1 {
			t.Errorf("non-email fields changed: %#v", got)
		}
		if !reflect.DeepEqual(out[1], base[1]) {
			t.Errorf("unrelated row (bob) changed: %#v", out[1])
		}
	})

	t.Run("case-insensitive match", func(t *testing.T) {
		_, found, changed := UpdateRosterRow(clone(), "ALICE", RosterPatch{FirstName: strptr("Alicia")})
		if !found || !changed {
			t.Fatalf("ALICE should match alice and change first name (found=%v changed=%v)", found, changed)
		}
	})

	t.Run("unknown username is not found", func(t *testing.T) {
		_, found, changed := UpdateRosterRow(clone(), "ghost", RosterPatch{Email: strptr("x@y")})
		if found || changed {
			t.Errorf("found=%v changed=%v, want both false", found, changed)
		}
	})

	t.Run("patch equal to current values is no change", func(t *testing.T) {
		_, found, changed := UpdateRosterRow(clone(), "alice", RosterPatch{Email: strptr("a@x"), Section: strptr("s1")})
		if !found {
			t.Fatalf("alice should match")
		}
		if changed {
			t.Errorf("patch identical to current row should report changed=false")
		}
	})

	t.Run("empty string clears a field", func(t *testing.T) {
		out, found, changed := UpdateRosterRow(clone(), "alice", RosterPatch{Email: strptr("")})
		if !found || !changed {
			t.Fatalf("found=%v changed=%v, want both true", found, changed)
		}
		if out[0].Email != "" {
			t.Errorf("email = %q, want cleared", out[0].Email)
		}
	})
}

func TestValidateRosterEmail(t *testing.T) {
	cases := []struct {
		in      string
		wantErr bool
	}{
		// Email is optional per row.
		{"", false},

		// Bare local@domain shapes teachers actually use.
		{"alice@example.edu", false},
		{"alice.smith@example.com", false},
		{"alice+section1@example.com", false},
		{"12345@example.com", false},
		{"a@b.c", false},
		{"alice@school.local", false},
		{"Alice@Example.EDU", false},
		{"<alice@example.edu>", false},
		{"alice@xn--bcher-kva.example", false},
		{"alice@[192.0.2.1]", false},

		// Display-name forms reject — name metadata belongs in
		// first_name/last_name, not the email column.
		{"Alice <alice@example.edu>", true},
		{"alice <alice@example.edu>", true},
		{"Alice Andersson <alice@example.edu>", true},

		// Malformed.
		{"alice", true},
		{"alice@", true},
		{"@example.com", true},
		{"alice example.com", true},
		{"alice@@example.com", true},
		{"alice@example.com, bob@example.com", true},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			err := ValidateRosterEmail(tc.in)
			if tc.wantErr && err == nil {
				t.Fatalf("ValidateRosterEmail(%q) = nil, want error", tc.in)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("ValidateRosterEmail(%q) = %v, want nil", tc.in, err)
			}
		})
	}
}

func TestParseRoster_StripsUTF8BOM(t *testing.T) {
	// Excel's "CSV UTF-8" prepends 0xEF 0xBB 0xBF. encoding/csv
	// does not strip it, so without the trim the first header
	// field would be `\ufeffusername` — equalSlices would reject
	// the file with a misleading "unexpected header" error.
	in := append([]byte{0xEF, 0xBB, 0xBF}, []byte("username,first_name,last_name,email,section,github_id\nalice,Alice,A,,s,1\n")...)
	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster with BOM: %v", err)
	}
	if len(rows) != 1 || rows[0].Username != "alice" {
		t.Fatalf("expected one alice row, got %#v", rows)
	}
}

func TestParseImportCSV_StripsUTF8BOM(t *testing.T) {
	in := append([]byte{0xEF, 0xBB, 0xBF}, []byte("username,first_name,last_name,email,section\nalice,A,A,,s\n")...)
	rows, err := ParseImportCSV(in)
	if err != nil {
		t.Fatalf("ParseImportCSV with BOM: %v", err)
	}
	if len(rows) != 1 || rows[0].Username != "alice" {
		t.Fatalf("expected one alice row, got %#v", rows)
	}
}

func TestParseImportCSV_RejectsWidenedExportWithGuidance(t *testing.T) {
	// Feeding a wider roster CSV (canonical six + extra trailing columns)
	// straight into import is rejected with a message that names the cause and
	// the fix, rather than the generic header error — import is canonical-only
	// by design (it re-resolves github_id and carries no extra column state).
	in := []byte("username,first_name,last_name,email,section,github_id," +
		"enrollment_status,enrollment_method,email_hash,invite_token,invited_at,enrolled_at\n" +
		"alice,Alice,A,a@x.edu,s1,123,enrolled,github,abcd,,2026-01-01T00:00:00Z,\n")
	_, err := ParseImportCSV(in)
	if err == nil {
		t.Fatal("expected ParseImportCSV to reject a widened export")
	}
	if !strings.Contains(err.Error(), "extra columns") || !strings.Contains(err.Error(), "import does not") {
		t.Fatalf("expected guidance about extra columns / import, got %v", err)
	}
}

func TestParseImportCSV_RejectsOversizedField(t *testing.T) {
	// A 400-byte first_name exceeds maxFieldBytes (320) and must
	// be rejected at parse time — otherwise a 1MB+ CSV could land
	// on disk and wedge later reads through the contents API's
	// encoding:"none" response.
	bigName := strings.Repeat("x", maxFieldBytes+1)
	in := []byte("username,first_name,last_name,email,section\nalice," + bigName + ",A,,s\n")
	_, err := ParseImportCSV(in)
	if err == nil {
		t.Fatalf("expected oversized first_name to be rejected, got nil error")
	}
	if !strings.Contains(err.Error(), "first_name") || !strings.Contains(err.Error(), "exceeds maximum length") {
		t.Fatalf("error should name first_name and length, got: %v", err)
	}
}

func TestParseImportCSV_TrimsEmailWhitespace(t *testing.T) {
	// CSV preserves whitespace; net/mail.ParseAddress rejects many
	// spaced shapes, so the parser trims `email` before
	// validation. `username` is also trimmed; other columns stay
	// verbatim.
	in := []byte("username,first_name,last_name,email,section\nalice,A,A,  alice@example.edu  ,s\n")
	rows, err := ParseImportCSV(in)
	if err != nil {
		t.Fatalf("ParseImportCSV: %v", err)
	}
	if rows[0].Email != "alice@example.edu" {
		t.Errorf("email should be trimmed, got %q", rows[0].Email)
	}
}

func TestEncodeRoster_DefangsFormulaCells(t *testing.T) {
	// Cells starting with =/+/-/@/\t/\r get a leading apostrophe so
	// Excel/LibreOffice render them as literal text instead of
	// evaluating them. ParseRoster strips the apostrophe so the
	// in-memory RosterRow always sees the original value.
	original := []RosterRow{
		{Username: "alice", FirstName: "=HYPERLINK(\"http://attacker\",\"click\")", LastName: "A", Email: "alice@example.edu", Section: "+cmd", GitHubID: 1},
		{Username: "bob", FirstName: "-Director", LastName: "@admin", Email: "bob@example.edu", Section: "\tindent", GitHubID: 2},
	}
	encoded, err := EncodeRoster(original)
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	// Every dangerous-leading cell should be apostrophe-prefixed.
	str := string(encoded)
	if !strings.Contains(str, "'=HYPERLINK") {
		t.Errorf("formula-cell should be defanged, got:\n%s", str)
	}
	if !strings.Contains(str, "'+cmd") {
		t.Errorf("plus-prefix cell should be defanged, got:\n%s", str)
	}
	if !strings.Contains(str, "'-Director") {
		t.Errorf("minus-prefix cell should be defanged, got:\n%s", str)
	}
	if !strings.Contains(str, "'@admin") {
		t.Errorf("at-prefix cell should be defanged, got:\n%s", str)
	}

	// ParseRoster strips the defang on read; in-memory rows match
	// the original input.
	roundTripped, err := ParseRoster(encoded)
	if err != nil {
		t.Fatalf("re-parse defanged output: %v", err)
	}
	if !reflect.DeepEqual(roundTripped, original) {
		t.Fatalf("defang round-trip mismatch:\noriginal: %#v\nround:    %#v", original, roundTripped)
	}
}

func TestEncodeRoster_LeavesSafeCellsAlone(t *testing.T) {
	rows := []RosterRow{
		{Username: "alice", FirstName: "Alice", LastName: "Andersson", Email: "alice@example.edu", Section: "section-1", GitHubID: 1},
	}
	encoded, err := EncodeRoster(rows)
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	if strings.Contains(string(encoded), "'Alice") {
		t.Errorf("normal cells should not be defanged, got:\n%s", encoded)
	}
}

// role is recorded metadata, refreshed from team membership; an upsert that
// doesn't know the role (empty Role) must preserve the existing recorded role
// rather than blanking it — mirroring the Extra-preservation guard.
func TestUpsertRosterRow_PreservesRoleWhenIncomingEmpty(t *testing.T) {
	rows := []RosterRow{{Username: "alice", GitHubID: 1, Role: "instructor"}}
	updated, replaced := UpsertRosterRow(rows, RosterRow{Username: "alice", FirstName: "Alice", GitHubID: 1})
	if !replaced {
		t.Fatalf("expected replace")
	}
	if updated[0].Role != "instructor" {
		t.Errorf("empty incoming Role should preserve existing role, got %q", updated[0].Role)
	}
	// A non-empty incoming role overrides (a re-sync that changed the role).
	updated, _ = UpsertRosterRow(updated, RosterRow{Username: "alice", GitHubID: 1, Role: "ta"})
	if updated[0].Role != "ta" {
		t.Errorf("non-empty incoming Role should override, got %q", updated[0].Role)
	}
}

func TestDedupeByUsername_LastWins(t *testing.T) {
	rows := []RosterRow{
		{Username: "Alice", FirstName: "first-A"},
		{Username: "bob", FirstName: "B"},
		{Username: "ALICE", FirstName: "second-A"}, // case-insensitive dup
	}
	out := DedupeByUsername(rows)
	if len(out) != 2 {
		t.Fatalf("expected 2 rows after dedupe, got %d: %#v", len(out), out)
	}
	if out[0].FirstName != "second-A" {
		t.Errorf("expected last-wins (FirstName=second-A) at the Alice slot, got %q", out[0].FirstName)
	}
	if out[1].Username != "bob" {
		t.Errorf("expected bob preserved, got %#v", out[1])
	}
}

// --- legacy extra columns (e.g. a prior web schema) ------------------------

// An earlier web app appended optional extra columns to the roster. The CLI
// must still parse such a wider file (not reject it) and preserve those columns
// on a read/modify/write cycle so a CLI roster edit never wipes them.

func TestParseRoster_AcceptsAndPreservesLegacyColumns(t *testing.T) {
	in := []byte(
		"username,first_name,last_name,email,section,github_id," +
			"enrollment_status,enrollment_method,email_hash,invite_token,invited_at,enrolled_at\n" +
			"alice,Alice,A,alice@x.edu,s1,123,enrolled,github,abcd1234ef567890,,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n" +
			"bob,Bob,B,bob@x.edu,s1,,invited,email,beef0000beef0000,tok123,2026-01-03T00:00:00Z,\n",
	)
	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster (12-column): %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0].Username != "alice" || rows[0].GitHubID != 123 || rows[0].Email != "alice@x.edu" {
		t.Errorf("alice canonical fields wrong: %#v", rows[0])
	}
	if rows[0].Extra["enrollment_status"] != "enrolled" {
		t.Errorf("alice enrollment_status = %q, want enrolled", rows[0].Extra["enrollment_status"])
	}
	if rows[0].Extra["email_hash"] != "abcd1234ef567890" {
		t.Errorf("alice email_hash = %q, want abcd1234ef567890", rows[0].Extra["email_hash"])
	}
	if rows[1].Extra["invite_token"] != "tok123" {
		t.Errorf("bob invite_token = %q, want tok123", rows[1].Extra["invite_token"])
	}
	if rows[1].Extra["enrolled_at"] != "" {
		t.Errorf("bob enrolled_at = %q, want empty", rows[1].Extra["enrolled_at"])
	}
}

func TestEncodeRoster_RoundTripsLegacyColumns(t *testing.T) {
	in := []byte(
		"username,first_name,last_name,email,section,github_id," +
			"enrollment_status,enrollment_method,email_hash,invite_token,invited_at,enrolled_at\n" +
			"alice,Alice,A,alice@x.edu,s1,123,enrolled,github,abcd1234ef567890,,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n",
	)
	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	encoded, err := EncodeRoster(rows)
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	// role (now canonical) is inserted after github_id; the legacy tail follows.
	wantHeader := "username,first_name,last_name,email,section,github_id,role," +
		"enrollment_status,enrollment_method,email_hash,invite_token,invited_at,enrolled_at\n"
	if !strings.HasPrefix(string(encoded), wantHeader) {
		t.Fatalf("encoded header drifted.\ngot:\n%s\nwant prefix:\n%s", encoded, wantHeader)
	}
	round, err := ParseRoster(encoded)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if !reflect.DeepEqual(round, rows) {
		t.Fatalf("legacy-column round-trip mismatch:\norig:  %#v\nround: %#v", rows, round)
	}
}

func TestEncodeRoster_UnknownColumnsPreserveSourceOrder(t *testing.T) {
	// The CLI imposes no canonical order on a legacy tail — it preserves
	// whatever unknown columns an existing file carries, in their on-disk
	// (first-seen) order, via RosterRow.Extra/ExtraOrder. This keeps a
	// between-deploys file readable and stable without the CLI reordering
	// columns it doesn't manage.
	in := []byte(
		"username,first_name,last_name,email,section,github_id," +
			"invite_token,enrollment_status\n" +
			"alice,Alice,A,alice@x.edu,s1,123,tok,invited\n",
	)
	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	encoded, err := EncodeRoster(rows)
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	wantHeader := "username,first_name,last_name,email,section,github_id,role," +
		"invite_token,enrollment_status\n"
	if !strings.HasPrefix(string(encoded), wantHeader) {
		t.Fatalf("unknown columns not preserved in source order.\ngot:\n%s\nwant prefix:\n%s", encoded, wantHeader)
	}
}

func TestUpsertRosterRow_PreservesLegacyColumns(t *testing.T) {
	// A web-written row carries extra columns; a CLI `roster add` upsert
	// supplies only the canonical fields (Extra == nil) and must NOT wipe them.
	rows := []RosterRow{
		{
			Username: "alice", FirstName: "Alice", LastName: "A", Email: "alice@x.edu", Section: "s1", GitHubID: 123,
			Extra:      map[string]string{"enrollment_status": "enrolled", "email_hash": "abcd1234ef567890"},
			ExtraOrder: []string{"enrollment_status", "email_hash"},
		},
	}
	updated, replaced := UpsertRosterRow(rows, RosterRow{
		Username: "alice", FirstName: "Alice", LastName: "Andersson", Email: "alice@new.edu", Section: "s2", GitHubID: 123,
	})
	if !replaced {
		t.Fatalf("expected replace")
	}
	if updated[0].LastName != "Andersson" || updated[0].Email != "alice@new.edu" || updated[0].Section != "s2" {
		t.Errorf("canonical fields not updated: %#v", updated[0])
	}
	if updated[0].Extra["enrollment_status"] != "enrolled" || updated[0].Extra["email_hash"] != "abcd1234ef567890" {
		t.Errorf("legacy columns wiped on upsert: %#v", updated[0].Extra)
	}
}

func TestUpsertRosterRow_IncomingExtraWins(t *testing.T) {
	// When the incoming row DOES supply Extra, it replaces the existing Extra
	// (an explicit caller intent), rather than being silently merged.
	rows := []RosterRow{
		{Username: "alice", GitHubID: 1, Extra: map[string]string{"enrollment_status": "invited"}, ExtraOrder: []string{"enrollment_status"}},
	}
	updated, _ := UpsertRosterRow(rows, RosterRow{
		Username: "alice", GitHubID: 1,
		Extra: map[string]string{"enrollment_status": "enrolled"}, ExtraOrder: []string{"enrollment_status"},
	})
	if updated[0].Extra["enrollment_status"] != "enrolled" {
		t.Errorf("incoming Extra should win, got %#v", updated[0].Extra)
	}
}

func TestParseRoster_RejectsWrongCanonicalPrefixEvenWithExtras(t *testing.T) {
	// A renamed canonical column must still be rejected — tolerance applies
	// only to columns AFTER the canonical six.
	in := []byte("user,first_name,last_name,email,section,github_id,enrollment_status\nalice,A,A,,s,1,invited\n")
	_, err := ParseRoster(in)
	if err == nil || !strings.Contains(err.Error(), "unexpected header") {
		t.Fatalf("expected unexpected-header error for renamed canonical column, got %v", err)
	}
}

func TestParseRoster_RejectsDuplicateExtraColumn(t *testing.T) {
	// A duplicated extra column would clobber on read and silently collapse on
	// write — reject it instead of losing a column on round-trip.
	in := []byte("username,first_name,last_name,email,section,github_id,note,note\nalice,A,A,,s,1,x,y\n")
	_, err := ParseRoster(in)
	if err == nil || !strings.Contains(err.Error(), "duplicate column") {
		t.Fatalf("expected duplicate-column error, got %v", err)
	}
}

func TestParseRoster_RejectsExtraColumnReusingCanonicalName(t *testing.T) {
	// An extra column reusing a canonical name would emit a duplicate-header
	// file other tools (the web app) mis-read — reject it.
	in := []byte("username,first_name,last_name,email,section,github_id,email\nalice,A,A,a@x,s,1,dup\n")
	_, err := ParseRoster(in)
	if err == nil || !strings.Contains(err.Error(), "reserved column name") {
		t.Fatalf("expected reserved-column-name error, got %v", err)
	}
}

func TestParseRoster_RejectsFormulaTriggerExtraColumnName(t *testing.T) {
	// EncodeRoster writes column names verbatim, so a formula-trigger extra
	// header name would round-trip raw into a CLI-written file and re-introduce
	// CSV-injection in Excel. Reject it at parse time alongside the other
	// malformed-header guards.
	for _, name := range []string{"=HYPERLINK(1)", "+x", "-x", "@x", "\tx", "\rx"} {
		in := []byte("username,first_name,last_name,email,section,github_id," + name + "\nalice,A,A,a@x,s,1,v\n")
		_, err := ParseRoster(in)
		if err == nil || !strings.Contains(err.Error(), "formula trigger") {
			t.Fatalf("extra column name %q: expected formula-trigger rejection, got %v", name, err)
		}
	}
}

// TestFullRosterHeader pins the exact on-disk header the CLI writes. The Python
// collector asserts the identical string
// (test_collect_scores.py::test_full_roster_header_matches_go_constant) and
// classroom50-web's STUDENT_CSV_FIELDS must match it, so a column-order drift
// across the three codebases fails here loudly rather than churning the shared
// file. If you change RosterColumns, update the web app and the Python fixture
// in lockstep.
func TestFullRosterHeader(t *testing.T) {
	const want = "username,first_name,last_name,email,section,github_id,role"
	if FullRosterHeader != want {
		t.Fatalf("FullRosterHeader = %q, want %q", FullRosterHeader, want)
	}
	// EncodeRoster of a canonical row must emit exactly this header line,
	// proving the constant matches real encoder output.
	row := RosterRow{Username: "alice", GitHubID: 1}
	encoded, err := EncodeRoster([]RosterRow{row})
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	gotHeader, _, _ := strings.Cut(string(encoded), "\n")
	if gotHeader != want {
		t.Fatalf("EncodeRoster header = %q, want %q", gotHeader, want)
	}
}
