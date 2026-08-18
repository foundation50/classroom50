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

// rosterRoleStudent is the `role` value a student's roster row records, and the
// role the classroom's student team implies. The exact string is a cross-tool
// contract: the web writes the same cell, so a row must be byte-identical either
// way or every pass would rewrite the other's rows forever. Staff roles come
// from configrepo.StaffRoles, which has no student member (the student team
// isn't a staff team).
const rosterRoleStudent = "student"

// roleRank mirrors the web's ROLE_RANK: a person on both a staff and the student
// team records the staff role, and StaffRoles is already ordered teacher-first.
func roleRank(role string) int {
	for i, staff := range configrepo.StaffRoles {
		if string(staff) == role {
			return len(configrepo.StaffRoles) - i
		}
	}
	return 0
}

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
		Short: "Sync roster.csv with the classroom's GitHub state",
		Long: "Sync <org>/classroom50/<classroom>/roster.csv with GitHub:\n" +
			"record the students who accepted an email invitation, drop the\n" +
			"pending rows whose invitation is gone, and fill in any missing\n" +
			"github_id. The web app runs the same sync when a teacher opens\n" +
			"the roster — here it is explicit and script-callable.\n\n" +
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
	cmd.Flags().BoolVar(&write, "write", false, "Apply the sync (default: report only, making no write request)")
	return cmd
}

// classroomIndex is the classroom's own membership: the enrollment set a
// recovery is checked against, and the login→id map an unresolved github_id is
// backfilled from. Built ONLY from this classroom's teams — a global
// `GET /users/{login}` would bind whoever now owns a recycled login.
type classroomIndex struct {
	enrolled map[int64]bool
	// roleByID is the role of the team each enrolled id was found on (highest
	// rank wins, as the web's listClassroomMembersWithRoles does), so an
	// appended row records the role the teams say rather than assuming student.
	roleByID map[int64]string
	// idByLogin omits any login held by more than one member: two accounts
	// answering to one login is not something to guess at.
	idByLogin map[string]int64
	// archived is classroom.json `active: false`: the roster is frozen, so
	// --write is refused (the web's assertClassroomNotArchived).
	archived bool
	// ok is false when any read was degraded, which forces the whole pass
	// conservative (an absent member can't be told from an unread one).
	ok bool
}

// loadClassroomIndex reads the classroom's student team plus any recorded staff
// team, mirroring the web's resolveClassroomTeamSlugs: a staffer who accepted an
// email invitation is enrolled too, and deriving the student slug alone would
// read them as unenrolled.
//
// EVERY error path clears `ok`: the caller's warning promises nothing will be
// removed, and only that flag delivers it.
func loadClassroomIndex(client githubapi.Client, org, classroom, branch string) (classroomIndex, error) {
	idx := classroomIndex{
		enrolled: map[int64]bool{}, roleByID: map[int64]string{},
		idByLogin: map[string]int64{}, ok: true,
	}

	slug, err := configrepo.ResolveClassroomTeamSlug(client, org, classroom, branch)
	if err != nil {
		idx.ok = false
		return idx, err
	}
	// Student team first (so a staff-team blip can't hide the enrollment set),
	// with the recorded role resolved by rank rather than by read order.
	teams := []struct {
		slug string
		role string
	}{{slug: slug, role: rosterRoleStudent}}
	if c, ok, err := configrepo.LoadClassroom(client, org, classroom, branch); err == nil && ok {
		idx.archived = c.IsArchived()
		for _, role := range configrepo.StaffRoles {
			if ref := c.Teams.RefForRole(role); ref != nil && ref.Slug != "" {
				teams = append(teams, struct {
					slug string
					role string
				}{slug: ref.Slug, role: string(role)})
			}
		}
	} else if err != nil {
		idx.ok = false
		return idx, err
	}

	counts := map[string]int{}
	for _, team := range teams {
		// Strict read: a classroom or staff team is RECORDED, so its absence is a
		// broken classroom (renamed, deleted, mistyped), not an empty roster.
		// Reading it as no members would make every accepted invitee look
		// unenrolled and authorize deleting the only record of their address.
		members, found, err := configrepo.FindTeamMembersWithIDs(client, org, team.slug)
		if err != nil {
			idx.ok = false
			return idx, err
		}
		if !found {
			idx.ok = false
			return idx, fmt.Errorf("team %s is recorded for classroom %s but GitHub has no such team — it was renamed or deleted, so who is enrolled cannot be read; restore the team (or correct %s in the config repo) before syncing",
				team.slug, classroom, configrepo.ClassroomFilePath(classroom))
		}
		for _, m := range members {
			if m.ID <= 0 {
				continue
			}
			if cur, seen := idx.roleByID[m.ID]; !seen || roleRank(team.role) > roleRank(cur) {
				idx.roleByID[m.ID] = team.role
			}
			if idx.enrolled[m.ID] {
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
		if state.Record == nil {
			// The invitee owns their own team's description after accepting, so a
			// record that no longer parses is the same trust failure as a hash
			// mismatch: it must not authorize reaping the row it might back. A
			// PROVISIONAL description is the exception — that is a run of either
			// tool still in flight, and its team holds no address to lose.
			if !state.Provisional {
				scan.anomalies = append(scan.anomalies, fmt.Sprintf("%s: description is no longer a readable invite record — left alone, and any pending row it might back was kept; delete it by hand once you've checked it", team.Slug))
				// The address it held is unknowable, so no liveEmails entry can
				// be made for it. Failing the whole pass closed is the only way
				// to keep the row it backed from looking unbacked.
				scan.trusted = false
			}
			continue
		}
		// Another classroom's invite: leave it for that classroom's own reconcile.
		if state.Record.Classroom != classroom {
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
				_, _ = fmt.Fprintf(errOut, "Warning: %s: no classroom members are visible, so %s can't be synced; leaving it alone.\n", org, team.Slug)
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
// Report-only findings live in rosterFindings, so `empty()` answers exactly
// "would --write change anything?" and the summary can't disagree with the exit
// code.
type rosterPlan struct {
	// folds are recoveries with a pending row to claim.
	folds []inviteRecovery
	// emailFills are recoveries whose row already names the account (by id or
	// login) but records no address. Without this the recovered address has
	// nowhere to land, and retiring its team would lose it.
	emailFills []inviteRecovery
	// reapEmails are pending rows no live invite team or invitation backs.
	reapEmails []string
	// backfills are usernames whose github_id can be filled from the classroom
	// team's membership.
	backfills []string
	// appends are recoveries no row claims at all — the invite-time row was
	// deleted (or never written, e.g. `roster invite`'s commit failed). Without
	// this the address would be lost when the team is retired below.
	appends []inviteRecovery
	// findings is what this pass will only REPORT. Never consulted by empty().
	findings rosterFindings
}

// rosterFindings are the report-only outcomes of a pass: nothing --write would
// change, so they must not make a dry run claim changes are pending (or a clean
// pass claim it is up to date while stderr warns).
type rosterFindings struct {
	// dupLogins are usernames on more than one row whose backfill therefore
	// can't apply: BackfillRosterGitHubID matches the FIRST row with a username,
	// so a later duplicate is reported for a hand-fix rather than planned — a
	// change --write can't make would leave every dry run exiting 2 forever.
	dupLogins []string
}

func (p rosterPlan) empty() bool {
	return len(p.folds) == 0 && len(p.emailFills) == 0 && len(p.reapEmails) == 0 &&
		len(p.backfills) == 0 && len(p.appends) == 0
}

// planRosterSync is phase 2: match the scan against the roster rows. Read-only,
// so a dry run and the commit closure share one classifier.
func planRosterSync(rows []configrepo.RosterRow, scan inviteScan, idx classroomIndex) rosterPlan {
	var plan rosterPlan
	recoveredByEmail := make(map[string]inviteRecovery, len(scan.recovered))
	for _, r := range scan.recovered {
		recoveredByEmail[r.Email] = r
	}

	claimed := map[string]bool{}
	for _, row := range rows {
		email := configrepo.NormalizeInviteEmail(row.Email)
		if !row.IsPendingEmailInvite() {
			continue
		}
		if rec, ok := recoveredByEmail[email]; ok && !claimed[email] {
			claimed[email] = true
			plan.folds = append(plan.folds, rec)
			continue
		}
		// A pending row lives only while something backs it. Three gates keep
		// that from eating a legitimate row: the pass must be trusted, no live
		// team may hold the address, and it must be absent from GitHub's CURRENT
		// pending invitations (re-read inside the commit closure, since an invite
		// sent after the team snapshot has a row but no team entry). A recovered
		// address is never a candidate — a duplicate row for it is the fold's
		// business, not the reaper's.
		if scan.trusted && !scan.liveEmails[email] &&
			scan.pendingEmails != nil && !scan.pendingEmails[email] {
			if _, recovered := recoveredByEmail[email]; !recovered {
				plan.reapEmails = append(plan.reapEmails, email)
			}
		}
	}

	// The remaining steps are planned against the rows AS THE FOLDS LEAVE THEM:
	// a fold gives a row an identity, so an index built before it would place a
	// recovery on a row that no longer needs it (and an append that then
	// duplicates). Applying the folds to a copy costs one pass and removes the
	// whole class of stale-index bug.
	folded := applyPlannedFolds(rows, plan.folds)
	rowIdx := indexRosterRows(folded)

	for i, row := range folded {
		// A row carrying a username but no usable id: fill it from the
		// classroom's own team membership. A login on no classroom team is left
		// alone rather than resolved globally.
		if row.IsPendingEmailInvite() || row.Username == "" || row.GitHubID != 0 {
			continue
		}
		key := loginKey(row.Username)
		if _, ok := idx.idByLogin[key]; !ok {
			continue
		}
		if rowIdx.firstByLogin[key] != i {
			plan.findings.dupLogins = append(plan.findings.dupLogins, row.Username)
			continue
		}
		plan.backfills = append(plan.backfills, row.Username)
	}

	// The two remaining steps join on IDENTITY (id or login), as the web's fold
	// does. A shared contact address on someone else's row proves nothing about
	// this account and must not decide either one.
	for _, rec := range scan.recovered {
		if claimed[rec.Email] {
			continue
		}
		i, ok := rowIdx.rowFor(rec)
		if !ok {
			// No row names this account at all: it needs one, or retiring the
			// team would lose the only record of the invited address.
			plan.appends = append(plan.appends, rec)
			continue
		}
		// The row names the account but records no address: the recovered one has
		// nowhere to land, and the team holding it is retired right after. Fill
		// the blank cell — never a teacher-entered one.
		if configrepo.NormalizeInviteEmail(folded[i].Email) == "" {
			plan.emailFills = append(plan.emailFills, rec)
		}
	}
	return plan
}

// applyPlannedFolds returns rows with each planned fold applied to a COPY, so
// the later steps plan against the shape the commit will produce without
// mutating the caller's slice.
func applyPlannedFolds(rows []configrepo.RosterRow, folds []inviteRecovery) []configrepo.RosterRow {
	if len(folds) == 0 {
		return rows
	}
	folded := append([]configrepo.RosterRow(nil), rows...)
	for _, rec := range folds {
		folded, _ = configrepo.ClaimPendingEmailRow(folded, rec.Email, rec.Login, rec.ID)
	}
	return folded
}

// rosterRowIndex is the identity join the plan is built against. firstByID /
// firstByLogin record WHICH row each identity is on, because every helper keyed
// on a username or an id touches the FIRST match: planning against a later
// duplicate plans an edit that then applies to nothing.
type rosterRowIndex struct {
	firstByID    map[int64]int
	firstByLogin map[string]int
}

func indexRosterRows(rows []configrepo.RosterRow) rosterRowIndex {
	out := rosterRowIndex{firstByID: map[int64]int{}, firstByLogin: map[string]int{}}
	for i, row := range rows {
		if row.GitHubID != 0 {
			if _, seen := out.firstByID[row.GitHubID]; !seen {
				out.firstByID[row.GitHubID] = i
			}
		}
		if key := loginKey(row.Username); key != "" {
			if _, seen := out.firstByLogin[key]; !seen {
				out.firstByLogin[key] = i
			}
		}
	}
	return out
}

// rowFor is the row RecordRosterEmail will touch for rec: the first one naming
// its login, else the first one carrying its id. The two must agree or the plan
// describes a row the helper never edits.
func (idx rosterRowIndex) rowFor(rec inviteRecovery) (int, bool) {
	if key := loginKey(rec.Login); key != "" {
		if i, ok := idx.firstByLogin[key]; ok {
			return i, true
		}
	}
	i, ok := idx.firstByID[rec.ID]
	return i, ok
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
	// An archived classroom's roster is frozen (the web's
	// assertClassroomNotArchived), but a dry run stays allowed so the leftovers
	// remain inspectable.
	if write && idx.archived {
		return fmt.Errorf("classroom %q is archived (classroom.json active:false) — its roster is frozen, so `roster sync --write` is refused; run `gh teacher classroom unarchive %s %s` first, or re-run without --write to see what is pending",
			classroom, org, classroom)
	}

	scan := scanInviteTeams(client, errOut, org, classroom, idx)

	rows, err := configrepo.LoadRosterLenient(client, org, classroom, branch)
	if err != nil {
		return err
	}
	plan := planRosterSync(rows, scan, idx)

	// A degraded pass proves nothing about a team either, so it deletes nothing
	// — and must not report a delete it won't make. That covers the RECOVERED
	// teardown as well as the stale sweep: the exit-1 message promises nothing
	// was removed, and fail-closed is the only way to keep that true.
	retirable := retirableSlugs(rows, scan)
	if !scan.trusted {
		scan.staleSlugs = nil
		retirable = nil
	}
	reportSyncPlan(out, errOut, org, classroom, scan, plan, retirable)

	pending := !plan.empty() || len(scan.staleSlugs) > 0 || len(retirable) > 0
	if !write {
		if pending {
			_, _ = fmt.Fprintf(errOut, "Nothing was changed. Re-run with --write to apply this.\n")
		}
		if !scan.trusted {
			return syncDegradedError(org, classroom)
		}
		if pending {
			return &cliutil.ExitCodeError{
				Code: syncExitChangesPending,
				Err:  fmt.Errorf("%s: %s has changes pending; re-run with --write to apply them", org, classroom),
			}
		}
		return nil
	}

	retired, degraded, err := applyRosterSync(client, out, errOut, org, classroom, branch, scan, idx)
	if err != nil {
		return err
	}
	if !scan.trusted || degraded {
		// A degrade discovered inside the write closure (a failed invitation
		// re-read) suppressed a removal there; the teardown must fail closed the
		// same way, and the exit code must still reach the caller.
		_, _ = fmt.Fprintf(errOut, "Note: %s: no metadata team was deleted — this pass could not read enough to prove one is redundant.\n", org)
		return syncDegradedError(org, classroom)
	}
	if !deleteRetiredInviteTeams(client, out, errOut, org, classroom, scan, retired) {
		return syncDegradedError(org, classroom)
	}
	return nil
}

// recordsRecovery reports whether rows provably hold rec's invited address: the
// row carrying it must ALSO identify rec's account. A row that merely shares the
// address (a classmate's department contact) proves nothing — deleting the team
// on its word would destroy the only record of where THIS account came from. A
// pending row never counts either: its address is exactly what the invite team
// is still the sole record of.
//
// The teardown deletes only teams that pass this, so a mapping nothing recorded
// survives for the teacher to finish by hand.
func recordsRecovery(rows []configrepo.RosterRow, rec inviteRecovery) bool {
	recLogin := loginKey(rec.Login)
	for _, row := range rows {
		if row.IsPendingEmailInvite() {
			continue
		}
		if configrepo.NormalizeInviteEmail(row.Email) != rec.Email {
			continue
		}
		if row.GitHubID == rec.ID || (recLogin != "" && loginKey(row.Username) == recLogin) {
			return true
		}
	}
	return false
}

// retirableSlugs is the invite teams a --write pass would delete given `rows`:
// every recovery the roster already records, in the same order the teardown
// walks. Computed in the read-only phase too, so a dry run whose plan is empty
// (nothing to fold — the address is already recorded) still reports the delete
// and exits 2 instead of claiming the classroom is up to date.
func retirableSlugs(rows []configrepo.RosterRow, scan inviteScan) []string {
	var slugs []string
	for _, rec := range scan.recovered {
		if recordsRecovery(rows, rec) {
			slugs = append(slugs, rec.Slug)
		}
	}
	return slugs
}

func syncDegradedError(org, classroom string) error {
	return &cliutil.ExitCodeError{
		Code: syncExitDegraded,
		Err:  fmt.Errorf("%s: the %s sync was incomplete — a read was degraded, so nothing was removed; re-run once GitHub is healthy", org, classroom),
	}
}

// reportSyncPlan prints the planned edits on stdout (the result a script reads)
// and the report-only findings needing a human on stderr. `retirable` is the
// recovered metadata teams a --write pass would delete: reported here so a dry
// run whose roster plan is empty still says so rather than "up to date".
func reportSyncPlan(out, errOut io.Writer, org, classroom string, scan inviteScan, plan rosterPlan, retirable []string) {
	path := fmt.Sprintf("%s/%s/%s", org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom))
	if plan.empty() && len(scan.staleSlugs) == 0 && len(retirable) == 0 {
		_, _ = fmt.Fprintf(out, "%s: up to date (no invites to record, no rows to drop, no ids to fill)\n", path)
	}
	for _, rec := range plan.folds {
		_, _ = fmt.Fprintf(out, "%s: %s accepted — record as %s (github_id %d)\n", path, rec.Email, rec.Login, rec.ID)
	}
	for _, rec := range plan.emailFills {
		_, _ = fmt.Fprintf(out, "%s: %s accepted — record that address on %s's row (github_id %d)\n", path, rec.Email, rec.Login, rec.ID)
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
	for _, slug := range retirable {
		_, _ = fmt.Fprintf(out, "%s: retire the metadata team %s — the roster already records its address\n", org, slug)
	}
	for _, username := range plan.findings.dupLogins {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: left a second row for %q alone — more than one row carries that username, and only the first can be filled in, so which student the id belongs to is not this pass's guess. Remove the duplicate row (or give it its own username) to let the sync finish it.\n",
			path, username)
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
//
// It reports the slugs the commit made redundant plus whether anything inside
// the closure degraded, since a degrade discovered here lives on a struct COPY
// and only the returned flag can reach the exit code.
func applyRosterSync(client githubapi.Client, out, errOut io.Writer, org, classroom, branch string, scan inviteScan, idx classroomIndex) (retired []string, degraded bool, err error) {
	var applied rosterPlan
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		// A rebase retries this closure, so every per-attempt result is reset:
		// the teardown must be gated on the attempt that actually landed.
		applied, retired, degraded = rosterPlan{}, nil, false
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
				degraded = true
			} else {
				fresh.pendingEmails = confirmed
			}
		}

		plan := planRosterSync(rows, fresh, idx)
		if plan.empty() {
			retired = retirableSlugs(rows, fresh)
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
		for _, rec := range plan.emailFills {
			if next, ok := configrepo.RecordRosterEmail(rows, rec.Login, rec.ID, rec.Email); ok {
				rows = next
				applied.emailFills = append(applied.emailFills, rec)
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
			// teacher-owned, never fabricated from a GitHub profile. Role comes
			// from the classroom team they were found on; unknown leaves it empty
			// so UpsertRosterRow preserves whatever is stored.
			rows, _ = configrepo.UpsertRosterRow(rows, configrepo.RosterRow{
				Username: rec.Login, Email: rec.Email, GitHubID: rec.ID, Role: idx.roleByID[rec.ID],
			})
			applied.appends = append(applied.appends, rec)
		}
		// Every planned edit can still be refused by the helpers (their
		// claimable-row rule is stricter than any planner-side match can prove
		// under a rebase), and committing the re-encoded rows then lands a real
		// commit with no diff. Nothing applied → nothing to write.
		retired = retirableSlugs(rows, fresh)
		if applied.empty() {
			return configwrite.CommitChange{}, nil
		}
		return configrepo.RosterWriteChange(classroom, rows)
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: sync %s with GitHub (gh teacher roster sync)", classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return nil, degraded, fmt.Errorf("syncing %s: %w", configrepo.RosterFilePath(classroom), err)
	}
	if applied.empty() {
		return retired, degraded, nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: recorded %d accepted invite(s), added %d row(s), dropped %d pending row(s), filled %d github_id(s)\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom),
		len(applied.folds)+len(applied.emailFills), len(applied.appends), len(applied.reapEmails), len(applied.backfills))
	return retired, degraded, nil
}

// deleteRetiredInviteTeams is the post-commit teardown: a recovered mapping's
// team is deleted only now that the commit carrying its address has landed, so a
// failed delete just means the next pass re-recovers idempotently. It reports
// whether every delete it intended succeeded, so a failure reaches the exit code
// rather than only stderr.
//
// Any slug a pending invitation now maps to is skipped: the slug is a
// deterministic hash, so a same-email RE-INVITE in the window since the scan
// adopts this very team, and deleting it would strip the metadata team off a
// brand-new live invitation. An unreadable invitation list keeps every team.
//
// `retired` is the recovered slugs the committed roster provably records (see
// recordsRecovery). A recovery outside it is skipped: nothing wrote its mapping,
// so that team is still the only record of which address the account came from —
// the very thing the teacher needs to finish the row by hand.
func deleteRetiredInviteTeams(client githubapi.Client, out, errOut io.Writer, org, classroom string, scan inviteScan, retired []string) bool {
	recordedSlug := make(map[string]bool, len(retired))
	for _, slug := range retired {
		recordedSlug[slug] = true
	}
	slugs := make([]string, 0, len(retired)+len(scan.staleSlugs))
	for _, rec := range scan.recovered {
		if !recordedSlug[rec.Slug] {
			_, _ = fmt.Fprintf(errOut, "Note: %s: kept metadata team %s — no row records %s against %s's account, so this team is still the only record of that address. Add it to their row (or clear the address they carry) and re-run.\n",
				org, rec.Slug, rec.Email, rec.Login)
			continue
		}
		slugs = append(slugs, rec.Slug)
	}
	slugs = append(slugs, scan.staleSlugs...)
	if len(slugs) == 0 {
		return true
	}
	sort.Strings(slugs)

	live, err := liveInviteSlugs(client, org, classroom)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: re-checking the pending invitations failed (%v); every metadata team was left in place — a leftover is collected next pass, whereas a wrong delete loses the address for good.\n", org, err)
		return false
	}
	ok := true
	for _, slug := range slugs {
		if live[slug] {
			_, _ = fmt.Fprintf(errOut, "Note: %s: kept metadata team %s — a same-email re-invite now maps to it, so deleting it would strip a live invitation.\n", org, slug)
			continue
		}
		if err := configrepo.DeleteInviteTeam(client, org, slug); err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: deleting the metadata team %s failed (%v); re-run `gh teacher roster sync %s %s --write` to collect it.\n", org, slug, err, org, classroom)
			ok = false
			continue
		}
		_, _ = fmt.Fprintf(out, "%s: deleted metadata team %s\n", org, slug)
	}
	return ok
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
		if !inv.IsEmailKeyed() {
			continue
		}
		emails[configrepo.NormalizeInviteEmail(inv.Email)] = true
	}
	return emails, nil
}
