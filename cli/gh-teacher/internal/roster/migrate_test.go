package roster

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// migrateMock serves the <org>/classroom50 contents + git-data surface a
// `roster migrate` touches. files maps repo-relative path -> content (present
// files); a path absent from the map 404s on both contents reads and existence
// checks. treeExtra lists paths that appear in the recursive tree listing but
// are NOT in files — i.e. the git tree says the blob exists while a contents
// GET 404s, modelling the eventual-consistency/spurious-404 case. tree records
// the last git Tree payload so a test can assert which paths were upserted
// (non-null sha) vs deleted (null sha).
type migrateMock struct {
	files     map[string]string
	treeExtra []string
	blobs     []string
	treeSeen  map[string]*string
	treePost  bool
}

func (m *migrateMock) handler(t *testing.T) http.Handler {
	t.Helper()
	m.treeSeen = map[string]*string{}
	mux := http.NewServeMux()

	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/", func(w http.ResponseWriter, r *http.Request) {
		repoPath := strings.TrimPrefix(r.URL.Path, "/repos/o/classroom50/contents/")
		if content, ok := m.files[repoPath]; ok {
			_ = json.NewEncoder(w).Encode(map[string]string{
				"content":  base64.StdEncoding.EncodeToString([]byte(content)),
				"encoding": "base64",
			})
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
		case http.MethodPatch:
			w.WriteHeader(http.StatusOK)
		}
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var blob struct {
			Content  string `json:"content"`
			Encoding string `json:"encoding"`
		}
		if err := json.Unmarshal(body, &blob); err == nil {
			if decoded, derr := base64.StdEncoding.DecodeString(blob.Content); derr == nil {
				m.blobs = append(m.blobs, string(decoded))
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees", func(w http.ResponseWriter, r *http.Request) {
		m.treePost = true
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Tree []struct {
				Path string  `json:"path"`
				SHA  *string `json:"sha"`
			} `json:"tree"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("unmarshal tree payload: %v", err)
		}
		for _, e := range payload.Tree {
			m.treeSeen[e.Path] = e.SHA
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	// Recursive-tree read used by the workflow-scope classifier's parent scan
	// AND by the migrator's presence check. Lists every present file plus any
	// treeExtra path (present in the tree but 404ing on contents).
	mux.HandleFunc("/repos/o/classroom50/git/trees/", func(w http.ResponseWriter, r *http.Request) {
		var entries []map[string]string
		for p := range m.files {
			entries = append(entries, map[string]string{"path": p, "type": "blob"})
		}
		for _, p := range m.treeExtra {
			entries = append(entries, map[string]string{"path": p, "type": "blob"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": entries, "truncated": false})
	})
	return mux
}

const migrateLegacyRoster = "username,first_name,last_name,email,section,github_id\n" +
	"alice,Ada,Lovelace,ada@uni.edu,A,1\n"

func TestRunRosterMigrate(t *testing.T) {
	t.Run("renames students.csv to roster.csv in one commit", func(t *testing.T) {
		mock := &migrateMock{files: map[string]string{
			"cs-principles/students.csv": migrateLegacyRoster,
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterMigrate(client, &out, "o", "cs-principles"); err != nil {
			t.Fatalf("runRosterMigrate: %v", err)
		}

		if !strings.Contains(out.String(), "migrated") || !strings.Contains(out.String(), "roster.csv") {
			t.Errorf("stdout = %q, want a 'migrated ... roster.csv' line", out.String())
		}
		// roster.csv upserted with the legacy bytes verbatim.
		if len(mock.blobs) != 1 || mock.blobs[0] != migrateLegacyRoster {
			t.Fatalf("blobs = %#v, want exactly the legacy roster bytes", mock.blobs)
		}
		if sha, ok := mock.treeSeen["cs-principles/roster.csv"]; !ok || sha == nil {
			t.Errorf("roster.csv tree entry = %v (ok=%v), want an upsert with a blob sha", sha, ok)
		}
		// students.csv deleted (null sha).
		sha, ok := mock.treeSeen["cs-principles/students.csv"]
		if !ok {
			t.Fatal("students.csv missing from the tree payload — the legacy file was not deleted")
		}
		if sha != nil {
			t.Errorf("students.csv tree sha = %v, want null (deletion)", *sha)
		}
	})

	t.Run("already migrated is a no-op", func(t *testing.T) {
		mock := &migrateMock{files: map[string]string{
			"cs-principles/roster.csv": migrateLegacyRoster,
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterMigrate(client, &out, "o", "cs-principles"); err != nil {
			t.Fatalf("runRosterMigrate: %v", err)
		}
		if mock.treePost {
			t.Error("no tree/commit should be POSTed when already migrated")
		}
		if !strings.Contains(out.String(), "already migrated") {
			t.Errorf("stdout = %q, want an 'already migrated' note", out.String())
		}
	})

	t.Run("neither file present errors and points at classroom add", func(t *testing.T) {
		mock := &migrateMock{files: map[string]string{}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		err := runRosterMigrate(client, &out, "o", "cs-principles")
		if err == nil {
			t.Fatal("expected an error when neither roster.csv nor students.csv exists")
		}
		if !strings.Contains(err.Error(), "nothing to migrate") || !strings.Contains(err.Error(), "classroom add") {
			t.Errorf("error = %q, want 'nothing to migrate' pointing at `classroom add`", err)
		}
	})

	t.Run("both present prefers roster.csv and still deletes the legacy file", func(t *testing.T) {
		mock := &migrateMock{files: map[string]string{
			"cs-principles/roster.csv":   migrateLegacyRoster,
			"cs-principles/students.csv": migrateLegacyRoster,
		}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterMigrate(client, &out, "o", "cs-principles"); err != nil {
			t.Fatalf("runRosterMigrate: %v", err)
		}
		// roster.csv already exists → no blob upsert, but the legacy file is deleted.
		if len(mock.blobs) != 0 {
			t.Errorf("blobs = %#v, want none (roster.csv already canonical)", mock.blobs)
		}
		sha, ok := mock.treeSeen["cs-principles/students.csv"]
		if !ok || sha != nil {
			t.Errorf("students.csv tree entry = %v (ok=%v), want a deletion (null sha)", sha, ok)
		}
		if _, ok := mock.treeSeen["cs-principles/roster.csv"]; ok {
			t.Error("roster.csv must not be rewritten when it already exists")
		}
	})

	// Branch selection is driven by the tree listing at parentSHA, NOT by
	// per-path contents 404s. A spurious/consistency-lag 404 on roster.csv (the
	// tree says it exists, but a contents GET would 404) must NOT flip the
	// migrator into re-migrating or clobbering it: with the legacy file also
	// present it takes the delete-only branch and never reads roster.csv.
	t.Run("roster.csv present in tree but 404ing on contents still takes the delete-only branch", func(t *testing.T) {
		mock := &migrateMock{
			files: map[string]string{
				"cs-principles/students.csv": migrateLegacyRoster,
			},
			// roster.csv is in the tree (canonical), but absent from files so a
			// contents GET 404s — the eventual-consistency case.
			treeExtra: []string{"cs-principles/roster.csv"},
		}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterMigrate(client, &out, "o", "cs-principles"); err != nil {
			t.Fatalf("runRosterMigrate: %v", err)
		}
		// roster.csv seen in the tree → not rewritten, and no blob upserted.
		if len(mock.blobs) != 0 {
			t.Errorf("blobs = %#v, want none (roster.csv already canonical per the tree)", mock.blobs)
		}
		if _, ok := mock.treeSeen["cs-principles/roster.csv"]; ok {
			t.Error("roster.csv must not be rewritten when the tree shows it exists")
		}
		// legacy still deleted.
		sha, ok := mock.treeSeen["cs-principles/students.csv"]
		if !ok || sha != nil {
			t.Errorf("students.csv tree entry = %v (ok=%v), want a deletion (null sha)", sha, ok)
		}
	})

	// A spurious 404 on the legacy contents read while the tree shows it present
	// (a genuine race, or a lag blip) must fail loud so the rebase loop retries
	// against fresh state — never commit an empty roster.csv.
	t.Run("legacy present in tree but 404ing on contents fails loud rather than writing an empty roster", func(t *testing.T) {
		mock := &migrateMock{
			files: map[string]string{},
			// students.csv is in the tree, but absent from files so its contents
			// GET 404s after the tree listing saw it.
			treeExtra: []string{"cs-principles/students.csv"},
		}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		err := runRosterMigrate(client, &out, "o", "cs-principles")
		if err == nil {
			t.Fatal("expected an error when the legacy file vanished between listing and read")
		}
		if len(mock.blobs) != 0 {
			t.Errorf("blobs = %#v, want none — must not write an empty roster.csv", mock.blobs)
		}
		if mock.treePost {
			t.Error("no tree/commit should be POSTed when the legacy read failed")
		}
	})
}
