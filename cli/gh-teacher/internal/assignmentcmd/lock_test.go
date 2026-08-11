package assignmentcmd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// lockFixture serves a single-classroom config repo plus the commit-tree write
// endpoints, and records the student-team template-repo grant (PUT) / revoke
// (DELETE) so a test can assert what happened to the private template.
type lockFixture struct {
	mu         sync.Mutex
	committed  []byte
	revokedURL string // DELETE .../teams/<slug>/repos/o/hello-template
	grantedURL string // PUT  .../teams/<slug>/repos/o/hello-template
	// touchedStaff records any staff-team repo path touched (must stay empty on
	// lock: only the student team is revoked).
	touchedStaff []string
}

type lockServerConfig struct {
	assignments     string // dst/assignments.json body
	classroom       string // dst/classroom.json body ("" => 404 => no team)
	templatePrivate bool
	templateMissing bool
}

func newLockServer(t *testing.T, cfg lockServerConfig) (*httptest.Server, *lockFixture) {
	t.Helper()
	fix := &lockFixture{}
	mux := http.NewServeMux()

	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	serveFile := func(path, body string) {
		mux.HandleFunc(path, func(w http.ResponseWriter, _ *http.Request) {
			if body == "" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, `{"message":"Not Found"}`)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"type":     "file",
				"content":  base64.StdEncoding.EncodeToString([]byte(body)),
				"encoding": "base64",
			})
		})
	}
	serveFile("/repos/o/classroom50/contents/dst/assignments.json", cfg.assignments)
	serveFile("/repos/o/classroom50/contents/dst/classroom.json", cfg.classroom)

	mux.HandleFunc("/repos/o/hello-template", func(w http.ResponseWriter, _ *http.Request) {
		if cfg.templateMissing {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"is_template":    true,
			"size":           1,
			"default_branch": "main",
			"private":        cfg.templatePrivate,
		})
	})

	// Student-team template access: DELETE on lock, GET+PUT on unlock.
	mux.HandleFunc("/orgs/o/teams/classroom50-dst/repos/o/hello-template", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodDelete:
			fix.mu.Lock()
			fix.revokedURL = r.URL.Path
			fix.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case http.MethodGet:
			w.WriteHeader(http.StatusNotFound) // not yet granted => unlock PUTs
		case http.MethodPut:
			fix.mu.Lock()
			fix.grantedURL = r.URL.Path
			fix.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}
	})
	// Any staff-team repo touch is a bug on lock; record the path so the test
	// can assert it stayed untouched.
	for _, role := range []string{"hta", "ta", "teacher"} {
		path := "/orgs/o/teams/classroom50-dst-" + role + "/repos/o/hello-template"
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			fix.mu.Lock()
			fix.touchedStaff = append(fix.touchedStaff, r.Method+" "+r.URL.Path)
			fix.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		})
	}

	// Commit-tree write loop.
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct{ Content, Encoding string }
		_ = json.Unmarshal(body, &payload)
		if payload.Encoding == "base64" {
			decoded, _ := base64.StdEncoding.DecodeString(payload.Content)
			fix.mu.Lock()
			fix.committed = decoded
			fix.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, fix
}

func lockAssignmentsBody(locked bool) string {
	lockedField := ""
	if locked {
		lockedField = `"locked": true,`
	}
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "o", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      ` + lockedField + `
      "feedback_pr": true
    }
  ]
}`
}

func lockClassroomBody() string {
	doc := map[string]any{
		"schema":     "classroom50/classroom/v1",
		"name":       "Dst",
		"short_name": "dst",
		"term":       "",
		"org":        "o",
		"team":       map[string]any{"id": 7, "slug": "classroom50-dst"},
	}
	b, _ := json.Marshal(doc)
	return string(b)
}

func decodeLock(t *testing.T, fix *lockFixture) assignment.AssignmentsJSON {
	t.Helper()
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committed == nil {
		t.Fatal("no blob was committed")
	}
	file, err := assignment.ParseAssignments(fix.committed)
	if err != nil {
		t.Fatalf("committed assignments.json does not parse: %v", err)
	}
	return file
}

// TestRunAssignmentLock_LocksAndRevokesStudentTeam: locking a private in-org
// template assignment flips locked=true and DELETEs the STUDENT team's read on
// the template, leaving staff teams untouched.
func TestRunAssignmentLock_LocksAndRevokesStudentTeam(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments:     lockAssignmentsBody(false),
		classroom:       lockClassroomBody(),
		templatePrivate: true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentLock(client, &out, &errOut, "o", "dst", "hello", true); err != nil {
		t.Fatalf("runAssignmentLock(lock): %v", err)
	}
	file := decodeLock(t, fix)
	if !file.Assignments[0].Locked {
		t.Errorf("assignment should be locked in the committed file")
	}
	fix.mu.Lock()
	revoked, touched := fix.revokedURL, fix.touchedStaff
	fix.mu.Unlock()
	if revoked != "/orgs/o/teams/classroom50-dst/repos/o/hello-template" {
		t.Errorf("student team read was not revoked, got %q", revoked)
	}
	if len(touched) != 0 {
		t.Errorf("staff teams must be untouched on lock, got %v", touched)
	}
}

// TestRunAssignmentLock_UnlockRegrantsStudentTeam: unlocking clears the flag
// and re-grants the student team read (PUT) on the private template.
func TestRunAssignmentLock_UnlockRegrantsStudentTeam(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments:     lockAssignmentsBody(true),
		classroom:       lockClassroomBody(),
		templatePrivate: true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentLock(client, &out, &errOut, "o", "dst", "hello", false); err != nil {
		t.Fatalf("runAssignmentLock(unlock): %v", err)
	}
	file := decodeLock(t, fix)
	if file.Assignments[0].Locked {
		t.Errorf("assignment should be unlocked in the committed file")
	}
	fix.mu.Lock()
	granted := fix.grantedURL
	fix.mu.Unlock()
	if granted != "/orgs/o/teams/classroom50-dst/repos/o/hello-template" {
		t.Errorf("student team read was not re-granted on unlock, got %q", granted)
	}
}

// TestRunAssignmentLock_PublicTemplateNoAccessChange: a public template is a
// UX-gate-only lock — the flag flips but no team access is changed.
func TestRunAssignmentLock_PublicTemplateNoAccessChange(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments:     lockAssignmentsBody(false),
		classroom:       lockClassroomBody(),
		templatePrivate: false,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentLock(client, &out, &errOut, "o", "dst", "hello", true); err != nil {
		t.Fatalf("runAssignmentLock(public): %v", err)
	}
	if !decodeLock(t, fix).Assignments[0].Locked {
		t.Errorf("assignment should still be locked (flag flip is unconditional)")
	}
	fix.mu.Lock()
	revoked := fix.revokedURL
	fix.mu.Unlock()
	if revoked != "" {
		t.Errorf("a public template must not have its team access revoked, got %q", revoked)
	}
}

// TestRunAssignmentLock_MissingSlugErrors: locking a slug that isn't in the
// manifest is an actionable error (nothing committed).
func TestRunAssignmentLock_MissingSlugErrors(t *testing.T) {
	server, _ := newLockServer(t, lockServerConfig{
		assignments:     lockAssignmentsBody(false),
		classroom:       lockClassroomBody(),
		templatePrivate: true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentLock(client, &out, &errOut, "o", "dst", "missing", true)
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected a not-found error for an unknown slug, got %v", err)
	}
}

// TestRunAssignmentAdd_PreservesLockAndSkipsGrant is the regression guard for
// the dead-guard bug: re-running `assignment add` on a same-slug LOCKED entry
// must keep it locked (Locked carried forward from the prior entry) AND must
// NOT re-grant the student team read on the private template (which would
// silently re-open a deliberately locked assignment).
func TestRunAssignmentAdd_PreservesLockAndSkipsGrant(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments:     lockAssignmentsBody(true), // already locked
		classroom:       lockClassroomBody(),
		templatePrivate: true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       "hello",
		Name:       "Hello",
		Tmpl:       &templateArg{Owner: "o", Repo: "hello-template", Branch: "main"},
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add locked): %v", err)
	}
	if !decodeLock(t, fix).Assignments[0].Locked {
		t.Errorf("re-adding a locked slug must keep it locked, but locked was cleared")
	}
	fix.mu.Lock()
	granted := fix.grantedURL
	fix.mu.Unlock()
	if granted != "" {
		t.Errorf("re-adding a locked slug must NOT re-grant the student team read, got %q", granted)
	}
	if !strings.Contains(errOut.String(), "locked") {
		t.Errorf("expected a note that the assignment stayed locked, got %q", errOut.String())
	}
}

// submissionModeAssignmentsBody is lockAssignmentsBody's tag-mode twin: one
// existing entry whose submission_mode is "tag", for re-add carry-forward tests.
func submissionModeAssignmentsBody() string {
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "o", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "submission_mode": "tag",
      "feedback_pr": true
    }
  ]
}`
}

// TestRunAssignmentAdd_PreservesSubmissionMode is the regression guard for the
// carry-forward: a same-slug re-add WITHOUT --submission-mode must keep a prior
// "tag" mode. A silent reset to every-push would strand the assignment —
// deployed tag-only shims fire on nothing while the submit clients stop pushing
// tags, so NOTHING grades. Mirrors TestRunAssignmentAdd_PreservesLockAndSkipsGrant.
func TestRunAssignmentAdd_PreservesSubmissionMode(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments: submissionModeAssignmentsBody(),
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       "hello",
		Name:       "Hello",
		Tmpl:       &templateArg{Owner: "o", Repo: "hello-template", Branch: "main"},
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
		// --submission-mode omitted: SubmissionMode is the normalized zero value
		// and SubmissionModeChanged is false — the carry-forward must fire.
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add tag-mode): %v", err)
	}
	if got := decodeLock(t, fix).Assignments[0].SubmissionMode; got != "tag" {
		t.Errorf("re-adding without --submission-mode must keep submission_mode=tag, got %q", got)
	}
}

// TestRunAssignmentAdd_ExplicitEveryPushResetsSubmissionMode pins the deliberate
// half of the contract: --submission-mode every-push on a re-add is an explicit
// reset (SubmissionModeChanged=true with the normalized empty value), so the
// prior "tag" must NOT be carried forward.
func TestRunAssignmentAdd_ExplicitEveryPushResetsSubmissionMode(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments: submissionModeAssignmentsBody(),
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       "hello",
		Name:       "Hello",
		Tmpl:       &templateArg{Owner: "o", Repo: "hello-template", Branch: "main"},
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
		// An explicit --submission-mode every-push normalizes to "" with
		// Changed=true — a deliberate reset the carry-forward must honor.
		SubmissionMode:        "",
		SubmissionModeChanged: true,
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(explicit every-push reset): %v", err)
	}
	if got := decodeLock(t, fix).Assignments[0].SubmissionMode; got != "" {
		t.Errorf("explicit --submission-mode every-push must reset the field (absent on the wire), got %q", got)
	}
}

// TestRunAssignmentAdd_PreservesSubmissionTags is the submission_tags twin of
// the mode carry-forward guard: a same-slug re-add WITHOUT --submission-tag
// must keep prior milestone patterns (deployed shims were rendered with
// them); passing the flag replaces the set.
func TestRunAssignmentAdd_PreservesSubmissionTags(t *testing.T) {
	assignments := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "o", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "submission_tags": ["phase1", "phase2"],
      "feedback_pr": true
    }
  ]
}`
	server, fix := newLockServer(t, lockServerConfig{
		assignments: assignments,
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       "hello",
		Name:       "Hello",
		Tmpl:       &templateArg{Owner: "o", Repo: "hello-template", Branch: "main"},
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
		// --submission-tag omitted: the prior patterns must carry forward.
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add with milestone tags): %v", err)
	}
	got := decodeLock(t, fix).Assignments[0].SubmissionTags
	if len(got) != 2 || got[0] != "phase1" || got[1] != "phase2" {
		t.Errorf("re-adding without --submission-tag must keep the patterns, got %v", got)
	}

	// Passing the flag replaces the set.
	server2, fix2 := newLockServer(t, lockServerConfig{
		assignments: assignments,
		classroom:   lockClassroomBody(),
	})
	client2 := githubtest.NewTestClient(t, server2)
	err = runAssignmentAdd(client2, &out, &errOut, addAssignmentParams{
		Org:                   "o",
		Classroom:             "dst",
		Slug:                  "hello",
		Name:                  "Hello",
		Tmpl:                  &templateArg{Owner: "o", Repo: "hello-template", Branch: "main"},
		Mode:                  assignment.ModeIndividual,
		Autograder:            "default",
		SubmissionTags:        []string{"final"},
		SubmissionTagsChanged: true,
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(explicit tags replace): %v", err)
	}
	got = decodeLock(t, fix2).Assignments[0].SubmissionTags
	if len(got) != 1 || got[0] != "final" {
		t.Errorf("explicit --submission-tag must replace the set, got %v", got)
	}
}

func includeAllBranchesAssignmentsBody() string {
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "o", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "include_all_branches": true,
      "feedback_pr": true
    }
  ]
}`
}

// TestRunAssignmentAdd_PreservesIncludeAllBranches is the carry-forward guard
// for the mutable include_all_branches: a same-slug re-add that KEEPS the
// template (the field has no --flag, so it's GUI/manifest-owned) must not
// silently reset a prior true. Mirrors TestRunAssignmentAdd_PreservesSubmissionMode.
func TestRunAssignmentAdd_PreservesIncludeAllBranches(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments: includeAllBranchesAssignmentsBody(),
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       "hello",
		Name:       "Hello",
		Tmpl:       &templateArg{Owner: "o", Repo: "hello-template", Branch: "main"},
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add templated): %v", err)
	}
	if !decodeLock(t, fix).Assignments[0].IncludeAllBranches {
		t.Errorf("re-adding a templated entry must keep include_all_branches=true")
	}
}

// TestRunAssignmentAdd_TemplateDropClearsIncludeAllBranches is the regression
// guard for the wedge bug: a same-slug re-add that DROPS --template must NOT
// carry include_all_branches:true onto the now-template-less entry. That combo
// is rejected by ParseAssignments/ValidateExistingEntry, so committing it would
// wedge every subsequent read of the file. The carry-forward is gated on the
// current template, and a post-carry-forward ValidateAssignmentEntry backstops
// it — so the committed entry is template-less, has no include_all_branches,
// and re-parses cleanly (decodeLock parses, proving no wedge).
func TestRunAssignmentAdd_TemplateDropClearsIncludeAllBranches(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments: includeAllBranchesAssignmentsBody(),
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       "hello",
		Name:       "Hello",
		// --template omitted: the entry becomes template-less, so the mutable
		// include_all_branches must be dropped rather than carried forward.
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add dropping --template): %v", err)
	}
	// decodeLock re-parses the committed file through ParseAssignments; a
	// template-less include_all_branches:true would fail that parse (the wedge).
	got := decodeLock(t, fix).Assignments[0]
	if got.Template != nil {
		t.Errorf("dropping --template must produce a template-less entry, got template %+v", got.Template)
	}
	if got.IncludeAllBranches {
		t.Errorf("include_all_branches must not carry forward onto a template-less entry (would wedge the file)")
	}
}
