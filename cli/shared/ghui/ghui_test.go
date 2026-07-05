package ghui

import (
	"bytes"
	"strings"
	"testing"
)

// A spinner writing to a plain buffer (not os.Stderr) must take the non-TTY
// path: no ANSI escapes, no carriage returns, just stable lines.
func TestSpinner_NonTTY_PlainLines(t *testing.T) {
	var buf bytes.Buffer
	s := NewSpinner(&buf, "Waiting for repo")
	if s.Active() {
		t.Fatal("a buffer-backed spinner must not be active (non-TTY)")
	}
	s.Start()
	s.Update("Waiting for repo (attempt 2/20)") // no-op on non-TTY
	s.Stop("Repo ready")

	got := buf.String()
	if strings.Contains(got, "\r") || strings.Contains(got, "\x1b[") {
		t.Errorf("non-TTY output must not contain carriage returns or ANSI escapes:\n%q", got)
	}
	if !strings.Contains(got, "Waiting for repo...") {
		t.Errorf("non-TTY Start should print a plain start line:\n%q", got)
	}
	if !strings.Contains(got, "Repo ready done") {
		t.Errorf("non-TTY Stop should print a plain done line:\n%q", got)
	}
}

func TestSpinner_NonTTY_Fail(t *testing.T) {
	var buf bytes.Buffer
	s := NewSpinner(&buf, "Provisioning")
	s.Start()
	s.Fail("Provisioning")
	got := buf.String()
	if !strings.Contains(got, "Provisioning failed") {
		t.Errorf("non-TTY Fail should print a plain failed line:\n%q", got)
	}
	if strings.Contains(got, "\x1b[") {
		t.Errorf("non-TTY output must not contain ANSI escapes:\n%q", got)
	}
}

// Calling a finalizer twice must be a safe no-op (no double-close panic, no
// duplicate output).
func TestSpinner_DoubleStopIsSafe(t *testing.T) {
	var buf bytes.Buffer
	s := NewSpinner(&buf, "Step")
	s.Start()
	s.Stop("Step")
	s.Stop("Step") // second call: no-op
	s.Fail("Step") // also no-op after done
	out := buf.String()
	if n := strings.Count(out, "done"); n != 1 {
		t.Errorf("expected exactly one done line, got %d:\n%q", n, out)
	}
}

// Finalizing without Start must not panic or emit an outcome (nothing was ever
// started).
func TestSpinner_FinishWithoutStart(t *testing.T) {
	var buf bytes.Buffer
	s := NewSpinner(&buf, "Step")
	s.Stop("Step")
	if buf.Len() != 0 {
		t.Errorf("finishing an unstarted spinner should emit nothing:\n%q", buf.String())
	}
}

// render() is the TTY draw path. It can't be reached through Start on a buffer
// (non-TTY), so exercise it directly to lock the frame shape: carriage return +
// clear-to-EOL, the current frame glyph, and the message. Guards the in-place
// rewrite contract independently of whether a real terminal is attached.
func TestSpinner_RenderFrameShape(t *testing.T) {
	var buf bytes.Buffer
	s := NewSpinner(&buf, "Cloning hello")
	s.render()
	got := buf.String()
	if !strings.HasPrefix(got, "\r\x1b[K") {
		t.Errorf("render must start with carriage-return + clear-to-EOL:\n%q", got)
	}
	if !strings.Contains(got, spinnerFrames[0]) {
		t.Errorf("render should include the current frame glyph %q:\n%q", spinnerFrames[0], got)
	}
	if !strings.Contains(got, "Cloning hello") {
		t.Errorf("render should include the message:\n%q", got)
	}
}
