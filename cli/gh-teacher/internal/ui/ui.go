// Package ui renders gh-teacher's human-facing output (progress headers,
// status lines, warnings, and end-of-run summaries) to a single writer —
// always stderr, so stdout stays machine-stable for --json and ad-hoc
// greps. It is the shared renderer for init, audit, and the init summary.
package ui

import (
	"fmt"
	"io"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/ghui"
)

// UI renders the human channel. Styling (ANSI color + box-drawing) is gated on
// color, which degrades to plain ASCII on non-TTYs and when NO_COLOR /
// CLASSROOM50_NO_COLOR is set. The "Warning: " prefix survives both modes
// because tests and downstream readers key on it.
type UI struct {
	w     io.Writer
	color bool
	tty   bool
}

// Minimal SGR codes. Hand-rolled rather than pulling in a color library — the
// renderer needs three colors and bold, nothing more.
const (
	ansiReset  = "\x1b[0m"
	ansiBold   = "\x1b[1m"
	ansiRed    = "\x1b[31m"
	ansiGreen  = "\x1b[32m"
	ansiYellow = "\x1b[33m"
	ansiDim    = "\x1b[2m"
)

// summaryWrapWidth is the soft-wrap width for long warning/summary bodies so a
// 600-char read-back warning doesn't render as one unreadable line.
const summaryWrapWidth = 76

// New builds a UI writing to w, auto-detecting color: w must be a TTY and
// neither NO_COLOR nor CLASSROOM50_NO_COLOR set. Non-stderr callers (tests,
// buffers) get color=false.
func New(w io.Writer) *UI {
	return &UI{w: w, color: detectColor(w), tty: detectTTY(w)}
}

// NewForced builds a UI with an explicit color setting for deterministic tests.
// tty follows color.
func NewForced(w io.Writer, color bool) *UI {
	return &UI{w: w, color: color, tty: color}
}

// detectTTY reports whether w is an interactive terminal. Kept separate from
// color so NO_COLOR still allows in-place progress on a real terminal.
func detectTTY(w io.Writer) bool {
	return ghui.IsStderrTTY(w)
}

// detectColor reports whether to emit color, via shared ghui.UseColor.
func detectColor(w io.Writer) bool {
	return ghui.UseColor(w)
}

// paint wraps s in an SGR code when color is on; else returns s unchanged.
func (u *UI) paint(code, s string) string {
	if !u.color {
		return s
	}
	return code + s + ansiReset
}

// Step prints a `[n/total] label` phase header (dimmed counter, bold label).
func (u *UI) Step(n, total int, label string) {
	counter := fmt.Sprintf("[%d/%d]", n, total)
	_, _ = fmt.Fprintf(u.w, "%s %s\n", u.paint(ansiDim, counter), u.paint(ansiBold, label))
}

// Section prints an un-numbered phase header, bold on a color TTY.
func (u *UI) Section(label string) {
	_, _ = fmt.Fprintf(u.w, "%s\n", u.paint(ansiBold, label))
}

// Progress renders a single self-rewriting status line on a TTY (Update per
// step, then Done). No-op on a non-TTY, so the machine-stable channel never
// sees cursor-control escapes.
type Progress struct {
	u     *UI
	total int
	shown bool
}

func (u *UI) NewProgress(total int) *Progress {
	return &Progress{u: u, total: total}
}

// Spinner returns a live single-line spinner backed by the shared ghui spinner.
func (u *UI) Spinner(message string) *ghui.Spinner {
	return ghui.NewSpinner(u.w, message)
}

// Active reports whether the progress line actually renders (TTY only). Callers
// use it to suppress verbose per-step output that would scroll it away.
func (p *Progress) Active() bool { return p.u.tty }

// Update rewrites the in-place line to "[n/total] label". \r + \x1b[K clear to
// end of line so a shorter label leaves no trailing chars.
func (p *Progress) Update(n int, label string) {
	if !p.u.tty {
		return
	}
	p.shown = true
	counter := fmt.Sprintf("[%d/%d]", n, p.total)
	_, _ = fmt.Fprintf(p.u.w, "\r\x1b[K%s %s", p.u.paint(ansiDim, counter), label)
}

// Done finalizes the progress line as "[total/total] Done" and moves to the
// next line so subsequent output starts cleanly.
func (p *Progress) Done() {
	if !p.u.tty || !p.shown {
		return
	}
	counter := fmt.Sprintf("[%d/%d]", p.total, p.total)
	_, _ = fmt.Fprintf(p.u.w, "\r\x1b[K%s %s\n", p.u.paint(ansiDim, counter), p.u.paint(ansiGreen, "Done"))
}

// Abort clears the in-place line without the "Done" marker, so a failure
// message isn't appended to a half-written progress line.
func (p *Progress) Abort() {
	if !p.u.tty || !p.shown {
		return
	}
	_, _ = fmt.Fprint(p.u.w, "\r\x1b[K")
}

// Ok prints a success line: "✓ <msg>" on a color TTY, "[ok] <msg>" plain.
func (u *UI) Ok(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	if u.color {
		_, _ = fmt.Fprintf(u.w, "%s %s\n", u.paint(ansiGreen, "\u2713"), msg)
		return
	}
	_, _ = fmt.Fprintf(u.w, "[ok] %s\n", msg)
}

// Warn prints a warning. It ALWAYS contains the literal "Warning: " so
// substring assertions and log scrapers keep working; on a color TTY it adds a
// yellow ⚠ and yellows the leading "Warning:". Long bodies are soft-wrapped.
func (u *UI) Warn(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	body := "Warning: " + msg
	wrapped := softWrap(body, summaryWrapWidth, "  ")
	if u.color {
		// Color only the first line's "Warning:" so multi-line bodies don't
		// smear escape codes.
		wrapped = strings.Replace(wrapped, "Warning:", u.paint(ansiYellow, "Warning:"), 1)
		_, _ = fmt.Fprintf(u.w, "%s %s\n", u.paint(ansiYellow, "\u26a0"), wrapped)
		return
	}
	_, _ = fmt.Fprintf(u.w, "%s\n", wrapped)
}

// Heading prints a section heading (bold on a color TTY), preceded by a blank
// line for separation.
func (u *UI) Heading(label string) {
	if u.color {
		_, _ = fmt.Fprintf(u.w, "\n%s\n", u.paint(ansiBold, label))
		return
	}
	_, _ = fmt.Fprintf(u.w, "\n%s\n", label)
}

// Result prints the one-line outcome banner opening the final report: a ✓/⚠/✗
// glyph (or ASCII tag plain) plus the message.
func (u *UI) Result(status Status, format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	if !u.color {
		tag := map[Status]string{StatusOK: "[ok]", StatusWarn: "[!]", StatusFail: "[x]"}[status]
		_, _ = fmt.Fprintf(u.w, "%s %s\n", tag, msg)
		return
	}
	glyph := map[Status]string{
		StatusOK:   u.paint(ansiGreen, "\u2713"),
		StatusWarn: u.paint(ansiYellow, "\u26a0"),
		StatusFail: u.paint(ansiRed, "\u2717"),
	}[status]
	_, _ = fmt.Fprintf(u.w, "%s %s\n", glyph, u.paint(ansiBold, msg))
}

// Numbered prints an ordinal list item ("  1. <msg>") with a hanging wrap. Used
// for manual steps that are NOT checkboxes (e.g. API-less settings to eyeball,
// not state the CLI tracks).
func (u *UI) Numbered(n int, format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	prefix := fmt.Sprintf("%d. ", n)
	// Indent continuation lines past the "  N. " prefix so wrapped text lines
	// up under the body.
	hang := strings.Repeat(" ", 2+len(prefix))
	_, _ = fmt.Fprintf(u.w, "  %s%s\n", prefix, softWrap(msg, summaryWrapWidth, hang))
}

// OkItem prints a checked-off list item: "  ✓ <msg>" / "  [x] <msg>". Indent
// and hanging wrap match Checkbox() so mixed done/to-do lists line up.
func (u *UI) OkItem(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	if u.color {
		_, _ = fmt.Fprintf(u.w, "  %s %s\n", u.paint(ansiGreen, "\u2713"), softWrap(msg, summaryWrapWidth, "      "))
		return
	}
	_, _ = fmt.Fprintf(u.w, "  [x] %s\n", softWrap(msg, summaryWrapWidth, "      "))
}

// Checkbox prints an actionable to-do item as an unchecked box, soft-wrapped
// with a hanging indent so a long instruction lines up under the text.
func (u *UI) Checkbox(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	_, _ = fmt.Fprintf(u.w, "  [ ] %s\n", softWrap(msg, summaryWrapWidth, "      "))
}

// Detail prints an indented, dimmed continuation line (e.g. a URL under a
// checklist).
func (u *UI) Detail(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	_, _ = fmt.Fprintf(u.w, "  %s\n", u.paint(ansiDim, msg))
}

// Item prints a plain status line in the report's summary section,
// two-space indented.
func (u *UI) Item(format string, a ...any) {
	_, _ = fmt.Fprintf(u.w, "  %s\n", fmt.Sprintf(format, a...))
}

// Next prints the prominent next-command call to action.
func (u *UI) Next(command string) {
	if u.color {
		_, _ = fmt.Fprintf(u.w, "\n%s %s\n", u.paint(ansiBold, "Next:"), u.paint(ansiGreen, command))
		return
	}
	_, _ = fmt.Fprintf(u.w, "\nNext: %s\n", command)
}

// Blank prints a single empty line for visual separation.
func (u *UI) Blank() {
	_, _ = fmt.Fprintln(u.w)
}

// softWrap wraps s to width columns on spaces, indenting continuation lines.
// Words longer than width are left intact (URLs).
func softWrap(s string, width int, indent string) string {
	words := strings.Fields(s)
	if len(words) == 0 {
		return s
	}
	var b strings.Builder
	lineLen := 0
	for i, word := range words {
		switch {
		case i == 0:
			b.WriteString(word)
			lineLen = displayLen(word)
		case lineLen+1+displayLen(word) > width:
			b.WriteString("\n")
			b.WriteString(indent)
			b.WriteString(word)
			lineLen = displayLen(indent) + displayLen(word)
		default:
			b.WriteString(" ")
			b.WriteString(word)
			lineLen += 1 + displayLen(word)
		}
	}
	return b.String()
}

// displayLen approximates the printed width of s as its rune count, ignoring
// ANSI escapes.
func displayLen(s string) int {
	n := 0
	inEscape := false
	for _, r := range s {
		switch {
		case inEscape:
			if r == 'm' {
				inEscape = false
			}
		case r == '\x1b':
			inEscape = true
		default:
			n++
		}
	}
	return n
}
