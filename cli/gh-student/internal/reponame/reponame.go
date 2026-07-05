// Package reponame owns the canonical assignment-repo naming formula, a
// cross-binary contract shared with cli/gh-teacher (which rebuilds the prefix
// by hand in download.go — separate go.mod, no shared symbol) and
// runner.py::username_from_repo. Changing the shape here silently makes
// `gh teacher download` return zero repos and misidentifies every submission
// in scores.json, so it lives in one named seam consumed by every gh-student
// command that builds or parses a repo name.
package reponame

import (
	"fmt"
	"strings"
)

// Name is the canonical lowercased <classroom>-<assignment>-<username>
// assignment-repo name.
func Name(classroom, assignment, username string) string {
	return Prefix(classroom, assignment) + strings.ToLower(username)
}

// Prefix is the single source of the group/individual repo-name prefix
// `<classroom>-<assignment>-` (all lowercased). Both the producer (Name) and
// the consumer (group-membership's owner recovery, which strips this prefix)
// derive from it, so the `<classroom>-<assignment>-<owner>` shape can only
// change in one place.
func Prefix(classroom, assignment string) string {
	return fmt.Sprintf("%s-%s-",
		strings.ToLower(classroom),
		strings.ToLower(assignment),
	)
}
