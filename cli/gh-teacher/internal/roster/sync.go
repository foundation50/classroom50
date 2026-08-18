package roster

import (
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// Exit codes, following `terraform plan -detailed-exitcode` so a script can
// branch on state without parsing output: 0 nothing to do (including a --write
// run that applied everything), 1 error or degraded read (nothing destructive
// happened), 2 a dry run found pending changes.
const (
	syncExitChangesPending = 2
	syncExitDegraded       = 1
)

// inviteRecovery is one accepted invite whose email→account mapping was
// recovered from its metadata team. The team at Slug is deleted only AFTER the
// roster commit folding it lands (push-before-delete).
type inviteRecovery struct {
	Email string
	Login string
	ID    int64
	Slug  string
}

// inviteScan is the read-only classification of this classroom's invite teams —
// the CLI's collectInviteRecoveries.
type inviteScan struct {
	recovered []inviteRecovery
	// liveEmails are normalized addresses whose invite team is still live (the
	// invitation is pending, or the team is an anomaly we refuse to touch). A
	// pending roster row backed by one of these must be kept.
	liveEmails map[string]bool
	// staleSlugs are teams to delete outright: a member-less team past the GC
	// age with no pending invitation, or a sole member no longer on any
	// classroom team (whose mapping must not resurrect a removed student).
	staleSlugs []string
	// anomalies are the teams this pass deliberately left alone, reported so a
	// teacher can act (tampered record, more than one member).
	anomalies []string
	// trusted is false after ANY degraded read. Nothing is reaped and no stale
	// team is deleted while it is false — an unreadable team can't prove its row
	// is dead.
	trusted bool
	// pendingEmails is the invitation-derived liveness signal, nil when the
	// invitation read failed (which also clears trusted).
	pendingEmails map[string]bool
}

func rosterSyncCmd() *cobra.Command {
	var write bool

	cmd := &cobra.Command{
		Use:   "sync <org> <classroom>",
		Short: "Reconcile roster.csv with the classroom's GitHub state",
		Long: "Reconcile <org>/classroom50/<classroom>/roster.csv against GitHub:\n" +
			"record the students who accepted an email invitation, drop the\n" +
			"pending rows whose invitation is gone, and fill in any missing\n" +
			"github_id. The same reconciliation the web app runs when a teacher\n" +
			"opens the roster — here it is explicit and script-callable.\n\n" +
			"Reports by default and changes nothing: a dry run issues no write\n" +
			"request at all. Pass --write to apply what it found.\n\n" +
			"An accepted email invitation is the case that needs this: GitHub\n" +
			"stops reporting the invited address once it's accepted, so the\n" +
			"per-invite `secret` metadata team holds the only record of which\n" +
			"address the new account came from. This folds that mapping onto the\n" +
			"pending row and then retires the team — in that order, so a failed\n" +
			"cleanup never loses the address.\n\n" +
			"Conservative by construction. Any degraded read (the invitation\n" +
			"list, a team) makes the whole pass read-mostly: nothing is removed\n" +
			"and no metadata team is deleted, because an unreadable team can't\n" +
			"prove its row is dead. A team whose stored address no longer hashes\n" +
			"to its name (the invitee can edit it after accepting) or that has\n" +
			"more than one member is reported and left standing, never guessed at.\n\n" +
			"Exit codes, following `terraform plan -detailed-exitcode`:\n" +
			"  0  nothing to do (or --write applied everything)\n" +
			"  1  error, or a degraded read left the pass incomplete\n" +
			"  2  a dry run found changes pending",
		Example: "  gh teacher roster sync cs50-fall-2026 cs-principles\n" +
			"  gh teacher roster sync cs50-fall-2026 cs-principles --write",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			if org == "" || classroom == "" {
				return errors.New("org and classroom must both be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runRosterSync(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, write)
		},
	}
	cmd.Flags().BoolVar(&write, "write", false, "Apply the reconciliation (default: report only, making no write request)")
	return cmd
}

// classroomIndex is the classroom's own membership: the enrollment set a
// recovery is checked against, and the login→id map an unresolved github_id is
// backfilled from. Built ONLY from this classroom's teams — a global
// `GET /users/{login}` would bind whoever now owns a recycled login.
type classroomIndex struct {
	enrolled map[int64]bool
	// idByLogin omits any login held by more than one member: two accounts
	// answering to one login is not something to guess at.
	idByLogin map[string]int64
	// ok is false when any team read was degraded, which forces the whole pass
	// conservative (an absent member can't be told from an unread one).
	ok bool
}

// loadClassroomIndex reads the classroom's student team plus any recorded staff
// team, mirroring the web's resolveClassroomTeamSlugs: a staffer who accepted an
// email invitation is enrolled too, and deriving the student slug alone would
// read them as unenrolled.
func loadClassroomIndex(client githubapi.Client, org, classroom, branch string) (classroomIndex, error) {
	idx := classroomIndex{enrolled: map[int64]bool{}, idByLogin: map[string]int64{}, ok: true}

	slug, err := configrepo.ResolveClassroomTeamSlug(client, org, classroom, branch)
	if err != nil {
		return idx, err
	}
	slugs := []string{slug}
	if c, ok, err := configrepo.LoadClassroom(client, org, classroom, branch); err == nil && ok {
		for _, role := range configrepo.StaffRoles {
			if ref := c.Teams.RefForRole(role); ref != nil && ref.Slug != "" {
				slugs = append(slugs, ref.Slug)
			}
		}
	} else if err != nil {
		return idx, err
	}

	counts := map[string]int{}
	for _, s := range slugs {
		members, err := configrepo.ListTeamMembersWithIDs(client, org, s)
		if err != nil {
			idx.ok = false
			return idx, err
		}
		for _, m := range members {
			if m.ID <= 0 || idx.enrolled[m.ID] {
				continue
			}
			idx.enrolled[m.ID] = true
			key := loginKey(m.Login)
			counts[key]++
			idx.idByLogin[key] = m.ID
		}
	}
	for login, n := range counts {
		if n > 1 {
			delete(idx.idByLogin, login)
		}
	}
	return idx, nil
}

// scanInviteTeams classifies every invite team belonging to this classroom
// WITHOUT writing anything — the CLI's collectInviteRecoveries. Never fails: a
// degraded read clears `trusted`, which switches every removal off for the pass.
func scanInviteTeams(client githubapi.Client, errOut io.Writer, org, classroom string, idx classroomIndex) inviteScan {
	scan := inviteScan{liveEmails: map[string]bool{}, trusted: idx.ok}

	// Read the invitation list once, up front: it is both the GC guard's
	// liveness signal and the confirmation the row reaper needs. A failure is
	// the degraded case the whole contract turns on.
	if pending, err := pendingEmailInvitations(client, org); err != nil {
		scan.trusted = false
		_, _ = fmt.Fprintf(errOut, "Warning: %s: reading the pending invitations failed (%v); nothing will be removed this pass — a pending row can't be proven dead without them.\n", org, err)
	} else {
		scan.pendingEmails = pending
	}

	teams, err := configrepo.ListInviteTeams(client, org)
	if err != nil {
		scan.trusted = false
		_, _ = fmt.Fprintf(errOut, "Warning: %s: listing the invite metadata teams failed (%v); this pass can only report what it could read.\n", org, err)
		return scan
	}

	for _, team := range teams {
		state, ok, err := configrepo.ReadInviteTeam(client, org, team.Slug)
		if err != nil {
			// An unreadable team can't prove its row is dead.
			scan.trusted = false
			if cliutil.IsRateLimited(err) {
				_, _ = fmt.Fprintf(errOut, "Warning: %s: rate-limited while reading %s; stopping the invite pass early — re-run later.\n", org, team.Slug)
				break
			}
			_, _ = fmt.Fprintf(errOut, "Warning: %s: reading invite team %s failed (%v); leaving it alone.\n", org, team.Slug, err)
			continue
		}
		if !ok {
			continue // already deleted
		}
		// Not a v1 record, or another classroom's invite: leave it for that
		// classroom's own reconcile.
		if state.Record == nil || state.Record.Classroom != classroom {
			continue
		}
		email := configrepo.NormalizeInviteEmail(state.Record.Email)

		// Trust boundary: the invitee can edit their own team's description
		// after accepting, so only a record whose address still hashes back to
		// this team's name may bind a roster row.
		if configrepo.InviteTeamName(classroom, email) != team.Slug {
			scan.anomalies = append(scan.anomalies, fmt.Sprintf("%s: stored address does not match the team name hash — left alone; delete it by hand once you've checked it", team.Slug))
			scan.liveEmails[email] = true
			continue
		}

		members, err := configrepo.ListTeamMembersWithIDs(client, org, team.Slug)
		if err != nil {
			scan.trusted = false
			_, _ = fmt.Fprintf(errOut, "Warning: %s: reading the members of %s failed (%v); leaving it alone.\n", org, team.Slug, err)
			continue
		}

		switch {
		case len(members) == 0:
			// Pending — or abandoned. Reap only when a mid-creation race is
			// impossible AND no pending invitation still maps to the slug. The
			// hash-back gate above proved this team's slug is this email's, so
			// the address IS the slug's liveness signal.
			if scan.pendingEmails != nil && !scan.pendingEmails[email] && pastGCAge(state.CreatedAt) {
				scan.staleSlugs = append(scan.staleSlugs, team.Slug)
				continue
			}
			scan.liveEmails[email] = true
		case len(members) > 1:
			scan.anomalies = append(scan.anomalies, fmt.Sprintf("%s: %d members, so no single invitee can be identified — left alone", team.Slug, len(members)))
			scan.liveEmails[email] = true
		default:
			invitee := members[0]
			if !idx.ok || len(idx.enrolled) == 0 {
				// This member accepted an invitation carrying the classroom
				// team, so an empty enrollment set means the read was degraded,
				// not that they were removed. Prove neither: keep the team.
				scan.trusted = false
				_, _ = fmt.Fprintf(errOut, "Warning: %s: no classroom members are visible, so %s can't be reconciled; leaving it alone.\n", org, team.Slug)
				continue
			}
			if !idx.enrolled[invitee.ID] {
				// Accepted, then removed from the classroom: the lifecycle is
				// over, and the record must not resurrect the row later.
				scan.staleSlugs = append(scan.staleSlugs, team.Slug)
				continue
			}
			scan.recovered = append(scan.recovered, inviteRecovery{
				Email: email, Login: invitee.Login, ID: invitee.ID, Slug: team.Slug,
			})
		}
	}
	return scan
}

// pastGCAge reports whether a team is older than the shared GC guard. A missing
// or unparseable created_at reads as "too young" — never reap on uncertainty.
func pastGCAge(createdAt time.Time) bool {
	if createdAt.IsZero() {
		return false
	}
	return time.Since(createdAt) > contract.InviteTeamGCMinAge
}

// rosterPlan is the roster-side work phase 2 derives from the scan and the
// current file — what a dry run prints and what the commit closure applies.
type rosterPlan struct {
	// folds are recoveries with a pending row to claim.
	folds []inviteRecovery
	// reapEmails are pending rows no live invite team or invitation backs.
	reapEmails []string
	// backfills are usernames whose github_id can be filled from the classroom
	// team's membership.
	backfills []string
	// appends are recoveries no row claims at all — the invite-time row was
	// deleted (or never written, e.g. `roster invite`'s commit failed). Without
	// this the address would be lost when the team is retired below.
	appends []inviteRecovery
}

func (p rosterPlan) empty() bool {
	return len(p.folds) == 0 && len(p.reapEmails) == 0 && len(p.backfills) == 0 && len(p.appends) == 0
}

// planRosterSync is phase 2: match the scan against the roster rows. Read-only,
// so a dry run and the commit closure share one classifier.
func planRosterSync(rows []configrepo.RosterRow, scan inviteScan, idx classroomIndex) rosterPlan {
	var plan rosterPlan
	recoveredByEmail := make(map[string]inviteRecovery, len(scan.recovered))
	for _, r := range scan.recovered {
		recoveredByEmail[r.Email] = r
	}

	// The id/login/email sets every row already identifies — the same join the
	// roster view uses, so a fold and an append can't both fire for one
	// recovery. Mirrors the web's recById/recByLogin/recByEmail match.
	var (
		rowIDs    = map[int64]bool{}
		rowLogins = map[string]bool{}
		rowEmails = map[string]bool{}
	)
	claimed := map[string]bool{}
	for _, row := range rows {
		if row.GitHubID != 0 {
			rowIDs[row.GitHubID] = true
		}
		if key := loginKey(row.Username); key != "" {
			rowLogins[key] = true
		}
		email := configrepo.NormalizeInviteEmail(row.Email)
		if email != "" {
			rowEmails[email] = true
		}
		if isPendingRosterRow(row) && email != "" {
			if rec, ok := recoveredByEmail[email]; ok && !claimed[email] {
				claimed[email] = true
				plan.folds = append(plan.folds, rec)
				continue
			}
			// A pending row lives only while something backs it. Three gates keep
			// that from eating a legitimate row: the pass must be trusted, no
			// live team may hold the address, and it must be absent from
			// GitHub's CURRENT pending invitations (re-read inside the commit
			// closure, since an invite sent after the team snapshot has a row but
			// no team entry). A recovered address is never a candidate — a
			// duplicate row for it is the fold's business, not the reaper's.
			if scan.trusted && !scan.liveEmails[email] &&
				scan.pendingEmails != nil && !scan.pendingEmails[email] {
				if _, recovered := recoveredByEmail[email]; !recovered {
					plan.reapEmails = append(plan.reapEmails, email)
				}
			}
			continue
		}
		// A row carrying a username but no usable id: fill it from the
		// classroom's own team membership. A login on no classroom team is left
		// alone rather than resolved globally.
		if row.Username != "" && row.GitHubID == 0 {
			if _, ok := idx.idByLogin[loginKey(row.Username)]; ok {
				plan.backfills = append(plan.backfills, row.Username)
			}
		}
	}

	// A recovery no row claims — by address, by id, or by login — needs one, or
	// retiring its team would lose the only record of the invited address.
	for _, rec := range scan.recovered {
		recLogin := loginKey(rec.Login)
		if claimed[rec.Email] || rowIDs[rec.ID] ||
			(recLogin != "" && rowLogins[recLogin]) || rowEmails[rec.Email] {
			continue
		}
		plan.appends = append(plan.appends, rec)
	}
	return plan
}

// isPendingRosterRow reports whether a row is an email-ONLY invite row — the
// narrow set the fold and the reap may touch, matching the configrepo helpers'
// own filter (no username, no github_id cell at all).
func isPendingRosterRow(row configrepo.RosterRow) bool {
	return row.Username == "" && row.GitHubID == 0 && row.Email != ""
}

// loginKey is the case-insensitive key classroomIndex.idByLogin is both built
// and read with; the two must derive it identically or a backfill silently
// never matches.
func loginKey(login string) string {
	return strings.ToLower(strings.TrimSpace(login))
}

// runRosterSync is the three-phase reconcile: classify the invite teams
// (read-only), plan the roster edits, then — only with --write — apply them in
// ONE commit and retire the teams that commit made redundant.
func runRosterSync(client githubapi.Client, out, errOut io.Writer, org, classroom string, write bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	idx, idxErr := loadClassroomIndex(client, org, classroom, branch)
	if idxErr != nil {
		// Not fatal: the pass can still report, and every removal is already
		// gated on the trusted flag this clears.
		_, _ = fmt.Fprintf(errOut, "Warning: %s: reading the classroom's team membership failed (%v); nothing will be removed or backfilled this pass.\n", org, idxErr)
	}

	scan := scanInviteTeams(client, errOut, org, classroom, idx)

	rows, err := configrepo.LoadRosterLenient(client, org, classroom, branch)
	if err != nil {
		return err
	}
	plan := planRosterSync(rows, scan, idx)

	// A degraded pass proves nothing about a team either, so it deletes nothing
	// — and must not report a delete it won't make.
	if !scan.trusted {
		scan.staleSlugs = nil
	}
	reportSyncPlan(out, errOut, org, classroom, scan, plan)

	if !write {
		if plan.empty() && len(scan.staleSlugs) == 0 {
			if !scan.trusted {
				return syncDegradedError(org, classroom)
			}
			return nil
		}
		_, _ = fmt.Fprintf(errOut, "Nothing was changed. Re-run with --write to apply this.\n")
		if !scan.trusted {
			return syncDegradedError(org, classroom)
		}
		return &cliutil.ExitCodeError{
			Code: syncExitChangesPending,
			Err:  fmt.Errorf("%s: %s has changes pending; re-run with --write to apply them", org, classroom),
		}
	}

	if err := applyRosterSync(client, out, errOut, org, classroom, branch, scan, idx); err != nil {
		return err
	}
	deleteRetiredInviteTeams(client, out, errOut, org, classroom, scan)
	if !scan.trusted {
		return syncDegradedError(org, classroom)
	}
	return nil
}

func syncDegradedError(org, classroom string) error {
	return &cliutil.ExitCodeError{
		Code: syncExitDegraded,
		Err:  fmt.Errorf("%s: the %s reconcile was incomplete — a read was degraded, so nothing was removed; re-run once GitHub is healthy", org, classroom),
	}
}

// reportSyncPlan prints the planned edits on stdout (the result a script reads)
// and the anomalies needing a human on stderr.
func reportSyncPlan(out, errOut io.Writer, org, classroom string, scan inviteScan, plan rosterPlan) {
	path := fmt.Sprintf("%s/%s/%s", org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom))
	if plan.empty() && len(scan.staleSlugs) == 0 {
		_, _ = fmt.Fprintf(out, "%s: up to date (no invites to record, no rows to drop, no ids to fill)\n", path)
	}
	for _, rec := range plan.folds {
		_, _ = fmt.Fprintf(out, "%s: %s accepted — record as %s (github_id %d)\n", path, rec.Email, rec.Login, rec.ID)
	}
	for _, rec := range plan.appends {
		_, _ = fmt.Fprintf(out, "%s: %s accepted but has no row — add %s (github_id %d)\n", path, rec.Email, rec.Login, rec.ID)
	}
	for _, email := range plan.reapEmails {
		_, _ = fmt.Fprintf(out, "%s: drop the pending row for %s (no invitation and no metadata team back it)\n", path, email)
	}
	for _, username := range plan.backfills {
		_, _ = fmt.Fprintf(out, "%s: fill in %s's github_id from the classroom team\n", path, username)
	}
	for _, slug := range scan.staleSlugs {
		_, _ = fmt.Fprintf(out, "%s: delete the leftover metadata team %s\n", org, slug)
	}
	for _, anomaly := range scan.anomalies {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: kept %s\n", org, anomaly)
	}
}

// applyRosterSync is phase 3: ONE rebase-retried commit that folds every
// recovered identity, reaps the dead pending rows, and backfills ids. The whole
// classification is redone inside the closure — including a FRESH invitation
// read — because the scan snapshotted teams before this roster read, so an
// invite sent in between has a row but no snapshot entry.
func applyRosterSync(client githubapi.Client, out, errOut io.Writer, org, classroom, branch string, scan inviteScan, idx classroomIndex) error {
	var applied rosterPlan
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		applied = rosterPlan{} // rebase may retry this closure
		rows, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}

		fresh := scan
		if scan.trusted {
			// Re-confirm liveness against GitHub's CURRENT invitations; a failed
			// read fails closed (nothing is reaped this attempt).
			confirmed, err := pendingEmailInvitations(client, org)
			if err != nil {
				_, _ = fmt.Fprintf(errOut, "Warning: %s: re-checking the pending invitations before the write failed (%v); no pending row was dropped.\n", org, err)
				fresh.trusted = false
			} else {
				fresh.pendingEmails = confirmed
			}
		}

		plan := planRosterSync(rows, fresh, idx)
		if plan.empty() {
			return configwrite.CommitChange{}, nil // empty → skips the commit
		}
		// Mutate through the exported helpers so a row's raw/Extra round-trip
		// fields and teacher-owned cells survive untouched.
		for _, rec := range plan.folds {
			if next, ok := configrepo.ClaimPendingEmailRow(rows, rec.Email, rec.Login, rec.ID); ok {
				rows = next
				applied.folds = append(applied.folds, rec)
			}
		}
		for _, email := range plan.reapEmails {
			if next, ok := configrepo.RemovePendingEmailRow(rows, email); ok {
				rows = next
				applied.reapEmails = append(applied.reapEmails, email)
			}
		}
		for _, username := range plan.backfills {
			id := idx.idByLogin[loginKey(username)]
			if next, ok := configrepo.BackfillRosterGitHubID(rows, username, id); ok {
				rows = next
				applied.backfills = append(applied.backfills, username)
			}
		}
		for _, rec := range plan.appends {
			// Identity + the recovered address only: name and section stay
			// teacher-owned, never fabricated from a GitHub profile.
			rows, _ = configrepo.UpsertRosterRow(rows, configrepo.RosterRow{
				Username: rec.Login, Email: rec.Email, GitHubID: rec.ID, Role: invitedRosterRole,
			})
			applied.appends = append(applied.appends, rec)
		}
		return configrepo.RosterWriteChange(classroom, rows)
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: sync %s with GitHub (gh teacher roster sync)", classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return fmt.Errorf("reconciling %s: %w", configrepo.RosterFilePath(classroom), err)
	}
	if applied.empty() {
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: recorded %d accepted invite(s), added %d row(s), dropped %d pending row(s), filled %d github_id(s)\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom),
		len(applied.folds), len(applied.appends), len(applied.reapEmails), len(applied.backfills))
	return nil
}

// deleteRetiredInviteTeams is the post-commit teardown: a recovered mapping's
// team is deleted only now that the commit carrying its address has landed, so a
// failed delete just means the next pass re-recovers idempotently.
//
// Any slug a pending invitation now maps to is skipped: the slug is a
// deterministic hash, so a same-email RE-INVITE in the window since the scan
// adopts this very team, and deleting it would strip the metadata team off a
// brand-new live invitation. An unreadable invitation list keeps every team.
func deleteRetiredInviteTeams(client githubapi.Client, out, errOut io.Writer, org, classroom string, scan inviteScan) {
	slugs := make([]string, 0, len(scan.recovered)+len(scan.staleSlugs))
	for _, rec := range scan.recovered {
		slugs = append(slugs, rec.Slug)
	}
	slugs = append(slugs, scan.staleSlugs...)
	if len(slugs) == 0 {
		return
	}
	sort.Strings(slugs)

	live, err := liveInviteSlugs(client, org, classroom)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: re-checking the pending invitations failed (%v); every metadata team was left in place — a leftover is collected next pass, whereas a wrong delete loses the address for good.\n", org, err)
		return
	}
	for _, slug := range slugs {
		if live[slug] {
			_, _ = fmt.Fprintf(errOut, "Note: %s: kept metadata team %s — a same-email re-invite now maps to it, so deleting it would strip a live invitation.\n", org, slug)
			continue
		}
		if err := configrepo.DeleteInviteTeam(client, org, slug); err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: deleting the metadata team %s failed (%v); re-run `gh teacher roster sync %s %s --write` to collect it.\n", org, slug, err, org, classroom)
			continue
		}
		_, _ = fmt.Fprintf(out, "%s: deleted metadata team %s\n", org, slug)
	}
}

// liveInviteSlugs is the invite-team slug set a pending EMAIL invitation still
// maps to. Strict: a failed read propagates so the caller fails closed rather
// than reading it as "nothing is live".
func liveInviteSlugs(client githubapi.Client, org, classroom string) (map[string]bool, error) {
	emails, err := pendingEmailInvitations(client, org)
	if err != nil {
		return nil, err
	}
	slugs := make(map[string]bool, len(emails))
	for email := range emails {
		slugs[configrepo.InviteTeamName(classroom, email)] = true
	}
	return slugs, nil
}

// pendingEmailInvitations is the org's pending EMAIL invitations as a set of
// normalized addresses. GitHub keys an invitation by login OR email; only an
// email one has an address (and a metadata team) to reconcile.
func pendingEmailInvitations(client githubapi.Client, org string) (map[string]bool, error) {
	pending, err := membership.ListPendingOrgInvitations(client, org)
	if err != nil {
		return nil, err
	}
	emails := map[string]bool{}
	for _, inv := range pending {
		if inv.Login != "" || inv.Email == "" {
			continue
		}
		emails[configrepo.NormalizeInviteEmail(inv.Email)] = true
	}
	return emails, nil
}
