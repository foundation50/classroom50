package identity

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"testing"

	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/githubtest"
)

// initRepo creates a temp git repo hidden from the host's global/system git
// config, so only config set by the test is visible.
func initRepo(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)

	dir := t.TempDir()
	runGit(t, dir, "init")
	return dir
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func userClient(t *testing.T, login string, id int64) githubapi.Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/user", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"login":"` + login + `","id":` + strconv.FormatInt(id, 10) + `}`))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return githubtest.NewTestClient(t, server)
}

// noAPIClient fails any request, proving git config alone sufficed.
func noAPIClient(t *testing.T) githubapi.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unexpected API call", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	return githubtest.NewTestClient(t, server)
}

func assertIdentity(t *testing.T, got, want GitIdentity) {
	t.Helper()
	// Signing order follows git's config-file order, which is not what these
	// tests pin.
	slices.Sort(got.Signing)
	slices.Sort(want.Signing)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Resolve = %+v, want %+v", got, want)
	}
}

func TestResolve_PrefersGitConfig(t *testing.T) {
	dir := initRepo(t)
	runGit(t, dir, "config", "user.name", "Ada Lovelace")
	runGit(t, dir, "config", "user.email", "ada@example.edu")

	got, err := Resolve(noAPIClient(t), dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	assertIdentity(t, got, GitIdentity{Name: "Ada Lovelace", Email: "ada@example.edu"})
}

func TestResolve_FallsBackToNoreply(t *testing.T) {
	dir := initRepo(t)

	got, err := Resolve(userClient(t, "octocat", 7), dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	assertIdentity(t, got, GitIdentity{Name: "octocat", Email: "7+octocat@users.noreply.github.com"})
}

func TestResolve_FillsOnlyMissingFields(t *testing.T) {
	dir := initRepo(t)
	runGit(t, dir, "config", "user.email", "ada@example.edu")

	got, err := Resolve(userClient(t, "octocat", 7), dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	assertIdentity(t, got, GitIdentity{Name: "octocat", Email: "ada@example.edu"})
}

// #1078: signing config that only applies to the clone must ride along with
// the identity, since the submit commit is created in a temp clone.
func TestResolve_CarriesRepoSigningConfig(t *testing.T) {
	dir := initRepo(t)
	runGit(t, dir, "config", "user.name", "Ada Lovelace")
	runGit(t, dir, "config", "user.email", "ada@example.edu")
	runGit(t, dir, "config", "commit.gpgsign", "true")
	runGit(t, dir, "config", "gpg.format", "ssh")
	runGit(t, dir, "config", "user.signingkey", "~/.ssh/github.pub")
	// Verification-only and unrelated keys: the former is harmless to forward,
	// the latter must not be.
	runGit(t, dir, "config", "gpg.ssh.allowedSignersFile", "~/.ssh/allowed_signers")
	runGit(t, dir, "config", "push.autoSetupRemote", "true")

	got, err := Resolve(noAPIClient(t), dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	assertIdentity(t, got, GitIdentity{
		Name:  "Ada Lovelace",
		Email: "ada@example.edu",
		Signing: []string{
			"commit.gpgsign=true",
			"gpg.format=ssh",
			"gpg.ssh.allowedsignersfile=~/.ssh/allowed_signers",
			"user.signingkey=~/.ssh/github.pub",
		},
	})
}

// A per-directory `includeIf "gitdir:"` is the common way to scope a signing
// key to coursework; it resolves for the clone but never for the temp clone.
func TestResolve_CarriesIncludeIfSigningConfig(t *testing.T) {
	dir := initRepo(t)
	// git matches gitdir: against the real path, and macOS temp dirs are
	// symlinked.
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}

	scoped := filepath.Join(t.TempDir(), "coursework.gitconfig")
	if err := os.WriteFile(scoped, []byte("[user]\n\tsigningkey = ~/.ssh/school.pub\n"), 0o644); err != nil {
		t.Fatalf("write scoped config: %v", err)
	}
	global := filepath.Join(t.TempDir(), "gitconfig")
	globalBody := "[user]\n\tname = Ada Lovelace\n\temail = ada@example.edu\n" +
		"[commit]\n\tgpgsign\n" + // valueless boolean, must stay bare
		"[gpg]\n\tformat = ssh\n" +
		"[includeIf \"gitdir:" + realDir + "/\"]\n\tpath = " + scoped + "\n"
	if err := os.WriteFile(global, []byte(globalBody), 0o644); err != nil {
		t.Fatalf("write global config: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", global)

	got, err := Resolve(noAPIClient(t), dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	assertIdentity(t, got, GitIdentity{
		Name:  "Ada Lovelace",
		Email: "ada@example.edu",
		Signing: []string{
			"commit.gpgsign",
			"gpg.format=ssh",
			"user.signingkey=~/.ssh/school.pub",
		},
	})
}

// `-c` applies in order, so Signing must keep git's scope order (global
// before local) for the clone's own setting to win.
func TestResolve_SigningConfigKeepsScopeOrder(t *testing.T) {
	dir := initRepo(t)
	global := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(global, []byte("[commit]\n\tgpgsign = true\n"), 0o644); err != nil {
		t.Fatalf("write global config: %v", err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	runGit(t, dir, "config", "user.name", "Ada Lovelace")
	runGit(t, dir, "config", "user.email", "ada@example.edu")
	runGit(t, dir, "config", "commit.gpgsign", "false")

	got, err := Resolve(noAPIClient(t), dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := []string{"commit.gpgsign=true", "commit.gpgsign=false"}
	if !reflect.DeepEqual(got.Signing, want) {
		t.Fatalf("Signing = %q, want %q (global first, local last)", got.Signing, want)
	}
}

func TestGitIdentity_ConfigArgs(t *testing.T) {
	id := GitIdentity{
		Name:    "Ada Lovelace",
		Email:   "ada@example.edu",
		Signing: []string{"commit.gpgsign", "user.signingkey=~/.ssh/school.pub"},
	}
	want := []string{
		"-c", "user.name=Ada Lovelace",
		"-c", "user.email=ada@example.edu",
		"-c", "commit.gpgsign",
		"-c", "user.signingkey=~/.ssh/school.pub",
	}
	if got := id.ConfigArgs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("ConfigArgs = %q, want %q", got, want)
	}
}
