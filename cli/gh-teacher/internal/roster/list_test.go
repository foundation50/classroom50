package roster

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// rosterListMock is a minimal <org>/classroom50 server for the
// read-only `roster list` command: default-branch metadata plus a
// roster.csv read. files maps repo-relative path -> content. When
// statusOverride is set for a repo path, that contents request returns
// the given HTTP status instead of file/404 -- used to exercise the
// non-404 error path.
type rosterListMock struct {
	files          map[string]string
	statusOverride map[string]int
}

func (m *rosterListMock) handler(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	})

	mux.HandleFunc("/repos/o/classroom50/contents/", func(w http.ResponseWriter, r *http.Request) {
		repoPath := strings.TrimPrefix(r.URL.Path, "/repos/o/classroom50/contents/")
		if code, ok := m.statusOverride[repoPath]; ok {
			http.Error(w, "injected error", code)
			return
		}
		if content, ok := m.files[repoPath]; ok {
			_ = json.NewEncoder(w).Encode(map[string]string{
				"content":  base64.StdEncoding.EncodeToString([]byte(content)),
				"encoding": "base64",
			})
			return
		}
		http.NotFound(w, r)
	})

	return mux
}

const rosterCSVTwoStudents = "username,first_name,last_name,email,section,github_id\n" +
	"alice,Alice,Andersson,alice@example.edu,section-1,111\n" +
	"bob,Bob,Brown,,,222\n"

func TestRunRosterList(t *testing.T) {
	t.Run("default table lists all rows with a stderr summary", func(t *testing.T) {
		mock := &rosterListMock{files: map[string]string{
			"cs-principles/roster.csv": rosterCSVTwoStudents,
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runRosterList(client, &out, &errOut, "o", "cs-principles", false, false); err != nil {
			t.Fatalf("runRosterList: %v", err)
		}
		s := out.String()
		if !strings.Contains(s, "USERNAME") || !strings.Contains(s, "GITHUB_ID") {
			t.Errorf("stdout = %q, want a header row", s)
		}
		for _, want := range []string{"alice", "Alice Andersson", "alice@example.edu", "section-1", "111", "bob", "Bob Brown", "222"} {
			if !strings.Contains(s, want) {
				t.Errorf("stdout missing %q\n%s", want, s)
			}
		}
		// bob has empty email + section -> dashIfEmpty renders both as "-".
		// Find bob's row and assert it carries at least two dash cells.
		var bobRow string
		for _, line := range strings.Split(s, "\n") {
			if strings.HasPrefix(line, "bob") {
				bobRow = line
				break
			}
		}
		if bobRow == "" {
			t.Fatalf("stdout has no bob row\n%s", s)
		}
		if dashes := strings.Count(bobRow, "-"); dashes < 2 {
			t.Errorf("bob row = %q, want >=2 dash cells (empty email + section)", bobRow)
		}
		if !strings.Contains(errOut.String(), "2 student(s)") {
			t.Errorf("stderr = %q, want '2 student(s)'", errOut.String())
		}
	})

	t.Run("--json emits typed entries; github_id present-and-0 when unresolved", func(t *testing.T) {
		csv := "username,first_name,last_name,email,section,github_id\n" +
			"alice,Alice,Andersson,alice@example.edu,section-1,111\n" +
			"carol,Carol,Clark,,,\n" // unresolved github_id (0)
		mock := &rosterListMock{files: map[string]string{"cs-principles/roster.csv": csv}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runRosterList(client, &out, &errOut, "o", "cs-principles", true, false); err != nil {
			t.Fatalf("runRosterList --json: %v", err)
		}
		var got []rosterListEntry
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal json: %v\n%s", err, out.String())
		}
		if len(got) != 2 {
			t.Fatalf("got %d entries, want 2: %#v", len(got), got)
		}
		if got[0].Username != "alice" || got[0].GitHubID != 111 || got[0].Email != "alice@example.edu" {
			t.Errorf("entry[0] = %#v, want alice/111", got[0])
		}
		if got[1].Username != "carol" || got[1].GitHubID != 0 {
			t.Errorf("entry[1] = %#v, want carol with github_id 0", got[1])
		}
		// No omitempty: github_id is always present (0 for unresolved).
		// Assert key presence structurally, independent of encoder spacing.
		var raw []map[string]json.RawMessage
		if err := json.Unmarshal(out.Bytes(), &raw); err != nil {
			t.Fatalf("unmarshal raw: %v", err)
		}
		if _, ok := raw[1]["github_id"]; !ok {
			t.Errorf("carol's object must carry the github_id key (no omitempty), got %s", out.String())
		}
		if string(raw[1]["github_id"]) != "0" {
			t.Errorf("carol github_id = %s, want 0", raw[1]["github_id"])
		}
	})

	t.Run("--json on empty roster emits [] not null", func(t *testing.T) {
		mock := &rosterListMock{files: map[string]string{
			"cs-principles/roster.csv": "username,first_name,last_name,email,section,github_id\n",
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runRosterList(client, &out, &errOut, "o", "cs-principles", true, false); err != nil {
			t.Fatalf("runRosterList: %v", err)
		}
		if got := strings.TrimSpace(out.String()); got != "[]" {
			t.Errorf("stdout = %q, want exactly []", got)
		}
	})

	t.Run("--quiet prints one username per line, no header, no stderr", func(t *testing.T) {
		mock := &rosterListMock{files: map[string]string{
			"cs-principles/roster.csv": rosterCSVTwoStudents,
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runRosterList(client, &out, &errOut, "o", "cs-principles", false, true); err != nil {
			t.Fatalf("runRosterList --quiet: %v", err)
		}
		lines := strings.Split(strings.TrimSpace(out.String()), "\n")
		want := []string{"alice", "bob"}
		if len(lines) != len(want) {
			t.Fatalf("stdout lines = %q, want %q", lines, want)
		}
		for i := range want {
			if lines[i] != want[i] {
				t.Errorf("line %d = %q, want %q", i, lines[i], want[i])
			}
		}
		if strings.Contains(out.String(), "USERNAME") {
			t.Errorf("--quiet should not print the table header, got %q", out.String())
		}
		if errOut.Len() != 0 {
			t.Errorf("--quiet should suppress the stderr summary, got %q", errOut.String())
		}
	})

	t.Run("--json takes precedence over --quiet", func(t *testing.T) {
		mock := &rosterListMock{files: map[string]string{
			"cs-principles/roster.csv": rosterCSVTwoStudents,
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runRosterList(client, &out, &errOut, "o", "cs-principles", true, true); err != nil {
			t.Fatalf("runRosterList --json --quiet: %v", err)
		}
		var got []rosterListEntry
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("expected JSON output when --json set with --quiet: %v\n%s", err, out.String())
		}
		if len(got) != 2 {
			t.Errorf("got %d entries, want 2", len(got))
		}
	})

	t.Run("empty roster: table shows header, stderr says none", func(t *testing.T) {
		mock := &rosterListMock{files: map[string]string{
			"cs-principles/roster.csv": "username,first_name,last_name,email,section,github_id\n",
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runRosterList(client, &out, &errOut, "o", "cs-principles", false, false); err != nil {
			t.Fatalf("runRosterList: %v", err)
		}
		if !strings.Contains(out.String(), "USERNAME") {
			t.Errorf("stdout = %q, want the header even when empty", out.String())
		}
		if !strings.Contains(errOut.String(), "no students on the roster") {
			t.Errorf("stderr = %q, want the empty-roster note", errOut.String())
		}
	})

	t.Run("missing roster errors and points at classroom add", func(t *testing.T) {
		mock := &rosterListMock{files: map[string]string{}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := runRosterList(client, &out, &errOut, "o", "ghost", false, false)
		if err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("err = %v, want a 'not found' error", err)
		}
		if !strings.Contains(err.Error(), "classroom add") {
			t.Errorf("err = %v, want a pointer to `gh teacher classroom add`", err)
		}
	})

	t.Run("non-404 API error propagates (not treated as missing)", func(t *testing.T) {
		mock := &rosterListMock{
			files:          map[string]string{},
			statusOverride: map[string]int{"cs-principles/roster.csv": http.StatusInternalServerError},
		}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := runRosterList(client, &out, &errOut, "o", "cs-principles", false, false)
		if err == nil {
			t.Fatalf("err = nil, want a non-nil error for a 5xx response")
		}
		// A 5xx must surface as a GET failure, not the friendly
		// "missing -> classroom add" 404 hint.
		if !strings.Contains(err.Error(), "GET") {
			t.Errorf("err = %v, want a 'GET ...' wrap", err)
		}
		if strings.Contains(err.Error(), "classroom add") {
			t.Errorf("err = %v, a 5xx must not be reported as a missing classroom", err)
		}
	})

	t.Run("malformed roster surfaces a parse error through runRosterList", func(t *testing.T) {
		// Wrong header -> parseRoster rejects; loadRoster wraps with the
		// repo path; runRosterList must propagate it.
		mock := &rosterListMock{files: map[string]string{
			"cs-principles/roster.csv": "name,email\nalice,alice@example.edu\n",
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		err := runRosterList(client, &out, &errOut, "o", "cs-principles", false, false)
		if err == nil {
			t.Fatalf("err = nil, want a parse error for a malformed roster.csv")
		}
		if !strings.Contains(err.Error(), "cs-principles/roster.csv") {
			t.Errorf("err = %v, want the loadRoster path wrap", err)
		}
		if !strings.Contains(err.Error(), "unexpected header") {
			t.Errorf("err = %v, want the parseRoster header reason", err)
		}
	})
}
