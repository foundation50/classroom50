package roster

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"strings"

	"github.com/foundation50/gh-teacher/internal/configrepo"
)

// addressEntry is one address parsed from a --file list: the normalized email
// and the file line it first appeared on, so a later skip/failure notice can
// name the line the teacher would edit.
type addressEntry struct {
	email string
	line  int
}

// parseInviteFile turns a plaintext address list into an ordered, deduped set of
// addresses to invite, reporting EVERY unusable line in one pass (never
// stopping at the first) so a teacher fixes the whole file once. A non-empty
// failure list means the caller must send nothing — the same fail-closed
// posture as `roster import`.
//
// One address per line. A blank line, or a line whose first non-space rune is
// `#`, is a comment and ignored, so a teacher can annotate the list. Surviving
// lines are validated with ValidateRosterEmail (bare local@domain, no display
// name), normalized (trim + lowercase), and deduped case-insensitively keeping
// the first occurrence — mirroring dedupePendingByEmail so one file can't queue
// two invites to the same address.
func parseInviteFile(data []byte) ([]addressEntry, []error) {
	var (
		entries  []addressEntry
		failures []error
		seen     = map[string]bool{}
	)
	scanner := bufio.NewScanner(bytes.NewReader(data))
	// A pathological single line could exceed bufio's default 64KiB token cap;
	// raise it so a long (if unusual) address file still parses rather than
	// silently truncating.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		raw := strings.TrimSpace(scanner.Text())
		if raw == "" || strings.HasPrefix(raw, "#") {
			continue
		}
		if err := configrepo.ValidateRosterEmail(raw); err != nil {
			failures = append(failures, fmt.Errorf("line %d (%s): %w", line, raw, err))
			continue
		}
		key := configrepo.NormalizeInviteEmail(raw)
		if seen[key] {
			continue
		}
		seen[key] = true
		entries = append(entries, addressEntry{email: key, line: line})
	}
	if err := scanner.Err(); err != nil {
		failures = append(failures, fmt.Errorf("reading address list: %w", err))
	}
	return entries, failures
}

// joinInviteFileFailures collapses the per-line failures into one fail-closed
// error whose message reports how many lines are unusable before listing them,
// matching planRosterImport's refusal shape.
func joinInviteFileFailures(failures []error) error {
	if len(failures) == 0 {
		return nil
	}
	return fmt.Errorf("%d line(s) can't be invited, so nothing was sent:\n%w", len(failures), errors.Join(failures...))
}
