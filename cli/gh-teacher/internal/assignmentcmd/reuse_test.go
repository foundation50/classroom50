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

// reuseFixture serves a config repo with two classrooms (source +
// target) plus the commit-tree write endpoints, capturing the proposed
// blob so a test can assert what landed in the target's assignments.json.
type reuseFixture struct {
	mu        sync.Mutex
	committed []byte
	treePath  string
	// grantedRepo records a PUT classroom-team repo grant target, if any.
	grantedRepo string
	// grantedTATeam records a PUT TA-staff-team repo grant target, if any.
	grantedTATeam string
	// grantedHTATeam records a PUT head-TA-staff-team repo grant target, if any.
	grantedHTATeam string
}

// reuseServerConfig parameterizes the mock: the source/target classroom
// assignments.json bodies, an optional target classroom.json body (empty
// => 404 => reads as active), the target classroom team, and the
// privacy/visibility of the hello template.
type reuseServerConfig struct {
	sourceAssignments string
	targetAssignments string
	targetClassroom   string // raw classroom.json for target; "" => 404
	templatePrivate   bool
	templateMissing   bool // template repo 404s
	// grantStatus overrides the classroom-team grant PUT response; 0 =>
	// the default 204 (success). Set to e.g. 500 to exercise the
	// grant-fails-after-the-copy-landed path.
	grantStatus int
	// grantRateLimited, when set, makes the classroom-team grant PUT return a
	// 403 WITH a Retry-After header — GitHub's secondary-rate-limit shape, which
	// must stay fatal (distinct from a plain permission 403, which is benign).
	grantRateLimited bool
	// templateOwner overrides the template repo owner (default "o", the
	// org). Set to a different owner to exercise the out-of-org private
	// template branch (warn, no grant). The source assignments body must
	// reference the same owner.
	templateOwner string
	// taGrantStatus overrides the TA-staff-team grant PUT response; 0 =>
	// the default 204 (success). Set to e.g. 500 to exercise the TA-grant
	// failure path (which must warn, not fail the reuse).
	taGrantStatus int
}

func newReuseServer(t *testing.T, cfg reuseServerConfig) (*httptest.Server, *reuseFixture) {
	t.Helper()
	fix := &reuseFixture{}
	mux := http.NewServeMux()

	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	serveFile := func(path, body string) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
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
	serveFile("/repos/o/classroom50/contents/src/assignments.json", cfg.sourceAssignments)
	serveFile("/repos/o/classroom50/contents/dst/assignments.json", cfg.targetAssignments)
	serveFile("/repos/o/classroom50/contents/dst/classroom.json", cfg.targetClassroom)

	// Template repo probe (private in-org template by default). The owner
	// defaults to the org ("o"); a test can point it out-of-org.
	tmplOwner := cfg.templateOwner
	if tmplOwner == "" {
		tmplOwner = "o"
	}
	mux.HandleFunc("/repos/"+tmplOwner+"/hello-template", func(w http.ResponseWriter, r *http.Request) {
		if cfg.templateMissing {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"is_template": true, "default_branch": "main", "private": cfg.templatePrivate})
	})

	// Classroom-team grant: GET team membership probe + PUT grant.
	mux.HandleFunc("/orgs/o/teams/classroom50-dst/repos/o/hello-template", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// 404 => not yet granted, so GrantTeamRepoRead will PUT.
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPut:
			if cfg.grantRateLimited {
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(http.StatusForbidden)
				return
			}
			if cfg.grantStatus != 0 {
				w.WriteHeader(cfg.grantStatus)
				return
			}
			fix.mu.Lock()
			fix.grantedRepo = "o/hello-template"
			fix.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}
	})

	// TA-staff-team grant: GET probe + PUT grant. Fires only when the target
	// classroom.json records a `teams.ta` block (older classrooms skip it).
	mux.HandleFunc("/orgs/o/teams/classroom50-dst-ta/repos/o/hello-template", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPut:
			if cfg.taGrantStatus != 0 {
				w.WriteHeader(cfg.taGrantStatus)
				return
			}
			fix.mu.Lock()
			fix.grantedTATeam = "o/hello-template"
			fix.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}
	})

	// Head-TA-staff-team grant: GET probe + PUT grant. Fires only when the target
	// classroom.json records a `teams.hta` block (older classrooms skip it).
	mux.HandleFunc("/orgs/o/teams/classroom50-dst-hta/repos/o/hello-template", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPut:
			fix.mu.Lock()
			fix.grantedHTATeam = "o/hello-template"
			fix.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}
	})

	// Commit-tree write loop.
	mux.HandleFunc("/repos/o/classroom50/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits/parent-sha", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/o/classroom50/git/blobs", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Content, Encoding string
		}
		_ = json.Unmarshal(body, &payload)
		if payload.Encoding == "base64" {
			decoded, _ := base64.StdEncoding.DecodeString(payload.Content)
			fix.mu.Lock()
			fix.committed = decoded
			fix.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var payload struct {
			Tree []struct {
				Path string `json:"path"`
			} `json:"tree"`
		}
		_ = json.Unmarshal(body, &payload)
		if len(payload.Tree) == 1 {
			fix.mu.Lock()
			fix.treePath = payload.Tree[0].Path
			fix.mu.Unlock()
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
	})
	mux.HandleFunc("/repos/o/classroom50/git/commits", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, fix
}

// sourceAssignmentsBody returns a source assignments.json with one entry
// named `hello` carrying a private in-org template + a pass_threshold, so
// reuse round-trip tests can assert verbatim field preservation.
func sourceAssignmentsBody() string {
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "description": "Say hi",
      "template": { "owner": "o", "repo": "hello-template", "branch": "main" },
      "due": "2026-09-15T23:59:00Z",
      "mode": "individual",
      "autograder": "default",
      "feedback_pr": true,
      "allowed_files": ["*", "!hello.py"],
      "pass_threshold": 70
    }
  ]
}`
}

func emptyAssignmentsBody() string {
	return `{"schema":"classroom50/assignments/v1","assignments":[]}`
}

func targetClassroomBody(active *bool) string {
	doc := map[string]any{
		"schema":     "classroom50/classroom/v1",
		"name":       "Dst",
		"short_name": "dst",
		"term":       "",
		"org":        "o",
		"team":       map[string]any{"id": 7, "slug": "classroom50-dst"},
	}
	if active != nil {
		doc["active"] = *active
	}
	b, _ := json.Marshal(doc)
	return string(b)
}

// targetClassroomBodyWithTA is targetClassroomBody plus recorded head-TA and TA
// staff teams, so the reuse grant path also grants those non-owner staff teams
// read on a private in-org template.
func targetClassroomBodyWithTA() string {
	doc := map[string]any{
		"schema":     "classroom50/classroom/v1",
		"name":       "Dst",
		"short_name": "dst",
		"term":       "",
		"org":        "o",
		"team":       map[string]any{"id": 7, "slug": "classroom50-dst"},
		"teams": map[string]any{
			"hta": map[string]any{"id": 8, "slug": "classroom50-dst-hta"},
			"ta":  map[string]any{"id": 9, "slug": "classroom50-dst-ta"},
		},
	}
	b, _ := json.Marshal(doc)
	return string(b)
}

func baseReuseParams() reuseAssignmentParams {
	return reuseAssignmentParams{
		Org:        "o",
		From:       "src",
		To:         "dst",
		SourceSlug: "hello",
	}
}

func decodeReuse(t *testing.T, fix *reuseFixture) assignment.AssignmentsJSON {
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

func TestRunAssignmentReuse_CopiesVerbatim(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse: %v", err)
	}
	file := decodeReuse(t, fix)
	if len(file.Assignments) != 1 {
		t.Fatalf("target should have 1 assignment, got %d", len(file.Assignments))
	}
	got := file.Assignments[0]
	if got.Slug != "hello" || got.Name != "Hello" {
		t.Errorf("slug/name = %q/%q, want hello/Hello", got.Slug, got.Name)
	}
	if got.Description != "Say hi" || got.Due != "2026-09-15T23:59:00Z" || !got.FeedbackPR {
		t.Errorf("verbatim fields not preserved: %#v", got)
	}
	if got.PassThreshold == nil || *got.PassThreshold != 70 {
		t.Errorf("pass_threshold not preserved: %v", got.PassThreshold)
	}
	if len(got.AllowedFiles) != 2 {
		t.Errorf("allowed_files not preserved: %v", got.AllowedFiles)
	}
	// Private in-org template => target team gets a read grant.
	fix.mu.Lock()
	granted := fix.grantedRepo
	fix.mu.Unlock()
	if granted != "o/hello-template" {
		t.Errorf("expected target team grant on o/hello-template, got %q", granted)
	}
	if fix.treePath != "dst/assignments.json" {
		t.Errorf("tree path = %q, want dst/assignments.json", fix.treePath)
	}
}

func TestRunAssignmentReuse_AutoSuffixOnCollision(t *testing.T) {
	target := `{"schema":"classroom50/assignments/v1","assignments":[{"slug":"hello","name":"Existing","mode":"individual","autograder":"default"}]}`
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: target,
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse: %v", err)
	}
	file := decodeReuse(t, fix)
	if _, ok := assignment.FindAssignment(file.Assignments, "hello-2"); !ok {
		slugs := make([]string, len(file.Assignments))
		for i, e := range file.Assignments {
			slugs[i] = e.Slug
		}
		t.Fatalf("expected auto-suffixed hello-2, got slugs %v", slugs)
	}
	if !strings.Contains(errOut.String(), "hello-2") {
		t.Errorf("stderr should note the auto-suffix, got %q", errOut.String())
	}
}

func TestRunAssignmentReuse_ExplicitSlugCollisionRefused(t *testing.T) {
	target := `{"schema":"classroom50/assignments/v1","assignments":[{"slug":"taken","name":"Taken","mode":"individual","autograder":"default"}]}`
	server, _ := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: target,
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
	})
	client := githubtest.NewTestClient(t, server)

	p := baseReuseParams()
	p.SlugOverride = "TAKEN" // case-insensitive collision
	p.SlugWasSet = true
	var out, errOut bytes.Buffer
	err := runAssignmentReuse(client, &out, &errOut, p)
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected case-insensitive collision refusal, got %v", err)
	}
}

func TestRunAssignmentReuse_SourceSlugMissing(t *testing.T) {
	server, _ := newReuseServer(t, reuseServerConfig{
		sourceAssignments: emptyAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentReuse(client, &out, &errOut, baseReuseParams())
	if err == nil || !strings.Contains(err.Error(), "not found in source classroom") {
		t.Fatalf("expected source-not-found error, got %v", err)
	}
}

func TestRunAssignmentReuse_RefusesArchivedTarget(t *testing.T) {
	archived := false
	server, _ := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(&archived),
		templatePrivate:   true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentReuse(client, &out, &errOut, baseReuseParams())
	if err == nil || !strings.Contains(err.Error(), "archived") {
		t.Fatalf("expected archived-target refusal, got %v", err)
	}
}

func TestRunAssignmentReuse_NameOverride(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
	})
	client := githubtest.NewTestClient(t, server)

	p := baseReuseParams()
	p.NameOverride = "Hello (Redux)"
	p.NameWasSet = true
	p.SlugOverride = "hello-redux"
	p.SlugWasSet = true
	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, p); err != nil {
		t.Fatalf("runAssignmentReuse: %v", err)
	}
	file := decodeReuse(t, fix)
	idx, ok := assignment.FindAssignment(file.Assignments, "hello-redux")
	if !ok {
		t.Fatalf("expected hello-redux entry")
	}
	if file.Assignments[idx].Name != "Hello (Redux)" {
		t.Errorf("name = %q, want Hello (Redux)", file.Assignments[idx].Name)
	}
}

// TestRunAssignmentReuse_PreservesUnknownField pins the forward-compat invariant
// end-to-end: a future field on the source entry that this binary doesn't
// know about is copied verbatim into the target classroom rather than
// silently dropped on the read-modify-write.
func TestRunAssignmentReuse_PreservesUnknownField(t *testing.T) {
	source := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "mode": "individual",
      "autograder": "default",
      "v2_only_flag": true
    }
  ]
}`
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: source,
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse: %v", err)
	}
	fix.mu.Lock()
	committed := string(fix.committed)
	fix.mu.Unlock()
	if !strings.Contains(committed, "v2_only_flag") {
		t.Errorf("reuse dropped the unknown field v2_only_flag:\n%s", committed)
	}
	file := decodeReuse(t, fix)
	if got := file.Assignments[0].Extra["v2_only_flag"]; string(got) != "true" {
		t.Errorf("v2_only_flag not preserved verbatim, got %q", got)
	}
}

// publicTemplateSourceBody is a source entry with a PUBLIC in-org template
// (private:false), so the reuse grant path takes the "public needs no
// grant" branch.
func publicTemplateSourceBody() string {
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "o", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default"
    }
  ]
}`
}

// outOfOrgTemplateSourceBody is a source entry whose template is owned by a
// DIFFERENT org, exercising the out-of-org private-template warn-no-grant
// branch.
func outOfOrgTemplateSourceBody() string {
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "other-org", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default"
    }
  ]
}`
}

// TestRunAssignmentReuse_PublicTemplateSkipsGrant: a public template needs
// no team grant, so the copy lands and no grant PUT fires.
func TestRunAssignmentReuse_PublicTemplateSkipsGrant(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: publicTemplateSourceBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   false,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse(public template): %v", err)
	}
	if len(decodeReuse(t, fix).Assignments) != 1 {
		t.Fatalf("copy should have landed")
	}
	fix.mu.Lock()
	granted := fix.grantedRepo
	fix.mu.Unlock()
	if granted != "" {
		t.Errorf("public template should not be team-granted, got %q", granted)
	}
}

// TestRunAssignmentReuse_OutOfOrgPrivateTemplateWarns: a private template
// owned outside the org can't be team-granted in-org-only v1, so reuse
// warns (no grant) but still lands the copy and returns nil.
func TestRunAssignmentReuse_OutOfOrgPrivateTemplateWarns(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: outOfOrgTemplateSourceBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
		templateOwner:     "other-org",
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse(out-of-org private template): %v", err)
	}
	if len(decodeReuse(t, fix).Assignments) != 1 {
		t.Fatalf("copy should still land for an out-of-org template")
	}
	fix.mu.Lock()
	granted := fix.grantedRepo
	fix.mu.Unlock()
	if granted != "" {
		t.Errorf("out-of-org template must not be granted, got %q", granted)
	}
	if !strings.Contains(errOut.String(), "out-of-org") {
		t.Errorf("expected an out-of-org warning on stderr, got %q", errOut.String())
	}
}

// TestRunAssignmentReuse_MissingTemplateWarns: a template that 404s (deleted
// or private-out-of-org and invisible) warns but doesn't fail the
// already-landed copy.
func TestRunAssignmentReuse_MissingTemplateWarns(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
		templateMissing:   true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse(missing template): %v", err)
	}
	if len(decodeReuse(t, fix).Assignments) != 1 {
		t.Fatalf("copy should still land when the template is not visible")
	}
	if !strings.Contains(errOut.String(), "not visible") {
		t.Errorf("expected a not-visible warning, got %q", errOut.String())
	}
}

// TestRunAssignmentReuse_GrantFailureAfterCommit: the copy commits first,
// then the team grant PUT fails. The error must surface (so the operator
// knows the grant is missing) AND the copy must have already landed.
func TestRunAssignmentReuse_GrantFailureAfterCommit(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
		grantStatus:       http.StatusInternalServerError,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentReuse(client, &out, &errOut, baseReuseParams())
	if err == nil || !strings.Contains(err.Error(), "reused") {
		t.Fatalf("expected a grant-failure error mentioning the copy was reused, got %v", err)
	}
	// The copy must have landed before the grant was attempted.
	fix.mu.Lock()
	committed := fix.committed
	fix.mu.Unlock()
	if committed == nil {
		t.Errorf("copy should have been committed before the grant failure")
	}
}

// TestRunAssignmentReuse_GrantForbiddenIsNonFatal: the classroom-team grant PUT
// is org-owner-only, so a non-owner author (head-TA) gets a 403. Since the copy
// already committed, the reuse must NOT fail — it warns with owner-required
// guidance on stderr and returns nil (an owner re-affirms it; collect-scores
// also does). Distinct from GrantFailureAfterCommit, where a non-403 error stays
// fatal.
func TestRunAssignmentReuse_GrantForbiddenIsNonFatal(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
		grantStatus:       http.StatusForbidden,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("a 403 on the owner-only grant must not fail the reuse, got %v", err)
	}
	if !strings.Contains(errOut.String(), "organization owner") {
		t.Errorf("expected an owner-required warning on stderr, got %q", errOut.String())
	}
	// The copy still landed.
	fix.mu.Lock()
	committed := fix.committed
	fix.mu.Unlock()
	if committed == nil {
		t.Errorf("copy should have been committed even when the grant 403s")
	}
}

// TestRunAssignmentReuse_GrantRateLimitedStaysFatal: a 403 carrying a Retry-After
// header is GitHub's secondary-rate-limit shape, not a permission denial — it must
// stay FATAL (a transient throttle reported as "needs an organization owner" +
// exit 0 would hide the real cause). Distinct from GrantForbiddenIsNonFatal.
func TestRunAssignmentReuse_GrantRateLimitedStaysFatal(t *testing.T) {
	server, _ := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
		grantRateLimited:  true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentReuse(client, &out, &errOut, baseReuseParams())
	if err == nil {
		t.Fatalf("a rate-limited (Retry-After) 403 must fail the reuse, got nil error")
	}
	if !strings.Contains(err.Error(), "failed") {
		t.Errorf("expected the fatal grant-failure error, got %v", err)
	}
	if strings.Contains(errOut.String(), "organization owner") {
		t.Errorf("a rate-limit 403 must NOT surface owner-required guidance, got %q", errOut.String())
	}
}

// TestRunAssignmentReuse_JSONOutput: --json emits the resolved copy with the
// FINAL (auto-suffixed) slug on stdout, the machine-readable contract an
// agent reads instead of scraping the human summary.
func TestRunAssignmentReuse_JSONOutput(t *testing.T) {
	target := `{"schema":"classroom50/assignments/v1","assignments":[{"slug":"hello","name":"Existing","mode":"individual","autograder":"default"}]}`
	server, _ := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: target,
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   true,
	})
	client := githubtest.NewTestClient(t, server)

	p := baseReuseParams()
	p.AsJSON = true
	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, p); err != nil {
		t.Fatalf("runAssignmentReuse(--json): %v", err)
	}
	var got reuseResult
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("stdout is not valid JSON: %v\n%s", err, out.String())
	}
	if got.Slug != "hello-2" || !got.AutoSuffixed {
		t.Errorf("json result = %#v, want slug hello-2 + auto_suffixed", got)
	}
	if got.SourceSlug != "hello" || got.Classroom != "dst" || got.Org != "o" {
		t.Errorf("json result identity fields wrong: %#v", got)
	}
	if got.Template == nil || got.Template.Repo != "hello-template" {
		t.Errorf("json result should carry the template, got %#v", got.Template)
	}
}

// TestAssignmentReuseCmd_InPlaceRequiresSlug: the cobra RunE guard refuses an
// in-place reuse (from == to) without --slug, since an in-place copy must
// rename to avoid colliding with itself.
func TestAssignmentReuseCmd_InPlaceRequiresSlug(t *testing.T) {
	cmd := assignmentReuseCmd()
	cmd.SetArgs([]string{"o", "hello", "--from", "same", "--to", "same"})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "must rename") {
		t.Fatalf("expected an in-place must-rename error, got %v", err)
	}
}

// TestRunAssignmentReuse_InPlaceWithSlug: an in-place reuse (from == to) with
// an explicit --slug copies the entry under the new slug into the same
// classroom. Both loadAssignments calls in the build callback read the same
// file at the same parentSHA, so they agree.
func TestRunAssignmentReuse_InPlaceWithSlug(t *testing.T) {
	// from == to == "src": newReuseServer serves the source body at
	// /src/assignments.json, which is both the read and the write target.
	// Use a public template so no team grant is attempted (the fixture only
	// serves the dst classroom.json, so a src-team resolve would 404).
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: publicTemplateSourceBody(),
		targetAssignments: publicTemplateSourceBody(),
		targetClassroom:   targetClassroomBody(nil),
		templatePrivate:   false,
	})
	client := githubtest.NewTestClient(t, server)

	p := reuseAssignmentParams{
		Org: "o", From: "src", To: "src", SourceSlug: "hello",
		SlugOverride: "hello-redux", SlugWasSet: true,
	}
	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, p); err != nil {
		t.Fatalf("runAssignmentReuse(in-place): %v", err)
	}
	file := decodeReuse(t, fix)
	if _, ok := assignment.FindAssignment(file.Assignments, "hello-redux"); !ok {
		t.Errorf("expected in-place copy under hello-redux, got %d entries", len(file.Assignments))
	}
}

// TestRunAssignmentReuse_GrantsTATeam: when the target classroom records a TA
// staff team, a private in-org template grants both the student team and the
// TA team read.
func TestRunAssignmentReuse_GrantsTATeam(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBodyWithTA(),
		templatePrivate:   true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse: %v", err)
	}
	fix.mu.Lock()
	student, ta, hta := fix.grantedRepo, fix.grantedTATeam, fix.grantedHTATeam
	fix.mu.Unlock()
	if student != "o/hello-template" {
		t.Errorf("student team grant = %q, want o/hello-template", student)
	}
	if hta != "o/hello-template" {
		t.Errorf("head-TA team grant = %q, want o/hello-template", hta)
	}
	if ta != "o/hello-template" {
		t.Errorf("TA team grant = %q, want o/hello-template", ta)
	}
}

// TestRunAssignmentReuse_NoTATeamSkips: a classroom with no recorded TA team
// (older classroom) grants only the student team; no TA grant fires and no
// error surfaces.
func TestRunAssignmentReuse_NoTATeamSkips(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil), // no teams.ta
		templatePrivate:   true,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse: %v", err)
	}
	fix.mu.Lock()
	student, ta, hta := fix.grantedRepo, fix.grantedTATeam, fix.grantedHTATeam
	fix.mu.Unlock()
	if student != "o/hello-template" {
		t.Errorf("student team grant = %q, want o/hello-template", student)
	}
	if ta != "" {
		t.Errorf("no TA grant expected, got %q", ta)
	}
	if hta != "" {
		t.Errorf("no head-TA grant expected, got %q", hta)
	}
}

// TestRunAssignmentReuse_TAGrantFailureIsNonFatal: when the student grant
// succeeds but the TA grant PUT fails, the reuse still succeeds (student
// success stands) and a warning is emitted to stderr.
func TestRunAssignmentReuse_TAGrantFailureIsNonFatal(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBodyWithTA(),
		templatePrivate:   true,
		taGrantStatus:     http.StatusInternalServerError,
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse should not fail on a TA-grant error, got %v", err)
	}
	fix.mu.Lock()
	student := fix.grantedRepo
	fix.mu.Unlock()
	if student != "o/hello-template" {
		t.Errorf("student team grant = %q, want o/hello-template", student)
	}
	if !strings.Contains(errOut.String(), "could not grant ta staff team") {
		t.Errorf("expected a TA-grant warning on stderr, got %q", errOut.String())
	}
}
