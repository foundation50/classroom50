package configrepo

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseRoster_Canonical(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
		"alice,Alice,Andersson,alice@example.edu,section-1,12345,teacher\n" +
		"bob,Bob,Baker,,,67890,ta\n" +
		"carol,,,carol@example.edu,section-2,11111,student\n")

	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	want := []RosterRow{
		{Username: "alice", FirstName: "Alice", LastName: "Andersson", Email: "alice@example.edu", Section: "section-1", GitHubID: 12345, Role: "teacher"},
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

func TestParseRoster_GitHubIDShapeMatchesWeb(t *testing.T) {
	// Both readers trim, so a WHITESPACE-padded cell is valid on both sides.
	// Pinned because ParseInt alone would reject it. Zero padding is the one
	// deliberate divergence (see parseGitHubID).
	in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
		"alice,A,A,,s, 42 ,student\n" +
		"bob,B,B,,s,9007199254740991,student\n")
	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0].GitHubID != 42 {
		t.Errorf("padded github_id = %d, want 42", rows[0].GitHubID)
	}
	if rows[1].GitHubID != maxSafeGitHubID {
		t.Errorf("largest safe github_id = %d, want %d", rows[1].GitHubID, int64(maxSafeGitHubID))
	}
}

// A zero-padded cell addresses the same account unambiguously, so Go resolves it
// and rewrites it canonically — repairing a cell the web's join deliberately
// rejects (it compares the raw string) so the two readers converge.
func TestParseRoster_ZeroPaddedGitHubIDNormalizes(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
		"alice,A,A,,s,0000583231,student\n")
	rows, err := ParseRoster(in)
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	encoded, err := EncodeRoster(rows)
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	if !strings.Contains(string(encoded), ",583231,") {
		t.Errorf("want a canonical ,583231, on rewrite, got:\n%s", encoded)
	}
}

// A cell the web reader won't use as an id must not fail the roster: it reads as
// unresolved (GitHubID 0) so the CLI re-resolves it, and the original value is
// preserved on rewrite rather than silently cleared. "0" in particular is what
// this type has always used to MEAN unresolved, so older rosters carry it, and
// "+42" is a spelling the web's regex rejects — resolving it here would make the
// same row identity to one tool and a claimable pending invite to the other.
func TestParseRoster_UnusableGitHubIDIsUnresolvedNotFatal(t *testing.T) {
	for _, cell := range []string{"0", "-5", "+42", "9007199254740993", " "} {
		t.Run(cell, func(t *testing.T) {
			in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
				"alice,A,A,,s," + cell + ",student\n")
			rows, err := ParseRoster(in)
			if err != nil {
				t.Fatalf("ParseRoster(%q) = error %v, want a tolerated row", cell, err)
			}
			if len(rows) != 1 {
				t.Fatalf("got %d rows, want 1", len(rows))
			}
			if rows[0].GitHubID != 0 {
				t.Errorf("GitHubID = %d, want 0 (unresolved)", rows[0].GitHubID)
			}
			if rows[0].Username != "alice" {
				t.Errorf("Username = %q, want alice (the row must stay addressable)", rows[0].Username)
			}
			encoded, err := EncodeRoster(rows)
			if err != nil {
				t.Fatalf("EncodeRoster: %v", err)
			}
			// A whitespace-only cell carries no value worth keeping; anything else
			// must survive the rewrite.
			want := cell
			if strings.TrimSpace(cell) == "" {
				want = ""
			}
			round, err := ParseRoster(encoded)
			if err != nil {
				t.Fatalf("re-parse: %v", err)
			}
			if got := round[0].githubIDRaw; got != want {
				t.Errorf("github_id after rewrite = %q, want %q (encoded: %s)", got, want, encoded)
			}
		})
	}
}

// A teacher who invites by email gets a pending roster row carrying only that
// address: the web writes it at invite time and fills in the account identity
// when the student accepts (web/src/domain/students/rosterSync.ts). The strict
// reader must keep it, or `roster list` fails for the whole classroom while any
// invite is outstanding. The keep-rule mirrors the web's parseRosterCsv filter:
// a row needs at least one of username, github_id, or email.
// A student invited by email has a pending roster row carrying only that
// address. When the teacher later adds them by username with the same email,
// that pending row must be claimed rather than left beside a second row for the
// same person — mirroring the web reconcile's email-match fold.
func TestUpsertRosterRow_ClaimsPendingEmailRow(t *testing.T) {
	rows := []RosterRow{
		{Username: "alice", Email: "alice@x.edu", GitHubID: 1},
		{Email: "pending@x.edu", Role: "student"},
	}
	incoming := RosterRow{Username: "bob", Email: "Pending@X.edu", GitHubID: 2}

	updated, replaced := UpsertRosterRow(rows, incoming)
	if !replaced {
		t.Fatal("replaced = false, want true (the pending row was claimed)")
	}
	if len(updated) != 2 {
		t.Fatalf("rows = %d, want 2 (claimed in place, not appended)", len(updated))
	}
	claimed := updated[1]
	if claimed.Username != "bob" || claimed.GitHubID != 2 {
		t.Fatalf("identity = %q/%d, want bob/2", claimed.Username, claimed.GitHubID)
	}
	// The pending row's Role is NOT inherited: an email invite may have been
	// sent for staff, and carrying that onto whoever the teacher names here
	// would silently grant it. The team is the role authority.
	if claimed.Role != "" {
		t.Fatalf("Role = %q, want \"\" (not inherited across an email claim)", claimed.Role)
	}
}

// A staff email invite's row must not hand its role to the student a teacher
// later adds under that address.
func TestUpsertRosterRow_EmailClaimDoesNotGrantStaffRole(t *testing.T) {
	rows := []RosterRow{{Email: "ta@x.edu", Role: "ta"}}
	incoming := RosterRow{Username: "student1", Email: "ta@x.edu", GitHubID: 9}

	updated, replaced := UpsertRosterRow(rows, incoming)
	if !replaced || len(updated) != 1 {
		t.Fatalf("replaced=%v rows=%d, want true/1", replaced, len(updated))
	}
	if updated[0].Role == "ta" {
		t.Error("the claim granted the pending row's staff role to the added student")
	}
}

// A username match still carries the recorded role over, so re-adding an
// enrolled student doesn't blank the role a sync recorded for them.
func TestUpsertRosterRow_UsernameMatchStillInheritsRole(t *testing.T) {
	rows := []RosterRow{{Username: "alice", GitHubID: 1, Role: "ta"}}
	incoming := RosterRow{Username: "alice", GitHubID: 1}

	updated, _ := UpsertRosterRow(rows, incoming)
	if updated[0].Role != "ta" {
		t.Fatalf("Role = %q, want ta preserved on a username match", updated[0].Role)
	}
}

// A github_id cell that addresses no account is not identity (the web's
// resolveGitHubId rejects it too), so an email claim adopts the row — and
// repairs the cell — instead of leaving a second row for the same person.
func TestUpsertRosterRow_EmailClaimAdoptsAnUnusableIDCell(t *testing.T) {
	in := "username,first_name,last_name,email,section,github_id,role\n" +
		",,,pending@x.edu,,0,student\n"
	rows, err := ParseRoster([]byte(in))
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	if rows[0].githubIDRaw == "" {
		t.Fatal("fixture precondition: expected the raw github_id cell to be preserved")
	}

	updated, replaced := UpsertRosterRow(rows, RosterRow{
		Username: "bob", Email: "pending@x.edu", GitHubID: 2,
	})
	if !replaced {
		t.Fatal("replaced = false: a cell addressing no account must not block the claim")
	}
	if len(updated) != 1 || updated[0].Username != "bob" || updated[0].GitHubID != 2 {
		t.Fatalf("rows = %#v, want the pending row claimed in place", updated)
	}
}

// The email fallback must never touch a row that already identifies someone:
// two students can share a contact email (a shared family address), so an
// email match on an enrolled row would rewrite the wrong person's identity.
func TestUpsertRosterRow_EmailMatchNeverClaimsAnIdentifiedRow(t *testing.T) {
	rows := []RosterRow{{Username: "alice", Email: "shared@x.edu", GitHubID: 1}}
	incoming := RosterRow{Username: "bob", Email: "shared@x.edu", GitHubID: 2}

	updated, replaced := UpsertRosterRow(rows, incoming)
	if replaced {
		t.Fatal("replaced = true, want false: an identified row must not be claimed by email")
	}
	if len(updated) != 2 {
		t.Fatalf("rows = %d, want 2 (bob appended as his own row)", len(updated))
	}
	if updated[0].Username != "alice" || updated[0].GitHubID != 1 {
		t.Fatalf("alice's row was modified: %+v", updated[0])
	}
}

// A username match wins over an email match, so re-adding an enrolled student
// updates their own row even when an unrelated pending row shares the email.
func TestUpsertRosterRow_UsernameMatchWinsOverEmail(t *testing.T) {
	rows := []RosterRow{
		{Email: "dup@x.edu", Role: "student"},
		{Username: "alice", GitHubID: 1},
	}
	incoming := RosterRow{Username: "ALICE", Email: "dup@x.edu", GitHubID: 1}

	updated, replaced := UpsertRosterRow(rows, incoming)
	if !replaced || len(updated) != 2 {
		t.Fatalf("replaced=%v rows=%d, want true/2", replaced, len(updated))
	}
	if updated[0].Username != "" {
		t.Fatalf("the pending row was claimed instead of alice's own row: %+v", updated[0])
	}
	if updated[1].Username != "ALICE" {
		t.Fatalf("alice's row = %+v, want the incoming row", updated[1])
	}
}

// An incoming row with no email must not claim an identity-less row by matching
// "" == "" — that would hijack an unrelated pending invite.
func TestUpsertRosterRow_EmptyEmailClaimsNothing(t *testing.T) {
	rows := []RosterRow{{Email: "pending@x.edu", Role: "student"}}
	incoming := RosterRow{Username: "bob", GitHubID: 2}

	updated, replaced := UpsertRosterRow(rows, incoming)
	if replaced {
		t.Fatal("replaced = true, want false: a blank email matches nothing")
	}
	if len(updated) != 2 || updated[0].Email != "pending@x.edu" {
		t.Fatalf("pending row disturbed: %+v", updated)
	}
}

// sharedRosterRowCasesPath locates the cross-language golden fixture for the
// roster-row keep-rule, also consumed by the TS reader's parity test
// (web/src/util/rosterCsv.test.ts).
const sharedRosterRowCasesPath = "../../../shared/testdata/roster_row_cases.json"

// TestParseRoster_SharedKeepRuleParity pins the Go strict reader to the shared
// keep-rule cases so it can't drift from the web reader. This is load-bearing:
// the web WRITES an email-only pending row when a teacher invites by email, and
// a Go side that rejected it would abort `roster list` for the whole classroom
// until the student accepted (the regression this fixture exists to prevent).
func TestParseRoster_SharedKeepRuleParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(sharedRosterRowCasesPath))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var doc struct {
		Columns []string `json:"columns"`
		Cases   []struct {
			Why    string   `json:"why"`
			Record []string `json:"record"`
			Keep   bool     `json:"keep"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal shared fixture: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("shared fixture has no cases")
	}
	// The fixture's column list must be the canonical header, or its records
	// aren't addressing the columns this reader parses.
	if strings.Join(doc.Columns, ",") != strings.Join(RosterColumns, ",") {
		t.Fatalf("fixture columns = %v, want %v", doc.Columns, RosterColumns)
	}

	for _, tc := range doc.Cases {
		t.Run(tc.Why, func(t *testing.T) {
			in := FullRosterHeader + "\n" + strings.Join(quoteCSVCells(tc.Record), ",") + "\n"
			rows, err := ParseRoster([]byte(in))
			if tc.Keep {
				if err != nil {
					t.Fatalf("ParseRoster rejected a row the keep-rule keeps: %v\ninput: %q", err, in)
				}
				if len(rows) != 1 {
					t.Fatalf("rows = %d, want 1", len(rows))
				}
				return
			}
			if err == nil {
				t.Fatalf("ParseRoster kept a row the keep-rule rejects: %q", in)
			}
		})
	}
}

// quoteCSVCells wraps each fixture cell in double quotes so whitespace-only
// cells reach the parser intact and a cell containing a comma can't split the
// record.
func quoteCSVCells(cells []string) []string {
	out := make([]string, len(cells))
	for i, c := range cells {
		out[i] = `"` + strings.ReplaceAll(c, `"`, `""`) + `"`
	}
	return out
}

func TestParseRoster_KeepsEmailOnlyPendingRow(t *testing.T) {
	in := "username,first_name,last_name,email,section,github_id,role\n" +
		"alice,Alice,A,alice@x.edu,s,1,student\n" +
		",,,pending@x.edu,,,student\n"
	rows, err := ParseRoster([]byte(in))
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	pending := rows[1]
	if pending.isRaw() {
		t.Fatal("email-only row must parse, not fall back to a preserved raw row")
	}
	if pending.Username != "" || pending.GitHubID != 0 {
		t.Fatalf("identity = %q/%d, want empty", pending.Username, pending.GitHubID)
	}
	if pending.Email != "pending@x.edu" {
		t.Fatalf("Email = %q, want pending@x.edu", pending.Email)
	}
	if pending.Role != "student" {
		t.Fatalf("Role = %q, want student", pending.Role)
	}
}

// A row carrying only a github_id is equally valid under the keep-rule (the web
// accepts it too), so a username-less id row must not be rejected either.
func TestParseRoster_KeepsIDOnlyRow(t *testing.T) {
	in := "username,first_name,last_name,email,section,github_id,role\n" +
		",,,,,4242,student\n"
	rows, err := ParseRoster([]byte(in))
	if err != nil {
		t.Fatalf("ParseRoster: %v", err)
	}
	if len(rows) != 1 || rows[0].GitHubID != 4242 {
		t.Fatalf("rows = %+v, want one row with GitHubID 4242", rows)
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
		{"no identity columns", "username,first_name,last_name,email,section,github_id,role\n,A,A,,s,,student\n", "no username, github_id, or email"},
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

	t.Run("6-column header surfaces github_id for cross-check", func(t *testing.T) {
		in := []byte("username,first_name,last_name,email,section,github_id\nalice,Alice,A,a@x,s,99999\n")
		rows, err := ParseImportCSV(in)
		if err != nil {
			t.Fatalf("ParseImportCSV: %v", err)
		}
		if len(rows) != 1 {
			t.Fatalf("got %d rows, want 1", len(rows))
		}
		// The parsed row carries the github_id cell so the import command can
		// cross-check it against the account it resolves for the username.
		if rows[0].GitHubID != 99999 {
			t.Errorf("import should surface github_id to the caller, got %d", rows[0].GitHubID)
		}
		if rows[0].Email != "a@x" {
			t.Errorf("expected email to round-trip, got %q", rows[0].Email)
		}
	})

	t.Run("7-column stored roster with a pending email-only row", func(t *testing.T) {
		in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
			"alice,Alice,A,alice@x.edu,s-1,12345,student\n" +
			",,,pending@x.edu,,,student\n")
		rows, err := ParseImportCSV(in)
		if err != nil {
			t.Fatalf("ParseImportCSV: %v", err)
		}
		if len(rows) != 2 {
			t.Fatalf("got %d rows, want 2", len(rows))
		}
		if rows[0].GitHubID != 12345 || rows[0].Role != "student" {
			t.Errorf("account row should carry github_id and role, got id=%d role=%q", rows[0].GitHubID, rows[0].Role)
		}
		pending := rows[1]
		if pending.Username != "" || pending.GitHubID != 0 {
			t.Errorf("pending row identity = %q/%d, want empty", pending.Username, pending.GitHubID)
		}
		if pending.Email != "pending@x.edu" || pending.Role != "student" {
			t.Errorf("pending row = email %q role %q, want pending@x.edu/student", pending.Email, pending.Role)
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
		{"no identity columns", "username,first_name,last_name,email,section\n,A,A,,s\n", "no username, github_id, or email"},
		{"no identity columns 7-wide", "username,first_name,last_name,email,section,github_id,role\n,A,A,,s,,student\n", "no username, github_id, or email"},
		{"non-numeric github_id", "username,first_name,last_name,email,section,github_id\nalice,A,A,,s,nope\n", "invalid github_id"},
		{"invalid email on pending row", "username,first_name,last_name,email,section,github_id,role\n,,,not-an-email,,,\n", "invalid email"},
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

// Import reports every bad line in one parse, so a teacher fixes the whole
// file at once instead of replaying import per error.
func TestParseImportCSV_ReportsAllRowErrors(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section\n" +
		"alice,A,A,bad email,s\n" +
		"bob,B,B,ok@x.edu,s\n" +
		",C,C,,s\n")
	_, err := ParseImportCSV(in)
	if err == nil {
		t.Fatal("expected an error for two bad rows, got nil")
	}
	msg := err.Error()
	if !strings.Contains(msg, "line 2:") || !strings.Contains(msg, "invalid email") {
		t.Errorf("error should report line 2's bad email, got: %v", err)
	}
	if !strings.Contains(msg, "line 4:") || !strings.Contains(msg, "no username, github_id, or email") {
		t.Errorf("error should report line 4's missing identity, got: %v", err)
	}
}

func TestEncodeRoster_RoundTrip(t *testing.T) {
	original := []RosterRow{
		{Username: "alice", FirstName: "Alice", LastName: "Andersson", Email: "alice@example.edu", Section: "section-1", GitHubID: 12345, Role: "teacher"},
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

// UpdatePendingEmailRow is import's only write to a pending invite row: it
// corrects metadata by address, and must never create a row (import doesn't
// send invitations) nor disturb the address/role the invitation recorded.
func TestUpdatePendingEmailRow(t *testing.T) {
	s := func(v string) *string { return &v }

	t.Run("patches name and section, matched case-insensitively", func(t *testing.T) {
		rows := []RosterRow{
			{Username: "alice", Email: "a@x.edu", GitHubID: 1, Role: "student"},
			{Email: "Pending@X.edu", Role: "teacher"},
		}
		updated, found := UpdatePendingEmailRow(rows, "  pending@x.edu ", RosterPatch{
			FirstName: s("Bob"), LastName: s("B"), Section: s("s2"),
		})
		if !found {
			t.Fatal("found = false, want the pending row matched on a normalized address")
		}
		got := updated[1]
		if got.FirstName != "Bob" || got.LastName != "B" || got.Section != "s2" {
			t.Errorf("metadata not applied: %+v", got)
		}
		if got.Email != "Pending@X.edu" || got.Role != "teacher" {
			t.Errorf("the invitation's own address/role must not change: %+v", got)
		}
		if updated[0].FirstName != "" || updated[0].Username != "alice" {
			t.Errorf("the account row was touched: %+v", updated[0])
		}
	})

	t.Run("never creates a row when no pending row matches", func(t *testing.T) {
		rows := []RosterRow{{Username: "alice", Email: "a@x.edu", GitHubID: 1}}
		updated, found := UpdatePendingEmailRow(rows, "nobody@x.edu", RosterPatch{FirstName: s("N")})
		if found {
			t.Fatal("found = true, want false")
		}
		if len(updated) != 1 {
			t.Fatalf("rows = %d, want 1 (no row appended)", len(updated))
		}
	})

	t.Run("skips rows that already identify someone", func(t *testing.T) {
		// Same narrow claim rule as UpsertRosterRow's email fallback: a shared
		// contact address must not let a metadata patch rewrite an enrolled row.
		rows := []RosterRow{
			{Username: "alice", Email: "shared@x.edu", GitHubID: 1},
			{Email: "shared@x.edu", GitHubID: 7},
		}

		updated, found := UpdatePendingEmailRow(rows, "shared@x.edu", RosterPatch{FirstName: s("Nope")})
		if found {
			t.Fatal("found = true, want false: a row naming an account is not claimable")
		}
		for _, r := range updated {
			if r.FirstName == "Nope" {
				t.Fatalf("a protected row was patched: %+v", r)
			}
		}
	})

	t.Run("an empty address matches nothing", func(t *testing.T) {
		rows := []RosterRow{{FirstName: "Ghost"}}
		if _, found := UpdatePendingEmailRow(rows, "  ", RosterPatch{FirstName: s("X")}); found {
			t.Fatal("found = true, want false for a blank address")
		}
	})
}

// RemovePendingEmailRow drops the row a cancelled invitation left behind. The
// claim rule is the load-bearing part: anything that identifies an account must
// survive, so a cancel can never drop an enrolled student.
func TestRemovePendingEmailRow(t *testing.T) {
	t.Run("removes the pending row, matched on a normalized address", func(t *testing.T) {
		rows := []RosterRow{
			{Username: "alice", Email: "a@x.edu", GitHubID: 1},
			{Email: "Pending@X.edu", Role: "student"},
			{Email: "other@x.edu", Role: "student"},
		}
		updated, removed := RemovePendingEmailRow(rows, "  pending@x.edu ")
		if !removed {
			t.Fatal("removed = false, want the pending row dropped")
		}
		if len(updated) != 2 {
			t.Fatalf("rows = %d, want 2: %+v", len(updated), updated)
		}
		if updated[0].Username != "alice" || updated[1].Email != "other@x.edu" {
			t.Errorf("the wrong row was dropped: %+v", updated)
		}
	})

	t.Run("never drops a row that identifies someone", func(t *testing.T) {
		// Two students may share a contact address — same narrow claim rule as
		// UpsertRosterRow's email fallback.
		rows := []RosterRow{
			{Username: "alice", Email: "shared@x.edu", GitHubID: 1},
			{Email: "shared@x.edu", GitHubID: 7},
		}

		updated, removed := RemovePendingEmailRow(rows, "shared@x.edu")
		if removed {
			t.Fatal("removed = true, want false: a row naming an account is not claimable")
		}
		if len(updated) != 2 {
			t.Fatalf("rows = %d, want 2 (nothing dropped)", len(updated))
		}
	})

	t.Run("an empty address matches nothing", func(t *testing.T) {
		rows := []RosterRow{{Email: ""}}
		if _, removed := RemovePendingEmailRow(rows, "  "); removed {
			t.Fatal("removed = true, want false for a blank address")
		}
	})
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

// The accepted/rejected forms are the roster email contract. Every case also
// asserts what the value CANONICALIZES to, since that parsed form — not the raw
// input — is what a later invite, roster join, or invite-team hash uses.
func TestCanonicalRosterEmailForms(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		// Email is optional per row.
		{in: "", want: ""},

		// Bare local@domain shapes teachers actually use.
		{in: "alice@example.edu", want: "alice@example.edu"},
		{in: "alice.smith@example.com", want: "alice.smith@example.com"},
		{in: "alice+section1@example.com", want: "alice+section1@example.com"},
		{in: "12345@example.com", want: "12345@example.com"},
		{in: "a@b.c", want: "a@b.c"},
		{in: "alice@school.local", want: "alice@school.local"},
		{in: "Alice@Example.EDU", want: "alice@example.edu"},
		{in: "alice@xn--bcher-kva.example", want: "alice@xn--bcher-kva.example"},
		{in: "alice@[192.0.2.1]", want: "alice@[192.0.2.1]"},

		// Accepted, but the angle brackets are stripped — sending the raw form
		// to GitHub is the bug this function exists to prevent.
		{in: "<alice@example.edu>", want: "alice@example.edu"},
		{in: "  <Alice@Example.EDU>  ", want: "alice@example.edu"},

		// Display-name forms reject — name metadata belongs in
		// first_name/last_name, not the email column.
		{in: "Alice <alice@example.edu>", wantErr: true},
		{in: "alice <alice@example.edu>", wantErr: true},
		{in: "Alice Andersson <alice@example.edu>", wantErr: true},

		// Malformed.
		{in: "alice", wantErr: true},
		{in: "alice@", wantErr: true},
		{in: "@example.com", wantErr: true},
		{in: "alice example.com", wantErr: true},
		{in: "alice@@example.com", wantErr: true},
		{in: "alice@example.com, bob@example.com", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := CanonicalRosterEmail(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("CanonicalRosterEmail(%q) = %q, want an error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("CanonicalRosterEmail(%q) = %v, want nil", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("CanonicalRosterEmail(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseRoster_StripsUTF8BOM(t *testing.T) {
	// Excel's "CSV UTF-8" prepends 0xEF 0xBB 0xBF. encoding/csv
	// does not strip it, so without the trim the first header
	// field would be `\ufeffusername` — slices.Equal would reject
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

func TestNormalizeTeacherText(t *testing.T) {
	// "Bjørn Ægir" in Windows-1252 single bytes (ø=0xF8, Æ=0xC6) — what Excel's
	// plain "CSV" export produces on a Western-locale Windows box (issue #742).
	win1252Name := []byte{0x42, 0x6A, 0xF8, 0x72, 0x6E, 0x20, 0xC6, 0x67, 0x69, 0x72}

	cases := []struct {
		name           string
		in             []byte
		want           string
		wantTranscoded bool
	}{
		{"ascii passthrough", []byte("username\nalice\n"), "username\nalice\n", false},
		{"utf-8 passthrough", []byte("first_name\nBjørn Ægir\n"), "first_name\nBjørn Ægir\n", false},
		{"utf-8 BOM stripped", append([]byte{0xEF, 0xBB, 0xBF}, "username\nalice\n"...), "username\nalice\n", false},
		{"windows-1252 transcoded", append([]byte("first_name\n"), append(win1252Name, '\n')...), "first_name\nBjørn Ægir\n", true},
		{"empty", nil, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, transcoded := NormalizeTeacherText(tc.in)
			if string(out) != tc.want {
				t.Fatalf("NormalizeTeacherText = %q, want %q", out, tc.want)
			}
			if transcoded != tc.wantTranscoded {
				t.Fatalf("transcoded = %v, want %v", transcoded, tc.wantTranscoded)
			}
		})
	}
}

func TestParseImportCSV_Windows1252ViaNormalize(t *testing.T) {
	// The readTeacherFile path: a Windows-1252 import normalizes to UTF-8
	// before parsing, so the name survives instead of landing invalid bytes
	// in roster.csv (which the web then renders as U+FFFD).
	in := append([]byte("username,first_name,last_name,email,section\nalice,"),
		0x42, 0x6A, 0xF8, 0x72, 0x6E) // "Bjørn" in Windows-1252
	in = append(in, []byte(",A,,s\n")...)
	normalized, transcoded := NormalizeTeacherText(in)
	if !transcoded {
		t.Fatal("expected the Windows-1252 fallback to run")
	}
	rows, err := ParseImportCSV(normalized)
	if err != nil {
		t.Fatalf("ParseImportCSV after normalize: %v", err)
	}
	if len(rows) != 1 || rows[0].FirstName != "Bjørn" {
		t.Fatalf("expected first_name Bjørn, got %#v", rows)
	}
}

func TestParseImportCSV_RejectsWidenedExportWithGuidance(t *testing.T) {
	// A roster CSV widened past the canonical role column (legacy web exports
	// carried enrollment bookkeeping columns) is still rejected: import
	// carries no extra-column state, so the tail would be silently dropped.
	// The error must name the accepted header forms.
	in := []byte("username,first_name,last_name,email,section,github_id,role," +
		"enrollment_status,enrollment_method,email_hash,invite_token,invited_at,enrolled_at\n" +
		"alice,Alice,A,a@x.edu,s1,123,student,enrolled,github,abcd,,2026-01-01T00:00:00Z,\n")
	_, err := ParseImportCSV(in)
	if err == nil {
		t.Fatal("expected ParseImportCSV to reject a widened export")
	}
	msg := err.Error()
	if !strings.Contains(msg, "unexpected header") {
		t.Fatalf("expected a header error, got %v", err)
	}
	// The accepted forms are named so the teacher knows which shapes work.
	if !strings.Contains(msg, "role") || !strings.Contains(msg, "github_id") || !strings.Contains(msg, "section") {
		t.Fatalf("error should name the accepted header forms, got %v", err)
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
	rows := []RosterRow{{Username: "alice", GitHubID: 1, Role: "teacher"}}
	updated, replaced := UpsertRosterRow(rows, RosterRow{Username: "alice", FirstName: "Alice", GitHubID: 1})
	if !replaced {
		t.Fatalf("expected replace")
	}
	if updated[0].Role != "teacher" {
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

// --- legacy extra columns (e.g., a prior web schema) ------------------------

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

// TestEncodeRoster_DefangsEveryColumnButGitHubID is the Go leg of the
// formula-guard lockstep (the web leg lives in web/src/util/rosterCsv.test.ts).
// The guarded set and the trigger set are hand-mirrored across the two writers,
// so a one-sided change must fail here rather than leave both suites green while
// a guarded cell stops being un-defanged by the other reader.
func TestEncodeRoster_DefangsEveryColumnButGitHubID(t *testing.T) {
	row := RosterRow{
		Username: "=u", FirstName: "=f", LastName: "=l",
		Email: "=e@x.io", Section: "=s", GitHubID: 583231, Role: "=student",
	}
	encoded, err := EncodeRoster([]RosterRow{row})
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	_, data, _ := strings.Cut(string(encoded), "\n")
	for _, want := range []string{"'=u", "'=f", "'=l", "'=e@x.io", "'=s", "'=student"} {
		if !strings.Contains(data, want) {
			t.Errorf("want defanged %q in:\n%s", want, data)
		}
	}
	if !strings.Contains(data, ",583231,") {
		t.Errorf("github_id must round-trip byte-exact, got:\n%s", data)
	}

	for _, trigger := range []byte{'=', '+', '-', '@', '\t', '\r'} {
		if !isFormulaTrigger(trigger) {
			t.Errorf("isFormulaTrigger(%q) = false, want true", trigger)
		}
	}
	if isFormulaTrigger('\'') || isFormulaTrigger('a') {
		t.Error("isFormulaTrigger must not match a non-trigger byte")
	}
}

// TestParseRosterLenient_PreservesMalformedRow is the parser-level guard for
// issue #207: the read-modify-write path must not abort on a pre-existing
// malformed row (here an empty username on line 2). ParseRosterLenient keeps the
// bad row verbatim while parsing the good rows normally, so a write command can
// round-trip it.
func TestParseRosterLenient_PreservesMalformedRow(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
		",Ghost,G,,,,\n" + // no identity column at all: strict ParseRoster rejects this
		"alice,Alice,A,alice@example.edu,s1,12345,student\n")

	// Strict parse still rejects, proving lenient is the behavior change. Note
	// the row is rejected for having NO identity column (no username, no
	// github_id, no email) — an email-only row is valid and parses (see
	// TestParseRoster_KeepsEmailOnlyPendingRow).
	if _, err := ParseRoster(in); err == nil {
		t.Fatal("strict ParseRoster must still reject a row with no identity column")
	}

	rows, err := ParseRosterLenient(in)
	if err != nil {
		t.Fatalf("ParseRosterLenient: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows (1 preserved raw + alice), got %d: %#v", len(rows), rows)
	}
	if !rows[0].isRaw() {
		t.Errorf("row 0 should be preserved raw, got %#v", rows[0])
	}
	if rows[1].isRaw() || rows[1].Username != "alice" || rows[1].GitHubID != 12345 {
		t.Errorf("row 1 should be the parsed alice, got %#v", rows[1])
	}
}

// TestParseRosterLenient_RoundTripsMalformedRow proves the preserved row
// survives a lenient parse -> EncodeRoster -> lenient parse cycle unchanged, so
// a write command never drops or corrupts a student it didn't touch.
func TestParseRosterLenient_RoundTripsMalformedRow(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
		",Ghost,G,,,,\n" +
		"alice,Alice,A,alice@example.edu,s1,12345,student\n")

	rows, err := ParseRosterLenient(in)
	if err != nil {
		t.Fatalf("ParseRosterLenient: %v", err)
	}
	encoded, err := EncodeRoster(rows)
	if err != nil {
		t.Fatalf("EncodeRoster: %v", err)
	}
	if !bytes.Equal(encoded, in) {
		t.Fatalf("round-trip changed the file.\ngot:\n%s\nwant:\n%s", encoded, in)
	}

	// A subsequent lenient parse yields the same shape (raw row still raw).
	rows2, err := ParseRosterLenient(encoded)
	if err != nil {
		t.Fatalf("ParseRosterLenient (re-read): %v", err)
	}
	if len(rows2) != 2 || !rows2[0].isRaw() || rows2[1].Username != "alice" {
		t.Fatalf("re-read shape changed: %#v", rows2)
	}
}

// TestParseRosterLenient_PreservesWrongFieldCount: a short/long row is also
// preserved verbatim (strict mode rejects it as a field-count error).
func TestParseRosterLenient_PreservesWrongFieldCount(t *testing.T) {
	in := []byte("username,first_name,last_name,email,section,github_id,role\n" +
		"alice,A,A\n" + // too few fields
		"bob,Bob,B,bob@example.edu,s1,2,student\n")

	if _, err := ParseRoster(in); err == nil {
		t.Fatal("strict ParseRoster must still reject a wrong-field-count row")
	}

	rows, err := ParseRosterLenient(in)
	if err != nil {
		t.Fatalf("ParseRosterLenient: %v", err)
	}
	if len(rows) != 2 || !rows[0].isRaw() || rows[1].Username != "bob" {
		t.Fatalf("want a preserved raw row + bob, got %#v", rows)
	}
}

// TestClaimPendingEmailRow: the acceptance fold is borrow-only — it contributes
// identity and touches nothing a teacher owns.
func TestClaimPendingEmailRow(t *testing.T) {
	pending := func() []RosterRow {
		return []RosterRow{
			{FirstName: "Ada", LastName: "Lovelace", Email: "Ada@Uni.edu", Section: "s1", Role: "student",
				Extra: map[string]string{"cohort": "a"}, ExtraOrder: []string{"cohort"}},
			{Username: "bob", Email: "bob@uni.edu", GitHubID: 2},
		}
	}

	t.Run("fills identity and keeps every other cell", func(t *testing.T) {
		rows, ok := ClaimPendingEmailRow(pending(), "ada@uni.edu", "ada", 101)
		if !ok {
			t.Fatal("claimed = false, want the pending row matched case-insensitively")
		}
		got := rows[0]
		if got.Username != "ada" || got.GitHubID != 101 {
			t.Errorf("identity not folded: %#v", got)
		}
		if got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Section != "s1" ||
			got.Email != "Ada@Uni.edu" || got.Role != "student" || got.Extra["cohort"] != "a" {
			t.Errorf("fold overwrote a teacher-owned cell: %#v", got)
		}
	})

	t.Run("never rewrites a row that already identifies someone", func(t *testing.T) {
		rows, ok := ClaimPendingEmailRow(pending(), "bob@uni.edu", "impostor", 999)
		if ok {
			t.Fatal("claimed a row that already has a username")
		}
		if rows[1].Username != "bob" || rows[1].GitHubID != 2 {
			t.Errorf("row mutated anyway: %#v", rows[1])
		}
	})

	t.Run("supersedes a github_id cell that addresses no account", func(t *testing.T) {
		rows, ok := ClaimPendingEmailRow([]RosterRow{{Email: "ada@uni.edu", githubIDRaw: "0"}},
			"ada@uni.edu", "ada", 101)
		if !ok {
			t.Fatal("claimed = false; a cell addressing no account is not identity")
		}
		if rows[0].GitHubID != 101 || rows[0].githubIDRaw != "" {
			t.Errorf("recovered id did not replace the unusable cell: %#v", rows[0])
		}
	})
}

// The claimable-row rule is the web's removeEmailInviteRows filter
// (rosterPrimitives.ts): no username, and no github_id cell that RESOLVES to an
// account. A cell the web's resolveGitHubId rejects (0, negative, past 2^53) is
// not identity there, so treating it as identity here would strand the row —
// unfoldable, unreapable, and re-reported by every reconcile.
func TestIsPendingEmailInvite_MatchesTheWebResolveRule(t *testing.T) {
	for _, cell := range []string{"0", "-1", "9007199254740992", "0000101"} {
		csv := FullRosterHeader + "\n,Ada,Lovelace,ada@uni.edu,s1," + cell + ",student\n"
		rows, err := ParseRoster([]byte(csv))
		if err != nil {
			t.Fatalf("github_id %q: ParseRoster: %v", cell, err)
		}
		// A zero-padded id resolves for Go (EncodeRoster rewrites it
		// canonically), so it is genuine identity — the one spelling difference.
		want := cell != "0000101"
		if got := rows[0].IsPendingEmailInvite(); got != want {
			t.Errorf("github_id %q: IsPendingEmailInvite = %v, want %v", cell, got, want)
		}
	}
}

// RecordRosterEmail is the fold for a recovery whose row already names the
// account but carries no address: without it the recovered address has nowhere
// to land and retiring the metadata team would lose it.
func TestRecordRosterEmail(t *testing.T) {
	t.Run("fills a blank cell, matching the login case-insensitively", func(t *testing.T) {
		rows, ok := RecordRosterEmail([]RosterRow{{Username: "Ada", GitHubID: 101}}, "ada", 101, "ada@uni.edu")
		if !ok || rows[0].Email != "ada@uni.edu" {
			t.Fatalf("recorded = %v, row = %#v", ok, rows[0])
		}
	})

	t.Run("falls back to the github_id when no row names the login", func(t *testing.T) {
		rows, ok := RecordRosterEmail([]RosterRow{{GitHubID: 101}}, "ada", 101, "ada@uni.edu")
		if !ok || rows[0].Email != "ada@uni.edu" {
			t.Fatalf("recorded = %v, row = %#v", ok, rows[0])
		}
	})

	t.Run("never overwrites an address the teacher entered", func(t *testing.T) {
		rows, ok := RecordRosterEmail([]RosterRow{{Username: "ada", Email: "ada@personal.com"}}, "ada", 101, "ada@uni.edu")
		if ok || rows[0].Email != "ada@personal.com" {
			t.Fatalf("recorded = %v, row = %#v", ok, rows[0])
		}
	})

	t.Run("a whitespace-only cell counts as blank", func(t *testing.T) {
		rows, ok := RecordRosterEmail([]RosterRow{{Username: "ada", Email: "   "}}, "ada", 101, "ada@uni.edu")
		if !ok || rows[0].Email != "ada@uni.edu" {
			t.Fatalf("recorded = %v, row = %#v", ok, rows[0])
		}
	})

	t.Run("the login wins over a different row carrying the id", func(t *testing.T) {
		rows := []RosterRow{{GitHubID: 101}, {Username: "ada"}}
		if _, ok := RecordRosterEmail(rows, "ada", 101, "ada@uni.edu"); !ok {
			t.Fatal("recorded = false")
		}
		if rows[0].Email != "" || rows[1].Email != "ada@uni.edu" {
			t.Errorf("filled the wrong row: %#v", rows)
		}
	})

	t.Run("no match or a blank address is a no-op", func(t *testing.T) {
		rows := []RosterRow{{Username: "bob"}}
		if _, ok := RecordRosterEmail(rows, "ada", 0, "ada@uni.edu"); ok {
			t.Error("recorded onto a different student's row")
		}
		if _, ok := RecordRosterEmail(rows, "bob", 0, "  "); ok {
			t.Error("recorded a blank address")
		}
	})

	t.Run("skips a preserved malformed row", func(t *testing.T) {
		if _, ok := RecordRosterEmail([]RosterRow{{raw: []string{"ada"}}}, "ada", 101, "ada@uni.edu"); ok {
			t.Error("mutated a row preserved verbatim for round-tripping")
		}
	})
}

// IsPendingEmailInvite is what a caller plans against, so it must answer exactly
// what the helpers then do — a caller whose predicate is looser plans edits they
// refuse, which no --write pass can ever converge.
//
// `want` is spelled out per case: deriving it from the predicate under test
// would make every assertion vacuous.
func TestIsPendingEmailInvite_AgreesWithTheHelpers(t *testing.T) {
	cases := map[string]struct {
		row  RosterRow
		want bool
	}{
		"claimable":                        {row: RosterRow{Email: "ada@uni.edu"}, want: true},
		"has a username":                   {row: RosterRow{Username: "ada", Email: "ada@uni.edu"}},
		"has a resolved github_id":         {row: RosterRow{Email: "ada@uni.edu", GitHubID: 101}},
		"has an unresolved github_id cell": {row: RosterRow{Email: "ada@uni.edu", githubIDRaw: "0"}, want: true},
		"has no address":                   {row: RosterRow{githubIDRaw: ""}},
		"is a preserved malformed row":     {row: RosterRow{raw: []string{"junk"}}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := tc.row.IsPendingEmailInvite(); got != tc.want {
				t.Fatalf("IsPendingEmailInvite = %v, want %v", got, tc.want)
			}
			if got := findPendingEmailRow([]RosterRow{tc.row}, tc.row.Email) >= 0; got != tc.want {
				t.Errorf("findPendingEmailRow matched = %v, want %v", got, tc.want)
			}
			_, removed := RemovePendingEmailRow([]RosterRow{tc.row}, tc.row.Email)
			if removed != tc.want {
				t.Errorf("RemovePendingEmailRow removed = %v, want %v", removed, tc.want)
			}
			_, claimed := ClaimPendingEmailRow([]RosterRow{tc.row}, tc.row.Email, "ada", 101)
			if claimed != tc.want {
				t.Errorf("ClaimPendingEmailRow claimed = %v, want %v", claimed, tc.want)
			}
		})
	}
}

// #27: the two readers must agree on which spellings ADDRESS an account, or the
// same row is identity to one and a claimable pending invite to the other. Only
// leading zeros are tolerated (the web's resolveGitHubId strips exactly those,
// and EncodeRoster rewrites the cell canonically).
func TestParseGitHubID_AcceptsOnlyTheWebsResolvableSpellings(t *testing.T) {
	for cell, want := range map[string]int64{
		"101":                  101,
		" 101 ":                101,
		"0000101":              101, // the one tolerated non-canonical spelling
		"+101":                 0,   // resolveGitHubId's regex rejects the sign
		"-101":                 0,
		"0":                    0,
		"9007199254740992":     0, // past 2^53-1
		"00000000000000000000": 0,
		"1_01":                 0,
		"0x65":                 0,
	} {
		id, err := parseGitHubID(cell)
		if want == 0 {
			if id != 0 {
				t.Errorf("parseGitHubID(%q) = %d, want 0 (the web addresses no account with it)", cell, id)
			}
			continue
		}
		if err != nil || id != want {
			t.Errorf("parseGitHubID(%q) = (%d, %v), want %d", cell, id, err, want)
		}
	}
}

// TestBackfillRosterGitHubID: an id that already resolves is never repointed —
// a recycled login must not silently move a row onto a different account.
func TestBackfillRosterGitHubID(t *testing.T) {
	t.Run("fills an unresolved cell", func(t *testing.T) {
		rows, ok := BackfillRosterGitHubID([]RosterRow{{Username: "Ada", githubIDRaw: "0"}}, "ada", 101)
		if !ok || rows[0].GitHubID != 101 {
			t.Fatalf("filled = %v, row = %#v", ok, rows[0])
		}
	})

	t.Run("leaves a resolved cell alone", func(t *testing.T) {
		rows, ok := BackfillRosterGitHubID([]RosterRow{{Username: "ada", GitHubID: 7}}, "ada", 101)
		if ok || rows[0].GitHubID != 7 {
			t.Fatalf("filled = %v, row = %#v", ok, rows[0])
		}
	})

	t.Run("no match is a no-op", func(t *testing.T) {
		if _, ok := BackfillRosterGitHubID([]RosterRow{{Username: "bob"}}, "ada", 101); ok {
			t.Error("filled a row for a different student")
		}
	})
}
