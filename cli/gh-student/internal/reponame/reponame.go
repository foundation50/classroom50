// Package reponame is the gh-student-facing assignment-repo naming API — a thin
// named seam so gh-student commands read the repo-name formula from one place.
// It delegates to the single cross-binary source in cli/shared/contract
// (AssignmentRepoName / AssignmentRepoPrefix), where the shape and its
// keep-byte-identical contract are documented.
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
