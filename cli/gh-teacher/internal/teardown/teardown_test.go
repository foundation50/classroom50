package teardown

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// teardownTestServer is a stateful in-memory backing for end-to-end
// teardown tests. Tracks deletes + supports a per-repo failure knob
// so partial-failure cases stay realistic.
type teardownTestServer struct {
	mu                sync.Mutex
	classroom50Exists bool              // GET /repos/{org}/classroom50 returns 200 when true
	repos             []string          // list-org-repos response
	deleted           []string          // names that received DELETE
	failOnDelete      map[string]int    // repo name → status code to return instead of 204
	classroomDirs     []string          // config-repo root dir entries (classroom short-names)
	classroomJSON     map[string]string // "<dir>/classroom.json" → contents-API JSON body
	teamGET           map[string]string // "/orgs/{org}/teams/{slug}" → GET body (id verify)
	deletedTeams      []string          // team slugs that received DELETE
}

func (s *teardownTestServer) handler(t *testing.T, org string) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		path := r.URL.Path
		switch {
		case path == "/repos/"+org+"/classroom50" && r.Method == http.MethodGet:
			if s.classroom50Exists {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"name":"classroom50"}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		case path == "/orgs/"+org+"/repos" && r.Method == http.MethodGet:
			// Paginate: page 1 = all repos, page 2+ = empty.
			if r.URL.Query().Get("page") != "1" {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			var sb strings.Builder
			sb.WriteByte('[')
			for i, name := range s.repos {
				if i > 0 {
					sb.WriteByte(',')
				}
				sb.WriteString(`{"name":"` + name + `"}`)
			}
			sb.WriteByte(']')
			_, _ = w.Write([]byte(sb.String()))
		case path == "/repos/"+org+"/classroom50/contents" && r.Method == http.MethodGet:
			// collectClassroomTeams lists the config-repo root before the
			// deletions. Return the configured classroom dir entries (empty
			// by default → the team sweep is a clean no-op).
			var sb strings.Builder
			sb.WriteByte('[')
			for i, name := range s.classroomDirs {
				if i > 0 {
					sb.WriteByte(',')
				}
				sb.WriteString(`{"name":"` + name + `","type":"dir"}`)
			}
			sb.WriteByte(']')
			_, _ = w.Write([]byte(sb.String()))
		case strings.HasPrefix(path, "/repos/"+org+"/classroom50/contents/") && r.Method == http.MethodGet:
			// A per-classroom classroom.json read during the team sweep.
			// Return whatever the test staged for this path, else 404 (a
			// dir without classroom.json isn't a classroom).
			if body, ok := s.classroomJSON[strings.TrimPrefix(path, "/repos/"+org+"/classroom50/contents/")]; ok {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(body))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		case strings.HasPrefix(path, "/orgs/"+org+"/teams/") && r.Method == http.MethodGet:
			// Team id-verify before delete during the sweep.
			if body, ok := s.teamGET[path]; ok {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(body))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		case strings.HasPrefix(path, "/orgs/"+org+"/teams/") && r.Method == http.MethodDelete:
			s.deletedTeams = append(s.deletedTeams, strings.TrimPrefix(path, "/orgs/"+org+"/teams/"))
			w.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(path, "/repos/"+org+"/") && r.Method == http.MethodDelete:
			name := strings.TrimPrefix(path, "/repos/"+org+"/")
			if status, fail := s.failOnDelete[name]; fail {
				w.WriteHeader(status)
				return
			}
			s.deleted = append(s.deleted, name)
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, path)
			http.NotFound(w, r)
		}
	})
}

// jsonBase64Body wraps a raw file body in the GitHub contents-API
// envelope ({content: <base64>, encoding: "base64"}) that
// ReadFileContents decodes.
func jsonBase64Body(raw string) string {
	return `{"content":"` + base64.StdEncoding.EncodeToString([]byte(raw)) + `","encoding":"base64"}`
}

func TestRunTeardown_SweepsClassroomTeams(t *testing.T) {
	state := &teardownTestServer{
		classroom50Exists: true,
		repos:             []string{"classroom50", "cs-principles-hello-alice"},
		failOnDelete:      map[string]int{},
		classroomDirs:     []string{"cs-principles"},
		classroomJSON: map[string]string{
			"cs-principles/classroom.json": jsonBase64Body(`{
  "schema": "classroom50/classroom/v1",
  "short_name": "cs-principles",
  "org": "classroom50-test",
  "team": {"id": 1, "slug": "classroom50-cs-principles"},
  "teams": {
    "instructor": {"id": 2, "slug": "classroom50-cs-principles-instructor"},
    "hta": {"id": 4, "slug": "classroom50-cs-principles-hta"},
    "ta": {"id": 3, "slug": "classroom50-cs-principles-ta"}
  }
}`),
		},
		teamGET: map[string]string{
			"/orgs/classroom50-test/teams/classroom50-cs-principles":            `{"id":1}`,
			"/orgs/classroom50-test/teams/classroom50-cs-principles-instructor": `{"id":2}`,
			"/orgs/classroom50-test/teams/classroom50-cs-principles-hta":        `{"id":4}`,
			"/orgs/classroom50-test/teams/classroom50-cs-principles-ta":         `{"id":3}`,
		},
	}
	server := httptest.NewServer(state.handler(t, "classroom50-test"))
	defer server.Close()

	var out, errOut bytes.Buffer
	if err := runTeardown(githubtest.NewTestClient(t, server), strings.NewReader(""), &out, &errOut, "classroom50-test", true); err != nil {
		t.Fatalf("runTeardown: %v\nstdout:\n%s\nstderr:\n%s", err, out.String(), errOut.String())
	}

	state.mu.Lock()
	teams := append([]string(nil), state.deletedTeams...)
	state.mu.Unlock()
	want := map[string]bool{
		"classroom50-cs-principles":            true,
		"classroom50-cs-principles-instructor": true,
		"classroom50-cs-principles-hta":        true,
		"classroom50-cs-principles-ta":         true,
	}
	if len(teams) != 4 {
		t.Fatalf("deleted teams = %v, want the 4 classroom teams", teams)
	}
	for _, slug := range teams {
		if !want[slug] {
			t.Errorf("deleted unexpected team %q", slug)
		}
	}
}

func TestRunTeardown_HappyPath(t *testing.T) {
	state := &teardownTestServer{
		classroom50Exists: true,
		repos: []string{
			"classroom50",
			"cs-principles-hello-alice",
			"cs-principles-hello-bob",
			"readability",
		},
		failOnDelete: map[string]int{},
	}
	server := httptest.NewServer(state.handler(t, "classroom50-test"))
	defer server.Close()

	var out, errOut bytes.Buffer
	if err := runTeardown(githubtest.NewTestClient(t, server), strings.NewReader(""), &out, &errOut, "classroom50-test", true); err != nil {
		t.Fatalf("runTeardown: %v\nstdout:\n%s\nstderr:\n%s", err, out.String(), errOut.String())
	}

	// Every repo deleted.
	state.mu.Lock()
	got := append([]string(nil), state.deleted...)
	state.mu.Unlock()
	if len(got) != 4 {
		t.Errorf("deleted = %v (len %d), want all 4 repos", got, len(got))
	}
	// classroom50 must be deleted LAST — leaves the marker repo
	// behind on a mid-run failure so re-runs still pass the
	// precondition check.
	if got[len(got)-1] != "classroom50" {
		t.Errorf("classroom50 deleted at position %d, want last (deletion order: %v)", indexOf(got, "classroom50"), got)
	}
	if !strings.Contains(out.String(), "Found 4 repo(s)") {
		t.Errorf("stdout missing 'Found 4 repo(s)' line:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "4 deleted, 0 failed") {
		t.Errorf("stdout missing summary line:\n%s", out.String())
	}
}

func TestRunTeardown_SweepsTeamsEvenOnPartialFailure(t *testing.T) {
	// A repo-delete failure preserves the marker repo, but the team
	// sweep must still run (deletes are idempotent and independent of
	// surviving repos) so write-granted staff teams aren't stranded.
	state := &teardownTestServer{
		classroom50Exists: true,
		repos:             []string{"classroom50", "cs-principles-hello-alice"},
		failOnDelete:      map[string]int{"cs-principles-hello-alice": http.StatusForbidden},
		classroomDirs:     []string{"cs-principles"},
		classroomJSON: map[string]string{
			"cs-principles/classroom.json": jsonBase64Body(`{
  "schema": "classroom50/classroom/v1",
  "short_name": "cs-principles",
  "org": "classroom50-test",
  "team": {"id": 1, "slug": "classroom50-cs-principles"},
  "teams": {
    "instructor": {"id": 2, "slug": "classroom50-cs-principles-instructor"},
    "ta": {"id": 3, "slug": "classroom50-cs-principles-ta"}
  }
}`),
		},
		teamGET: map[string]string{
			"/orgs/classroom50-test/teams/classroom50-cs-principles":            `{"id":1}`,
			"/orgs/classroom50-test/teams/classroom50-cs-principles-instructor": `{"id":2}`,
			"/orgs/classroom50-test/teams/classroom50-cs-principles-ta":         `{"id":3}`,
		},
	}
	server := httptest.NewServer(state.handler(t, "classroom50-test"))
	defer server.Close()

	var out, errOut bytes.Buffer
	// The failed repo delete makes runTeardown return a non-nil error,
	// but the team sweep must have run regardless.
	_ = runTeardown(githubtest.NewTestClient(t, server), strings.NewReader(""), &out, &errOut, "classroom50-test", true)

	state.mu.Lock()
	teams := append([]string(nil), state.deletedTeams...)
	state.mu.Unlock()
	if len(teams) != 3 {
		t.Fatalf("deleted teams = %v, want all 3 swept even though a repo delete failed", teams)
	}
}

func TestRunTeardown_RefusesWithoutMarkerRepo(t *testing.T) {
	// Without /repos/<org>/classroom50, teardown refuses before
	// listing or deleting anything — the marker repo is the safety
	// net that prevents accidental teardown of a non-Classroom 50 org.
	state := &teardownTestServer{
		classroom50Exists: false,
		repos:             []string{"classroom50", "other-repo"}, // shouldn't be reached
		failOnDelete:      map[string]int{},
	}
	server := httptest.NewServer(state.handler(t, "random-org"))
	defer server.Close()

	var out, errOut bytes.Buffer
	err := runTeardown(githubtest.NewTestClient(t, server), strings.NewReader(""), &out, &errOut, "random-org", true)
	if err == nil {
		t.Fatalf("expected refusal when classroom50 doesn't exist")
	}
	if !strings.Contains(err.Error(), "Classroom 50 marker repo") {
		t.Errorf("err = %v, want 'Classroom 50 marker repo' substring", err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.deleted) != 0 {
		t.Errorf("deleted %v, want zero deletes when precondition fails", state.deleted)
	}
}

func TestRunTeardown_ConfirmationRejected(t *testing.T) {
	// User types something other than the org name → abort cleanly
	// without any DELETE going out.
	state := &teardownTestServer{
		classroom50Exists: true,
		repos:             []string{"classroom50", "x"},
		failOnDelete:      map[string]int{},
	}
	server := httptest.NewServer(state.handler(t, "myorg"))
	defer server.Close()

	var out, errOut bytes.Buffer
	in := strings.NewReader("not-the-org-name\n")
	err := runTeardown(githubtest.NewTestClient(t, server), in, &out, &errOut, "myorg", false)
	if err == nil {
		t.Fatalf("expected error when confirmation doesn't match")
	}
	if !strings.Contains(err.Error(), "confirmation did not match") {
		t.Errorf("err = %v, want 'confirmation did not match' substring", err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.deleted) != 0 {
		t.Errorf("deleted %v, want zero deletes when confirmation rejected", state.deleted)
	}
}

func TestRunTeardown_ConfirmationAccepted(t *testing.T) {
	// User types the org name correctly → deletes proceed.
	state := &teardownTestServer{
		classroom50Exists: true,
		repos:             []string{"classroom50", "x"},
		failOnDelete:      map[string]int{},
	}
	server := httptest.NewServer(state.handler(t, "myorg"))
	defer server.Close()

	var out, errOut bytes.Buffer
	in := strings.NewReader("myorg\n")
	if err := runTeardown(githubtest.NewTestClient(t, server), in, &out, &errOut, "myorg", false); err != nil {
		t.Fatalf("runTeardown: %v", err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.deleted) != 2 {
		t.Errorf("deleted = %v, want 2 (both repos)", state.deleted)
	}
}

func TestRunTeardown_PartialFailurePreservesMarker(t *testing.T) {
	// On any per-repo failure, the marker repo (classroom50) must
	// be PRESERVED so re-running teardown still passes the
	// precondition guard and can retry the survivors. The function
	// returns non-nil so the CLI exits non-zero.
	state := &teardownTestServer{
		classroom50Exists: true,
		repos:             []string{"classroom50", "ok-repo", "locked-repo"},
		failOnDelete:      map[string]int{"locked-repo": http.StatusForbidden},
	}
	server := httptest.NewServer(state.handler(t, "o"))
	defer server.Close()

	var out, errOut bytes.Buffer
	err := runTeardown(githubtest.NewTestClient(t, server), strings.NewReader(""), &out, &errOut, "o", true)
	if err == nil {
		t.Fatalf("expected non-zero exit on partial failure")
	}
	if !strings.Contains(err.Error(), "1 repo(s) failed") {
		t.Errorf("err = %v, want '1 repo(s) failed' substring", err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	// Only ok-repo got deleted — classroom50 must be preserved
	// because locked-repo failed.
	if len(state.deleted) != 1 {
		t.Errorf("deleted = %v, want 1 (ok-repo only; classroom50 preserved because locked-repo failed)", state.deleted)
	}
	for _, name := range state.deleted {
		if name == "classroom50" {
			t.Errorf("classroom50 was deleted despite a partial failure — the safe-re-run contract requires the marker to stay")
		}
	}
	if !strings.Contains(out.String(), "marker repo preserved") {
		t.Errorf("stdout summary should note 'marker repo preserved', got:\n%s", out.String())
	}
	if !strings.Contains(errOut.String(), "skipped:") || !strings.Contains(errOut.String(), "preserved so a re-run") {
		t.Errorf("stderr should explain why classroom50 was skipped, got:\n%s", errOut.String())
	}
	if !strings.Contains(errOut.String(), "locked-repo") {
		t.Errorf("stderr missing locked-repo failure:\n%s", errOut.String())
	}
	// 403 hint must surface our opt-in path (not raw `gh auth refresh`).
	if !strings.Contains(errOut.String(), "gh teacher login -s delete_repo") {
		t.Errorf("stderr missing opt-in hint `gh teacher login -s delete_repo`:\n%s", errOut.String())
	}
}

func TestOrderRepoDeletions_MovesMarkerLast(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{"marker first", []string{"classroom50", "a", "b"}, []string{"a", "b", "classroom50"}},
		{"marker middle", []string{"a", "classroom50", "b"}, []string{"a", "b", "classroom50"}},
		{"marker last", []string{"a", "b", "classroom50"}, []string{"a", "b", "classroom50"}},
		{"no marker", []string{"a", "b"}, []string{"a", "b"}},
		{"only marker", []string{"classroom50"}, []string{"classroom50"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := orderRepoDeletions(tc.in)
			if !equalStringSlice(got, tc.want) {
				t.Errorf("orderRepoDeletions(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// indexOf returns the position of `target` in `slice`, or -1.
func indexOf(slice []string, target string) int {
	for i, s := range slice {
		if s == target {
			return i
		}
	}
	return -1
}

func equalStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
