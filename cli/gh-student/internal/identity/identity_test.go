package identity

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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

func TestResolve_PrefersGitConfig(t *testing.T) {
	dir := initRepo(t)
	runGit(t, dir, "config", "user.name", "Ada Lovelace")
	runGit(t, dir, "config", "user.email", "ada@example.edu")

	// Any API call fails the resolve, proving config alone suffices.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unexpected API call", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)

	got, err := Resolve(client, dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := GitIdentity{Name: "Ada Lovelace", Email: "ada@example.edu"}
	if got != want {
		t.Fatalf("Resolve = %+v, want %+v", got, want)
	}
}

func TestResolve_FallsBackToNoreply(t *testing.T) {
	dir := initRepo(t)

	got, err := Resolve(userClient(t, "octocat", 7), dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := GitIdentity{Name: "octocat", Email: "7+octocat@users.noreply.github.com"}
	if got != want {
		t.Fatalf("Resolve = %+v, want %+v", got, want)
	}
}

func TestResolve_FillsOnlyMissingFields(t *testing.T) {
	dir := initRepo(t)
	runGit(t, dir, "config", "user.email", "ada@example.edu")

	got, err := Resolve(userClient(t, "octocat", 7), dir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	want := GitIdentity{Name: "octocat", Email: "ada@example.edu"}
	if got != want {
		t.Fatalf("Resolve = %+v, want %+v", got, want)
	}
}
