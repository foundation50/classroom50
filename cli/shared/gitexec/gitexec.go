// Package gitexec builds git subprocesses that cannot hang on a stalled
// network connection, shared by gh-teacher (download) and gh-student (submit).
package gitexec

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// Vars rather than consts so tests can shrink them.
var (
	// StallTimeout makes git abort an HTTPS transfer that moves under 1 byte/s
	// for this long: a dead connection fails in seconds, a slow one does not.
	StallTimeout = 30 * time.Second
	// WaitDelay bounds Wait() on a killed git's pipes, which an orphaned
	// git-remote-https still holds open.
	WaitDelay = 5 * time.Second
)

// Command builds a ctx-bound git-backed subprocess (git itself, or gh wrapping
// git) with the HTTPS stall detector and WaitDelay applied. Both are no-ops
// for local-only subcommands, so callers need no network/local split.
func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(),
		"GIT_HTTP_LOW_SPEED_LIMIT=1",
		"GIT_HTTP_LOW_SPEED_TIME="+strconv.Itoa(int(StallTimeout/time.Second)),
	)
	cmd.WaitDelay = WaitDelay
	return cmd
}
