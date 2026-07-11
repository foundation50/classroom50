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

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// rosterWriteMock is a minimal in-memory <org>/classroom50 server covering
// the contents read plus the git-data surface a roster write (CommitTree)
// touches: refs, commits, blobs, trees. files maps repo-relative path ->
// content; blobs records every POSTed blob so a test can assert what the edit
// re-encoded. It exposes no invite/membership/team endpoints, so a happy-path
// update also confirms runRosterUpdate never calls them.
type rosterWriteMock struct {
	files map[string]string
	blobs []string
	// treeEntries records the entries POSTed to /git/trees on the last write,
	// so a test can assert both the roster.csv upsert and any legacy deletion
	// (a deletion carries an explicit "sha": null).
	treeEntries []rosterTreeEntry
}

type rosterTreeEntry struct {
	Path    string  `json:"path"`
	Mode    string  `json:"mode"`
	Type    string  `json:"type"`
	Content *string `json:"content"`
	SHA     *string `json:"sha"`
}

func (m *rosterWriteMock) handler(t *testing.T) http.Handler {
	t.Helper()
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
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Tree []rosterTreeEntry `json:"tree"`
		}
		if err := json.Unmarshal(body, &payload); err == nil {
			m.treeEntries = payload.Tree
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees/", func(w http.ResponseWriter, r *http.Request) {
		dirs := map[string]bool{}
		var entries []map[string]string
		for p := range m.files {
			entries = append(entries, map[string]string{"path": p, "type": "blob"})
			if seg, _, found := strings.Cut(p, "/"); found {
				dirs[seg] = true
			}
		}
		for d := range dirs {
			entries = append(entries, map[string]string{"path": d, "type": "tree"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": entries, "truncated": false})
	})

	return mux
}

func rosterCSVContent(t *testing.T, rows ...configrepo.RosterRow) string {
	t.Helper()
	b, err := configrepo.EncodeRoster(rows)
	if err != nil {
		t.Fatalf("encode roster: %v", err)
	}
	return string(b)
}

func TestRunRosterUpdate(t *testing.T) {
	roster := rosterCSVContent(t,
		configrepo.RosterRow{Username: "alice", FirstName: "Alice", LastName: "A", Email: "a@x.edu", Section: "s1", GitHubID: 1},
		configrepo.RosterRow{Username: "bob", FirstName: "Bob", LastName: "B", Email: "b@x.edu", Section: "s1", GitHubID: 2},
	)
	strptr := func(s string) *string { return &s }

	t.Run("updates only the targeted field and commits once", func(t *testing.T) {
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": roster}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterUpdate(client, &out, "o", "cs-principles", "alice", configrepo.RosterPatch{Email: strptr("alice@new.edu")}); err != nil {
			t.Fatalf("runRosterUpdate: %v", err)
		}
		if !strings.Contains(out.String(), "updated alice") {
			t.Errorf("stdout = %q, want 'updated alice'", out.String())
		}
		if len(mock.blobs) != 1 {
			t.Fatalf("got %d blobs POSTed, want 1: %#v", len(mock.blobs), mock.blobs)
		}
		rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
		if err != nil {
			t.Fatalf("parse re-encoded roster: %v\n%s", err, mock.blobs[0])
		}
		var alice, bob configrepo.RosterRow
		for _, r := range rows {
			switch r.Username {
			case "alice":
				alice = r
			case "bob":
				bob = r
			}
		}
		if alice.Email != "alice@new.edu" {
			t.Errorf("alice email = %q, want alice@new.edu", alice.Email)
		}
		if alice.FirstName != "Alice" || alice.LastName != "A" || alice.Section != "s1" || alice.GitHubID != 1 {
			t.Errorf("alice non-email fields changed: %#v", alice)
		}
		if bob.Username != "bob" || bob.FirstName != "Bob" || bob.LastName != "B" || bob.Email != "b@x.edu" || bob.Section != "s1" || bob.GitHubID != 2 {
			t.Errorf("unrelated row (bob) changed: %#v", bob)
		}
	})

	t.Run("unknown username errors and commits nothing", func(t *testing.T) {
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": roster}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		err := runRosterUpdate(client, &out, "o", "cs-principles", "ghost", configrepo.RosterPatch{Email: strptr("g@x.edu")})
		if err == nil || !strings.Contains(err.Error(), "not in cs-principles roster") {
			t.Fatalf("err = %v, want 'not in cs-principles roster'", err)
		}
		if len(mock.blobs) != 0 {
			t.Errorf("expected no blob POSTed on not-found, got %d", len(mock.blobs))
		}
	})

	t.Run("no-op when patch matches current values", func(t *testing.T) {
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": roster}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterUpdate(client, &out, "o", "cs-principles", "alice", configrepo.RosterPatch{Email: strptr("a@x.edu")}); err != nil {
			t.Fatalf("runRosterUpdate: %v", err)
		}
		if !strings.Contains(out.String(), "already up to date") {
			t.Errorf("stdout = %q, want 'already up to date'", out.String())
		}
		if len(mock.blobs) != 0 {
			t.Errorf("expected no blob POSTed on no-op, got %d", len(mock.blobs))
		}
	})

	// The web app may append extra columns to roster.csv; a `roster update`
	// (which patches only canonical fields) must round-trip them so it never
	// silently wipes them. This drives the actual command path (LoadRoster ->
	// UpdateRosterRow -> EncodeRoster), not just the configrepo helpers.
	t.Run("preserves web extra columns on both edited and unrelated rows", func(t *testing.T) {
		extraRoster := rosterCSVContent(t,
			configrepo.RosterRow{
				Username: "alice", FirstName: "Alice", LastName: "A", Email: "a@x.edu", Section: "s1", GitHubID: 1,
				Extra:      map[string]string{"enrollment_status": "enrolled", "email_hash": "abcd1234ef567890"},
				ExtraOrder: []string{"enrollment_status", "email_hash"},
			},
			configrepo.RosterRow{
				Username: "bob", FirstName: "Bob", LastName: "B", Email: "b@x.edu", Section: "s1", GitHubID: 2,
				Extra:      map[string]string{"enrollment_status": "invited", "invite_token": "tok123"},
				ExtraOrder: []string{"enrollment_status", "invite_token"},
			},
		)
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": extraRoster}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterUpdate(client, &out, "o", "cs-principles", "alice", configrepo.RosterPatch{Email: strptr("alice@new.edu")}); err != nil {
			t.Fatalf("runRosterUpdate: %v", err)
		}
		if len(mock.blobs) != 1 {
			t.Fatalf("got %d blobs POSTed, want 1", len(mock.blobs))
		}
		rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
		if err != nil {
			t.Fatalf("parse re-encoded roster: %v\n%s", err, mock.blobs[0])
		}
		var alice, bob configrepo.RosterRow
		for _, r := range rows {
			switch r.Username {
			case "alice":
				alice = r
			case "bob":
				bob = r
			}
		}
		if alice.Email != "alice@new.edu" {
			t.Errorf("alice email = %q, want alice@new.edu", alice.Email)
		}
		if alice.Extra["enrollment_status"] != "enrolled" || alice.Extra["email_hash"] != "abcd1234ef567890" {
			t.Errorf("edited row lost extra columns: %#v", alice.Extra)
		}
		if bob.Extra["enrollment_status"] != "invited" || bob.Extra["invite_token"] != "tok123" {
			t.Errorf("unrelated row lost extra columns: %#v", bob.Extra)
		}
	})
}

// TestRunRosterRemove covers the `roster remove` command path. With no
// classroom.json mocked, ResolveClassroomTeam returns ok=false and the
// team-removal step is skipped, so the test exercises the LoadRoster ->
// RemoveRosterRow -> EncodeRoster write without needing team endpoints.
func TestRunRosterRemove(t *testing.T) {
	t.Run("removes the row and commits once", func(t *testing.T) {
		roster := rosterCSVContent(t,
			configrepo.RosterRow{Username: "alice", FirstName: "Alice", LastName: "A", Email: "a@x.edu", Section: "s1", GitHubID: 1},
			configrepo.RosterRow{Username: "bob", FirstName: "Bob", LastName: "B", Email: "b@x.edu", Section: "s1", GitHubID: 2},
		)
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": roster}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterRemove(client, &out, "o", "cs-principles", "alice"); err != nil {
			t.Fatalf("runRosterRemove: %v", err)
		}
		if !strings.Contains(out.String(), "removed alice") {
			t.Errorf("stdout = %q, want 'removed alice'", out.String())
		}
		if len(mock.blobs) != 1 {
			t.Fatalf("got %d blobs POSTed, want 1", len(mock.blobs))
		}
		rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
		if err != nil {
			t.Fatalf("parse re-encoded roster: %v\n%s", err, mock.blobs[0])
		}
		if len(rows) != 1 || rows[0].Username != "bob" {
			t.Fatalf("after removing alice, want only bob, got %#v", rows)
		}
	})

	// Removing one student must not wipe the extra columns of the
	// surviving students.
	t.Run("preserves web extra columns on surviving rows", func(t *testing.T) {
		roster := rosterCSVContent(t,
			configrepo.RosterRow{
				Username: "alice", FirstName: "Alice", LastName: "A", Email: "a@x.edu", Section: "s1", GitHubID: 1,
				Extra:      map[string]string{"enrollment_status": "enrolled"},
				ExtraOrder: []string{"enrollment_status"},
			},
			configrepo.RosterRow{
				Username: "bob", FirstName: "Bob", LastName: "B", Email: "b@x.edu", Section: "s1", GitHubID: 2,
				Extra:      map[string]string{"enrollment_status": "invited", "invite_token": "tok123"},
				ExtraOrder: []string{"enrollment_status", "invite_token"},
			},
		)
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": roster}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterRemove(client, &out, "o", "cs-principles", "alice"); err != nil {
			t.Fatalf("runRosterRemove: %v", err)
		}
		if len(mock.blobs) != 1 {
			t.Fatalf("got %d blobs POSTed, want 1", len(mock.blobs))
		}
		rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
		if err != nil {
			t.Fatalf("parse re-encoded roster: %v\n%s", err, mock.blobs[0])
		}
		if len(rows) != 1 || rows[0].Username != "bob" {
			t.Fatalf("after removing alice, want only bob, got %#v", rows)
		}
		if rows[0].Extra["enrollment_status"] != "invited" || rows[0].Extra["invite_token"] != "tok123" {
			t.Errorf("surviving row lost extra columns: %#v", rows[0].Extra)
		}
	})
}

// TestRosterWriteMigratesLegacy verifies migrate-on-write: a roster write on a
// classroom that still has only the legacy students.csv (never migrated) writes
// the combined content to roster.csv AND deletes students.csv in the same
// commit, converging the classroom onto the current name. A classroom already
// on roster.csv is left alone (no spurious legacy deletion).
func TestRosterWriteMigratesLegacy(t *testing.T) {
	legacy := rosterCSVContent(t,
		configrepo.RosterRow{Username: "alice", FirstName: "Alice", LastName: "A", Email: "a@x.edu", Section: "s1", GitHubID: 1},
	)
	strptr := func(s string) *string { return &s }

	// treeDelete returns the deletion entry (sha:null) for path, if present.
	findDelete := func(entries []rosterTreeEntry, path string) (rosterTreeEntry, bool) {
		for _, e := range entries {
			if e.Path == path && e.SHA == nil {
				return e, true
			}
		}
		return rosterTreeEntry{}, false
	}
	findUpsert := func(entries []rosterTreeEntry, path string) bool {
		for _, e := range entries {
			if e.Path == path && e.SHA != nil {
				return true
			}
		}
		return false
	}

	t.Run("legacy-only classroom: update writes roster.csv and deletes students.csv", func(t *testing.T) {
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/students.csv": legacy}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterUpdate(client, &out, "o", "cs-principles", "alice", configrepo.RosterPatch{Email: strptr("alice@new.edu")}); err != nil {
			t.Fatalf("runRosterUpdate: %v", err)
		}
		if len(mock.blobs) != 1 {
			t.Fatalf("got %d blobs POSTed, want 1", len(mock.blobs))
		}
		// The migrated content lands on roster.csv, carrying the edit.
		rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
		if err != nil {
			t.Fatalf("parse re-encoded roster: %v\n%s", err, mock.blobs[0])
		}
		if len(rows) != 1 || rows[0].Username != "alice" || rows[0].Email != "alice@new.edu" {
			t.Fatalf("migrated roster.csv = %#v, want a single alice row with the edited email", rows)
		}
		if !findUpsert(mock.treeEntries, "cs-principles/roster.csv") {
			t.Errorf("tree = %#v, want a roster.csv upsert", mock.treeEntries)
		}
		if _, ok := findDelete(mock.treeEntries, "cs-principles/students.csv"); !ok {
			t.Errorf("tree = %#v, want a students.csv deletion (sha:null)", mock.treeEntries)
		}
	})

	t.Run("roster.csv classroom: no legacy deletion", func(t *testing.T) {
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": legacy}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		if err := runRosterUpdate(client, &out, "o", "cs-principles", "alice", configrepo.RosterPatch{Email: strptr("alice@new.edu")}); err != nil {
			t.Fatalf("runRosterUpdate: %v", err)
		}
		if _, ok := findDelete(mock.treeEntries, "cs-principles/students.csv"); ok {
			t.Errorf("tree = %#v, must NOT delete students.csv when the classroom is already on roster.csv", mock.treeEntries)
		}
	})

	// A no-op edit (patch matches current) on a legacy-only classroom must not
	// commit anything — and therefore must NOT migrate. Migration rides an
	// actual write, never a no-change command.
	t.Run("legacy-only classroom: a no-op update does not migrate", func(t *testing.T) {
		mock := &rosterWriteMock{files: map[string]string{"cs-principles/students.csv": legacy}}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out bytes.Buffer
		// alice's email in `legacy` is already a@x.edu — patching to the same
		// value is a no-op.
		if err := runRosterUpdate(client, &out, "o", "cs-principles", "alice", configrepo.RosterPatch{Email: strptr("a@x.edu")}); err != nil {
			t.Fatalf("runRosterUpdate: %v", err)
		}
		if len(mock.blobs) != 0 || len(mock.treeEntries) != 0 {
			t.Errorf("no-op update committed a tree (blobs=%v, tree=%#v); the legacy file must be left untouched", mock.blobs, mock.treeEntries)
		}
	})
}

// "nothing to update" guard and email validation run inside RunE before any
// auth/network, so these cases need no server (a stray HTTP call would be a
// bug — RequireAuthClient is only reached after the guard).
func TestRosterUpdateCmd(t *testing.T) {
	// run drives the command as the CLI does (flag parse + RunE).
	run := func(t *testing.T, args ...string) error {
		t.Helper()
		cmd := rosterUpdateCmd()
		cmd.SilenceErrors = true
		cmd.SilenceUsage = true
		cmd.SetArgs(args)
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		return cmd.Execute()
	}

	t.Run("no data flags errors with 'nothing to update' before any auth/network", func(t *testing.T) {
		err := run(t, "o", "cs-principles", "alice")
		if err == nil || !strings.Contains(err.Error(), "nothing to update") {
			t.Fatalf("err = %v, want 'nothing to update'", err)
		}
	})

	t.Run("invalid --email is rejected before any auth/network", func(t *testing.T) {
		// Display-name form is rejected by ValidateRosterEmail (before auth).
		err := run(t, "o", "cs-principles", "alice", "--email", "Alice <a@x.edu>")
		if err == nil || !strings.Contains(err.Error(), "invalid email") {
			t.Fatalf("err = %v, want 'invalid email'", err)
		}
	})

	t.Run("blank classroom is rejected before any auth/network", func(t *testing.T) {
		err := run(t, "o", "   ", "alice", "--first-name", "Alice")
		if err == nil {
			t.Fatalf("err = nil, want a classroom validation error")
		}
	})
}

// TestRosterUpdateCmdPatchBuilder verifies the Changed()-gated patch builder:
// only flags passed become non-nil fields (an omitted flag leaves its column
// alone), and `--email ""` is a present-but-empty (clearing) patch, distinct
// from an omitted --email. This is the invariant that makes update
// non-destructive where add rewrites the whole row.
func TestRosterUpdateCmdPatchBuilder(t *testing.T) {
	build := func(t *testing.T, args ...string) configrepo.RosterPatch {
		t.Helper()
		cmd := rosterUpdateCmd()
		flags := cmd.Flags()
		if err := flags.Parse(args); err != nil {
			t.Fatalf("parse flags %v: %v", args, err)
		}
		var patch configrepo.RosterPatch
		if flags.Changed("first-name") {
			v, _ := flags.GetString("first-name")
			v = strings.TrimSpace(v)
			patch.FirstName = &v
		}
		if flags.Changed("last-name") {
			v, _ := flags.GetString("last-name")
			v = strings.TrimSpace(v)
			patch.LastName = &v
		}
		if flags.Changed("email") {
			v, _ := flags.GetString("email")
			v = strings.TrimSpace(v)
			patch.Email = &v
		}
		if flags.Changed("section") {
			v, _ := flags.GetString("section")
			v = strings.TrimSpace(v)
			patch.Section = &v
		}
		return patch
	}

	t.Run("omitted flags stay nil; only passed flags are set", func(t *testing.T) {
		patch := build(t, "--email", "new@x.edu")
		if patch.Email == nil || *patch.Email != "new@x.edu" {
			t.Errorf("Email = %v, want pointer to new@x.edu", patch.Email)
		}
		if patch.FirstName != nil || patch.LastName != nil || patch.Section != nil {
			t.Errorf("omitted flags must stay nil: %+v", patch)
		}
	})

	t.Run("--email \"\" is a present, empty patch (clear), not omitted", func(t *testing.T) {
		patch := build(t, "--email", "")
		if patch.Email == nil {
			t.Fatalf("--email \"\" must produce a non-nil (clearing) Email patch, got nil")
		}
		if *patch.Email != "" {
			t.Errorf("Email = %q, want empty (cleared)", *patch.Email)
		}
	})
}
