// Package ghui holds the terminal-feedback primitives shared by the gh-teacher
// and gh-student CLIs so both render long-running work the same way: a
// self-rewriting spinner line on an interactive terminal, stable one-shot lines
// everywhere else.
//
// Stdlib-only (plus the shared ghauth TTY guard) — no third-party spinner; the
// animation is a hand-rolled time.Ticker.
//
// Channel discipline (matching the rest of the CLIs): the spinner always writes
// to the human channel (stderr) and animates only when stderr is a TTY. On a
// non-TTY (pipe, redirect, CI) it falls back to plain "<message>..." /
// "<message> done"/"failed" lines, so no cursor escapes leak into captured
// output.
package ghui

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/foundation50/classroom50-cli-shared/ghauth"
)

// spinnerFrames is a Braille-dot cycle — one cell wide so the in-place rewrite
// never wraps.
var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// spinnerInterval is the frame cadence (~10fps).
const spinnerInterval = 100 * time.Millisecond

const (
	ansiReset = "\x1b[0m"
	ansiGreen = "\x1b[32m"
	ansiRed   = "\x1b[31m"
	ansiDim   = "\x1b[2m"
)

// Spinner renders a single live status line for a long-running step. Construct
// with NewSpinner, call Start once, optionally Update the message, then exactly
// one of Stop / Fail.
//
// The ticker goroutine and the caller race on the message and writer; a mutex
// guards the shared fields and finish() joins the goroutine before its final
// write.
type Spinner struct {
	w     io.Writer
	tty   bool
	color bool

	mu      sync.Mutex
	msg     string
	frame   int
	started bool
	done    bool

	stop chan struct{}
	wg   sync.WaitGroup
}

// NewSpinner builds a spinner writing to w. Animation + color are gated on w
// being os.Stderr AND a TTY (color additionally on NO_COLOR /
// CLASSROOM50_NO_COLOR being unset). Any other writer (captured buffer, pipe,
// redirect) gets the plain non-TTY fallback.
func NewSpinner(w io.Writer, message string) *Spinner {
	return &Spinner{
		w:     w,
		msg:   message,
		tty:   IsStderrTTY(w),
		color: UseColor(w),
		stop:  make(chan struct{}),
	}
}

// IsStderrTTY reports whether w is the real stderr and a TTY — the single
// source of the "interactive human channel?" check shared by ghui and both
// CLIs' ui packages. Only stderr is eligible, so a UI renderer can never write
// cursor escapes to a redirected stdout.
func IsStderrTTY(w io.Writer) bool {
	return w == io.Writer(os.Stderr) && ghauth.IsCharDevice(os.Stderr)
}

// UseColor reports whether to emit SGR color to w: TTY-gated (via IsStderrTTY),
// honoring NO_COLOR and CLASSROOM50_NO_COLOR. The single source both CLIs' ui
// packages delegate to.
func UseColor(w io.Writer) bool {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("CLASSROOM50_NO_COLOR") != "" {
		return false
	}
	return IsStderrTTY(w)
}

// Active reports whether the spinner animates (TTY). Callers use it to decide
// whether to suppress per-substep lines that would scroll the spinner away.
func (s *Spinner) Active() bool { return s.tty }

// Start begins the spinner. On a TTY it launches the ticker goroutine that
// rewrites the line in place; on a non-TTY it prints one plain "<message>..."
// line so a piped/CI run still shows the step beginning. A second Start is a
// no-op.
func (s *Spinner) Start() {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	msg := s.msg
	s.mu.Unlock()

	if !s.tty {
		// Non-TTY: one stable line; Stop/Fail prints the matching outcome.
		_, _ = fmt.Fprintf(s.w, "%s...\n", msg)
		return
	}

	s.wg.Add(1)
	go s.run()
}

// run is the ticker loop (TTY only), rewriting the line until stop closes.
func (s *Spinner) run() {
	defer s.wg.Done()
	ticker := time.NewTicker(spinnerInterval)
	defer ticker.Stop()
	s.render()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			s.mu.Lock()
			s.frame = (s.frame + 1) % len(spinnerFrames)
			s.mu.Unlock()
			s.render()
		}
	}
}

// render draws the current frame + message, rewriting the line via carriage
// return + clear-to-EOL so a shorter message leaves no trailing characters.
func (s *Spinner) render() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	glyph := spinnerFrames[s.frame]
	if s.color {
		glyph = ansiDim + glyph + ansiReset
	}
	_, _ = fmt.Fprintf(s.w, "\r\x1b[K%s %s", glyph, s.msg)
}

// Update changes the live message. A no-op on a non-TTY, so a polling loop
// doesn't spam a line per attempt into a log.
func (s *Spinner) Update(message string) {
	s.mu.Lock()
	s.msg = message
	s.mu.Unlock()
}

// Stop finalizes the spinner as success: on a TTY a green ✓ replaces the live
// line; on a non-TTY a plain "<message> done" line. Idempotent.
func (s *Spinner) Stop(message string) {
	s.finish(message, outcomeOK)
}

// Fail finalizes the spinner as failure: a red ✗ on a TTY, "<message> failed"
// plain. Use on the error path so a half-drawn spinner line isn't left dangling
// above an error message.
func (s *Spinner) Fail(message string) {
	s.finish(message, outcomeFail)
}

// outcome selects the line finish() writes when finalizing the spinner.
type outcome int

const (
	outcomeOK outcome = iota
	outcomeFail
)

func (s *Spinner) finish(message string, oc outcome) {
	s.mu.Lock()
	if !s.started || s.done {
		s.mu.Unlock()
		return
	}
	s.done = true
	tty := s.tty
	color := s.color
	if message != "" {
		s.msg = message
	}
	final := s.msg
	s.mu.Unlock()

	// Stop the ticker goroutine and wait for it to exit before the final write,
	// so the two don't race on s.w. No-op wait on a non-TTY.
	close(s.stop)
	s.wg.Wait()

	if !tty {
		switch oc {
		case outcomeOK:
			_, _ = fmt.Fprintf(s.w, "%s done\n", final)
		case outcomeFail:
			_, _ = fmt.Fprintf(s.w, "%s failed\n", final)
		}
		return
	}

	switch oc {
	case outcomeOK:
		_, _ = fmt.Fprintf(s.w, "\r\x1b[K%s %s\n", paint(color, ansiGreen, "✓"), final)
	case outcomeFail:
		_, _ = fmt.Fprintf(s.w, "\r\x1b[K%s %s\n", paint(color, ansiRed, "✗"), final)
	}
}

// paint wraps s in an SGR code when color is on, else returns s unchanged.
func paint(color bool, code, s string) string {
	if !color {
		return s
	}
	return code + s + ansiReset
}
