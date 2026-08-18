package roster

import (
	"errors"
	"fmt"
	"io"

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
			"invitation belongs to another classroom in this org, or if the\n" +
			"cancellation itself or the roster write following it fails.",
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
// only after a REAL cancellation, mirroring useCancelClassroomInvite. Three
// gates are load-bearing: without a pending invitation nothing is written at all
// (an accepted-but-unsynced invitation is indistinguishable from here, and the
// invite team holds the only email→account mapping); a pending invitation this
// classroom doesn't own belongs to a sibling classroom in the same org
// (requireClassroomOwnsInvite); and a 404'd DELETE means a stale id — a live
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

	// A read, deliberately before the DELETE: a refusal leaves the invitation
	// intact.
	slug, err := requireClassroomOwnsInvite(client, org, classroom, email)
	if err != nil {
		return err
	}

	// Resolve the write target BEFORE cancelling: it's a read, so a config repo
	// this run couldn't write to anyway fails while the invitation is intact.
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
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

// requireClassroomOwnsInvite proves the pending invitation belongs to THIS
// classroom, returning the invite team slug the teardown then deletes (a pure
// function of (classroom, email), never read back — DeleteInviteTeam is fenced
// to that hashed shape).
//
// Load-bearing because org invitations are org-scoped while everything this
// command tears down is classroom-scoped: without the gate, cancelling in
// classroom B revokes the live invitation classroom A sent, deletes none of A's
// artifacts, and reports success — leaving A's student unable to accept against
// a row nothing backs. The web needs no equivalent, taking an invitationId
// picked from the classroom team's own pending list (useCancelClassroomInvite).
//
// The per-invite team is the only classroom-scoped record of an email invite, so
// its presence is the ownership proof; a missing team means this classroom never
// sent it (ReadInviteTeam propagates every non-404 failure, so a degraded read
// never reads as absent).
func requireClassroomOwnsInvite(client githubapi.Client, org, classroom, email string) (string, error) {
	slug := configrepo.InviteTeamName(classroom, email)
	state, ok, err := configrepo.ReadInviteTeam(client, org, slug)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("%s: the pending invitation for %s is not %s's — its metadata team %s does not exist, so nothing was cancelled; another classroom in this org sent it (cancel it there), or if the team was already removed run `gh teacher roster sync %s %s` to reconcile",
			org, email, classroom, slug, org, classroom)
	}
	if state.Record != nil && state.Record.Classroom != classroom {
		return "", fmt.Errorf("%s: the metadata team %s records classroom %s, not %s, so nothing was cancelled; run `gh teacher roster cancel-invite %s %s %s` instead",
			org, slug, state.Record.Classroom, classroom, org, state.Record.Classroom, email)
	}
	return slug, nil
}

// pendingEmailInvitationID finds the pending EMAIL invitation for email. GitHub
// keys an invitation by login OR email, never both, so a login-keyed one carries
// no address to cancel this way — the same filter sync.go's reader applies.
func pendingEmailInvitationID(pending []membership.PendingOrgInvitation, email string) (int64, bool) {
	key := configrepo.NormalizeInviteEmail(email)
	if key == "" {
		return 0, false
	}
	for _, inv := range pending {
		if inv.ID == 0 || inv.Login != "" {
			continue
		}
		if configrepo.NormalizeInviteEmail(inv.Email) == key {
			return inv.ID, true
		}
	}
	return 0, false
}
