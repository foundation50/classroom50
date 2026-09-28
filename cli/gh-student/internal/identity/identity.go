// Package identity resolves the git author/committer identity stamped on
// submit commits, and the commit-signing config they're signed with.
package identity

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"

	"github.com/foundation50/gh-student/internal/githubapi"
)

// GitIdentity is what a submit commit carries over from the student's clone:
// the author/committer pair and the commit-signing config git resolves there.
type GitIdentity struct {
	Name  string
	Email string
	// Signing holds the config entries that decide whether and how git signs
	// the commit, as `key=value` or a bare `key` for a valueless boolean.
	Signing []string
}

// ConfigArgs returns the `-c` flags that apply the identity to a git command
// run against another repository, such as the temp submit clone.
func (id GitIdentity) ConfigArgs() []string {
	args := []string{"-c", "user.name=" + id.Name, "-c", "user.email=" + id.Email}
	for _, entry := range id.Signing {
		args = append(args, "-c", entry)
	}
	return args
}

// Resolve returns the user's git identity as configured for the repo at dir
// (the submit commit is created in a temp clone, where that config wouldn't
// apply — and a mismatched email makes signed commits show as unverified).
// Unset fields fall back to the GitHub login + noreply email, so a shell
// without git identity still submits.
func Resolve(client githubapi.Client, dir string) (GitIdentity, error) {
	identity := GitIdentity{
		Name:    gitConfig(dir, "user.name"),
		Email:   gitConfig(dir, "user.email"),
		Signing: signingConfig(dir),
	}
	if identity.Name != "" && identity.Email != "" {
		return identity, nil
	}

	login, id, err := githubapi.CurrentUser(client)
	if err != nil {
		return GitIdentity{}, err
	}
	if identity.Name == "" {
		identity.Name = login
	}
	if identity.Email == "" {
		identity.Email = fmt.Sprintf("%d+%s@users.noreply.github.com", id, login)
	}
	return identity, nil
}

// gitConfigOutput runs `git config <args>` as resolved from dir, or returns
// nil when it fails (best-effort: callers fall back or leave defaults).
func gitConfigOutput(dir string, args ...string) []byte {
	cmd := exec.Command("git", append([]string{"-C", dir, "config"}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return out
}

// gitConfig returns key as git resolves it from dir, or "" when unset or
// unreadable (the noreply fallback covers it).
func gitConfig(dir, key string) string {
	return strings.TrimSpace(string(gitConfigOutput(dir, "--get", key)))
}

// signingConfigPattern matches every key git consults when signing a commit:
// the switch, the key, and the gpg.* family (format, programs, ssh options).
const signingConfigPattern = `^(commit\.gpgsign|user\.signingkey|gpg\.)`

// signingConfig returns the commit-signing config as git resolves it from
// dir, which includes `includeIf "gitdir:"` matches the temp clone never sees
// (#1078). Unreadable or empty resolves as nil, leaving the temp clone's own
// resolution in place.
func signingConfig(dir string) []string {
	return parseConfigEntries(gitConfigOutput(dir, "--get-regexp", "-z", signingConfigPattern))
}

// parseConfigEntries turns `git config --get-regexp -z` output into `-c`
// operands. A NUL-terminated record is `key\nvalue`, or a bare `key` for a
// valueless boolean, which must stay bare: `key=` would read as false.
func parseConfigEntries(out []byte) []string {
	var entries []string
	for _, record := range bytes.Split(out, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		entries = append(entries, strings.Replace(string(record), "\n", "=", 1))
	}
	return entries
}
