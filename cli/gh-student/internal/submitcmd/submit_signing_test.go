package submitcmd

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	identitypkg "github.com/foundation50/gh-student/internal/identity"
)

// Regression guard for #1078: the student's signing key is configured for the
// clone only (local config or an includeIf "gitdir:" include) while
// commit.gpgsign is global. The submit commit is created in a temp clone,
// where the key is invisible but the signing switch still applies, so git
// used to fail with "either user.signingkey or gpg.ssh.defaultKeyCommand
// needs to be configured". Uses real SSH signing so the assertion is on an
// actual signature header, not merely on the absence of a signing error.
func TestCommitWorkTreeOnRemoteBranch_SignsWithCloneSigningConfig(t *testing.T) {
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("ssh-keygen not available")
	}
	tmp := t.TempDir()

	// The student's global config: signing on, key nowhere global.
	global := filepath.Join(tmp, "gitconfig")
	globalBody := "[user]\n\tname = Ada Lovelace\n\temail = ada@example.edu\n" +
		"[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n"
	if err := os.WriteFile(global, []byte(globalBody), 0o644); err != nil {
		t.Fatalf("write global config: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)

	key := filepath.Join(tmp, "id_ed25519")
	if out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v\n%s", err, out)
	}

	// The student's clone knows the key; the bare remote it pushes to is
	// what commitWorkTreeOnRemoteBranch clones into the temp area.
	clone := filepath.Join(tmp, "clone")
	_git(t, tmp, "init", "-q", "-b", "main", clone)
	_git(t, clone, "config", "user.signingkey", key)
	_git(t, clone, "commit", "-q", "--allow-empty", "-m", "Accept hello")
	remote := filepath.Join(tmp, "remote.git")
	_git(t, tmp, "clone", "-q", "--bare", clone, remote)

	// A nil client is safe: name and email resolve from the global config
	// above, so Resolve never reaches the API fallback.
	identity, err := identitypkg.Resolve(nil, clone)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	workTree := filepath.Join(tmp, "worktree")
	if err := os.MkdirAll(workTree, 0o755); err != nil {
		t.Fatalf("mkdir worktree: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workTree, "hello.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatalf("write worktree file: %v", err)
	}
	gitDir := filepath.Join(tmp, "submission.git")

	sha, err := commitWorkTreeOnRemoteBranch(
		context.Background(), gitDir, workTree, remote, "main", "Submit hello",
		identity, io.Discard, io.Discard,
	)
	if err != nil {
		t.Fatalf("commitWorkTreeOnRemoteBranch: %v", err)
	}

	if head := _git(t, remote, "rev-parse", "main"); head != sha {
		t.Fatalf("remote main = %s, want the pushed submission %s", head, sha)
	}
	commit := _git(t, remote, "cat-file", "commit", sha)
	if !strings.Contains(commit, "gpgsig -----BEGIN SSH SIGNATURE-----") {
		t.Fatalf("submission commit is not SSH-signed:\n%s", commit)
	}
	if !strings.Contains(commit, "Ada Lovelace <ada@example.edu>") {
		t.Fatalf("submission commit lacks the student's identity:\n%s", commit)
	}
}

// The clone's own config must win over global config in the temp clone too:
// a student who turned signing off for this repository (and has no key)
// submits unsigned instead of hitting the missing-key error.
func TestCommitWorkTreeOnRemoteBranch_CloneConfigOverridesGlobalSigning(t *testing.T) {
	tmp := t.TempDir()

	global := filepath.Join(tmp, "gitconfig")
	globalBody := "[user]\n\tname = Ada Lovelace\n\temail = ada@example.edu\n" +
		"[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n"
	if err := os.WriteFile(global, []byte(globalBody), 0o644); err != nil {
		t.Fatalf("write global config: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)

	clone := filepath.Join(tmp, "clone")
	_git(t, tmp, "init", "-q", "-b", "main", clone)
	_git(t, clone, "config", "commit.gpgsign", "false")
	_git(t, clone, "commit", "-q", "--allow-empty", "-m", "Accept hello")
	remote := filepath.Join(tmp, "remote.git")
	_git(t, tmp, "clone", "-q", "--bare", clone, remote)

	identity, err := identitypkg.Resolve(nil, clone)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	sha, err := commitWorkTreeOnRemoteBranch(
		context.Background(), filepath.Join(tmp, "submission.git"), t.TempDir(), remote, "main", "Submit hello",
		identity, io.Discard, io.Discard,
	)
	if err != nil {
		t.Fatalf("commitWorkTreeOnRemoteBranch: %v", err)
	}
	if commit := _git(t, remote, "cat-file", "commit", sha); strings.Contains(commit, "gpgsig") {
		t.Fatalf("submission commit must be unsigned when the clone disables signing:\n%s", commit)
	}
}
