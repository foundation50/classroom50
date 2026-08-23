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

// renamedAssignmentsBody is a manifest whose only entry was slug-renamed:
// its renamed_from reserves the old slug and must survive a same-slug re-add.
func renamedAssignmentsBody() string {
	return `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "ps3",
      "name": "PS3",
      "mode": "individual",
      "autograder": "default",
      "renamed_from": "problem-set-three-with-a-legacy-slug",
      "migrated_from": {
        "source": "github_classroom",
        "classroom_id": 7,
        "assignment_id": 9,
        "migrated_at": "2026-01-01T00:00:00Z"
      }
    }
  ]
}`
}

// TestRunAssignmentAdd_BlocksReservedSlug: a renamed assignment's old slug is
// reserved — a new assignment there would mint repos at renamed student repos'
// old names, severing GitHub's redirects. Nothing is committed.
func TestRunAssignmentAdd_BlocksReservedSlug(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments: renamedAssignmentsBody(),
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       "problem-set-three-with-a-legacy-slug",
		Name:       "Sneaky",
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
	})
	if err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("err = %v, want a reserved-slug error", err)
	}
	fix.mu.Lock()
	committed := fix.committed
	fix.mu.Unlock()
	if committed != nil {
		t.Error("a blocked add must not commit anything")
	}
}

// TestRunAssignmentAdd_CarriesRenameAndMigrationProvenance: `add` has no flags
// for renamed_from/migrated_from, and both are known keys (they decode onto
// the struct, not Extra) — a same-slug re-add must carry them or it silently
// erases the rename reservation / migration record.
func TestRunAssignmentAdd_CarriesRenameAndMigrationProvenance(t *testing.T) {
	server, fix := newLockServer(t, lockServerConfig{
		assignments: renamedAssignmentsBody(),
		classroom:   lockClassroomBody(),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentAdd(client, &out, &errOut, addAssignmentParams{
		Org:        "o",
		Classroom:  "dst",
		Slug:       "ps3",
		Name:       "PS3 (edited)",
		Mode:       assignment.ModeIndividual,
		Autograder: "default",
	})
	if err != nil {
		t.Fatalf("runAssignmentAdd(re-add renamed): %v", err)
	}
	got := decodeLock(t, fix).Assignments[0]
	if got.RenamedFrom != "problem-set-three-with-a-legacy-slug" {
		t.Errorf("RenamedFrom = %q, want the prior value carried", got.RenamedFrom)
	}
	if got.MigratedFrom == nil || got.MigratedFrom.ClassroomID != 7 {
		t.Errorf("MigratedFrom = %+v, want the prior record carried", got.MigratedFrom)
	}
}

// TestRunAssignmentReuse_BlocksReservedSlug: an explicit --slug matching a
// TARGET-classroom renamed_from is refused before anything is committed.
func TestRunAssignmentReuse_BlocksReservedSlug(t *testing.T) {
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceAssignmentsBody(),
		targetAssignments: renamedAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
	})
	client := githubtest.NewTestClient(t, server)

	params := baseReuseParams()
	params.SlugOverride = "problem-set-three-with-a-legacy-slug"
	params.SlugWasSet = true

	var out, errOut bytes.Buffer
	err := runAssignmentReuse(client, &out, &errOut, params)
	if err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("err = %v, want a reserved-slug error", err)
	}
	fix.mu.Lock()
	committed := fix.committed
	fix.mu.Unlock()
	if committed != nil {
		t.Error("a blocked reuse must not commit anything")
	}
}

// TestRunAssignmentReuse_ClearsRenamedFrom: renamed_from is source-classroom
// provenance (the copy has no renamed repos), so the copy must not carry it —
// otherwise it wrongly reserves a slug and grandfathers old-slug submissions
// in the target.
func TestRunAssignmentReuse_ClearsRenamedFrom(t *testing.T) {
	sourceBody := `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    { "slug": "hello", "name": "Hello", "mode": "individual", "autograder": "default", "renamed_from": "hello-with-a-legacy-slug" }
  ]
}`
	server, fix := newReuseServer(t, reuseServerConfig{
		sourceAssignments: sourceBody,
		targetAssignments: emptyAssignmentsBody(),
		targetClassroom:   targetClassroomBody(nil),
	})
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentReuse(client, &out, &errOut, baseReuseParams()); err != nil {
		t.Fatalf("runAssignmentReuse: %v", err)
	}
	got := decodeReuse(t, fix).Assignments[0]
	if got.RenamedFrom != "" {
		t.Errorf("RenamedFrom = %q, want cleared on reuse", got.RenamedFrom)
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
