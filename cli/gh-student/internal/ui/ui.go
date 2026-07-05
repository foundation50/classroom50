// Package ui renders gh-student's human-facing output (warnings, verbose
// detail, and the long-running spinner) to a single writer — always stderr, so
// stdout stays machine-stable for scripts and greps.
//
// Mirrors gh-teacher's internal/ui tone and shares the ghui spinner +
// color/TTY policy so the two CLIs present a consistent experience: the
// "Warning: " prefix is preserved in both color and plain modes, and color is
// TTY-gated (honoring NO_COLOR / CLASSROOM50_NO_COLOR).
package ui

import (
	"fmt"
	"io"

	"github.com/foundation50/classroom50-cli-shared/ghui"
)

const (
	ansiReset  = "\x1b[0m"
	ansiYellow = "\x1b[33m"
	ansiDim    = "\x1b[2m"
)

// UI renders gh-student's human channel.
type UI struct {
	w     io.Writer
	color bool
}

// New builds a UI writing to w, auto-detecting color via ghui.UseColor
// (stderr-TTY-gated, honoring NO_COLOR / CLASSROOM50_NO_COLOR) so the policy
// stays identical to the shared spinner and gh-teacher.
func New(w io.Writer) *UI {
	return &UI{w: w, color: ghui.UseColor(w)}
}

// NewForced builds a UI with an explicit color setting, for deterministic
// tests.
func NewForced(w io.Writer, color bool) *UI {
	return &UI{w: w, color: color}
}

func (u *UI) paint(code, s string) string {
	if !u.color {
		return s
	}
	return code + s + ansiReset
}

// Spinner returns a live single-line spinner for a long-running step, writing
// to the human channel. Animates on a TTY; degrades to plain lines otherwise.
// Backed by the shared ghui spinner so gh-student and gh-teacher animate
// identically.
func (u *UI) Spinner(message string) *ghui.Spinner {
	return ghui.NewSpinner(u.w, message)
}

// Warn prints a warning that ALWAYS contains the literal "Warning: " so
// downstream log scrapers and assertions keep working; on a color TTY it's
// additionally prefixed with a yellow ⚠.
func (u *UI) Warn(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	if u.color {
		_, _ = fmt.Fprintf(u.w, "%s %s%s\n", u.paint(ansiYellow, "\u26a0"), u.paint(ansiYellow, "Warning: "), msg)
		return
	}
	_, _ = fmt.Fprintf(u.w, "Warning: %s\n", msg)
}

// Detail prints a dimmed continuation line (dimmed on a color TTY, plain
// otherwise) for verbose per-step operational detail.
func (u *UI) Detail(format string, a ...any) {
	_, _ = fmt.Fprintf(u.w, "%s\n", u.paint(ansiDim, fmt.Sprintf(format, a...)))
}
