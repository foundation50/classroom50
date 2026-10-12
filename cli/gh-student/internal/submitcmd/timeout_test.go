package submitcmd

// Regression guards for #932: every network step in submit must return an
// error against a connection that accepts but never answers.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/foundation50/classroom50-cli-shared/ghauth"
	"github.com/foundation50/classroom50-cli-shared/gitexec"
	"github.com/foundation50/gh-student/internal/githubtest"
	identitypkg "github.com/foundation50/gh-student/internal/identity"
)

const stallCeiling = 2 * time.Second

// stalledServer holds every request open until the client gives up, so
// Close() never blocks on a handler.
func stalledServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	return server
}

// stalledRemoteURL points at a socket that completes the TCP handshake (via
// the listen backlog) but never sends a byte, like a dead VPN looks to git.
func stalledRemoteURL(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return fmt.Sprintf("http://%s/o/repo.git", ln.Addr().String())
}

func setTimeout(t *testing.T, target *time.Duration, d time.Duration) {
	t.Helper()
	restore := *target
	*target = d
	t.Cleanup(func() { *target = restore })
}

func assertStalledFailure(t *testing.T, what string, elapsed time.Duration, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: expected an error against a stalled connection, got nil", what)
	}
	if elapsed > stallCeiling {
		t.Fatalf("%s took %v to fail; it should fail near its timeout, not hang", what, elapsed)
	}
}

func TestResolveRepoDefaultBranch_FailsFastOnStall(t *testing.T) {
	setTimeout(t, &defaultBranchTimeout, 50*time.Millisecond)
	client := githubtest.NewTestClient(t, stalledServer(t))

	start := time.Now()
	_, err := resolveRepoDefaultBranch(context.Background(), client, "o", "repo")
	assertStalledFailure(t, "resolveRepoDefaultBranch", time.Since(start), err)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got: %v", err)
	}
}

func TestFetchRepoPath_FailsFastOnStall(t *testing.T) {
	setTimeout(t, &teacherFileTimeout, 50*time.Millisecond)
	client := githubtest.NewTestClient(t, stalledServer(t))

	start := time.Now()
	err := fetchRepoPath(context.Background(), client, t.TempDir(), "o", "repo", "main", ".github")
	assertStalledFailure(t, "fetchRepoPath", time.Since(start), err)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got: %v", err)
	}
}

// The blob fallback has its own deadline; a stalled blob read must still
// fail near that deadline rather than hang the submit.
func TestFetchBlob_FailsFastOnStall(t *testing.T) {
	setTimeout(t, &teacherFileTimeout, 50*time.Millisecond)
	client := githubtest.NewTestClient(t, stalledServer(t))

	start := time.Now()
	_, err := fetchBlob(context.Background(), client, "o", "repo", "big-sha", 0)
	assertStalledFailure(t, "fetchBlob", time.Since(start), err)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got: %v", err)
	}
}

func TestBlobReadTimeout(t *testing.T) {
	const mib = 1 << 20
	cases := []struct {
		name string
		size int64
		want time.Duration
	}{
		{"unknown size keeps the base deadline", 0, teacherFileTimeout},
		// 1.5 MiB decoded is 2 MiB on the wire; at 256 KiB/s that is 8 s.
		{"scales with the base64 payload", 3 * mib / 2, teacherFileTimeout + 8*time.Second},
		// 100 MiB (the blob API ceiling) is 9m8s at the floor rate, inside the
		// backstop; anything that would exceed it is clamped.
		{"blob ceiling fits under the backstop", 100 * mib, teacherFileTimeout + 533*time.Second},
		{"capped at the network ceiling", 200 * mib, gitNetworkTimeout},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := blobReadTimeout(tc.size); got != tc.want {
				t.Fatalf("blobReadTimeout(%d) = %v, want %v", tc.size, got, tc.want)
			}
		})
	}
	// The production client (ghauth.RequireClient) honors a request's own
	// deadline only up to ghauth.RequestCeiling; a cap above it would describe
	// a deadline that never runs.
	if gitNetworkTimeout > ghauth.RequestCeiling {
		t.Fatalf("gitNetworkTimeout %v exceeds ghauth.RequestCeiling %v, so blobReadTimeout's cap is unreachable", gitNetworkTimeout, ghauth.RequestCeiling)
	}
}

// On a dead HTTPS remote the stall detector, not the ceiling, should fire: git
// exits on its own and the error is git's, not a deadline.
func TestCommitWorkTreeOnRemoteBranch_StallDetectorAbortsClone(t *testing.T) {
	setTimeout(t, &gitexec.StallTimeout, time.Second) // git's minimum granularity
	setTimeout(t, &gitexec.WaitDelay, 50*time.Millisecond)

	start := time.Now()
	_, err := commitWorkTreeOnRemoteBranch(
		context.Background(), t.TempDir(), t.TempDir(), stalledRemoteURL(t),
		"main", "Submit test",
		identitypkg.GitIdentity{Name: "Test Student", Email: "test@example.com"},
		io.Discard, io.Discard,
	)
	assertStalledFailure(t, "commitWorkTreeOnRemoteBranch", time.Since(start), err)
	if errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "timed out") {
		t.Fatalf("stall detector should abort before the ceiling, got a deadline error: %v", err)
	}
}

// The ceiling is the SSH backstop, so it must end a stalled clone on its own
// and say what to do next.
func TestCommitWorkTreeOnRemoteBranch_CeilingAbortsClone(t *testing.T) {
	setTimeout(t, &gitNetworkTimeout, 200*time.Millisecond)
	setTimeout(t, &gitexec.WaitDelay, 50*time.Millisecond)

	start := time.Now()
	_, err := commitWorkTreeOnRemoteBranch(
		context.Background(), t.TempDir(), t.TempDir(), stalledRemoteURL(t),
		"main", "Submit test",
		identitypkg.GitIdentity{Name: "Test Student", Email: "test@example.com"},
		io.Discard, io.Discard,
	)
	assertStalledFailure(t, "commitWorkTreeOnRemoteBranch", time.Since(start), err)
	if !strings.Contains(err.Error(), "run `gh student submit` again") {
		t.Fatalf("deadline error must tell the student what to do next, got: %v", err)
	}
}

// Ctrl-C cancels the root context; that must not read as network advice.
func TestRunGit_CancelIsNotReportedAsStall(t *testing.T) {
	setTimeout(t, &gitexec.WaitDelay, 50*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := runGit(ctx, io.Discard, io.Discard, "clone", "--bare", stalledRemoteURL(t), t.TempDir())
	if err == nil {
		t.Fatal("expected an error from a canceled context")
	}
	if strings.Contains(err.Error(), "network") {
		t.Fatalf("a canceled context must not be reported as a network stall, got: %v", err)
	}
}

func TestPushSubmitTag_FailsFastOnStall(t *testing.T) {
	setTimeout(t, &submitTagTimeout, 200*time.Millisecond)
	setTimeout(t, &gitexec.WaitDelay, 50*time.Millisecond)

	local, _, sha := _tagTestRepos(t)
	if out, err := exec.Command("git", "--git-dir", local, "remote", "set-url", "origin", stalledRemoteURL(t)).CombinedOutput(); err != nil {
		t.Fatalf("remote set-url: %v\n%s", err, out)
	}

	start := time.Now()
	_, err := pushSubmitTag(context.Background(), local, sha)
	assertStalledFailure(t, "pushSubmitTag", time.Since(start), err)
}
