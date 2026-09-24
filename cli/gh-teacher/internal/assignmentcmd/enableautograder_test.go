package assignmentcmd

import (
	"bytes"
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// eaAssignmentsBody builds a one-entry manifest for the enable-autograder
// tests; extra keys land on the entry verbatim.
func eaAssignmentsBody(noAutograder bool, extra map[string]any) string {
	entry := map[string]any{
		"slug": "hello", "name": "Hello",
		"mode": "individual", "autograder": "default",
	}
	if noAutograder {
		entry["no_autograder"] = true
	}
	for k, v := range extra {
		entry[k] = v
	}
	doc := map[string]any{
		"schema":      "classroom50/assignments/v1",
		"assignments": []any{entry},
	}
	b, _ := json.Marshal(doc)
	return string(b)
}

func eaParams() enableAutograderParams {
	return enableAutograderParams{
		org: "o", classroom: "dst", slug: "hello",
		addShims: true,
	}
}

func TestRunEnableAutograder_FlipsFieldAndAddsShims(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, nil),
		repos: map[string]string{
			"dst-hello-alice": "",               // accepted while off: no shim
			"dst-hello-bob":   cliShimEveryPush, // already has one -> untouched
		},
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runEnableAutograder(client, &out, &errOut, eaParams()); err != nil {
		t.Fatalf("runEnableAutograder: %v\nstderr: %s", err, errOut.String())
	}

	fix.mu.Lock()
	defer fix.mu.Unlock()
	file, err := assignment.ParseAssignments(fix.committedAssignments)
	if err != nil {
		t.Fatalf("committed assignments.json does not parse: %v", err)
	}
	if file.Assignments[0].NoAutograder {
		t.Error("committed no_autograder still true")
	}

	shim := string(fix.committedShims["dst-hello-alice"])
	for _, want := range []string{
		`branches: ["main"]`,
		`tags: ["submit/*"]`,
		`uses: "o/classroom50/.github/workflows/autograde-runner.yaml@main"`,
	} {
		if !strings.Contains(shim, want) {
			t.Errorf("alice's added shim missing %q:\n%s", want, shim)
		}
	}
	if _, wrote := fix.committedShims["dst-hello-bob"]; wrote {
		t.Error("bob's existing shim must not be rewritten")
	}
	if msg := fix.commitMessages["dst-hello-alice"]; msg != contract.ShimBackfillCommitMessage() {
		t.Errorf("backfill commit message = %q, want %q", msg, contract.ShimBackfillCommitMessage())
	}
	for _, want := range []string{"git pull", "graded on their next push", "1 added, 1 already had it"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output missing %q:\n%s", want, out.String())
		}
	}
}

// A no_autograder accept writes no `.classroom50.yaml`, and the runner the shim
// calls refuses a repo without one: the backfill lands both in one commit.
func TestRunEnableAutograder_AddsMissingMarkerWithShim(t *testing.T) {
	classroom := map[string]any{
		"schema": "classroom50/classroom/v1", "name": "Dst", "short_name": "dst",
		"org": "o", "team": map[string]any{"id": 7, "slug": "classroom50-dst"},
		"secret": "abcd1234",
	}
	classroomBody, _ := json.Marshal(classroom)
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, map[string]any{
			"template": map[string]string{"owner": "acme", "repo": "hello-template", "branch": "main"},
		}),
		classroom: string(classroomBody),
		repos: map[string]string{
			"dst-hello-alice": "", // markerless: accepted while off
			"dst-hello-bob":   "", // accepted while off, marker present
		},
		markerless: map[string]bool{"dst-hello-alice": true},
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runEnableAutograder(client, &out, &errOut, eaParams()); err != nil {
		t.Fatalf("runEnableAutograder: %v\nstderr: %s", err, errOut.String())
	}

	fix.mu.Lock()
	defer fix.mu.Unlock()
	alice := fix.committedFiles["dst-hello-alice"]
	if _, ok := alice[autogradeShimPath]; !ok {
		t.Fatalf("alice's commit is missing the shim; files = %v", slices.Sorted(maps.Keys(alice)))
	}
	marker, ok := alice[contract.MetadataPath]
	if !ok {
		t.Fatalf("alice's commit is missing %s; files = %v", contract.MetadataPath, slices.Sorted(maps.Keys(alice)))
	}
	// Byte-identical to what accept would write, minus accepted_at: alice's
	// id resolved (4242), the template owner's did not (omitted, like accept).
	want := "schema: \"classroom50/repo-config/v1\"\n" +
		"classroom: \"dst\"\n" +
		"assignment: \"hello\"\n" +
		"secret: \"abcd1234\"\n" +
		"owner:\n  username: \"alice\"\n  id: 4242\n" +
		"source:\n  owner: \"acme\"\n  repo: \"hello-template\"\n  branch: \"main\"\n"
	if string(marker) != want {
		t.Errorf("alice's marker\n got:\n%s\nwant:\n%s", marker, want)
	}
	if msg := fix.commitMessages["dst-hello-alice"]; msg != contract.ShimBackfillCommitMessage() {
		t.Errorf("backfill commit message = %q, want %q", msg, contract.ShimBackfillCommitMessage())
	}

	// bob's existing marker is left alone: shim only.
	if _, wrote := fix.committedFiles["dst-hello-bob"][contract.MetadataPath]; wrote {
		t.Error("bob already has a marker; the backfill must not rewrite it")
	}
	if _, wrote := fix.committedFiles["dst-hello-bob"][autogradeShimPath]; !wrote {
		t.Error("bob's shim must still be added")
	}
}

// A repo that already carries the default shim but no marker (a template that
// ships the shim, or a backfill by a release that wrote the shim alone) still
// gets its marker: without it the runner refuses the repo, and the only remedy
// left would be a heal re-accept whose marker commit moves the baseline.
func TestRunEnableAutograder_AddsMarkerWhenShimAlreadyPresent(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, nil),
		repos:       map[string]string{"dst-hello-alice": cliShimEveryPush},
		markerless:  map[string]bool{"dst-hello-alice": true},
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runEnableAutograder(client, &out, &errOut, eaParams()); err != nil {
		t.Fatalf("runEnableAutograder: %v\nstderr: %s", err, errOut.String())
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	alice := fix.committedFiles["dst-hello-alice"]
	if _, ok := alice[contract.MetadataPath]; !ok {
		t.Fatalf("marker must be added to a shim-only repo; files = %v", slices.Sorted(maps.Keys(alice)))
	}
	if _, rewrote := alice[autogradeShimPath]; rewrote {
		t.Error("an existing default shim must not be rewritten")
	}
	if msg := fix.commitMessages["dst-hello-alice"]; msg != contract.ShimBackfillCommitMessage() {
		t.Errorf("marker-only commit message = %q, want the backfill subject so readers keep the root baseline", msg)
	}
	if !strings.Contains(out.String(), "Added the missing "+contract.MetadataPath+" to dst-hello-alice") {
		t.Errorf("per-repo line should name the marker-only write:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "1 added, 0 already had it") {
		t.Errorf("summary should count the marker-only write as an addition:\n%s", out.String())
	}
}

func TestRunEnableAutograder_RendersModeAndTags(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, map[string]any{
			"submission_mode": "tag",
			"submission_tags": []string{"phase1"},
		}),
		repos: map[string]string{"dst-hello-alice": ""},
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runEnableAutograder(client, &out, &errOut, eaParams()); err != nil {
		t.Fatalf("runEnableAutograder: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	shim := string(fix.committedShims["dst-hello-alice"])
	if strings.Contains(shim, "branches:") {
		t.Errorf("tag-mode shim must not have a branches: trigger:\n%s", shim)
	}
	if !strings.Contains(shim, `tags: ["phase1", "submit/*"]`) {
		t.Errorf("shim missing the milestone tags union:\n%s", shim)
	}
}

func TestRunEnableAutograder_Idempotent(t *testing.T) {
	// Already on + every repo already has the shim: no commits anywhere.
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(false, nil),
		repos:       map[string]string{"dst-hello-alice": cliShimEveryPush},
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runEnableAutograder(client, &out, &errOut, eaParams()); err != nil {
		t.Fatalf("runEnableAutograder: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committedAssignments != nil {
		t.Error("idempotent flip must not commit assignments.json")
	}
	if len(fix.committedShims) != 0 {
		t.Errorf("no shim should be written, got %v", fix.committedShims)
	}
	if !strings.Contains(out.String(), "already has the built-in autograder on") {
		t.Errorf("output should report the no-op flip:\n%s", out.String())
	}
	if strings.Contains(out.String(), "next push") {
		t.Errorf("the next-push reminder must only follow a real write:\n%s", out.String())
	}
}

func TestRunEnableAutograder_ForeignFileAtShimPathLeftAlone(t *testing.T) {
	// A hand-added or template-shipped workflow at the reserved path is not
	// the shim: calling it "present" would hide that nothing grades.
	custom := "name: Autograde\non:\n  workflow_dispatch: {}\njobs: {}\n"
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, nil),
		repos:       map[string]string{"dst-hello-alice": custom},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	if err := runEnableAutograder(client, &out, &errOut, eaParams()); err != nil {
		t.Fatalf("an unrecognized file must not fail the command: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if _, wrote := fix.committedShims["dst-hello-alice"]; wrote {
		t.Error("a foreign workflow must never be overwritten")
	}
	if !strings.Contains(errOut.String(), "not the default autograde shim") {
		t.Errorf("skip must be reported on stderr:\n%s", errOut.String())
	}
	if !strings.Contains(out.String(), "0 added, 0 already had it, 1 skipped") {
		t.Errorf("summary should count the skip:\n%s", out.String())
	}
}

func TestRunEnableAutograder_GroupModeRefused(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, map[string]any{"mode": "group", "max_group_size": 3}),
		repos:       map[string]string{"dst-hello-alice": ""},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := runEnableAutograder(client, &out, &errOut, eaParams())
	if err == nil || !strings.Contains(err.Error(), "group assignment") {
		t.Fatalf("expected group-mode refusal, got %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committedAssignments != nil || len(fix.committedShims) != 0 {
		t.Error("refused command must write nothing")
	}
}

func TestRunEnableAutograder_EmptyRepoRefused(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(false, map[string]any{"empty_repo": true}),
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := runEnableAutograder(client, &out, &errOut, eaParams())
	if err == nil || !strings.Contains(err.Error(), "empty_repo") {
		t.Fatalf("expected empty_repo refusal, got %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committedAssignments != nil {
		t.Error("refused command must write nothing")
	}
}

func TestRunEnableAutograder_CustomAutograderRefused(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(false, map[string]any{"autograder": "grader50"}),
		repos:       map[string]string{"dst-hello-alice": ""},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := runEnableAutograder(client, &out, &errOut, eaParams())
	if err == nil || !strings.Contains(err.Error(), "grader50") {
		t.Fatalf("expected custom-autograder refusal, got %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if len(fix.committedShims) != 0 {
		t.Error("a teacher-authored workflow must never be written by this command")
	}
}

func TestRunEnableAutograder_WorkflowScope404Classified(t *testing.T) {
	server, _ := newSMServer(t, smServerConfig{
		assignments:      eaAssignmentsBody(true, nil),
		repos:            map[string]string{"dst-hello-alice": ""},
		workflowScope404: true,
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := runEnableAutograder(client, &out, &errOut, eaParams())
	if err == nil {
		t.Fatal("scope-404 must fail the command")
	}
	if !strings.Contains(errOut.String(), "workflow") {
		t.Errorf("failure should carry the workflow-scope remediation:\n%s", errOut.String())
	}
}

func TestRunEnableAutograder_UserTargetsSingleRepo(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, nil),
		repos: map[string]string{
			"dst-hello-alice": "",
			"dst-hello-bob":   "",
		},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	p := eaParams()
	p.user = "alice"
	if err := runEnableAutograder(client, &out, &errOut, p); err != nil {
		t.Fatalf("runEnableAutograder --user: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if _, wrote := fix.committedShims["dst-hello-alice"]; !wrote {
		t.Error("alice's shim should be added")
	}
	if _, wrote := fix.committedShims["dst-hello-bob"]; wrote {
		t.Error("--user alice must not touch bob's repo")
	}
}

func TestRunEnableAutograder_DryRunWritesNothing(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, nil),
		repos:       map[string]string{"dst-hello-alice": ""},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	p := eaParams()
	p.dryRun = true
	if err := runEnableAutograder(client, &out, &errOut, p); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committedAssignments != nil || len(fix.committedShims) != 0 {
		t.Error("dry run must write nothing")
	}
	for _, want := range []string{"dry run: would turn on", "would have added", "1 would add"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("dry run output missing %q:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "next push") {
		t.Errorf("dry run must not print the post-write reminder:\n%s", out.String())
	}
}

func TestRunEnableAutograder_FieldOnly(t *testing.T) {
	server, fix := newSMServer(t, smServerConfig{
		assignments: eaAssignmentsBody(true, nil),
		repos:       map[string]string{"dst-hello-alice": ""},
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	p := eaParams()
	p.addShims = false
	if err := runEnableAutograder(client, &out, &errOut, p); err != nil {
		t.Fatalf("field-only: %v", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if fix.committedAssignments == nil {
		t.Error("field flip should land")
	}
	if len(fix.committedShims) != 0 {
		t.Error("--add-workflows=false must not touch student repos")
	}
}

func TestRunEnableAutograder_MissingSlugErrors(t *testing.T) {
	server, _ := newSMServer(t, smServerConfig{
		assignments: `{"schema":"classroom50/assignments/v1","assignments":[]}`,
	})
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	if err := runEnableAutograder(client, &out, &errOut, eaParams()); err == nil {
		t.Fatal("missing slug must error")
	}
}
