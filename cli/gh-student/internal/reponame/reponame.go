// Package reponame owns the gh-student-facing assignment-repo naming API,
// delegating to the single cross-binary source in cli/shared/contract
// (AssignmentRepoName / AssignmentRepoPrefix). Kept as a thin named seam so the
// gh-student commands that build or parse a repo name read from one place; the
// formula itself is shared with gh-teacher's download command and mirrored by
// runner.py::username_from_repo. Changing the shape (in contract) silently makes
// `gh teacher download` return zero repos and misidentifies every submission in
// scores.json.
package reponame

import "github.com/foundation50/classroom50-cli-shared/contract"

// Name is the canonical lowercased <classroom>-<assignment>-<username>
// assignment-repo name.
func Name(classroom, assignment, username string) string {
	return contract.AssignmentRepoName(classroom, assignment, username)
}

// Prefix is the group/individual repo-name prefix `<classroom>-<assignment>-`
// (all lowercased). Both the producer (Name) and the consumer
// (group-membership's owner recovery, which strips this prefix) derive from it.
func Prefix(classroom, assignment string) string {
	return contract.AssignmentRepoPrefix(classroom, assignment)
}
