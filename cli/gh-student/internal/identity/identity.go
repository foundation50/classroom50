// Package identity resolves the git author/committer identity stamped on
// submit commits.
package identity

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/foundation50/gh-student/internal/githubapi"
)

// GitIdentity is the author/committer pair stamped on submit commits.
type GitIdentity struct {
	Name  string
	Email string
}

// Resolve returns the user's git identity as configured for the repo at dir
// (the submit commit is created in a temp clone, where that config wouldn't
// apply — and a mismatched email makes signed commits show as unverified).
// Unset fields fall back to the GitHub login + noreply email, so a shell
// without git identity still submits.
func Resolve(client githubapi.Client, dir string) (GitIdentity, error) {
	identity := GitIdentity{
		Name:  gitConfig(dir, "user.name"),
		Email: gitConfig(dir, "user.email"),
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

// gitConfig returns key as git resolves it from dir, or "" when unset or
// unreadable (best-effort — the noreply fallback covers it).
func gitConfig(dir, key string) string {
	cmd := exec.Command("git", "-C", dir, "config", "--get", key)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
