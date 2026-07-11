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
// raw CSV) for whichever of roster.csv / students.csv is present in `files`,
// and 404 for the other. Path key is like "cs/roster.csv".
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
		// A legacy file also present must be ignored — roster.csv wins.
		"cs/students.csv": rosterTestHeader + "bob,Bob,Bee,bob@uni.edu,B,2\n",
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	rows, err := LoadRoster(client, "o", "cs", "main")
	if err != nil {
		t.Fatalf("LoadRoster: %v", err)
	}
	if len(rows) != 1 || rows[0].Username != "alice" {
		t.Fatalf("rows = %+v, want a single alice row from roster.csv (not the legacy students.csv)", rows)
	}
}

func TestLoadRoster_FallsBackToLegacyStudentsCSV(t *testing.T) {
	server := httptest.NewServer(rosterContentsMux(t, map[string]string{
		// roster.csv absent; only the legacy file exists.
		"cs/students.csv": rosterTestHeader + "bob,Bob,Bee,bob@uni.edu,B,2\n",
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	rows, err := LoadRoster(client, "o", "cs", "main")
	if err != nil {
		t.Fatalf("LoadRoster: %v", err)
	}
	if len(rows) != 1 || rows[0].Username != "bob" {
		t.Fatalf("rows = %+v, want the legacy students.csv row", rows)
	}
}

func TestLoadRoster_MissingBothErrorsNamingRosterCSV(t *testing.T) {
	server := httptest.NewServer(rosterContentsMux(t, map[string]string{}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	_, err := LoadRoster(client, "o", "cs", "main")
	if err == nil {
		t.Fatal("expected an error when both roster.csv and students.csv are absent")
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
		t.Errorf("error = %q, want it to name the roster.csv path (not the legacy fallback)", err)
	}
	if strings.Contains(err.Error(), "students.csv") {
		t.Errorf("error = %q, must not mention students.csv when roster.csv itself is malformed", err)
	}
}

// A non-404 error on the roster.csv read must propagate, NOT trigger the legacy
// fallback — otherwise a transient 5xx/permission failure would be silently
// masked as "roster missing, use students.csv" and could read stale data.
func TestLoadRoster_Non404OnRosterDoesNotFallBack(t *testing.T) {
	var legacyRequested bool
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/classroom50/contents/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/repos/o/classroom50/contents/")
		if strings.HasSuffix(path, "students.csv") {
			legacyRequested = true
		}
		// roster.csv (and anything else) returns a 500, not a 404.
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	_, err := LoadRoster(client, "o", "cs", "main")
	if err == nil {
		t.Fatal("expected the 500 to propagate, got nil")
	}
	if legacyRequested {
		t.Error("students.csv must NOT be requested when roster.csv fails with a non-404 error")
	}
}

// RosterWriteChange is the single seam every roster-mutating write funnels
// through, so its delete gate is the invariant that decides whether a write
// migrates. Pin both directions: a legacy source converges (write roster.csv +
// delete the legacy file), a roster.csv source never emits a spurious delete.
func TestRosterWriteChange(t *testing.T) {
	rows := []RosterRow{{Username: "alice", GitHubID: 1}}

	t.Run("legacy source: writes roster.csv and deletes the legacy file", func(t *testing.T) {
		change, err := RosterWriteChange("cs", LegacyRosterFilePath("cs"), rows)
		if err != nil {
			t.Fatalf("RosterWriteChange: %v", err)
		}
		if _, ok := change.Upserts[RosterFilePath("cs")]; !ok {
			t.Errorf("upserts = %v, want a roster.csv entry", change.Upserts)
		}
		if len(change.Deletes) != 1 || change.Deletes[0] != LegacyRosterFilePath("cs") {
			t.Errorf("deletes = %v, want exactly the legacy path", change.Deletes)
		}
	})

	t.Run("roster.csv source: no legacy deletion", func(t *testing.T) {
		change, err := RosterWriteChange("cs", RosterFilePath("cs"), rows)
		if err != nil {
			t.Fatalf("RosterWriteChange: %v", err)
		}
		if _, ok := change.Upserts[RosterFilePath("cs")]; !ok {
			t.Errorf("upserts = %v, want a roster.csv entry", change.Upserts)
		}
		if len(change.Deletes) != 0 {
			t.Errorf("deletes = %v, want none when the source is already roster.csv", change.Deletes)
		}
	})
}
