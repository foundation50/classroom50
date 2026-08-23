package assignmentcmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// overBudgetSlug composes past GitHub's 100-char repo-name limit with the
// 3-char test classroom "dst": 3 + 1 + 57 + 1 + 39 = 101.
var overBudgetSlug = strings.Repeat("s", 57)

// overBudgetAssignmentsBody is a manifest already carrying an over-budget
// (pre-cap) template-less entry, for the replace-stays-allowed tests.
func overBudgetAssignmentsBody() string {
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "` + overBudgetSlug + `",
      "name": "Long",
      "mode": "individual",
      "autograder": "default"
    }
  ]
}`
}

// TestRunAssignmentAdd_BlocksNewOverBudgetSlug: a NEW slug whose composed
// `<classroom>-<slug>-<username>` name can exceed GitHub's 100-char limit is a
// hard preflight error (#691) — nothing is committed, so no config entry or
// template grant is left behind.
func TestRunAssignmentAdd_BlocksNewOverBudgetSlug(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments: lockAssignmentsBody(false),
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       overBudgetSlug,
		Name:       "Long",
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
	})
	if err == nil || !strings.Contains(err.Error(), "repo-name limit") {
		t.Fatalf("err = %v, want a repo-name limit error", err)
	}
	fix.mu.Lock()
	committed := fix.committed
	fix.mu.Unlock()
	if committed != nil {
		t.Error("a blocked add must not commit anything")
	}
}

// TestRunAssignmentAdd_AllowsReplacingOverBudgetSlug: the budget is a
// creation-time rule only — a same-slug replace of a pre-cap over-budget entry
// must keep working (the teacher can still edit it), with the standing accept
// risk surfaced as a warning.
func TestRunAssignmentAdd_AllowsReplacingOverBudgetSlug(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments: overBudgetAssignmentsBody(),
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       overBudgetSlug,
		Name:       "Long (edited)",
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(replace over-budget): %v", err)
	}
	file := decodeLock(t, fix)
	if len(file.Assignments) != 1 || file.Assignments[0].Name != "Long (edited)" {
		t.Errorf("replace did not land, got %+v", file.Assignments)
	}
	if !strings.Contains(errOut.String(), "repo-name limit") {
		t.Errorf("errOut = %q, want the over-budget warning", errOut.String())
	}
}

// TestRunAssignmentReuse_BlocksOverBudgetSlug: an EXPLICIT --slug past the
// target's budget is refused inside the build — nothing is committed.
func TestRunAssignmentReuse_BlocksOverBudgetSlug(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
	})
	client := githubtest.NewTestClient(t, server)

	params := baseReuseParams()
	params.SlugOverride = overBudgetSlug
	params.SlugWasSet = true

	var out, errOut bytes.Buffer
	err := runAssignmentReuse(client, &out, &errOut, params)
	if err == nil || !strings.Contains(err.Error(), "repo-name limit") {
		t.Fatalf("err = %v, want a repo-name limit error", err)
	}
	fix.mu.Lock()
	committed := fix.committed
	fix.mu.Unlock()
	if committed != nil {
		t.Error("a blocked reuse must not commit anything")
	}
}

// TestRunAssignmentReuse_TrimsAutoSlugToBudget: the AUTO-derived slug (no
// --slug) is trimmed to the target classroom's budget instead of erroring,
// mirroring the web reuse modals, with a note naming why the copy was renamed.
func TestRunAssignmentReuse_TrimsAutoSlugToBudget(t *testing.T) {
	// "dst" (3) leaves 59 - 3 = 56 slug chars; the 57-char source slug trims.
	longSlug := strings.Repeat("s", 57)
	sourceBody := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    { "slug": "` + longSlug + `", "name": "Long", "mode": "individual", "autograder": "default" }
  ]
}`
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceBody,
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
	})
	client := githubtest.NewTestClient(t, server)

	params := baseReuseParams()
	params.SourceSlug = longSlug

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, params); err != nil {
		t.Fatalf("runAssignmentReuse(auto slug): %v", err)
	}
	file := decodeReuse(t, fix)
	want := strings.Repeat("s", 56)
	if len(file.Assignments) != 1 || file.Assignments[0].Slug != want {
		t.Errorf("committed slug = %+v, want %q", file.Assignments, want)
	}
	if !strings.Contains(errOut.String(), "past GitHub's") {
		t.Errorf("errOut = %q, want the budget-trim note", errOut.String())
	}
}
