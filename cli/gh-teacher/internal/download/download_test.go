package download

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubtest"
	scoresschema "github.com/foundation50/gh-teacher/internal/scores"
)

func TestAssignmentRepoName(t *testing.T) {
	cases := []struct {
		classroom, assignment, username, want string
	}{
		{"cs-principles", "hello", "alice", "cs-principles-hello-alice"},
		{"CS-Principles", "Hello", "Alice", "cs-principles-hello-alice"},
		{"intro-java", "hello-world", "ada-l", "intro-java-hello-world-ada-l"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			if got := assignmentRepoName(tc.classroom, tc.assignment, tc.username); got != tc.want {
				t.Fatalf("assignmentRepoName(%q,%q,%q) = %q, want %q",
					tc.classroom, tc.assignment, tc.username, got, tc.want)
			}
		})
	}
}

// TestMatchesAssignmentPrefix pins the repo-selection downloadByPattern uses:
// canonical and mixed-case assignment repos match; the config repo, a different
// assignment, and a near-miss prefix do not.
func TestMatchesAssignmentPrefix(t *testing.T) {
	cases := []struct {
		name, classroom, assignment string
		want                        bool
	}{
		{"cs-principles-hello-alice", "cs-principles", "hello", true},
		{"CS-Principles-Hello-Alice", "cs-principles", "hello", true}, // repo name cased differently
		{"cs-principles-hello-ada-l", "cs-principles", "hello", true}, // hyphenated username
		{"cs-principles-goodbye-alice", "cs-principles", "hello", false},
		{"classroom50", "cs-principles", "hello", false},                // config repo
		{"cs-principles-hello", "cs-principles", "hello", false},        // prefix without trailing "-<owner>"
		{"cs-principles-hello2-alice", "cs-principles", "hello", false}, // near-miss: no "-" boundary
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesAssignmentPrefix(tc.name, tc.classroom, tc.assignment); got != tc.want {
				t.Fatalf("matchesAssignmentPrefix(%q,%q,%q) = %v, want %v",
					tc.name, tc.classroom, tc.assignment, got, tc.want)
			}
		})
	}
}

func TestAssignmentRegistered(t *testing.T) {
	file := assignment.AssignmentsJSON{
		Schema: contract.AssignmentsSchemaV1,
		Assignments: []assignment.AssignmentEntry{
			{Slug: "hello"},
			{Slug: "Goodbye"},
		},
	}
	cases := []struct {
		in   string
		want bool
	}{
		{"hello", true},
		{"HELLO", true}, // case-insensitive
		{"goodbye", true},
		{"missing", false},
		{"", false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := assignmentRegistered(file, tc.in); got != tc.want {
				t.Fatalf("assignmentRegistered(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestAssignmentIsGroup(t *testing.T) {
	file := assignment.AssignmentsJSON{
		Schema: contract.AssignmentsSchemaV1,
		Assignments: []assignment.AssignmentEntry{
			{Slug: "solo", Mode: "individual"},
			{Slug: "team", Mode: "group"},
			{Slug: "blank"}, // no mode → not group
		},
	}
	cases := []struct {
		in   string
		want bool
	}{
		{"team", true},
		{"TEAM", true}, // case-insensitive
		{"solo", false},
		{"blank", false},
		{"missing", false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := assignmentIsGroup(file, tc.in); got != tc.want {
				t.Fatalf("assignmentIsGroup(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestCreditedUsernames(t *testing.T) {
	scores := scoresschema.File{
		Schema: scoresschema.SchemaV1,
		Assignments: map[string]scoresschema.AssignmentBucket{
			"project": {
				Type: "group",
				Entries: []map[string]any{
					{"owner": "alice", "member_usernames": []any{"alice", "Bob", "carol"}},
				},
			},
			"other": {
				Type: "individual",
				Entries: []map[string]any{
					{"owner": "dan"},
				},
			},
		},
	}
	credited := creditedUsernames(scores, "project")
	// All three group members credited, lowercased; other-assignment entries excluded.
	for _, u := range []string{"alice", "bob", "carol"} {
		if _, ok := credited[u]; !ok {
			t.Fatalf("expected %q credited for project, got %v", u, credited)
		}
	}
	if _, ok := credited["dan"]; ok {
		t.Fatalf("dan is in another assignment bucket, must not be credited for project")
	}
}

func TestSelectResultAsset(t *testing.T) {
	cases := []struct {
		name        string
		rel         release
		wantURL     string
		wantErrPart string
	}{
		{
			name: "single result.json asset",
			rel: release{
				TagName: "submit/2026-06-01T14-32-05Z",
				Assets: []releaseAsset{
					{Name: "result.json", URL: "https://api.github.com/repos/o/r/releases/assets/1"},
				},
			},
			wantURL: "https://api.github.com/repos/o/r/releases/assets/1",
		},
		{
			name: "case-insensitive name match",
			rel: release{
				Assets: []releaseAsset{
					{Name: "RESULT.JSON", URL: "https://example/assets/2"},
				},
			},
			wantURL: "https://example/assets/2",
		},
		{
			name:    "no result.json asset returns empty (not an error)",
			rel:     release{Assets: []releaseAsset{{Name: "other.zip", URL: "x"}}},
			wantURL: "",
		},
		{
			name:    "empty assets list returns empty",
			rel:     release{Assets: nil},
			wantURL: "",
		},
		{
			name: "duplicate result.json assets reject ambiguity",
			rel: release{
				Assets: []releaseAsset{
					{Name: "result.json", URL: "a"},
					{Name: "result.json", URL: "b"},
				},
			},
			wantErrPart: "2 result.json assets",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := selectResultAsset(tc.rel)
			if tc.wantErrPart != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
				}
				if !strings.Contains(err.Error(), tc.wantErrPart) {
					t.Fatalf("err = %q, want substring %q", err.Error(), tc.wantErrPart)
				}
				return
			}
			if err != nil {
				t.Fatalf("selectResultAsset: %v", err)
			}
			if got != tc.wantURL {
				t.Fatalf("selectResultAsset = %q, want %q", got, tc.wantURL)
			}
		})
	}
}

func TestParseScores(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		wantRows    int // total rows across every assignment bucket
		wantErrPart string
	}{
		{
			name:     "empty file -> empty assignments",
			in:       "",
			wantRows: 0,
		},
		{
			name:     "whitespace only -> empty assignments",
			in:       "   \n\t",
			wantRows: 0,
		},
		{
			name:     "well-formed empty map",
			in:       `{"schema":"classroom50/scores/v1","assignments":{}}`,
			wantRows: 0,
		},
		{
			name:     "null assignments normalize to empty",
			in:       `{"schema":"classroom50/scores/v1","assignments":null}`,
			wantRows: 0,
		},
		{
			name:        `"{}" string wrapper now rejected (no legacy migration)`,
			in:          `{"schema":"classroom50/scores/v1","assignments":"{}"}`,
			wantErrPart: "must be an object",
		},
		{
			name:     "one entry in a bucket",
			in:       `{"schema":"classroom50/scores/v1","assignments":{"hello":{"type":"individual","entries":[{"owner":"alice","submissions":[]}]}}}`,
			wantRows: 1,
		},
		{
			name:        "bucket missing type rejected (Go/Python parity)",
			in:          `{"schema":"classroom50/scores/v1","assignments":{"hello":{"entries":[]}}}`,
			wantErrPart: "type",
		},
		{
			name:        "bucket with bad type rejected",
			in:          `{"schema":"classroom50/scores/v1","assignments":{"hello":{"type":"squad","entries":[]}}}`,
			wantErrPart: "type",
		},
		{
			name:        "legacy flat array now rejected (no legacy migration)",
			in:          `{"schema":"classroom50/scores/v1","assignments":[{"assignment":"hello"}]}`,
			wantErrPart: "must be an object",
		},
		{
			name:        "wrong schema rejected",
			in:          `{"schema":"classroom50/scores/v2","assignments":{}}`,
			wantErrPart: "schema mismatch",
		},
		{
			name:        "malformed JSON rejected",
			in:          `{`,
			wantErrPart: "parse",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseScores([]byte(tc.in))
			if tc.wantErrPart != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
				}
				if !strings.Contains(err.Error(), tc.wantErrPart) {
					t.Fatalf("err = %q, want substring %q", err.Error(), tc.wantErrPart)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseScores: %v", err)
			}
			if got.Assignments == nil {
				t.Fatal("Assignments must be a non-nil map")
			}
			rows := 0
			for _, bucket := range got.Assignments {
				rows += len(bucket.Entries)
			}
			if rows != tc.wantRows {
				t.Fatalf("rows = %d, want %d", rows, tc.wantRows)
			}
		})
	}
}

// TestParseScoresRejectsLegacyShapes pins that legacy scores.json
// shapes are NO LONGER migrated — backward compatibility was
// intentionally dropped, so a flat array or a "{}" string wrapper
// hard-fails rather than being coerced.
func TestParseScoresRejectsLegacyShapes(t *testing.T) {
	cases := []string{
		// flat array under assignments
		`{"schema":"classroom50/scores/v1","assignments":[{"assignment":"hello"}]}`,
		// "{}" string wrapper under assignments
		`{"schema":"classroom50/scores/v1","assignments":"{}"}`,
	}
	for _, in := range cases {
		if _, err := parseScores([]byte(in)); err == nil {
			t.Errorf("expected a legacy shape to be rejected, got nil error for %s", in)
		}
	}
}

func TestStringifyNumber(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{float64(10), "10"},
		{float64(0), "0"},
		{float64(10.5), "10.5"},
		{int(7), "7"},
		{int64(42), "42"},
		{"not a number", ""},
		{nil, ""},
		{true, ""},
	}
	for _, tc := range cases {
		if got := stringifyNumber(tc.in); got != tc.want {
			t.Errorf("stringifyNumber(%#v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestStringifyOverride(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{true, "true"},
		{false, "false"},
		{nil, ""},
		{"verified", "verified"}, // extension shape
		{0, ""},                  // non-bool/string → empty
	}
	for _, tc := range cases {
		if got := stringifyOverride(tc.in); got != tc.want {
			t.Errorf("stringifyOverride(%#v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestWriteScoresCSV(t *testing.T) {
	teamLogins := []string{"alice", "Bob", "carol"} // mixed case to verify lookup is case-insensitive
	// Best-effort roster metadata join (blank when a member is absent
	// from the CSV — carol here).
	meta := map[string]RosterMeta{
		"alice": {FirstName: "Ada", LastName: "Lovelace", Email: "ada@uni.edu", Section: "A"},
		"bob":   {FirstName: "Bob", LastName: "Jones", Email: "bob@uni.edu", Section: "B"},
	}

	// scores: alice submitted twice (newest first), bob submitted once with
	// entry-level override true, carol has no entry. "mallory" has an entry
	// but isn't on the roster → must NOT appear in csv. A different
	// assignment bucket must NOT appear. The per-submission detail lives in
	// each entry's `submissions` list; an individual entry credits its owner.
	scores := scoresschema.File{
		Schema: scoresschema.SchemaV1,
		Assignments: map[string]scoresschema.AssignmentBucket{
			"hello": {
				Type: "individual",
				Entries: []map[string]any{
					{
						"owner": "alice",
						"submissions": []any{
							map[string]any{
								"score":        float64(20),
								"max-score":    float64(30),
								"datetime":     "2026-06-02T09:00:00Z",
								"submission":   "submit/2026-06-02T08-59-00Z",
								"review":       "https://github.com/cs50/cs-principles-hello-alice/commit/ghi",
								"late":         false,
								"submitted_by": map[string]any{"username": "alice", "id": float64(111)},
							},
							map[string]any{
								"score":      float64(18),
								"max-score":  float64(30),
								"datetime":   "2026-06-01T14:33:11Z",
								"submission": "submit/2026-06-01T14-32-05Z",
								"review":     "https://github.com/cs50/cs-principles-hello-alice/commit/abc",
								"late":       false,
							},
						},
					},
					{
						"owner":    "bob",
						"override": true,
						"submissions": []any{
							map[string]any{
								"score":      float64(25),
								"max-score":  float64(30),
								"datetime":   "2026-06-01T15:00:00Z",
								"submission": "submit/2026-06-01T14-59-00Z",
								"review":     "https://github.com/cs50/cs-principles-hello-bob/commit/def",
								"late":       true,
							},
						},
					},
					{
						"owner":       "mallory",
						"submissions": []any{map[string]any{"score": float64(0), "max-score": float64(30)}},
					},
				},
			},
			"goodbye": {
				Type: "individual",
				Entries: []map[string]any{
					{
						"owner":       "alice",
						"submissions": []any{map[string]any{"score": float64(99), "max-score": float64(100)}},
					},
				},
			},
		},
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "scores.csv")
	if err := writeScoresCSV(path, scores, "hello", teamLogins, meta); err != nil {
		t.Fatalf("writeScoresCSV: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}

	want := strings.Join([]string{
		"username,first_name,last_name,email,section,score,max_score,datetime,submission_tag,submitted_by,review_url,late,override",
		"alice,Ada,Lovelace,ada@uni.edu,A,20,30,2026-06-02T09:00:00Z,submit/2026-06-02T08-59-00Z,alice,https://github.com/cs50/cs-principles-hello-alice/commit/ghi,false,",
		"alice,Ada,Lovelace,ada@uni.edu,A,18,30,2026-06-01T14:33:11Z,submit/2026-06-01T14-32-05Z,,https://github.com/cs50/cs-principles-hello-alice/commit/abc,false,",
		"Bob,Bob,Jones,bob@uni.edu,B,25,30,2026-06-01T15:00:00Z,submit/2026-06-01T14-59-00Z,,https://github.com/cs50/cs-principles-hello-bob/commit/def,true,true",
		"carol,,,,,,,,,,,,",
		"",
	}, "\n")
	if string(got) != want {
		t.Fatalf("scores.csv mismatch:\n got:\n%s\nwant:\n%s", got, want)
	}
}

func TestWriteScoresCSV_GroupFanOut(t *testing.T) {
	// A group submission is one multi-username row. writeScoresCSV must
	// credit every member with the group's submissions, including a
	// teammate who owns no derived repo.
	teamLogins := []string{
		"alice", // owner
		"bob",   // joined alice's repo
		"carol", // joined alice's repo
		"dan",   // not in the group — no score
	}
	scores := scoresschema.File{
		Schema: scoresschema.SchemaV1,
		Assignments: map[string]scoresschema.AssignmentBucket{
			"project": {
				Type: "group",
				Entries: []map[string]any{
					{
						"owner":            "alice",
						"member_usernames": []any{"alice", "bob", "carol"},
						"submissions": []any{
							map[string]any{
								"score":        float64(90),
								"max-score":    float64(100),
								"datetime":     "2026-06-01T14:33:11Z",
								"submission":   "submit/2026-06-01T14-32-05Z",
								"review":       "https://github.com/cs50/cs-principles-project-alice/commit/abc",
								"late":         false,
								"submitted_by": map[string]any{"username": "bob", "id": float64(222)},
							},
						},
					},
				},
			},
		},
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "scores.csv")
	if err := writeScoresCSV(path, scores, "project", teamLogins, map[string]RosterMeta{}); err != nil {
		t.Fatalf("writeScoresCSV: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}

	// No CSV metadata here (blank name/section/email): 4 empty cells after
	// the username, then the shared submission columns.
	row := ",,,,,90,100,2026-06-01T14:33:11Z,submit/2026-06-01T14-32-05Z,bob,https://github.com/cs50/cs-principles-project-alice/commit/abc,false,"
	want := strings.Join([]string{
		"username,first_name,last_name,email,section,score,max_score,datetime,submission_tag,submitted_by,review_url,late,override",
		"alice" + row,
		"bob" + row,
		"carol" + row,
		"dan,,,,,,,,,,,,", // not a group member → blank
		"",
	}, "\n")
	if string(got) != want {
		t.Fatalf("group scores.csv mismatch:\n got:\n%s\nwant:\n%s", got, want)
	}
}

func TestWriteScoresCSV_EmptyRoster(t *testing.T) {
	// No team members yields just the header — the file still
	// exists so a teacher checking the download root sees the
	// expected artifact even on a brand-new class.
	dir := t.TempDir()
	path := filepath.Join(dir, "scores.csv")
	if err := writeScoresCSV(path, scoresschema.File{Schema: scoresschema.SchemaV1}, "hello", nil, nil); err != nil {
		t.Fatalf("writeScoresCSV: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	want := "username,first_name,last_name,email,section,score,max_score,datetime,submission_tag,submitted_by,review_url,late,override\n"
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestCSVSafeCell(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"alice", "alice"},
		{"submit/2026-06-01T14-32-05Z", "submit/2026-06-01T14-32-05Z"},
		{"=HYPERLINK(\"http://evil\")", "'=HYPERLINK(\"http://evil\")"},
		{"+1", "'+1"},
		{"-1+2", "'-1+2"},
		{"@SUM(A1:A2)", "'@SUM(A1:A2)"},
		{"\tcmd", "'\tcmd"},
		{"\rcmd", "'\rcmd"},
	}
	for _, tc := range cases {
		if got := csvSafeCell(tc.in); got != tc.want {
			t.Errorf("csvSafeCell(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestWriteScoresCSV_NeutralizesFormulaInjection(t *testing.T) {
	// A student owns their repo and can publish a result.json with a
	// formula-injection payload in a string field. writeScoresCSV must
	// neutralize it (leading-quote) so opening scores.csv in a spreadsheet
	// can't execute it.
	scores := scoresschema.File{
		Schema: scoresschema.SchemaV1,
		Assignments: map[string]scoresschema.AssignmentBucket{
			"hello": {
				Type: "individual",
				Entries: []map[string]any{
					{
						"owner": "alice",
						"submissions": []any{
							map[string]any{
								"score":        float64(10),
								"max-score":    float64(10),
								"datetime":     "2026-06-01T14:33:11Z",
								"submission":   "submit/2026-06-01T14-32-05Z",
								"review":       "=HYPERLINK(\"http://evil\",\"x\")",
								"late":         "=cmd|'/c calc'!A1",
								"submitted_by": map[string]any{"username": "@SUM(A1)"},
							},
						},
					},
				},
			},
		},
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "scores.csv")
	// Metadata is teacher/student-controllable free text, so it's guarded too.
	meta := map[string]RosterMeta{
		"alice": {FirstName: "=HYPERLINK(1)", Section: "@SUM(B1)"},
	}
	if err := writeScoresCSV(path, scores, "hello", []string{"alice"}, meta); err != nil {
		t.Fatalf("writeScoresCSV: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// The dangerous cells must be prefixed with a single quote.
	if !strings.Contains(string(got), "'=HYPERLINK") {
		t.Errorf("review/first_name formula not neutralized:\n%s", got)
	}
	if !strings.Contains(string(got), "'@SUM(A1)") {
		t.Errorf("submitted_by formula not neutralized:\n%s", got)
	}
	if !strings.Contains(string(got), "'@SUM(B1)") {
		t.Errorf("section metadata formula not neutralized:\n%s", got)
	}
	if !strings.Contains(string(got), "'=cmd") {
		t.Errorf("late formula not neutralized:\n%s", got)
	}
}

func TestRepoExistsOnOrg(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/exists", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"name": "exists"})
	})
	mux.HandleFunc("/repos/o/missing", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	mux.HandleFunc("/repos/o/down", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	if ok, err := repoExistsOnOrg(client, "o", "exists"); err != nil || !ok {
		t.Errorf("exists: ok=%v err=%v", ok, err)
	}
	if ok, err := repoExistsOnOrg(client, "o", "missing"); err != nil || ok {
		t.Errorf("missing: ok=%v err=%v", ok, err)
	}
	if _, err := repoExistsOnOrg(client, "o", "down"); err == nil {
		t.Error("expected error on 500")
	}
}

func TestDownloadAssetBytes(t *testing.T) {
	t.Run("happy path returns body", func(t *testing.T) {
		var (
			mu        sync.Mutex
			gotAccept string
			gotAuth   string
		)
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			gotAccept = r.Header.Get("Accept")
			gotAuth = r.Header.Get("Authorization")
			mu.Unlock()
			_, _ = w.Write([]byte(`{"schema":"classroom50/result/v1"}`))
		}))
		t.Cleanup(s.Close)

		body, err := downloadAssetBytes("test-token", s.URL+"/repos/o/r/releases/assets/1")
		if err != nil {
			t.Fatalf("downloadAssetBytes: %v", err)
		}
		if !strings.Contains(string(body), "classroom50/result/v1") {
			t.Errorf("body = %q", body)
		}
		mu.Lock()
		defer mu.Unlock()
		if gotAccept != "application/octet-stream" {
			t.Errorf("Accept = %q, want application/octet-stream", gotAccept)
		}
		if gotAuth != "Bearer test-token" {
			t.Errorf("Authorization = %q, want Bearer test-token", gotAuth)
		}
	})

	t.Run("strips Authorization on cross-host redirect", func(t *testing.T) {
		var (
			mu          sync.Mutex
			storageAuth string
		)
		storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			storageAuth = r.Header.Get("Authorization")
			mu.Unlock()
			_, _ = w.Write([]byte(`{"signed":"ok"}`))
		}))
		t.Cleanup(storage.Close)

		// The api server redirects to the storage server (different
		// host because httptest.NewServer picks a fresh port).
		// The redirect MUST land at the storage server with no
		// Authorization header.
		storageURL, err := url.Parse(storage.URL)
		if err != nil {
			t.Fatalf("parse storage URL: %v", err)
		}
		api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Build a different-host redirect target by swapping
			// the port. httptest binds 127.0.0.1, so localhost vs
			// 127.0.0.1 counts as a different host name for Go's
			// stdlib redirect-stripping logic.
			target := "http://localhost:" + storageURL.Port() + "/redirected"
			http.Redirect(w, r, target, http.StatusFound)
		}))
		t.Cleanup(api.Close)

		body, err := downloadAssetBytes("test-token", api.URL+"/repos/o/r/releases/assets/1")
		if err != nil {
			t.Fatalf("downloadAssetBytes: %v", err)
		}
		if !strings.Contains(string(body), `"signed":"ok"`) {
			t.Errorf("body = %q", body)
		}
		mu.Lock()
		defer mu.Unlock()
		if storageAuth != "" {
			t.Errorf("Authorization leaked to storage host: %q", storageAuth)
		}
	})

	t.Run("non-2xx surfaces HTTP status", func(t *testing.T) {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		t.Cleanup(s.Close)
		_, err := downloadAssetBytes("test-token", s.URL+"/repos/o/r/releases/assets/1")
		if err == nil {
			t.Fatal("expected error on 403")
		}
		if !strings.Contains(err.Error(), "HTTP 403") {
			t.Errorf("err = %v, want HTTP 403", err)
		}
	})

	t.Run("empty token fails fast", func(t *testing.T) {
		_, err := downloadAssetBytes("", "https://example/assets/1")
		if err == nil {
			t.Fatal("expected error on empty token")
		}
		if !strings.Contains(err.Error(), "no GitHub token") {
			t.Errorf("err = %v, want no GitHub token", err)
		}
	})
}

func TestRefreshResultJSON(t *testing.T) {
	dir := t.TempDir()

	// `server` is captured by reference so handlers can mint asset
	// URLs that point back at the live server (whose URL isn't
	// known until NewServer returns).
	var server *httptest.Server

	mux := http.NewServeMux()
	// Happy path: two submit-tag releases (newest first). Both carry
	// a result.json asset, so results.json has two entries and
	// result.json is the latest.
	mux.HandleFunc("/repos/o/has-result/releases", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{
				"tag_name": "submit/2026-06-02T10-00-00Z",
				"assets":   []map[string]string{{"name": "result.json", "url": server.URL + "/asset-new.json"}},
			},
			{
				"tag_name": "submit/2026-06-01T14-32-05Z",
				"assets":   []map[string]string{{"name": "result.json", "url": server.URL + "/asset-old.json"}},
			},
		})
	})
	// A repo whose releases mix submit-tag and non-submit tags: only
	// the submit-tag ones are collected, in newest-first order.
	mux.HandleFunc("/repos/o/mixed/releases", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"tag_name": "v1.0.0"},
			{
				"tag_name": "submit/2026-06-01T14-32-05Z",
				"assets":   []map[string]string{{"name": "result.json", "url": server.URL + "/asset-old.json"}},
			},
		})
	})
	// No submit-tag release anywhere → silent no-op.
	mux.HandleFunc("/repos/o/non-submit-empty/releases", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{{"tag_name": "v1.0.0"}})
	})
	// A submit-tag release with no result.json asset: it appears in
	// results.json with a null result, but result.json is not written.
	mux.HandleFunc("/repos/o/no-asset/releases", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{{
			"tag_name": "submit/2026-06-01T14-32-05Z",
			"assets":   []map[string]string{{"name": "other.txt", "url": "ignored"}},
		}})
	})
	// 404 on the releases walk (no releases / not accepted) → no-op.
	mux.HandleFunc("/repos/o/no-release/releases", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	mux.HandleFunc("/asset-new.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"schema":"classroom50/result/v1","score":25}`))
	})
	mux.HandleFunc("/asset-old.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"schema":"classroom50/result/v1","score":18}`))
	})

	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	t.Run("collects every submission newest-first and points result.json at the latest", func(t *testing.T) {
		target := filepath.Join(dir, "has-result")
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := refreshResultJSON(client, "test-token", server.URL, "o", "has-result", target); err != nil {
			t.Fatalf("refreshResultJSON: %v", err)
		}

		historyBytes, err := os.ReadFile(filepath.Join(target, resultsAssetName))
		if err != nil {
			t.Fatalf("read results.json: %v", err)
		}
		var history []submissionRecord
		if err := json.Unmarshal(historyBytes, &history); err != nil {
			t.Fatalf("decode results.json: %v", err)
		}
		if len(history) != 2 {
			t.Fatalf("results.json has %d entries, want 2", len(history))
		}
		if history[0].SubmissionTag != "submit/2026-06-02T10-00-00Z" {
			t.Errorf("results.json[0].submission_tag = %q, want the newest", history[0].SubmissionTag)
		}
		if !strings.Contains(string(history[0].Result), `"score": 25`) {
			t.Errorf("results.json[0].result = %q, want the newest payload", history[0].Result)
		}
		if !strings.Contains(string(history[1].Result), `"score": 18`) {
			t.Errorf("results.json[1].result = %q, want the older payload", history[1].Result)
		}

		latest, err := os.ReadFile(filepath.Join(target, resultAssetName))
		if err != nil {
			t.Fatalf("read result.json: %v", err)
		}
		if !strings.Contains(string(latest), `"score":25`) {
			t.Errorf("result.json = %q, want the latest payload", latest)
		}
	})

	t.Run("filters non-submit tags out of the history", func(t *testing.T) {
		target := filepath.Join(dir, "mixed")
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := refreshResultJSON(client, "test-token", server.URL, "o", "mixed", target); err != nil {
			t.Fatalf("refreshResultJSON: %v", err)
		}
		var history []submissionRecord
		historyBytes, err := os.ReadFile(filepath.Join(target, resultsAssetName))
		if err != nil {
			t.Fatalf("read results.json: %v", err)
		}
		if err := json.Unmarshal(historyBytes, &history); err != nil {
			t.Fatalf("decode results.json: %v", err)
		}
		if len(history) != 1 || history[0].SubmissionTag != "submit/2026-06-01T14-32-05Z" {
			t.Fatalf("history = %#v, want only the submit-tag release", history)
		}
	})

	t.Run("submit release without result asset → null result, no result.json", func(t *testing.T) {
		target := filepath.Join(dir, "no-asset")
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := refreshResultJSON(client, "test-token", server.URL, "o", "no-asset", target); err != nil {
			t.Fatalf("refreshResultJSON: %v", err)
		}
		var history []submissionRecord
		historyBytes, err := os.ReadFile(filepath.Join(target, resultsAssetName))
		if err != nil {
			t.Fatalf("read results.json: %v", err)
		}
		if err := json.Unmarshal(historyBytes, &history); err != nil {
			t.Fatalf("decode results.json: %v", err)
		}
		if len(history) != 1 || len(history[0].Result) != 0 && string(history[0].Result) != "null" {
			t.Fatalf("history = %#v, want one entry with null result", history)
		}
		if _, err := os.Stat(filepath.Join(target, resultAssetName)); !os.IsNotExist(err) {
			t.Errorf("result.json should not exist when no release has an asset (stat err: %v)", err)
		}
	})

	noOpCases := []struct {
		name string
		repo string
	}{
		{name: "no submit-tag release anywhere → no files", repo: "non-submit-empty"},
		{name: "404 releases → no files", repo: "no-release"},
	}
	for _, tc := range noOpCases {
		t.Run(tc.name, func(t *testing.T) {
			target := filepath.Join(dir, tc.repo)
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if err := refreshResultJSON(client, "test-token", server.URL, "o", tc.repo, target); err != nil {
				t.Fatalf("refreshResultJSON: %v", err)
			}
			if _, err := os.Stat(filepath.Join(target, resultsAssetName)); !os.IsNotExist(err) {
				t.Errorf("results.json should not exist (stat err: %v)", err)
			}
			if _, err := os.Stat(filepath.Join(target, resultAssetName)); !os.IsNotExist(err) {
				t.Errorf("result.json should not exist (stat err: %v)", err)
			}
		})
	}
}

func TestListAllSubmitReleases(t *testing.T) {
	t.Run("returns every submit-tag release newest-first, filtering non-submit", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/r/releases", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"tag_name": "submit/2026-06-03T10-00-00Z"},
				{"tag_name": "v2.0.0"},
				{"tag_name": "submit/2026-06-02T10-00-00Z"},
				{"tag_name": "submit/2026-06-01T10-00-00Z"},
			})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		rels, err := listAllSubmitReleases(client, "o", "r")
		if err != nil {
			t.Fatalf("listAllSubmitReleases: %v", err)
		}
		gotTags := make([]string, len(rels))
		for i, rel := range rels {
			gotTags[i] = rel.TagName
		}
		want := []string{
			"submit/2026-06-03T10-00-00Z",
			"submit/2026-06-02T10-00-00Z",
			"submit/2026-06-01T10-00-00Z",
		}
		if strings.Join(gotTags, ",") != strings.Join(want, ",") {
			t.Fatalf("tags = %v, want %v", gotTags, want)
		}
	})

	t.Run("404 → empty, not an error", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/missing/releases", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		rels, err := listAllSubmitReleases(client, "o", "missing")
		if err != nil {
			t.Fatalf("listAllSubmitReleases: %v", err)
		}
		if len(rels) != 0 {
			t.Fatalf("got %d releases, want 0", len(rels))
		}
	})

	t.Run("paginates across pages", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/many/releases", func(w http.ResponseWriter, r *http.Request) {
			page := r.URL.Query().Get("page")
			if page == "1" {
				batch := make([]map[string]string, allReleasesPerPage)
				for i := range batch {
					batch[i] = map[string]string{"tag_name": fmt.Sprintf("submit/p1-%d", i)}
				}
				_ = json.NewEncoder(w).Encode(batch)
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]string{{"tag_name": "submit/last"}})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		rels, err := listAllSubmitReleases(client, "o", "many")
		if err != nil {
			t.Fatalf("listAllSubmitReleases: %v", err)
		}
		if len(rels) != allReleasesPerPage+1 {
			t.Fatalf("got %d releases, want %d", len(rels), allReleasesPerPage+1)
		}
		if rels[len(rels)-1].TagName != "submit/last" {
			t.Errorf("last tag = %q, want submit/last", rels[len(rels)-1].TagName)
		}
	})
}

func TestApiBaseURL(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", "https://api.github.com"},
		{"github.com", "https://api.github.com"},
		{"  github.com  ", "https://api.github.com"},
		{"ghe.example.test", "https://ghe.example.test/api/v3"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := apiBaseURL(tc.in); got != tc.want {
				t.Fatalf("apiBaseURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRewriteAssetURL(t *testing.T) {
	cases := []struct {
		name    string
		asset   string
		apiBase string
		want    string
	}{
		{
			name:    "github.com → test server: swap scheme+host, preserve path/query",
			asset:   "https://api.github.com/repos/o/r/releases/assets/123?name=result.json",
			apiBase: "http://127.0.0.1:9999",
			want:    "http://127.0.0.1:9999/repos/o/r/releases/assets/123?name=result.json",
		},
		{
			name:    "GHES asset (already prefixed) → GHES mirror: path unchanged",
			asset:   "https://ghe.example.test/api/v3/repos/o/r/releases/assets/123",
			apiBase: "https://mirror.example.test/api/v3",
			want:    "https://mirror.example.test/api/v3/repos/o/r/releases/assets/123",
		},
		{
			name:    "github.com asset → GHES target: /api/v3 prefix added",
			asset:   "https://api.github.com/repos/o/r/releases/assets/123",
			apiBase: "https://ghe.example.test/api/v3",
			want:    "https://ghe.example.test/api/v3/repos/o/r/releases/assets/123",
		},
		{
			name:    "relative asset URL left unchanged (defensive fallback)",
			asset:   "/repos/o/r/releases/assets/123",
			apiBase: "http://127.0.0.1",
			want:    "/repos/o/r/releases/assets/123",
		},
		{
			name:    "malformed apiBase leaves asset alone",
			asset:   "https://api.github.com/x",
			apiBase: "not a url",
			want:    "https://api.github.com/x",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := rewriteAssetURL(tc.asset, tc.apiBase); got != tc.want {
				t.Fatalf("rewriteAssetURL(%q, %q) = %q, want %q", tc.asset, tc.apiBase, got, tc.want)
			}
		})
	}
}

// TestLoadRosterMetadata_MissingCSVWarnsAndBlanks: the roster is optional
// display metadata now — a missing/unreadable file must NOT skip students. Both
// roster.csv and the legacy fallback contents reads 404, so LoadRoster
// errors; loadRosterMetadata warns and returns an empty map so every team
// member still gets a (blank-metadata) row.
func TestLoadRosterMetadata_MissingCSVWarnsAndBlanks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r) // roster.csv and the legacy fallback both 404
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var errOut bytes.Buffer
	meta := loadRosterMetadata(client, "o", "cs", "main", &errOut)

	if len(meta) != 0 {
		t.Fatalf("got %d metadata rows, want 0 (blank on missing CSV)", len(meta))
	}
	if !strings.Contains(errOut.String(), "roster metadata unavailable") {
		t.Errorf("expected an 'unavailable' warning, got %q", errOut.String())
	}
}

// TestLoadRosterMetadata_IndexesByLogin: a readable roster is indexed by
// lowercased login into RosterMeta for the scores.csv name/section/email join.
func TestLoadRosterMetadata_IndexesByLogin(t *testing.T) {
	csv := "username,first_name,last_name,email,section,github_id\n" +
		"Alice,Ada,Lovelace,ada@uni.edu,A,1\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content":  base64.StdEncoding.EncodeToString([]byte(csv)),
			"encoding": "base64",
		})
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	meta := loadRosterMetadata(client, "o", "cs", "main", io.Discard)

	// Indexed by lowercased login even though the CSV cased it "Alice".
	got, ok := meta["alice"]
	if !ok {
		t.Fatalf("login not indexed lowercased; keys = %v", meta)
	}
	want := RosterMeta{FirstName: "Ada", LastName: "Lovelace", Email: "ada@uni.edu", Section: "A"}
	if got != want {
		t.Errorf("meta[alice] = %+v, want %+v", got, want)
	}
}
