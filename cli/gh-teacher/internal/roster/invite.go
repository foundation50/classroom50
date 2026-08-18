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

// invitedRosterRole is the role an email invitation's pending row records.
// Fixed at student: the CLI has no `--role`, matching the web's
// appendEmailInviteRows so a CLI-written row is byte-identical to a web one.
const invitedRosterRole = "student"

func rosterInviteCmd() *cobra.Command {
	var (
		firstName string
		lastName  string
		section   string
	)

	cmd := &cobra.Command{
		Use:   "invite <org> <classroom> <email>",
		Short: "Invite one student to the classroom by email address",
		Long: "Send a GitHub organization invitation to <email> and record it as a\n" +
			"pending row in <org>/classroom50/<classroom>/roster.csv — the same\n" +
			"three artifacts the web app's email invite creates, so either tool\n" +
			"can complete the invitation.\n\n" +
			"Use this when the student has no GitHub account yet (or you only have\n" +
			"their address). For a student whose username you already know, use\n" +
			"`gh teacher roster add`, which resolves their github_id immediately.\n\n" +
			"The invitation carries two teams, so accepting it enrolls them in one\n" +
			"step: the classroom team (template read) and a per-invite `secret`\n" +
			"metadata team retaining the invited address. GitHub stops reporting\n" +
			"that address once the invitation is accepted, so without the metadata\n" +
			"team nothing could join the new account to its roster row.\n\n" +
			"Student role only: unlike the web app this cannot invite staff, so it\n" +
			"can never grant org ownership from a mistyped address.\n\n" +
			"Once the student accepts, run `gh teacher roster sync` to fill in\n" +
			"their username and github_id (the web app does this on its own).\n\n" +
			"Returns non-zero on: classroom missing a GitHub team, an address the\n" +
			"roster already lists as invited, or a failed invitation. An address\n" +
			"that already belongs to a member (or already has a pending\n" +
			"invitation) is reported as skipped and exits 0.",
		Example: "  gh teacher roster invite cs50-fall-2026 cs-principles ada@example.edu\n" +
			"  gh teacher roster invite cs50-fall-2026 cs-principles ada@example.edu --first-name Ada --last-name Lovelace --section section-1",
		Args: cobra.ExactArgs(3),
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
			return runRosterInvite(client, cmd.OutOrStdout(), cmd.ErrOrStderr(),
				org, classroom, email,
				strings.TrimSpace(firstName), strings.TrimSpace(lastName), strings.TrimSpace(section))
		},
	}
	cmd.Flags().StringVar(&firstName, "first-name", "", "Student's first name (written into the first_name column)")
	cmd.Flags().StringVar(&lastName, "last-name", "", "Student's last name (written into the last_name column)")
	cmd.Flags().StringVar(&section, "section", "", "Section identifier (free-form text, written into the section column)")
	return cmd
}

// runRosterInvite sends the email invitation, then records the pending row.
// The order mirrors the web's bulkInviteByEmail and is load-bearing throughout:
// every read that could refuse the send happens before the first write, the
// invite team's record is written before the invitation exists (so an accepted
// invitation always has an address to recover), and the roster row is appended
// only once the invitation is real.
func runRosterInvite(client githubapi.Client, out, errOut io.Writer, org, classroom, email, firstName, lastName, section string) error {
	email = configrepo.NormalizeInviteEmail(email)

	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	// A team-less email invitation is broken, not degraded: the invitee accepts
	// into the org attached to nothing and, with no username to key on, nothing
	// later notices. Refuse while nothing has been created or sent. A recorded
	// team missing its numeric id is just as unusable — the invitation carries
	// team ids, not slugs.
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
	if holder, claimed := rosterEmailClaim(rows, email); claimed {
		if holder == "" {
			return fmt.Errorf("%s is already invited to %s — run `gh teacher roster sync %s %s` if they accepted, or `gh teacher roster cancel-invite %s %s %s` to revoke it; nothing was sent",
				email, classroom, org, classroom, org, classroom, email)
		}
		return fmt.Errorf("%s is already on the %s roster as %s, so nothing was sent — use `gh teacher roster update %s %s %s` to correct their details",
			email, classroom, holder, org, classroom, holder)
	}

	// EnsureInviteTeam drops the creator GitHub silently adds, so it needs to
	// know who that is.
	actor, _, err := githubapi.CurrentUser(client)
	if err != nil {
		return fmt.Errorf("resolving your GitHub login (needed to keep the invite team free of teachers): %w", err)
	}

	// No cleanup on failure here on purpose: EnsureInviteTeam writes the email
	// LAST, so anything it strands holds no address and no valid record — a
	// reconcile skips it and the next invite to this address adopts and heals it.
	inviteTeam, created, err := configrepo.EnsureInviteTeam(client, org, classroom, email, actor)
	if err != nil {
		return err
	}

	if err := membership.InviteOrgByEmail(client, org, email, []int64{classroomTeam.ID, inviteTeam.ID}); err != nil {
		// A doomed invitation must not leave a fresh, member-less metadata team
		// behind for the GC to reap — but an ADOPTED team may hold an earlier
		// invite's still-unrecovered record, so only delete what this run made.
		if created {
			if delErr := configrepo.DeleteInviteTeam(client, org, inviteTeam.Slug); delErr != nil {
				warnStrandedInviteTeam(errOut, "nothing was invited, but cleaning up", org, inviteTeam.Slug, delErr)
			}
		}
		if errors.Is(err, membership.ErrEmailAlreadyInvitedOrMember) {
			_, _ = fmt.Fprintf(out, "%s: skipped %s — already a member of the org or already invited\n", org, email)
			_, _ = fmt.Fprintf(errOut, "If they accepted an earlier invitation, run `gh teacher roster sync %s %s` to record them on the roster.\n", org, classroom)
			return nil
		}
		return err
	}
	_, _ = fmt.Fprintf(out, "%s: invited %s as direct_member (teams %s, %s)\n",
		org, email, classroomTeam.Slug, inviteTeam.Slug)

	var appended bool
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		appended = false
		current, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		// Re-check under the rebase: a concurrent writer (the web app, or a
		// sync) may have claimed the address since the pre-send read.
		if _, claimed := rosterEmailClaim(current, email); claimed {
			return configwrite.CommitChange{}, nil
		}
		appended = true
		return configrepo.RosterWriteChange(classroom, append(current, configrepo.RosterRow{
			FirstName: firstName,
			LastName:  lastName,
			Email:     email,
			Section:   section,
			Role:      invitedRosterRole,
		}))
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: add invited email to %s (gh teacher roster invite)", classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		// Never a rollback: the invitation is the source of truth and the
		// metadata team retains the address, so `roster sync` heals the row.
		// Still non-zero, so a script sees the partial state.
		_, _ = fmt.Fprintf(errOut, "Warning: the invitation to %s was sent, but recording it in %s failed; run `gh teacher roster sync %s %s` to add the pending row (the invitation itself is unaffected).\n",
			email, configrepo.RosterFilePath(classroom), org, classroom)
		return fmt.Errorf("invitation sent, but the roster row was not written: %w", err)
	}
	if !appended {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: %s already listed, roster unchanged\n",
			org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), email)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: added pending row for %s\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), email)
	_, _ = fmt.Fprintf(errOut, "Advise %s to accept the emailed invitation, then run `gh teacher roster sync %s %s` to record their username and github_id.\n",
		email, org, classroom)
	return nil
}

// rosterEmailClaim reports whether ANY row already holds this address, and the
// username holding it ("" for a pending email-only row). Both block a send: a
// second invitation would either duplicate the pending row or invite someone
// already enrolled. Mirrors the `claimed` set the web's appendEmailInviteRows
// builds, which skips a claimed address for the same reason.
func rosterEmailClaim(rows []configrepo.RosterRow, email string) (holder string, claimed bool) {
	key := configrepo.NormalizeInviteEmail(email)
	if key == "" {
		return "", false
	}
	for _, row := range rows {
		if configrepo.NormalizeInviteEmail(row.Email) == key {
			return row.Username, true
		}
	}
	return "", false
}
