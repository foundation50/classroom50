package roster

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
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

// runRosterInviteFile sends an email invitation to every address in a plaintext
// list and retains the whole invited batch as pending rows in ONE commit.
//
// The lifecycle mirrors the web's bulkInviteByEmail: resolve the classroom team
// once (a missing team aborts the batch before anything is sent), send each
// address through the shared sendOneEmailInvite (so the load-bearing order and
// created-team teardown match the single invite), stop issuing NEW sends once a
// rate limit appears (hammering a throttled endpoint only extends the window),
// and append every successfully-invited address in one CommitTreeChange whose
// closure re-checks the roster under the rebase. A rate-limited or failed run is
// safe to re-run: an already-invited address 422-skips and an already-rowed one
// appends nothing.
func runRosterInviteFile(client githubapi.Client, out, errOut io.Writer, org, classroom string, data []byte) error {
	entries, failures := parseInviteFile(data)
	if err := joinInviteFileFailures(failures); err != nil {
		return err
	}
	if len(entries) == 0 {
		return fmt.Errorf("no email addresses to invite — the file has only blank or # comment lines")
	}

	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	// A team-less email invitation is broken, not degraded (see runRosterInvite):
	// refuse the whole batch before sending anything.
	classroomTeam, ok, err := configrepo.ResolveClassroomTeam(client, org, classroom, branch)
	if err != nil {
		return err
	}
	if !ok || classroomTeam.ID <= 0 {
		return fmt.Errorf("%s: classroom %s has no usable team recorded in classroom.json, so an invitation would enroll nobody — nothing was sent; run `gh teacher classroom add %s %s` to create the team, then retry",
			org, classroom, org, classroom)
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
		skipped        []string
		pendingBlocked []string
		deferredList   []string
		failedList     []string
		rateLimited    bool
	)
	for _, entry := range entries {
		if rateLimited {
			// Once throttled, every remaining address is deferred without a call.
			deferredList = append(deferredList, entry.email)
			continue
		}
		outcome, _, sendErr := sendOneEmailInvite(client, errOut, org, classroom, entry.email, classroomTeam, actor, rows)
		switch outcome {
		case outcomeInvited:
			invited = append(invited, entry.email)
		case outcomeSkippedAlready:
			skipped = append(skipped, entry.email)
		case outcomePendingBlocked:
			pendingBlocked = append(pendingBlocked, entry.email)
		case outcomeRateLimited:
			rateLimited = true
			deferredList = append(deferredList, entry.email)
		case outcomeFailed:
			failedList = append(failedList, fmt.Sprintf("%s (%v)", entry.email, sendErr))
		}
	}

	appended, commitErr := commitInvitedRows(client, org, classroom, branch, invited)

	// Report before deciding the exit status so a teacher sees the whole picture.
	_, _ = fmt.Fprintf(out, "%s/%s/%s: %d invited, %d appended as pending rows, %d already member/invited, %d already on the roster, %d failed, %d deferred (rate limit)\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom),
		len(invited), appended, len(skipped), len(pendingBlocked), len(failedList), len(deferredList))
	for _, addr := range pendingBlocked {
		_, _ = fmt.Fprintf(errOut, "Skipped %s: already a pending invitation on the roster — run `gh teacher roster sync %s %s` if they accepted.\n", addr, org, classroom)
	}
	for _, f := range failedList {
		_, _ = fmt.Fprintf(errOut, "Failed %s\n", f)
	}
	if len(deferredList) > 0 {
		_, _ = fmt.Fprintf(errOut, "Deferred (GitHub rate limit hit): %s\nRe-run the same command once the limit clears; already-invited addresses are skipped automatically.\n",
			strings.Join(deferredList, ", "))
	}
	if len(invited) > 0 {
		_, _ = fmt.Fprintf(errOut, "Advise the newly-invited students to accept the emailed invitation, then run `gh teacher roster sync %s %s` to record their username and github_id.\n", org, classroom)
	}

	if commitErr != nil {
		// Never a rollback: the invitations are the source of truth and each
		// metadata team retains its address, so `roster sync` heals the rows.
		_, _ = fmt.Fprintf(errOut, "Warning: %d invitation(s) were sent, but recording them in %s failed; run `gh teacher roster sync %s %s` to add the pending rows (the invitations are unaffected).\n",
			len(invited), configrepo.RosterFilePath(classroom), org, classroom)
		return fmt.Errorf("invitations sent, but the roster rows were not written: %w", commitErr)
	}
	if len(failedList) > 0 || len(deferredList) > 0 {
		return fmt.Errorf("%d address(es) were not invited (%d failed, %d deferred); see the report above",
			len(failedList)+len(deferredList), len(failedList), len(deferredList))
	}
	return nil
}

// commitInvitedRows appends the invited addresses as email-only pending rows in
// one Tree commit, dropping under the rebase any address a concurrent writer
// already put on a row (rosterHoldsEmail) — matching the web's single batched
// appendEmailInviteRows. Returns how many rows were actually appended. An empty
// invited set writes nothing.
func commitInvitedRows(client githubapi.Client, org, classroom, branch string, invited []string) (int, error) {
	if len(invited) == 0 {
		return 0, nil
	}
	var appended int
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		appended = 0
		current, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		for _, email := range invited {
			if rosterHoldsEmail(current, email) {
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
		return 0, err
	}
	return appended, nil
}
