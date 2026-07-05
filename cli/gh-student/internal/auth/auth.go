// Package auth implements the gh-student authentication commands: whoami,
// login, and logout. Mirrors cli/gh-teacher/internal/auth — thin cobra
// wrappers over the shared classroom50-cli-shared/ghauth scaffolding and the
// internal/githubapi client seam.
package auth

import (
	"github.com/foundation50/classroom50-cli-shared/ghauth"
)

// isInteractiveTTY reports whether stdin+stderr are both a TTY.
func isInteractiveTTY() bool { return ghauth.IsInteractiveTTY() }
