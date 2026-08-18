package roster

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
)

func rosterCancelInviteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cancel-invite <org> <classroom> <email>",
		Short: "Revoke a pending email invitation and clear what it left behind",
		Long: "Revoke the pending GitHub organization invitation sent to <email>\n" +
			"and clear the two records it left behind: the per-invite `secret`\n" +
			"metadata team retaining the address, and the pending row in\n" +
			"<org>/classroom50/<classroom>/roster.csv. The same teardown the web\n" +
			"app performs, so either tool can revoke either tool's invitation.\n\n" +
			"Only ever acts on a PENDING invitation. With no pending invitation\n" +
			"for the address this reports and changes nothing — an invitation the\n" +
			"student already accepted looks exactly the same from here, and the\n" +
			"metadata team holds the only record of which address their account\n" +
			"came from. Run `gh teacher roster sync` in that case: it records the\n" +
			"student, and cleans up a genuine leftover under its own checks.\n\n" +
			"For a student already on the roster with a username, use\n" +
			"`gh teacher roster remove` (and `gh teacher remove` for the org).\n\n" +
			"Exits 0 when nothing was pending; returns non-zero if the pending\n" +
			"invitation belongs to another classroom in this org, if this\n" +
			"classroom's metadata team for the address is missing or record-less\n" +
			"(revoke such an invitation from the web app's roster or from GitHub's\n" +
			"org pending-invitations page), or if the cancellation itself or the\n" +
			"roster write following it fails.",
		Example: "  gh teacher roster cancel-invite cs50-fall-2026 cs-principles ada@example.edu",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, classroom, email, err := parseEmailArgs(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runRosterCancelInvite(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, email)
		},
	}
	return cmd
}

// runRosterCancelInvite revokes the invitation first and retires its artifacts
// only after a REAL cancellation, mirroring useCancelClassroomInvite. Four gates
// are load-bearing: without a pending invitation nothing is written at all (an
// accepted-but-unsynced invitation is indistinguishable from here, and the
// invite team holds the only email→account mapping); the address must be one
// this classroom invited (requireClassroomOwnsInvite); the invitation ID itself
// must be bound to this classroom (requireInvitationBoundToClassroom), since an
// org invitation is org-scoped; and a 404'd DELETE means a stale id — a live
// invitation for the same address may still exist, so retiring its artifacts
// would strip someone who can still accept.
func runRosterCancelInvite(client githubapi.Client, out, errOut io.Writer, org, classroom, email string) error {
	email = configrepo.NormalizeInviteEmail(email)

	pending, err := membership.ListPendingOrgInvitations(client, org)
	if err != nil {
		return err
	}
	invitationID, found := pendingEmailInvitationID(pending, email)
	if !found {
		_, _ = fmt.Fprintf(out, "%s: no pending invitation for %s, nothing was cancelled\n", org, email)
		_, _ = fmt.Fprintf(errOut, "If they already accepted, run `gh teacher roster sync %s %s` to record their username and github_id — it also collects a genuine leftover invite team or pending row under its own checks, which this command deliberately won't do without a pending invitation to revoke.\n",
			org, classroom)
		return nil
	}

	// Resolve the write target BEFORE cancelling: it's a read, so a config repo
	// this run couldn't write to anyway fails while the invitation is intact. It
	// also names the classroom team the ownership proof below accepts.
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	// Both reads, deliberately before the DELETE: a refusal — or a degraded read
	// — leaves the invitation intact.
	slug, err := requireClassroomOwnsInvite(client, org, classroom, email)
	if err != nil {
		return err
	}
	classroomTeamSlug, err := configrepo.ResolveClassroomTeamSlug(client, org, classroom, branch)
	if err != nil {
		return err
	}
	if err := requireInvitationBoundToClassroom(client, org, classroom, email, invitationID, slug, classroomTeamSlug); err != nil {
		return err
	}

	if err := membership.CancelOrgInvitation(client, org, invitationID); err != nil {
		if errors.Is(err, membership.ErrInvitationAlreadyGone) {
			_, _ = fmt.Fprintf(out, "%s: the invitation for %s was already gone, nothing was cancelled\n", org, email)
			_, _ = fmt.Fprintf(errOut, "Nothing else was touched: another invitation for %s may have replaced this one. Run `gh teacher roster sync %s %s` to reconcile.\n",
				email, org, classroom)
			return nil
		}
		return err
	}
	_, _ = fmt.Fprintf(out, "%s: cancelled the invitation for %s\n", org, email)

	if err := configrepo.DeleteInviteTeam(client, org, slug); err != nil {
		warnStrandedInviteTeam(errOut, "the invitation was cancelled, but deleting", org, slug, err)
	} else {
		_, _ = fmt.Fprintf(out, "%s: deleted metadata team %s\n", org, slug)
	}

	var removed bool
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		rows, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		next, ok := configrepo.RemovePendingEmailRow(rows, email)
		removed = ok
		if !ok {
			return configwrite.CommitChange{}, nil // empty → skips the commit (already absent)
		}
		return configrepo.RosterWriteChange(classroom, next)
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: remove cancelled invite from %s (gh teacher roster cancel-invite)", classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: the invitation to %s was cancelled, but dropping its pending row from %s failed; run `gh teacher roster sync %s %s` to reconcile.\n",
			email, configrepo.RosterFilePath(classroom), org, classroom)
		return fmt.Errorf("invitation cancelled, but the pending roster row was not removed: %w", err)
	}
	if !removed {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: no pending row for %s, roster unchanged\n",
			org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), email)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: removed the pending row for %s\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), email)
	return nil
}

// requireClassroomOwnsInvite proves THIS classroom invited this address,
// returning the invite team slug the teardown then deletes (a pure function of
// (classroom, email), never read back — DeleteInviteTeam is fenced to that
// hashed shape).
//
// The per-invite team is the only classroom-scoped record of an email invite, so
// its presence is one half of the ownership proof; the other half is
// requireInvitationBoundToClassroom, since two classrooms may each hold a team
// for the same address. A missing team means this classroom never sent it, and a
// team with no parseable record proves nothing at all (ReadInviteTeam propagates
// every non-404 failure, so a degraded read never reads as absent).
func requireClassroomOwnsInvite(client githubapi.Client, org, classroom, email string) (string, error) {
	slug := configrepo.InviteTeamName(classroom, email)
	state, ok, err := configrepo.ReadInviteTeam(client, org, slug)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("%s: the pending invitation for %s has no metadata team (%s) in %s, so nothing was cancelled; if another classroom in this org sent it, cancel it there, and if this classroom's team was already deleted revoke the invitation from the web app's roster or from https://github.com/orgs/%s/people/pending_invitations",
			org, email, slug, classroom, org)
	}
	// The record is written LAST, so a team without one is an aborted send (or a
	// blanked description): it names no classroom and must authorize nothing.
	// `roster sync` deliberately skips such a team, so it is no help here.
	if state.Record == nil {
		return "", fmt.Errorf("%s: the metadata team %s holds no invite record — an interrupted send leaves exactly that — so nothing proves the pending invitation for %s is %s's and nothing was cancelled; revoke it from the web app's %s roster or from https://github.com/orgs/%s/people/pending_invitations, and delete the team by hand",
			org, slug, email, classroom, classroom, org)
	}
	if state.Record.Classroom != classroom {
		return "", fmt.Errorf("%s: the metadata team %s records classroom %s, not %s, so nothing was cancelled; run `gh teacher roster cancel-invite %s %s %s` instead",
			org, slug, state.Record.Classroom, classroom, org, state.Record.Classroom, email)
	}
	return slug, nil
}

// requireInvitationBoundToClassroom proves the invitation ID about to be DELETEd
// is the one THIS classroom sent, by requiring one of its classroom-scoped teams
// among the teams the invitation carries.
//
// Load-bearing because the address lookup is org-wide while everything torn down
// is classroom-scoped: when two classrooms invited the same address they each
// have a metadata team, so requireClassroomOwnsInvite passes in both — and the
// org-wide lookup can still return the sibling's live invitation. Revoking that
// leaves the sibling's student unable to accept against a row nothing backs, and
// reports success. The web needs no equivalent: it cancels an invitationId picked
// from the classroom team's own pending list (useCancelClassroomInvite).
func requireInvitationBoundToClassroom(client githubapi.Client, org, classroom, email string, invitationID int64, inviteTeamSlug, classroomTeamSlug string) error {
	teams, err := membership.ListInvitationTeams(client, org, invitationID)
	if err != nil {
		return err
	}
	for _, team := range teams {
		if team.Slug == inviteTeamSlug || (classroomTeamSlug != "" && team.Slug == classroomTeamSlug) {
			return nil
		}
	}
	carried := make([]string, 0, len(teams))
	for _, team := range teams {
		if team.Slug != "" {
			carried = append(carried, team.Slug)
		}
	}
	if len(carried) == 0 {
		carried = append(carried, "no teams")
	}
	return fmt.Errorf("%s: pending invitation %d for %s carries none of %s's teams (it carries %s, not %s or %s), so another classroom in this org sent it and nothing was cancelled; cancel it in that classroom",
		org, invitationID, email, classroom, strings.Join(carried, ", "), inviteTeamSlug, classroomTeamSlug)
}

// pendingEmailInvitationID finds the pending EMAIL invitation for email. GitHub
// keys an invitation by login OR email, never both, so a login-keyed one carries
// no address to cancel this way (membership.PendingOrgInvitation.IsEmailKeyed is
// the shared filter).
func pendingEmailInvitationID(pending []membership.PendingOrgInvitation, email string) (int64, bool) {
	key := configrepo.NormalizeInviteEmail(email)
	if key == "" {
		return 0, false
	}
	for _, inv := range pending {
		if inv.ID == 0 || !inv.IsEmailKeyed() {
			continue
		}
		if configrepo.NormalizeInviteEmail(inv.Email) == key {
			return inv.ID, true
		}
	}
	return 0, false
}
