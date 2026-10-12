package configrepo

import (
	"fmt"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// LoadAssignments reads and parses a classroom's assignments.json at `ref`.
// Mirrors LoadRoster/LoadClassroom: the read substrate lives here, the typed
// shape + parse logic in internal/assignment. A missing file is an actionable
// error.
func LoadAssignments(client githubapi.Client, org, classroom, ref string) (assignment.AssignmentsJSON, error) {
	path := assignment.AssignmentsFilePath(classroom)
	data, ok, err := ReadFileContents(client, org, ConfigRepoName, path, ref)
	if err != nil {
		return assignment.AssignmentsJSON{}, err
	}
	if !ok {
		return assignment.AssignmentsJSON{}, fmt.Errorf("%s/%s/%s not found: run `gh teacher classroom add %s %s` first, or restore the file if it was deleted",
			org, ConfigRepoName, path, org, classroom)
	}
	file, err := assignment.ParseAssignments(data)
	if err != nil {
		return assignment.AssignmentsJSON{}, fmt.Errorf("%s/%s/%s: %w", org, ConfigRepoName, path, err)
	}
	return file, nil
}

// ResolvedAssignment is the per-command context an assignment-scoped command
// resolves before anything else: the config-repo branch, the assignments file
// (so a caller can also look at siblings), and the scope's own entry.
type ResolvedAssignment struct {
	Branch string
	File   assignment.AssignmentsJSON
	Entry  assignment.AssignmentEntry
}

// ResolveAssignment resolves the config-repo branch and loads the registered
// entry for scope. `missingHint` finishes the not-registered error with this
// command's next step (for example "run `gh teacher assignment list ...`"), so
// each command keeps its own remediation while sharing the lookup.
func ResolveAssignment(client githubapi.Client, scope cliutil.AssignmentScope, missingHint string) (ResolvedAssignment, error) {
	branch, err := ResolveConfigRepoBranch(client, scope.Org)
	if err != nil {
		return ResolvedAssignment{}, err
	}
	file, err := LoadAssignments(client, scope.Org, scope.Classroom, branch)
	if err != nil {
		return ResolvedAssignment{}, err
	}
	idx, ok := assignment.FindAssignment(file.Assignments, scope.Assignment)
	if !ok {
		return ResolvedAssignment{}, fmt.Errorf("assignment %q is not registered in %s/%s/%s: %s",
			scope.Assignment, scope.Org, ConfigRepoName, assignment.AssignmentsFilePath(scope.Classroom), missingHint)
	}
	return ResolvedAssignment{Branch: branch, File: file, Entry: file.Assignments[idx]}, nil
}
