package gitexec

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"
)

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

// The stall detector makes git itself give up, so the error is git's and the
// context is untouched.
func TestCommand_StallDetectorAbortsClone(t *testing.T) {
	setTimeout(t, &StallTimeout, time.Second) // git's minimum granularity
	setTimeout(t, &WaitDelay, 50*time.Millisecond)
	ctx := context.Background()

	start := time.Now()
	err := Command(ctx, "git", "clone", "--bare", stalledRemoteURL(t), t.TempDir()).Run()
	if err == nil {
		t.Fatal("expected clone against a stalled remote to fail")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("clone took %v to fail; the stall detector should have ended it", elapsed)
	}
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stall detector should fire without a deadline, got: %v", err)
	}
}

// A ctx deadline kills git; WaitDelay keeps the orphaned transport helper
// from holding Wait() open afterwards.
func TestCommand_DeadlineEndsClone(t *testing.T) {
	setTimeout(t, &WaitDelay, 50*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := Command(ctx, "git", "clone", "--bare", stalledRemoteURL(t), t.TempDir()).Run()
	if err == nil {
		t.Fatal("expected clone against a stalled remote to fail")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("clone took %v to fail; the deadline should have ended it", elapsed)
	}
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("expected the deadline to have fired, ctx.Err() = %v", ctx.Err())
	}
}
