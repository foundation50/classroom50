// Package localgit holds small helpers that inspect the caller's local git
// working tree (not the GitHub API). Extracted so the accept/submit/invite
// commands can share them without living in a command file.
package localgit

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// CurrentGitRoot returns the toplevel of the git repo the process runs from,
// and whether cwd is inside a git tree at all. Used to warn against nested
// clones. A non-git cwd is ("", false, nil); git-not-found (or another exec
// failure) propagates as an error.
func CurrentGitRoot() (string, bool, error) {
	cmd := exec.Command("git", "rev-parse", "--show-toplevel")

	out, err := cmd.Output()
	if err != nil {
		if _, ok := errors.AsType[*exec.ExitError](err); ok {
			// Not inside a git tree.
			return "", false, nil
		}
		// e.g. git not installed.
		return "", false, fmt.Errorf("check git repository: %w", err)
	}

	return strings.TrimSpace(string(out)), true, nil
}
