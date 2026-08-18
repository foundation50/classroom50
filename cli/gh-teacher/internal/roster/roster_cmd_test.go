package roster

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

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

// inviteCall is one recorded request. Order is the contract several of the
// invite-lifecycle tests assert on (e.g. the email record is the LAST team
// write, and the roster commit follows the invitation).
type inviteCall struct {
	Method      string
	Path        string
	Description string
}

// recordCalls appends every request to dst before the mux sees it. The body is
// restored so the mux's own handlers can still read it, and a `description`
// field is decoded eagerly for the record-ordering assertions.
func recordCalls(dst *[]inviteCall, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw []byte
		if r.Body != nil {
			raw, _ = io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewReader(raw))
		}
		var body struct {
			Description string `json:"description"`
		}
		_ = json.Unmarshal(raw, &body)
		*dst = append(*dst, inviteCall{
			Method: r.Method, Path: r.URL.Path, Description: body.Description,
		})
		next.ServeHTTP(w, r)
	})
}

// indexOfCall is the position of the first method+path match, or -1.
func indexOfCall(calls []inviteCall, method, path string) int {
	for i, c := range calls {
		if c.Method == method && c.Path == path {
			return i
		}
	}
	return -1
}

func countCalls(calls []inviteCall, method, path string) int {
	n := 0
	for _, c := range calls {
		if c.Method == method && c.Path == path {
			n++
		}
	}
	return n
}

// writeCalls returns every recorded request that mutates server state, so a
// report-only path can be asserted to have made none.
func writeCalls(calls []inviteCall) []inviteCall {
	var out []inviteCall
	for _, c := range calls {
		switch c.Method {
		case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
			out = append(out, c)
		}
	}
	return out
}

// runRosterSubcommand drives a subcommand as the CLI does (flag parse + RunE),
// for the guards that must reject before any auth or network happens.
func runRosterSubcommand(t *testing.T, cmd *cobra.Command, args ...string) error {
	t.Helper()
	cmd.SilenceErrors = true
	cmd.SilenceUsage = true
	cmd.SetArgs(args)
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	return cmd.Execute()
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

// "nothing to update" guard and email validation run inside RunE before any
// auth/network, so these cases need no server (a stray HTTP call would be a
// bug — RequireAuthClient is only reached after the guard).
func TestRosterUpdateCmd(t *testing.T) {
	run := func(t *testing.T, args ...string) error {
		t.Helper()
		return runRosterSubcommand(t, rosterUpdateCmd(), args...)
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

// TestRunRosterRemove_PreservesMalformedRow is the command-level guard for issue
// #207 on the simplest write path (remove needs no user-lookup/invite mocks): a
// pre-existing malformed row (empty username on line 2) must not block the
// command, and must round-trip untouched into the written file.
func TestRunRosterRemove_PreservesMalformedRow(t *testing.T) {
	roster := "username,first_name,last_name,email,section,github_id,role\n" +
		",Ghost,G,,,,\n" + // malformed: empty username, strict parse would abort
		"alice,Alice,A,a@x.edu,s1,1,student\n" +
		"bob,Bob,B,b@x.edu,s1,2,student\n"

	mock := &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": roster}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out bytes.Buffer
	if err := runRosterRemove(client, &out, "o", "cs-principles", "alice"); err != nil {
		t.Fatalf("runRosterRemove must tolerate a malformed pre-existing row: %v", err)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("got %d blobs POSTed, want 1", len(mock.blobs))
	}
	// The written file must still carry the untouched malformed row and bob.
	if !strings.Contains(mock.blobs[0], ",Ghost,G,,,,") {
		t.Errorf("malformed row was dropped or rewritten:\n%s", mock.blobs[0])
	}
	rows, err := configrepo.ParseRosterLenient([]byte(mock.blobs[0]))
	if err != nil {
		t.Fatalf("re-parse written roster: %v\n%s", err, mock.blobs[0])
	}
	var haveBob, haveAlice bool
	for _, r := range rows {
		switch r.Username {
		case "bob":
			haveBob = true
		case "alice":
			haveAlice = true
		}
	}
	if !haveBob || haveAlice {
		t.Errorf("want bob kept and alice removed, got %#v", rows)
	}
}

// rosterAddMock extends the write mock with the user-lookup and org-invite
// endpoints runRosterAdd calls. No classroom.json is served, so the team step
// warns-and-skips (returns nil) — keeping the test focused on the commit path.
type rosterAddMock struct{ *rosterWriteMock }

func (m *rosterAddMock) handler(t *testing.T) http.Handler {
	t.Helper()
	base := m.rosterWriteMock.handler(t).(*http.ServeMux)
	base.HandleFunc("/users/", func(w http.ResponseWriter, r *http.Request) {
		login := strings.TrimPrefix(r.URL.Path, "/users/")
		_ = json.NewEncoder(w).Encode(map[string]any{"login": login, "id": 999})
	})
	base.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 1})
	})
	return base
}

// TestRunRosterAdd_PreservesMalformedRow is the direct reproduction of issue
// #207: `roster add` over a roster whose line 2 has an empty username must
// succeed (previously it failed with "line 2: username column is empty") and
// preserve the malformed row.
func TestRunRosterAdd_PreservesMalformedRow(t *testing.T) {
	roster := "username,first_name,last_name,email,section,github_id,role\n" +
		",Ghost,G,,,,\n" + // the malformed row from the issue
		"alice,Alice,A,a@x.edu,s1,1,student\n"

	mock := &rosterAddMock{&rosterWriteMock{files: map[string]string{"ai26/roster.csv": roster}}}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runRosterAdd(client, &out, &errOut, "o", "ai26", "aristotea", "", "", "", ""); err != nil {
		t.Fatalf("runRosterAdd must tolerate a malformed pre-existing row: %v", err)
	}
	if len(mock.blobs) != 1 {
		t.Fatalf("got %d blobs POSTed, want 1", len(mock.blobs))
	}
	if !strings.Contains(mock.blobs[0], ",Ghost,G,,,,") {
		t.Errorf("malformed row was dropped or rewritten:\n%s", mock.blobs[0])
	}
	rows, err := configrepo.ParseRosterLenient([]byte(mock.blobs[0]))
	if err != nil {
		t.Fatalf("re-parse written roster: %v\n%s", err, mock.blobs[0])
	}
	var haveNew bool
	for _, r := range rows {
		if r.Username == "aristotea" {
			haveNew = true
		}
	}
	if !haveNew {
		t.Errorf("added student aristotea missing from written roster: %#v", rows)
	}
}

// dualRoleAddMock extends rosterAddMock with classroom.json (carrying staff-team
// refs) and staff-team member endpoints, so runRosterAdd's best-effort
// dual-role check can resolve teams and find (or not find) the target on them.
// staffMembers maps a team slug -> the logins it lists.
type dualRoleAddMock struct {
	*rosterWriteMock
	classroomJSON string
	staffMembers  map[string][]string
}

func (m *dualRoleAddMock) handler(t *testing.T) http.Handler {
	t.Helper()
	base := m.rosterWriteMock.handler(t).(*http.ServeMux)
	base.HandleFunc("/users/", func(w http.ResponseWriter, r *http.Request) {
		login := strings.TrimPrefix(r.URL.Path, "/users/")
		_ = json.NewEncoder(w).Encode(map[string]any{"login": login, "id": 999})
	})
	base.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 1})
	})
	// classroom.json read (ResolveClassroomTeam / ResolveClassroomStaffTeam).
	base.HandleFunc("/repos/o/classroom50/contents/ai26/classroom.json", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"content":  base64.StdEncoding.EncodeToString([]byte(m.classroomJSON)),
			"encoding": "base64",
		})
	})
	// Staff-team member lists (ListTeamMembers) + team membership PUTs (the
	// classroom-team add in runRosterAdd). A slug not in staffMembers 404s on
	// /members -> ListTeamMembers treats it as empty.
	base.HandleFunc("/orgs/o/teams/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/orgs/o/teams/")
		slug, tail, _ := strings.Cut(rest, "/")
		// PUT .../memberships/<user>: the classroom-team add. Accept it.
		if strings.HasPrefix(tail, "memberships/") {
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{"state": "active"})
			return
		}
		if tail != "members" {
			http.NotFound(w, r)
			return
		}
		logins, ok := m.staffMembers[slug]
		if !ok {
			http.NotFound(w, r)
			return
		}
		var members []map[string]any
		for _, l := range logins {
			members = append(members, map[string]any{"login": l, "id": 1})
		}
		_ = json.NewEncoder(w).Encode(members)
	})
	return base
}

// rosterImportMock extends the write mock with the user-lookup and org-invite
// endpoints the import path calls. userIDs maps login -> id; a username absent
// from it 404s, which is how the unknown-username failures are driven. No
// classroom.json is served, so the team step warns and skips.
type rosterImportMock struct {
	*rosterWriteMock
	userIDs map[string]int64
}

func (m *rosterImportMock) handler(t *testing.T) http.Handler {
	t.Helper()
	base := m.rosterWriteMock.handler(t).(*http.ServeMux)
	base.HandleFunc("/users/", func(w http.ResponseWriter, r *http.Request) {
		login := strings.TrimPrefix(r.URL.Path, "/users/")
		id, ok := m.userIDs[login]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"login": login, "id": id})
	})
	base.HandleFunc("/orgs/o/invitations", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 1})
	})
	return base
}

// runImport drives `roster import` end-to-end against a mocked config repo:
// stored is the committed roster.csv, file the teacher's import CSV.
func runImport(t *testing.T, stored, file string, userIDs map[string]int64) (*rosterImportMock, string, string, error) {
	t.Helper()
	mock := &rosterImportMock{
		rosterWriteMock: &rosterWriteMock{files: map[string]string{"cs-principles/roster.csv": stored}},
		userIDs:         userIDs,
	}
	server := httptest.NewServer(mock.handler(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	path := filepath.Join(t.TempDir(), "import.csv")
	if err := os.WriteFile(path, []byte(file), 0o600); err != nil {
		t.Fatalf("write import csv: %v", err)
	}
	var out, errOut bytes.Buffer
	err := runRosterImport(client, &out, &errOut, "o", "cs-principles", path)
	return mock, out.String(), errOut.String(), err
}

// committedRow finds a row in the single POSTed blob, keyed by username (or by
// email for a pending email-invite row, which has no username).
func committedRow(t *testing.T, mock *rosterImportMock, username, email string) configrepo.RosterRow {
	t.Helper()
	if len(mock.blobs) != 1 {
		t.Fatalf("got %d blobs POSTed, want 1: %#v", len(mock.blobs), mock.blobs)
	}
	rows, err := configrepo.ParseRoster([]byte(mock.blobs[0]))
	if err != nil {
		t.Fatalf("parse committed roster: %v\n%s", err, mock.blobs[0])
	}
	for _, r := range rows {
		if username != "" && r.Username == username {
			return r
		}
		if username == "" && r.Username == "" && strings.EqualFold(r.Email, email) {
			return r
		}
	}
	t.Fatalf("no committed row for username=%q email=%q:\n%s", username, email, mock.blobs[0])
	return configrepo.RosterRow{}
}

const storedRosterHeader = "username,first_name,last_name,email,section,github_id,role\n"

// TestRunRosterImport covers the stored-roster-shape import: account rows keep
// the resolve/upsert path, email-only rows patch a pending row's metadata, and
// anything the CLI can't act on is a notice, not a silent write.
func TestRunRosterImport(t *testing.T) {
	t.Run("stored 7-column export imports cleanly", func(t *testing.T) {
		stored := storedRosterHeader +
			"alice,Alice,A,a@x.edu,s1,1,student\n" +
			",,,pending@x.edu,,,student\n"
		file := storedRosterHeader +
			"alice,Alice,A,a@x.edu,s1,1,student\n" +
			",Bob,B,pending@x.edu,s2,,student\n"

		mock, out, _, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err != nil {
			t.Fatalf("runRosterImport: %v", err)
		}
		pending := committedRow(t, mock, "", "pending@x.edu")
		if pending.FirstName != "Bob" || pending.LastName != "B" || pending.Section != "s2" {
			t.Errorf("pending row did not gain name/section: %#v", pending)
		}
		if pending.Email != "pending@x.edu" || pending.Role != "student" || pending.GitHubID != 0 {
			t.Errorf("pending row lost its email/role or gained an id: %#v", pending)
		}
		if alice := committedRow(t, mock, "alice", ""); alice.GitHubID != 1 {
			t.Errorf("account row missing or unresolved: %#v", alice)
		}
		if !strings.Contains(out, "1 pending metadata updated") {
			t.Errorf("stdout should count the pending metadata update:\n%s", out)
		}
	})

	t.Run("reports every unusable line in one error and commits nothing", func(t *testing.T) {
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n"
		file := storedRosterHeader +
			"ghost,G,G,,,,\n" +
			"phantom,P,P,,,,\n"

		mock, _, _, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err == nil {
			t.Fatal("err = nil, want a report naming both unusable lines")
		}
		for _, want := range []string{"line 2", "ghost", "line 3", "phantom"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error must name %q:\n%v", want, err)
			}
		}
		if len(mock.blobs) != 0 {
			t.Errorf("nothing may be committed when a line fails, got %d blobs", len(mock.blobs))
		}
	})

	// A parse-level failure and a resolution-level one are found by two
	// different passes, so a file carrying one of each must still report BOTH
	// before refusing — otherwise fixing the reported line only reveals the
	// next, one round-trip per bad row. The resolution failure sits AFTER the
	// parse failures on purpose: its line number must be the file's, which no
	// position in the surviving-row slice can stand in for.
	t.Run("a parse-level and a resolution-level bad line report together", func(t *testing.T) {
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n"
		file := storedRosterHeader +
			"alice,Alice,A,not-an-email,s1,,student\n" + // line 2: unparseable email
			"bob,B,B,also-not-an-email,s1,,student\n" + // line 3: same
			"ghost,G,G,,,,\n" // line 4: no such account

		mock, _, _, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err == nil {
			t.Fatal("err = nil, want a report naming every unusable line")
		}
		for _, want := range []string{
			"3 row(s) can't be imported, so nothing was committed",
			"line 2", "not-an-email", "line 3", "line 4 (ghost)",
		} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error must name %q:\n%v", want, err)
			}
		}
		if len(mock.blobs) != 0 {
			t.Errorf("nothing may be committed when a line fails, got %d blobs", len(mock.blobs))
		}
	})

	// A header error is not per-row, so it has no failure list to join and must
	// still surface on its own.
	t.Run("a bad header still fails on its own", func(t *testing.T) {
		mock, _, _, err := runImport(t, storedRosterHeader, "nope,wrong\nx,y\n", nil)
		if err == nil || !strings.Contains(err.Error(), "unexpected header") {
			t.Fatalf("err = %v, want an 'unexpected header' error", err)
		}
		if len(mock.blobs) != 0 {
			t.Errorf("a bad header must commit nothing, got %d blobs", len(mock.blobs))
		}
	})

	t.Run("github_id disagreeing with the resolved account fails the line", func(t *testing.T) {
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n"
		file := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,777,student\n"

		mock, _, _, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err == nil {
			t.Fatal("err = nil, want a github_id mismatch failure")
		}
		if !strings.Contains(err.Error(), "777") || !strings.Contains(err.Error(), "1") {
			t.Errorf("error must name both ids:\n%v", err)
		}
		if len(mock.blobs) != 0 {
			t.Errorf("a mismatch must commit nothing, got %d blobs", len(mock.blobs))
		}
	})

	t.Run("github_id matching the resolved account imports fine", func(t *testing.T) {
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n"
		file := storedRosterHeader + "alice,Alice,Anderson,a@x.edu,s1,1,student\n"

		mock, _, _, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err != nil {
			t.Fatalf("runRosterImport: %v", err)
		}
		alice := committedRow(t, mock, "alice", "")
		if alice.LastName != "Anderson" || alice.GitHubID != 1 {
			t.Errorf("account row not upserted: %#v", alice)
		}
	})

	t.Run("email-only row with no stored counterpart notices and continues", func(t *testing.T) {
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n"
		file := storedRosterHeader +
			"alice,Alice,Anderson,a@x.edu,s1,,student\n" +
			",New,N,nobody@x.edu,s3,,student\n"

		mock, _, errOut, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err != nil {
			t.Fatalf("an unmatched email-only row must not fail the import: %v", err)
		}
		if !strings.Contains(errOut, "nobody@x.edu") {
			t.Errorf("stderr should notice the unmatched address:\n%s", errOut)
		}
		if strings.Contains(mock.blobs[0], "nobody@x.edu") {
			t.Errorf("import must not create an email-only row:\n%s", mock.blobs[0])
		}
		if alice := committedRow(t, mock, "alice", ""); alice.LastName != "Anderson" {
			t.Errorf("the rest of the import must still apply: %#v", alice)
		}
	})

	t.Run("github_id-only row is skipped as cargo and its stored row untouched", func(t *testing.T) {
		storedCargo := ",Cargo,C,,,555,student\n"
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n" + storedCargo
		file := storedRosterHeader +
			"alice,Alice,Anderson,a@x.edu,s1,1,student\n" +
			",Changed,X,,,555,teacher\n"

		mock, out, errOut, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err != nil {
			t.Fatalf("a github_id-only row must not fail the import: %v", err)
		}
		if !strings.Contains(errOut, "github_id") || !strings.Contains(errOut, "Upload") {
			t.Errorf("stderr should notice the cargo row and name the web Upload:\n%s", errOut)
		}
		if !strings.Contains(out, "1 skipped") {
			t.Errorf("stdout should count the skipped row:\n%s", out)
		}
		if !strings.Contains(mock.blobs[0], storedCargo) {
			t.Errorf("the stored github_id-only row must round-trip byte-identical:\n%s", mock.blobs[0])
		}
	})

	t.Run("stored role wins over the import file's role cell", func(t *testing.T) {
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n"
		file := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,teacher\n"

		mock, _, _, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err != nil {
			t.Fatalf("runRosterImport: %v", err)
		}
		if alice := committedRow(t, mock, "alice", ""); alice.Role != "student" {
			t.Errorf("import must not apply a role cell, got %q", alice.Role)
		}
	})

	t.Run("stored github_id survives an import row that omits it", func(t *testing.T) {
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n"
		file := storedRosterHeader + "alice,Alice,A,a@x.edu,s2,,student\n"

		mock, _, _, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err != nil {
			t.Fatalf("runRosterImport: %v", err)
		}
		alice := committedRow(t, mock, "alice", "")
		if alice.GitHubID != 1 || alice.Section != "s2" {
			t.Errorf("want the stored id kept and the section updated: %#v", alice)
		}
	})

	// A file whose only rows are addresses import may not create leaves the
	// stored rows exactly as read, so committing the re-encoding would land a
	// real commit with an empty diff.
	t.Run("a file that changes nothing commits nothing", func(t *testing.T) {
		stored := storedRosterHeader + "alice,Alice,A,a@x.edu,s1,1,student\n"
		file := storedRosterHeader + ",New,N,nobody@x.edu,s3,,student\n"

		mock, out, errOut, err := runImport(t, stored, file, map[string]int64{"alice": 1})
		if err != nil {
			t.Fatalf("runRosterImport: %v", err)
		}
		if len(mock.blobs) != 0 {
			t.Errorf("POSTed %d blob(s) for a commit with no diff: %#v", len(mock.blobs), mock.blobs)
		}
		if !strings.Contains(errOut, "nobody@x.edu") {
			t.Errorf("stderr should still notice the unmatched address:\n%s", errOut)
		}
		if !strings.Contains(out, "1 skipped") {
			t.Errorf("stdout should still count the skipped row:\n%s", out)
		}
	})
}

// classroomJSONWithStaffTeams builds a classroom.json carrying the student team
// plus all three staff-team refs, so the dual-role check can resolve slugs.
func classroomJSONWithStaffTeams(t *testing.T, classroom string) string {
	t.Helper()
	c := map[string]any{
		"name": classroom,
		"team": map[string]any{"id": 1, "slug": "classroom50-" + classroom},
		"teams": map[string]any{
			"teacher": map[string]any{"id": 2, "slug": "classroom50-" + classroom + "-teacher"},
			"hta":     map[string]any{"id": 3, "slug": "classroom50-" + classroom + "-hta"},
			"ta":      map[string]any{"id": 4, "slug": "classroom50-" + classroom + "-ta"},
		},
	}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal classroom.json: %v", err)
	}
	return string(b)
}

// TestRunRosterAdd_DualRoleNote: adding a user already on the teacher staff team
// prints the advisory dual-role note to stderr; a plain new student does not.
func TestRunRosterAdd_DualRoleNote(t *testing.T) {
	roster := "username,first_name,last_name,email,section,github_id,role\n"

	t.Run("existing staff member gets the dual-role note", func(t *testing.T) {
		mock := &dualRoleAddMock{
			rosterWriteMock: &rosterWriteMock{files: map[string]string{
				"ai26/roster.csv": roster,
			}},
			classroomJSON: classroomJSONWithStaffTeams(t, "ai26"),
			staffMembers: map[string][]string{
				"classroom50-ai26-teacher": {"prof"},
			},
		}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runRosterAdd(client, &out, &errOut, "o", "ai26", "prof", "", "", "", ""); err != nil {
			t.Fatalf("runRosterAdd: %v", err)
		}
		if !strings.Contains(errOut.String(), "Dual roles aren't disallowed") {
			t.Errorf("stderr missing the dual-role note:\n%s", errOut.String())
		}
		if !strings.Contains(errOut.String(), "teacher") {
			t.Errorf("dual-role note should name the teacher role:\n%s", errOut.String())
		}
	})

	t.Run("plain new student gets no dual-role note", func(t *testing.T) {
		mock := &dualRoleAddMock{
			rosterWriteMock: &rosterWriteMock{files: map[string]string{
				"ai26/roster.csv": roster,
			}},
			classroomJSON: classroomJSONWithStaffTeams(t, "ai26"),
			// No staff-team members: every staff-team read 404s -> empty.
			staffMembers: map[string][]string{},
		}
		server := httptest.NewServer(mock.handler(t))
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		var out, errOut bytes.Buffer
		if err := runRosterAdd(client, &out, &errOut, "o", "ai26", "newbie", "", "", "", ""); err != nil {
			t.Fatalf("runRosterAdd: %v", err)
		}
		if strings.Contains(errOut.String(), "Dual roles aren't disallowed") {
			t.Errorf("a plain student must not get the dual-role note:\n%s", errOut.String())
		}
	})
}
