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

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// The two accept clients' shims share the trigger block but differ in their
// comment headers — the retrofit must survive both (and preserve them).
const cliShimEveryPush = `# Classroom50 autograder shim.
#
# This file should not be edited.

name: Autograde

on:
  push:
    branches: ["main"]
    tags: ["submit/*"]

jobs:
  grade:
    uses: "o/classroom50/.github/workflows/autograde-runner.yaml@main"
    permissions:
      contents: write
      statuses: write
      pull-requests: write
`

const webShimTagMode = `name: Autograde

on:
  push:
    tags: ["submit/*"]

jobs:
  grade:
    uses: "o/classroom50/.github/workflows/autograde-runner.yaml@main"
    permissions:
      contents: write
      statuses: write
      # Lets the runner open the opt-in Feedback PR.
      pull-requests: write
`

// ---------------------------------------------------------------------------
// rewriteShimTrigger — pure line surgery
// ---------------------------------------------------------------------------

func TestRewriteShimTrigger_EveryPushToTag(t *testing.T) {
	got, changed, err := rewriteShimTrigger(cliShimEveryPush, contract.SubmissionModeTag, "main", nil)
	if err != nil || !changed {
		t.Fatalf("rewrite = (changed=%v, err=%v), want changed", changed, err)
	}
	if strings.Contains(got, "branches:") {
		t.Errorf("tag-mode shim still has a branches: line:\n%s", got)
	}
	// Exactly the one line removed; comments and everything else preserved.
	want := strings.Replace(cliShimEveryPush, "    branches: [\"main\"]\n", "", 1)
	if got != want {
		t.Errorf("rewrite is not surgical:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestRewriteShimTrigger_TagToEveryPush(t *testing.T) {
	// The branches line is inserted with the repo's CURRENT default branch
	// (master here), not a hardcoded main.
	got, changed, err := rewriteShimTrigger(webShimTagMode, contract.SubmissionModeEveryPush, "master", nil)
	if err != nil || !changed {
		t.Fatalf("rewrite = (changed=%v, err=%v), want changed", changed, err)
	}
	if !strings.Contains(got, "    branches: [\"master\"]\n    tags: [\"submit/*\"]\n") {
		t.Errorf("every-push shim missing the inserted branches line:\n%s", got)
	}
	// Round trip: removing it again restores the original.
	back, changed, err := rewriteShimTrigger(got, contract.SubmissionModeTag, "master", nil)
	if err != nil || !changed || back != webShimTagMode {
		t.Errorf("round trip failed:\n%s", back)
	}
}

func TestRewriteShimTrigger_Idempotent(t *testing.T) {
	// Already on target -> no change (no commit at the call site).
	if _, changed, err := rewriteShimTrigger(webShimTagMode, contract.SubmissionModeTag, "main", nil); err != nil || changed {
		t.Errorf("tag->tag = (changed=%v, err=%v), want no change", changed, err)
	}
	if _, changed, err := rewriteShimTrigger(cliShimEveryPush, contract.SubmissionModeEveryPush, "main", nil); err != nil || changed {
		t.Errorf("every-push->every-push = (changed=%v, err=%v), want no change", changed, err)
	}
}

func TestRewriteShimTrigger_UnrecognizedContent(t *testing.T) {
	// Teacher-/student-authored triggers must never be rewritten.
	for _, content := range []string{
		"name: Custom\non:\n  workflow_dispatch: {}\njobs: {}\n",
		"on:\n  push:\n    branches: [\"main\"]\n", // no submit/* tags line
		"",
	} {
		if _, _, err := rewriteShimTrigger(content, contract.SubmissionModeTag, "main", nil); err == nil {
			t.Errorf("rewriteShimTrigger accepted unrecognized content:\n%s", content)
		}
	}
}

func TestRewriteShimTrigger_QuotedYamlHostileBranch(t *testing.T) {
	// A branch named `off` stays quoted (matching the accept clients' quoting).
	got, changed, err := rewriteShimTrigger(webShimTagMode, contract.SubmissionModeEveryPush, "off", nil)
	if err != nil || !changed {
		t.Fatalf("rewrite = (changed=%v, err=%v)", changed, err)
	}
	if !strings.Contains(got, `branches: ["off"]`) {
		t.Errorf("branch not quoted:\n%s", got)
	}
}

// ---------------------------------------------------------------------------
// runSubmissionMode — end to end against a fake GitHub
// ---------------------------------------------------------------------------

type smFixture struct {
	mu sync.Mutex
	// committedAssignments is the last assignments.json blob written to the
	// config repo; committedShims maps student repo -> last shim blob.
	committedAssignments []byte
	committedShims       map[string][]byte
	commitMessages       map[string]string // repo -> last commit message
}

type smServerConfig struct {
	assignments string
	// student repos: name -> shim content ("" => repo exists, shim missing;
	// absent from map => repo 404s)
	repos map[string]string
	// tree-write 404 with a scopes header, simulating a missing workflow scope
	workflowScope404 bool
}

func newSMServer(t *testing.T, cfg smServerConfig) (*httptest.Server, *smFixture) {
	t.Helper()
	fix := &smFixture{
		committedShims: map[string][]byte{},
		commitMessages: map[string]string{},
	}
	mux := http.NewServeMux()

	serveJSON := func(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }
	serve404 := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"Not Found"}`)
	}
	serveContents := func(w http.ResponseWriter, body string) {
		serveJSON(w, map[string]any{
			"type": "file", "encoding": "base64",
			"content": base64.StdEncoding.EncodeToString([]byte(body)),
		})
	}

	// Config repo: branch, classroom.json (team), assignments.json, git-data.
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, _ *http.Request) {
		serveJSON(w, map[string]string{"default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/dst/assignments.json", func(w http.ResponseWriter, _ *http.Request) {
		serveContents(w, cfg.assignments)
	})
	mux.HandleFunc("/repos/o/classroom50/contents/dst/classroom.json", func(w http.ResponseWriter, _ *http.Request) {
		serveContents(w, lockClassroomBody())
	})
	mux.HandleFunc("/orgs/o/teams/classroom50-dst/members", func(w http.ResponseWriter, _ *http.Request) {
		var members []map[string]string
		for repo := range cfg.repos {
			login := strings.TrimPrefix(repo, "dst-hello-")
			members = append(members, map[string]string{"login": login})
		}
		// A member who never accepted (repo absent from cfg.repos).
		members = append(members, map[string]string{"login": "ghost"})
		serveJSON(w, members)
	})

	// Per-repo git-data write endpoints (config repo + every student repo).
	gitData := func(repoName string) {
		base := "/repos/o/" + repoName
		mux.HandleFunc(base+"/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				w.WriteHeader(http.StatusOK)
				return
			}
			serveJSON(w, map[string]any{"object": map[string]string{"sha": "parent-sha"}})
		})
		mux.HandleFunc(base+"/git/commits/parent-sha", func(w http.ResponseWriter, _ *http.Request) {
			serveJSON(w, map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
		})
		mux.HandleFunc(base+"/git/blobs", func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var payload struct{ Content, Encoding string }
			_ = json.Unmarshal(body, &payload)
			decoded, _ := base64.StdEncoding.DecodeString(payload.Content)
			fix.mu.Lock()
			if repoName == "classroom50" {
				fix.committedAssignments = decoded
			} else {
				fix.committedShims[repoName] = decoded
			}
			fix.mu.Unlock()
			serveJSON(w, map[string]string{"sha": "blob-sha"})
		})
		mux.HandleFunc(base+"/git/trees", func(w http.ResponseWriter, _ *http.Request) {
			if cfg.workflowScope404 && repoName != "classroom50" {
				w.Header().Set("X-OAuth-Scopes", "repo, read:org")
				serve404(w)
				return
			}
			serveJSON(w, map[string]string{"sha": "new-tree-sha"})
		})
		mux.HandleFunc(base+"/git/commits", func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var payload struct{ Message string }
			_ = json.Unmarshal(body, &payload)
			fix.mu.Lock()
			fix.commitMessages[repoName] = payload.Message
			fix.mu.Unlock()
			serveJSON(w, map[string]string{"sha": "new-commit-sha"})
		})
	}
	gitData("classroom50")

	for repoName, shim := range cfg.repos {
		repoName, shim := repoName, shim
		mux.HandleFunc("/repos/o/"+repoName, func(w http.ResponseWriter, _ *http.Request) {
			serveJSON(w, map[string]string{"default_branch": "main"})
		})
		mux.HandleFunc("/repos/o/"+repoName+"/contents/.github/workflows/autograde.yaml", func(w http.ResponseWriter, _ *http.Request) {
			if shim == "" {
				serve404(w)
				return
			}
			serveContents(w, shim)
		})
		gitData(repoName)
	}
	// Unregistered /repos/o/<repo> paths 404 via the default mux handler? No —
	// net/http's mux would match the longest pattern; add an explicit 404 for
	// the ghost student's repo.
	mux.HandleFunc("/repos/o/dst-hello-ghost", func(w http.ResponseWriter, _ *http.Request) {
		serve404(w)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, fix
}

func smAssignmentsBody(mode, autograder string, emptyRepo bool) string {
	entry := map[string]any{
		"slug": "hello", "name": "Hello",
		"mode": "individual", "autograder": autograder,
	}
	if mode != "" {
		entry["submission_mode"] = mode
	}
	if emptyRepo {
		entry["empty_repo"] = true
	}
	doc := map[string]any{
		"schema":      "classroom50/assignments/v1",
		"assignments": []any{entry},
	}
	b, _ := json.Marshal(doc)
	return string(b)
}

func smParams(mode string) submissionModeParams {
	return submissionModeParams{
		org: "o", classroom: "dst", slug: "hello",
		mode:        mode,
		updateShims: true,
	}
}

func TestRunSubmissionMode_FlipsFieldAndRetrofitsShims(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: smAssignmentsBody("", "default", false),
		repos: map[string]string{
			"dst-hello-alice": cliShimEveryPush,
			"dst-hello-bob":   webShimTagMode, // already tag-shaped -> current
		},
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runSubmissionMode(client, &out, &errOut, smParams(contract.SubmissionModeTag)); err != nil {
		t.Fatalf("runSubmissionMode: %v\nstderr: %s", err, errOut.String())
	}

	fix.mu.Lock()
	defer fix.mu.Unlock()
	// Field flip landed with the wire collapse (tag written explicitly).
	file, err := assignment.ParseAssignments(fix.committedAssignments)
	if err != nil {
		t.Fatalf("committed assignments.json does not parse: %v", err)
	}
	if got := file.Assignments[0].SubmissionMode; got != contract.SubmissionModeTag {
		t.Errorf("committed submission_mode = %q, want tag", got)
	}
	// alice's shim rewritten (branches line removed); bob untouched.
	aliceShim := string(fix.committedShims["dst-hello-alice"])
	if strings.Contains(aliceShim, "branches:") || !strings.Contains(aliceShim, `tags: ["submit/*"]`) {
		t.Errorf("alice's retrofitted shim wrong:\n%s", aliceShim)
	}
	if _, wrote := fix.committedShims["dst-hello-bob"]; wrote {
		t.Error("bob's already-current shim must not be rewritten")
	}
	// The retrofit commit carries [skip ci] (load-bearing for tag->every-push).
	if msg := fix.commitMessages["dst-hello-alice"]; !strings.Contains(msg, "[skip ci]") {
		t.Errorf("retrofit commit message missing [skip ci]: %q", msg)
	}
	if !strings.Contains(out.String(), "git pull") {
		t.Errorf("summary should tell students to re-pull:\n%s", out.String())
	}
}

func TestRunSubmissionMode_TagToEveryPushInsertsBranchLine(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: smAssignmentsBody("tag", "default", false),
		repos:       map[string]string{"dst-hello-alice": webShimTagMode},
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runSubmissionMode(client, &out, &errOut, smParams(contract.SubmissionModeEveryPush)); err != nil {
		t.Fatalf("runSubmissionMode: %v", err)
	}

	fix.mu.Lock()
	defer fix.mu.Unlock()
	// every-push collapses to absent on the wire.
	file, err := assignment.ParseAssignments(fix.committedAssignments)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := file.Assignments[0].SubmissionMode; got != "" {
		t.Errorf("committed submission_mode = %q, want absent (collapsed)", got)
	}
	shim := string(fix.committedShims["dst-hello-alice"])
	if !strings.Contains(shim, `branches: ["main"]`) {
		t.Errorf("branches line not restored:\n%s", shim)
	}
}

func TestRunSubmissionMode_IdempotentFieldNoCommit(t *testing.T) {
	// Already tag mode + already tag-shaped shim: no commits anywhere.
	server, fix := newSMServer(t, smServerConfig{
		assignments: smAssignmentsBody("tag", "default", false),
		repos:       map[string]string{"dst-hello-alice": webShimTagMode},
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runSubmissionMode(client, &out, &errOut, smParams(contract.SubmissionModeTag)); err != nil {
		t.Fatalf("runSubmissionMode: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committedAssignments != nil {
		t.Error("idempotent flip must not commit assignments.json")
	}
	if len(fix.committedShims) != 0 {
		t.Errorf("idempotent retrofit must not commit shims, got %v", fix.committedShims)
	}
}

func TestRunSubmissionMode_EmptyRepoRefused(t *testing.T) {
	server, _ := newSMServer(t, smServerConfig{
		assignments: smAssignmentsBody("", "default", true),
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := runSubmissionMode(client, &out, &errOut, smParams(contract.SubmissionModeTag))
	if err == nil || !strings.Contains(err.Error(), "empty_repo") {
		t.Fatalf("expected empty_repo refusal, got %v", err)
	}
}

func TestRunSubmissionMode_CustomAutograderRefusesShimUpdate(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: smAssignmentsBody("", "grader50", false),
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer

	// Default (update shims) -> refused outright, nothing written.
	err := runSubmissionMode(client, &out, &errOut, smParams(contract.SubmissionModeTag))
	if err == nil || !strings.Contains(err.Error(), "grader50") {
		t.Fatalf("expected custom-autograder refusal, got %v", err)
	}
	fix.mu.Lock()
	if fix.committedAssignments != nil {
		t.Error("refused command must not write the field")
	}
	fix.mu.Unlock()

	// --update-shims=false -> field flip allowed (mode still drives client
	// tag pushing, which is autograder-independent).
	p := smParams(contract.SubmissionModeTag)
	p.updateShims = false
	if err := runSubmissionMode(client, &out, &errOut, p); err != nil {
		t.Fatalf("field-only flip should succeed for a custom autograder: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	file, err := assignment.ParseAssignments(fix.committedAssignments)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := file.Assignments[0].SubmissionMode; got != contract.SubmissionModeTag {
		t.Errorf("committed submission_mode = %q, want tag", got)
	}
}

func TestRunSubmissionMode_UnrecognizedShimSkipped(t *testing.T) {
	custom := "name: Autograde\non:\n  workflow_dispatch: {}\njobs: {}\n"
	server, fix := newSMServer(t, smServerConfig{
		assignments: smAssignmentsBody("", "default", false),
		repos:       map[string]string{"dst-hello-alice": custom},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	// Skips are not failures: exit 0, reported on stderr.
	if err := runSubmissionMode(client, &out, &errOut, smParams(contract.SubmissionModeTag)); err != nil {
		t.Fatalf("unrecognized shim must not fail the command: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if _, wrote := fix.committedShims["dst-hello-alice"]; wrote {
		t.Error("unrecognized shim must never be rewritten")
	}
	if !strings.Contains(errOut.String(), "not recognized") {
		t.Errorf("skip must be reported on stderr:\n%s", errOut.String())
	}
}

func TestRunSubmissionMode_WorkflowScope404Classified(t *testing.T) {
	server, _ := newSMServer(t, smServerConfig{
		assignments:      smAssignmentsBody("", "default", false),
		repos:            map[string]string{"dst-hello-alice": cliShimEveryPush},
		workflowScope404: true,
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := runSubmissionMode(client, &out, &errOut, smParams(contract.SubmissionModeTag))
	if err == nil {
		t.Fatal("scope-404 must fail the command")
	}
	if !strings.Contains(errOut.String(), "workflow") {
		t.Errorf("failure should carry the workflow-scope remediation:\n%s", errOut.String())
	}
}

func TestRunSubmissionMode_UserTargetsSingleRepo(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: smAssignmentsBody("", "default", false),
		repos: map[string]string{
			"dst-hello-alice": cliShimEveryPush,
			"dst-hello-bob":   cliShimEveryPush,
		},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	p := smParams(contract.SubmissionModeTag)
	p.user = "alice"
	if err := runSubmissionMode(client, &out, &errOut, p); err != nil {
		t.Fatalf("runSubmissionMode --user: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if _, wrote := fix.committedShims["dst-hello-alice"]; !wrote {
		t.Error("alice's shim should be updated")
	}
	if _, wrote := fix.committedShims["dst-hello-bob"]; wrote {
		t.Error("--user alice must not touch bob's repo")
	}
}

func TestRunSubmissionMode_DryRunWritesNothing(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: smAssignmentsBody("", "default", false),
		repos:       map[string]string{"dst-hello-alice": cliShimEveryPush},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	p := smParams(contract.SubmissionModeTag)
	p.dryRun = true
	if err := runSubmissionMode(client, &out, &errOut, p); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committedAssignments != nil || len(fix.committedShims) != 0 {
		t.Error("dry run must write nothing")
	}
	if !strings.Contains(out.String(), "dry run") {
		t.Errorf("dry run output missing marker:\n%s", out.String())
	}
}

func TestRunSubmissionMode_MissingSlugErrors(t *testing.T) {
	server, _ := newSMServer(t, smServerConfig{
		assignments: `{"schema":"classroom50/assignments/v1","assignments":[]}`,
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	if err := runSubmissionMode(client, &out, &errOut, smParams(contract.SubmissionModeTag)); err == nil {
		t.Fatal("missing slug must error")
	}
}

// ---------------------------------------------------------------------------
// rewriteShimTrigger — milestone submission_tags
// ---------------------------------------------------------------------------

// A shim rendered WITH milestone patterns must still be recognized (never
// shimUnrecognized) and rewritable in both directions.
const cliShimWithTags = `# Classroom50 autograder shim.
#
# This file should not be edited.

name: Autograde

on:
  push:
    branches: ["main"]
    tags: ["phase1", "v*", "submit/*"]

jobs:
  grade:
    uses: "o/classroom50/.github/workflows/autograde-runner.yaml@main"
    permissions:
      contents: write
      statuses: write
      pull-requests: write
`

func TestRewriteShimTrigger_TagsReconciled(t *testing.T) {
	// Retrofitting with a pattern set widens the tags line (union with
	// submit/*) while the mode surgery behaves as before.
	got, changed, err := rewriteShimTrigger(cliShimEveryPush, contract.SubmissionModeEveryPush, "main", []string{"phase1", "v*"})
	if err != nil || !changed {
		t.Fatalf("rewrite = (changed=%v, %v), want a change", changed, err)
	}
	if !strings.Contains(got, `    tags: ["phase1", "v*", "submit/*"]`) {
		t.Errorf("tags line not widened:\n%s", got)
	}
	if !strings.Contains(got, `    branches: ["main"]`) {
		t.Errorf("every-push branches line must be preserved:\n%s", got)
	}

	// A pattern-bearing shim is recognized and can be narrowed back to the
	// default set (patterns removed from the assignment).
	back, changed, err := rewriteShimTrigger(cliShimWithTags, contract.SubmissionModeEveryPush, "main", nil)
	if err != nil || !changed {
		t.Fatalf("narrow = (changed=%v, %v), want a change", changed, err)
	}
	if !strings.Contains(back, `    tags: ["submit/*"]`) {
		t.Errorf("tags line not narrowed to the default:\n%s", back)
	}

	// Idempotent: rewriting a shim already in the target state is a no-op.
	if _, changed, err := rewriteShimTrigger(cliShimWithTags, contract.SubmissionModeEveryPush, "main", []string{"phase1", "v*"}); err != nil || changed {
		t.Errorf("already-current pattern shim must be a no-op (changed=%v, err=%v)", changed, err)
	}
}

func TestRewriteShimTrigger_TagModeWithTags(t *testing.T) {
	// Tag mode + milestone patterns: branch line dropped, tags widened.
	got, changed, err := rewriteShimTrigger(cliShimEveryPush, contract.SubmissionModeTag, "main", []string{"phase1"})
	if err != nil || !changed {
		t.Fatalf("rewrite = (changed=%v, %v), want a change", changed, err)
	}
	if strings.Contains(got, "branches:") {
		t.Errorf("tag mode must drop the branches line:\n%s", got)
	}
	if !strings.Contains(got, `    tags: ["phase1", "submit/*"]`) {
		t.Errorf("tags line not widened:\n%s", got)
	}
}
