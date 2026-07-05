// Package ignorematch classifies repository paths against an ordered list of
// .gitignore-style patterns (the assignment's allowed_files), delegating to
// `git check-ignore` so negation, ordering, and directory rules match
// .gitignore exactly.
//
// allowed_files is an allowlist in gitignore syntax: `*` then `!hello.py`
// allows only hello.py. A path is ALLOWED when git would NOT ignore it.
// Mirrors the runner.py classifier; callers force-keep control paths.
package ignorematch

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// gitTimeout bounds each git call so a hung git can't block the
// `gh student submit` hot path; the caller degrades safely on error.
const gitTimeout = 30 * time.Second

// Disallowed returns the subset of paths the patterns do NOT allow (the paths
// git would ignore under an allowlist built from patterns). Empty patterns or
// paths returns an empty set. Paths are forward-slash relative, as git emits.
func Disallowed(patterns []string, paths []string) (map[string]bool, error) {
	disallowed := make(map[string]bool)
	if len(patterns) == 0 || len(paths) == 0 {
		return disallowed, nil
	}

	tmpDir, err := os.MkdirTemp("", "classroom50-ignore-*")
	if err != nil {
		return nil, fmt.Errorf("create temp ignore dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	// check-ignore needs a repo context even with --no-index, so use a
	// throwaway repo whose .gitignore is the pattern list, isolated from the
	// host's git config (see isolatedGitEnv). Mirrors runner.py.
	gitEnv := isolatedGitEnv()
	initCtx, cancelInit := context.WithTimeout(context.Background(), gitTimeout)
	defer cancelInit()
	initCmd := exec.CommandContext(initCtx, "git", "-C", tmpDir, "init", "-q")
	initCmd.Env = gitEnv
	if out, err := initCmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("git init temp ignore repo: %w: %s", err, strings.TrimSpace(string(out)))
	}

	ignorePath := filepath.Join(tmpDir, ".gitignore")
	if err := os.WriteFile(ignorePath, []byte(strings.Join(patterns, "\n")+"\n"), 0o644); err != nil {
		return nil, fmt.Errorf("write ignore patterns: %w", err)
	}

	checkCtx, cancelCheck := context.WithTimeout(context.Background(), gitTimeout)
	defer cancelCheck()
	cmd := exec.CommandContext(checkCtx, "git", "-c", "core.excludesFile="+os.DevNull,
		"check-ignore", "--no-index", "--stdin", "-z")
	cmd.Dir = tmpDir
	cmd.Env = gitEnv
	cmd.Stdin = bytes.NewReader([]byte(strings.Join(paths, "\x00") + "\x00"))

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// check-ignore exits 0 (>=1 ignored), 1 (none ignored), >1 (error).
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return disallowed, nil
		}
		return nil, fmt.Errorf("git check-ignore: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	for _, p := range bytes.Split(stdout.Bytes(), []byte{0}) {
		if len(p) == 0 {
			continue
		}
		disallowed[string(p)] = true
	}
	return disallowed, nil
}

// isolatedGitEnv neutralizes git's system/global config so the matcher
// classifies identically regardless of the user's global gitignore. Paired
// with `-c core.excludesFile`. Mirrors runner.py's _isolated_git_env.
func isolatedGitEnv() []string {
	return append(os.Environ(),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL="+os.DevNull,
	)
}
