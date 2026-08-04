package submitcmd

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// _tagTestRepos builds the fixture pushSubmitTag runs against: a bare
// "remote" with one commit on main, and a local bare clone of it (the shape
// commitWorkTreeOnRemoteBranch leaves behind). Returns (localGitDir,
// remoteGitDir, commitSHA).
func _tagTestRepos(t *testing.T) (string, string, string) {
	t.Helper()
	tmp := t.TempDir()

	run := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}

	// Seed a work repo, then serve it as a bare remote.
	seed := filepath.Join(tmp, "seed")
	run(tmp, "init", "-q", "-b", "main", seed)
	run(seed, "-c", "user.name=t", "-c", "user.email=t@example.com",
		"commit", "-q", "--allow-empty", "-m", "Submit hello")
	sha := run(seed, "rev-parse", "HEAD")

	remote := filepath.Join(tmp, "remote.git")
	run(tmp, "clone", "-q", "--bare", seed, remote)

	local := filepath.Join(tmp, "local.git")
	run(tmp, "clone", "-q", "--bare", remote, local)

	return local, remote, sha
}

func _remoteTags(t *testing.T, remote string) []string {
	t.Helper()
	out, err := exec.Command("git", "--git-dir", remote, "tag", "--list").Output()
	if err != nil {
		t.Fatalf("list remote tags: %v", err)
	}
	var tags []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" {
			tags = append(tags, l)
		}
	}
	return tags
}

func TestPushSubmitTag_PushesCanonicalTag(t *testing.T) {
	local, remote, sha := _tagTestRepos(t)

	origNow := timeNow
	t.Cleanup(func() { timeNow = origNow })
	timeNow = func() time.Time {
		return time.Date(2026, 8, 3, 14, 30, 5, 0, time.UTC)
	}

	tag, err := pushSubmitTag(local, sha)
	if err != nil {
		t.Fatalf("pushSubmitTag: %v", err)
	}
	want := "submit/2026-08-03T14-30-05Z-" + sha[:7]
	if tag != want {
		t.Errorf("tag = %q, want %q", tag, want)
	}
	tags := _remoteTags(t, remote)
	if len(tags) != 1 || tags[0] != want {
		t.Errorf("remote tags = %v, want [%s]", tags, want)
	}
}

func TestPushSubmitTag_ReusesExistingTagAtSHA(t *testing.T) {
	// A retry after a tag-push failure — or a hand-pushed submit/* tag —
	// must be reused, never duplicated: one grading run per commit.
	local, remote, sha := _tagTestRepos(t)

	pre := "submit/hand-pushed"
	if out, err := exec.Command(
		"git", "--git-dir", local, "push", "origin", sha+":refs/tags/"+pre,
	).CombinedOutput(); err != nil {
		t.Fatalf("seed existing tag: %v\n%s", err, out)
	}

	tag, err := pushSubmitTag(local, sha)
	if err != nil {
		t.Fatalf("pushSubmitTag: %v", err)
	}
	if tag != pre {
		t.Errorf("tag = %q, want reused %q", tag, pre)
	}
	if tags := _remoteTags(t, remote); len(tags) != 1 {
		t.Errorf("remote tags = %v, want exactly the pre-existing one", tags)
	}
}

func TestPushSubmitTag_NonSubmitTagAtSHAIsIgnored(t *testing.T) {
	// Only submit/* tags count as submissions; an unrelated tag at the same
	// SHA must not suppress the canonical submit tag.
	local, remote, sha := _tagTestRepos(t)

	if out, err := exec.Command(
		"git", "--git-dir", local, "push", "origin", sha+":refs/tags/v1.0",
	).CombinedOutput(); err != nil {
		t.Fatalf("seed unrelated tag: %v\n%s", err, out)
	}

	tag, err := pushSubmitTag(local, sha)
	if err != nil {
		t.Fatalf("pushSubmitTag: %v", err)
	}
	if !strings.HasPrefix(tag, "submit/") {
		t.Errorf("tag = %q, want a fresh submit/* tag", tag)
	}
	if tags := _remoteTags(t, remote); len(tags) != 2 {
		t.Errorf("remote tags = %v, want v1.0 plus the submit tag", tags)
	}
}

func TestPushSubmitTag_PushFailureSurfacesError(t *testing.T) {
	local, _, sha := _tagTestRepos(t)
	// Point origin at a nonexistent path so the push fails.
	if out, err := exec.Command(
		"git", "--git-dir", local, "remote", "set-url", "origin",
		filepath.Join(t.TempDir(), "gone.git"),
	).CombinedOutput(); err != nil {
		t.Fatalf("set-url: %v\n%s", err, out)
	}
	if _, err := pushSubmitTag(local, sha); err == nil {
		t.Fatal("pushSubmitTag against a dead remote must error (submit surfaces the re-run guidance)")
	}
}
