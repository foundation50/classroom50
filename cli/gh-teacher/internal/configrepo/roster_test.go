package configrepo

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

const rosterTestHeader = "username,first_name,last_name,email,section,github_id\n"

// rosterContentsMux serves the classroom50 contents API, returning `body` (a
// raw CSV) for whichever files are present, and 404 for anything else. Path key
// is like "cs/roster.csv".
func rosterContentsMux(t *testing.T, files map[string]string) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50/contents/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/repos/o/classroom50/contents/")
		body, ok := files[path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content":  base64.StdEncoding.EncodeToString([]byte(body)),
			"encoding": "base64",
		})
	})
	return mux
}

func TestLoadRoster_ReadsRosterCSV(t *testing.T) {
	server := httptest.NewServer(rosterContentsMux(t, map[string]string{
		"cs/roster.csv": rosterTestHeader + "alice,Ada,Lovelace,ada@uni.edu,A,1\n",
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	rows, err := LoadRoster(client, "o", "cs", "main")
	if err != nil {
		t.Fatalf("LoadRoster: %v", err)
	}
	if len(rows) != 1 || rows[0].Username != "alice" {
		t.Fatalf("rows = %+v, want a single alice row from roster.csv", rows)
	}
}

func TestLoadRoster_MissingErrorsNamingRosterCSV(t *testing.T) {
	server := httptest.NewServer(rosterContentsMux(t, map[string]string{}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	_, err := LoadRoster(client, "o", "cs", "main")
	if err == nil {
		t.Fatal("expected an error when roster.csv is absent")
	}
	if !strings.Contains(err.Error(), "cs/roster.csv") || !strings.Contains(err.Error(), "classroom add") {
		t.Errorf("error = %q, want it to name cs/roster.csv and point at `classroom add`", err)
	}
}

func TestLoadRoster_MalformedRosterCSVNamesRosterPath(t *testing.T) {
	server := httptest.NewServer(rosterContentsMux(t, map[string]string{
		"cs/roster.csv": "name,email\nalice,alice@uni.edu\n", // wrong header
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	_, err := LoadRoster(client, "o", "cs", "main")
	if err == nil {
		t.Fatal("expected a parse error for a malformed roster.csv")
	}
	if !strings.Contains(err.Error(), "cs/roster.csv") {
		t.Errorf("error = %q, want it to name the roster.csv path", err)
	}
}

// A non-404 error on the roster.csv read must propagate, NOT be masked as
// "roster missing" — otherwise a transient 5xx/permission failure could be
// silently swallowed.
func TestLoadRoster_Non404OnRosterPropagates(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50/contents/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	_, err := LoadRoster(client, "o", "cs", "main")
	if err == nil {
		t.Fatal("expected the 500 to propagate, got nil")
	}
}

// RosterWriteChange is the single seam every roster-mutating write funnels
// through: it always upserts roster.csv and never deletes anything.
func TestRosterWriteChange(t *testing.T) {
	rows := []RosterRow{{Username: "alice", GitHubID: 1}}

	change, err := RosterWriteChange("cs", rows)
	if err != nil {
		t.Fatalf("RosterWriteChange: %v", err)
	}
	if _, ok := change.Upserts[RosterFilePath("cs")]; !ok {
		t.Errorf("upserts = %v, want a roster.csv entry", change.Upserts)
	}
	if len(change.Deletes) != 0 {
		t.Errorf("deletes = %v, want none", change.Deletes)
	}
}
