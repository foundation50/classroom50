package configrepo

import (
	"fmt"

	"github.com/foundation50/gh-teacher/internal/assignment"
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
		return assignment.AssignmentsJSON{}, fmt.Errorf("%s/%s/%s not found — run `gh teacher classroom add %s %s` first, or restore the file if it was deleted",
			org, ConfigRepoName, path, org, classroom)
	}
	file, err := assignment.ParseAssignments(data)
	if err != nil {
		return assignment.AssignmentsJSON{}, fmt.Errorf("%s/%s/%s: %w", org, ConfigRepoName, path, err)
	}
	return file, nil
}
