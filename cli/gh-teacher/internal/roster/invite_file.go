package roster

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
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
		// The CANONICAL address is what gets invited: an address that merely
		// validates (`<ada@uni.edu>` unwraps) must be sent in its parsed form, or
		// GitHub 422s it and the report misreads that as already-invited.
		email, err := configrepo.CanonicalRosterEmail(raw)
		if err != nil {
			failures = append(failures, inviteLineError(line, raw, err))
			continue
		}
		if seen[email] {
			continue
		}
		seen[email] = true
		entries = append(entries, addressEntry{email: email, line: line})
	}
	if err := scanner.Err(); err != nil {
		failures = append(failures, fmt.Errorf("reading address list: %w", err))
	}
	return entries, failures
}

// maxReportedLineBytes caps how much of an unusable line the report echoes. The
// line number is what a teacher needs to find it; echoing an entire line of a
// file pointed at --file by mistake would spill its contents.
const maxReportedLineBytes = 120

// inviteLineError reports an unusable line without echoing more of it than the
// teacher needs to locate it. An over-long line drops the underlying validator
// message too, since mail.ParseAddress embeds the whole input in its own error.
func inviteLineError(line int, raw string, err error) error {
	if len(raw) <= maxReportedLineBytes {
		return fmt.Errorf("line %d (%s): %w", line, raw, err)
	}
	return fmt.Errorf("line %d (%s... truncated, %d bytes): not a valid email address",
		line, raw[:maxReportedLineBytes], len(raw))
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

// inviteFileSleep is the throttle wait, indirected so tests don't actually sleep
// through a mock's Retry-After.
var inviteFileSleep = time.Sleep

// runRosterInviteFile sends an email invitation to every address in a plaintext
// list and retains the whole invited batch as pending rows in ONE commit.
//
// The lifecycle mirrors the web's bulkInviteByEmail: resolve the classroom team
// once (a missing team aborts the batch before anything is sent), send each
// address through the shared sendOneEmailInvite, stop issuing NEW sends once a
// rate limit appears (hammering a throttled endpoint only extends the window),
// and append every successfully-invited address in one CommitTreeChange whose
// closure re-checks the roster under the rebase. A rate-limited or failed run is
// safe to re-run: an already-invited address 422-skips and an already-rowed one
// appends nothing.
//
// Exit codes follow `roster sync`'s convention so a script can tell a retryable
// partial run from a broken one: 0 all done, 2 nothing failed but addresses
// remain (deferred), 1 something actually failed.
func runRosterInviteFile(client githubapi.Client, out, errOut io.Writer, org, classroom string, data []byte) error {
	entries, failures := parseInviteFile(data)
	if err := joinInviteFileFailures(failures); err != nil {
		return err
	}
	if len(entries) == 0 {
		return errors.New("no email addresses to invite — the file has only blank or # comment lines")
	}

	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	classroomTeam, ok, err := configrepo.ResolveClassroomTeam(client, org, classroom, branch)
	if err != nil {
		return err
	}
	if !ok || classroomTeam.ID <= 0 {
		return errClassroomTeamUnusable(org, classroom)
	}

	rows, err := configrepo.LoadRosterLenient(client, org, classroom, branch)
	if err != nil {
		return err
	}

	actor, _, err := githubapi.CurrentUser(client)
	if err != nil {
		return fmt.Errorf("resolving your GitHub login (needed to keep the invite team free of teachers): %w", err)
	}

	var (
		invited        []string
		skipped        []addressEntry
		pendingBlocked []addressEntry
		deferredList   []addressEntry
		failedList     []addressEntry
		failedErrs     []error
		rateLimitErr   error
	)
	for _, entry := range entries {
		if rateLimitErr != nil {
			// Once throttled, every remaining address is deferred without a call.
			deferredList = append(deferredList, entry)
			continue
		}
		outcome, _, sendErr := sendOneEmailInvite(client, errOut, org, classroom, entry.email, classroomTeam, actor, rows)
		// Report each address as it resolves: a few hundred addresses take
		// minutes, and a silent run is indistinguishable from a hang.
		switch outcome {
		case outcomeInvited:
			invited = append(invited, entry.email)
			_, _ = fmt.Fprintf(out, "  invited %s (line %d)\n", entry.email, entry.line)
		case outcomeSkippedAlready:
			skipped = append(skipped, entry)
			_, _ = fmt.Fprintf(out, "  skipped %s (line %d) — already a member of the org or already invited\n", entry.email, entry.line)
		case outcomePendingBlocked:
			pendingBlocked = append(pendingBlocked, entry)
			_, _ = fmt.Fprintf(out, "  skipped %s (line %d) — already a pending invitation on this roster\n", entry.email, entry.line)
		case outcomeRateLimited:
			rateLimitErr = sendErr
			deferredList = append(deferredList, entry)
			_, _ = fmt.Fprintf(out, "  deferred %s (line %d) — GitHub rate limit reached\n", entry.email, entry.line)
		default:
			// outcomeFailed, plus any outcome a future change forgets to handle:
			// both mean "not invited", which must never read as success.
			failedList = append(failedList, entry)
			failedErrs = append(failedErrs, fmt.Errorf("line %d (%s): %w", entry.line, entry.email, sendErr))
			_, _ = fmt.Fprintf(out, "  failed %s (line %d)\n", entry.email, entry.line)
		}
	}

	// Wait out the throttle before the batch commit: the roster write is several
	// more requests, and firing them inside the same window turns a partial
	// success into "sent but unrecorded", the one state that needs a repair.
	if rateLimitErr != nil && len(invited) > 0 {
		if wait := cliutil.RetryAfter(rateLimitErr); wait > 0 {
			_, _ = fmt.Fprintf(errOut, "Waiting %s for GitHub's rate limit to clear before recording the %d invitation(s) already sent.\n",
				wait, len(invited))
			inviteFileSleep(wait)
		}
	}

	appended, alreadyHeld, commitErr := commitInvitedRows(client, org, classroom, branch, invited)

	_, _ = fmt.Fprintf(out, "%s/%s/%s: %d invited, %d appended as pending rows, %d already member/invited, %d already on the roster, %d failed, %d deferred (rate limit)\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom),
		len(invited), appended, len(skipped), len(pendingBlocked), len(failedList), len(deferredList))

	for _, entry := range skipped {
		_, _ = fmt.Fprintf(errOut, "Skipped %s (line %d): already a member of the org or already invited — run `gh teacher roster sync %s %s` if they accepted an earlier invitation.\n",
			entry.email, entry.line, org, classroom)
	}
	for _, entry := range pendingBlocked {
		_, _ = fmt.Fprintf(errOut, "Skipped %s (line %d): already a pending invitation on the roster — run `gh teacher roster sync %s %s` if they accepted.\n",
			entry.email, entry.line, org, classroom)
	}
	for _, addr := range alreadyHeld {
		_, _ = fmt.Fprintf(errOut, "Invited %s, but a roster row already carries that address, so no second pending row was written.\n", addr)
	}
	for _, err := range failedErrs {
		_, _ = fmt.Fprintf(errOut, "Failed %v\n", err)
	}
	if len(deferredList) > 0 {
		_, _ = fmt.Fprintf(errOut, "Deferred (GitHub rate limit: %v): %s\nRe-run the same command once the limit clears; already-invited addresses are skipped automatically.\n",
			rateLimitErr, joinEntryEmails(deferredList))
	}
	if len(invited) > 0 {
		_, _ = fmt.Fprintf(errOut, "Advise the newly-invited students to accept the emailed invitation, then run `gh teacher roster sync %s %s` to record their username and github_id.\n", org, classroom)
	}

	if commitErr != nil {
		// Never a rollback: the invitations are the source of truth and each
		// metadata team retains its address, so a sync heals the rows once the
		// students accept.
		_, _ = fmt.Fprintf(errOut, "Warning: %d invitation(s) were sent, but recording them in %s failed; the invitations are unaffected — re-run this command to record them, or `gh teacher roster sync %s %s` once the students accept.\n",
			len(invited), configrepo.RosterFilePath(classroom), org, classroom)
		return fmt.Errorf("invitations sent, but the roster rows were not written: %w", commitErr)
	}
	if len(failedList) > 0 {
		return fmt.Errorf("%d address(es) could not be invited; see the report above", len(failedList))
	}
	if len(deferredList) > 0 {
		// Nothing is broken — GitHub is throttling — so this is the "changes
		// remain" code, not a failure.
		return &cliutil.ExitCodeError{Code: 2, Err: fmt.Errorf("%d address(es) not yet invited (GitHub rate limit); re-run to continue", len(deferredList))}
	}
	return nil
}

func joinEntryEmails(entries []addressEntry) string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.email)
	}
	return strings.Join(out, ", ")
}

// commitInvitedRows appends the invited addresses as email-only pending rows in
// one Tree commit, dropping under the rebase any address a concurrent writer
// already put on a row (rosterHoldsEmail) — matching the web's single batched
// appendEmailInviteRows. Returns how many rows were appended and which addresses
// were dropped, so the report can name them rather than only counting.
func commitInvitedRows(client githubapi.Client, org, classroom, branch string, invited []string) (int, []string, error) {
	if len(invited) == 0 {
		return 0, nil, nil
	}
	var (
		appended    int
		alreadyHeld []string
	)
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		appended, alreadyHeld = 0, nil
		current, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		for _, email := range invited {
			if rosterHoldsEmail(current, email) {
				alreadyHeld = append(alreadyHeld, email)
				continue
			}
			current = append(current, configrepo.RosterRow{Email: email, Role: rosterRoleStudent})
			appended++
		}
		if appended == 0 {
			return configwrite.CommitChange{}, nil // every address already held → nothing to write
		}
		return configrepo.RosterWriteChange(classroom, current)
	}
	message := contract.PrefixCommit(fmt.Sprintf("roster: add %d invited email(s) to %s (gh teacher roster invite --file)", len(invited), classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return 0, nil, err
	}
	return appended, alreadyHeld, nil
}
