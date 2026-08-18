package roster

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func rosterInviteCmd() *cobra.Command {
	var (
		firstName string
		lastName  string
		section   string
		file      string
	)

	cmd := &cobra.Command{
		Use:   "invite <org> <classroom> [email]",
		Short: "Invite one student (or a whole list with --file) by email address",
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
			"Bulk mode: pass --file <path> instead of an email to invite a whole\n" +
			"list. The file is plaintext, one address per line; blank lines and\n" +
			"lines starting with `#` are ignored. Every address is validated first,\n" +
			"and if any line is unusable nothing is sent. Successful invitations are\n" +
			"retained as pending rows in one commit. --file carries no names or\n" +
			"sections (fill those later with `roster import` or `roster sync`), so\n" +
			"the --first-name/--last-name/--section flags are rejected with it.\n" +
			"Each address is reported as it resolves, then a summary counts them.\n\n" +
			"Bulk exit codes follow `roster sync`: 0 every address was invited or\n" +
			"cleanly skipped, 2 nothing failed but a GitHub rate limit left\n" +
			"addresses uninvited (re-run to continue — already-invited addresses are\n" +
			"skipped), 1 an address genuinely failed or the roster write failed.\n\n" +
			"Returns non-zero on: classroom missing a GitHub team, an address the\n" +
			"roster already lists as invited, or a failed invitation. An address\n" +
			"that already belongs to a member (or already has a pending\n" +
			"invitation) is reported as skipped and exits 0. An address some other\n" +
			"row already carries is still invited, but gets no second row.",
		Example: "  gh teacher roster invite cs50-fall-2026 cs-principles ada@example.edu\n" +
			"  gh teacher roster invite cs50-fall-2026 cs-principles ada@example.edu --first-name Ada --last-name Lovelace --section section-1\n" +
			"  gh teacher roster invite cs50-fall-2026 cs-principles --file ./section-1-emails.txt",
		Args: func(cmd *cobra.Command, args []string) error {
			// --file replaces the positional email: <org> <classroom> only.
			// Without it, the classic <org> <classroom> <email> triple stands.
			if strings.TrimSpace(file) != "" {
				if len(args) != 2 {
					return errors.New("with --file, pass only <org> <classroom> (the addresses come from the file, not the command line)")
				}
				// A per-student flag can't apply to a whole list, and silently
				// dropping it would lose metadata the teacher believes they set.
				var ignored []string
				for _, name := range []string{"first-name", "last-name", "section"} {
					if cmd.Flags().Changed(name) {
						ignored = append(ignored, "--"+name)
					}
				}
				if len(ignored) > 0 {
					return fmt.Errorf("%s applies to a single invite, not --file (a list carries no per-student metadata); invite the list, then fill names and sections in with `gh teacher roster import`",
						strings.Join(ignored, " and "))
				}
				return nil
			}
			if len(args) != 3 {
				return errors.New("pass <org> <classroom> <email>, or <org> <classroom> --file <path> to invite a list")
			}
			return nil
		},
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
			// Validate the input BEFORE any auth or network so a typo or an
			// unreadable file can never reach GitHub.
			path := strings.TrimSpace(file)
			var email string
			if path == "" {
				canonical, err := configrepo.CanonicalRosterEmail(strings.TrimSpace(args[2]))
				if err != nil {
					return err
				}
				if canonical == "" {
					return errors.New("email must be non-empty")
				}
				email = canonical
			}
			var data []byte
			if path != "" {
				var err error
				if _, data, err = readTeacherFile(path, "--file path"); err != nil {
					return err
				}
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			if path != "" {
				return runRosterInviteFile(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, data)
			}
			return runRosterInvite(client, cmd.OutOrStdout(), cmd.ErrOrStderr(),
				org, classroom, email,
				strings.TrimSpace(firstName), strings.TrimSpace(lastName), strings.TrimSpace(section))
		},
	}
	cmd.Flags().StringVar(&firstName, "first-name", "", "Student's first name (single invite only; written into the first_name column)")
	cmd.Flags().StringVar(&lastName, "last-name", "", "Student's last name (single invite only; written into the last_name column)")
	cmd.Flags().StringVar(&section, "section", "", "Section identifier (single invite only; free-form text, written into the section column)")
	cmd.Flags().StringVar(&file, "file", "", "Path to a plaintext list of email addresses (one per line; # comments and blank lines ignored) to invite in bulk")
	return cmd
}

// readTeacherFile reads a local file a teacher passed on the command line,
// returning the resolved absolute path alongside the bytes so callers name the
// file they actually opened. `what` labels the argument in a resolve error
// (e.g. "--file path", "import path").
func readTeacherFile(path, what string) (string, []byte, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", nil, fmt.Errorf("resolve %s: %w", what, err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", nil, fmt.Errorf("read %s: %w", abs, err)
	}
	return abs, data, nil
}

// errClassroomTeamUnusable refuses a send when classroom.json records no usable
// team. A team-less email invitation is broken, not degraded: the invitee
// accepts into the org attached to nothing and, with no username to key on,
// nothing later notices. A recorded team missing its numeric id is just as
// unusable, since the invitation carries team ids rather than slugs. Shared so
// the single and bulk paths refuse identically.
func errClassroomTeamUnusable(org, classroom string) error {
	return fmt.Errorf("%s: classroom %s has no usable team recorded in classroom.json, so an invitation would enroll nobody — nothing was sent; run `gh teacher classroom add %s %s` to create the team, then retry",
		org, classroom, org, classroom)
}

// emailInviteOutcome classifies what sendOneEmailInvite did with one address,
// so both the single and bulk callers can react without re-reading the API
// result. Exactly one is returned per address.
type emailInviteOutcome int

const (
	// The zero value is deliberately unnamed and unused: an unset outcome must
	// not read as success, since the callers' success arm appends a roster row
	// for an address that may never have been invited. Both switches carry a
	// default arm that rejects it.
	_ emailInviteOutcome = iota
	// outcomeInvited: a fresh invitation was sent; the caller should append a
	// pending row for the address.
	outcomeInvited
	// outcomeSkippedAlready: GitHub's 422 — already a member or already invited.
	// No row; a team this run created has already been torn down.
	outcomeSkippedAlready
	// outcomePendingBlocked: the stored roster already lists this address as a
	// pending email invite, so nothing was sent (no API call was made).
	outcomePendingBlocked
	// outcomeRateLimited: a secondary rate limit; the bulk caller stops issuing
	// new sends and the single caller surfaces the error.
	outcomeRateLimited
	// outcomeFailed: a hard send or team-prep failure; err is set.
	outcomeFailed
)

// sendOneEmailInvite runs the per-address invite sequence shared by the single
// `roster invite` and the bulk `--file` path: pre-check the stored roster,
// ensure the per-invite metadata team, send the org invitation carrying the
// classroom and invite team ids, and classify the result. It never writes
// roster.csv — the caller owns the commit — so a bulk run can append every
// invited address in one batched commit.
//
// The order is load-bearing (mirrors the web's bulkInviteByEmail inviteOne):
// every read that could refuse the send happens before the first write, and the
// invite team's record is written before the invitation exists, so an accepted
// invitation always has an address to recover.
func sendOneEmailInvite(client githubapi.Client, errOut io.Writer, org, classroom, email string, classroomTeam configrepo.TeamRef, actor string, rows []configrepo.RosterRow) (emailInviteOutcome, configrepo.TeamRef, error) {
	holder, pending := rosterEmailClaim(rows, email)
	if pending {
		return outcomePendingBlocked, configrepo.TeamRef{}, nil
	}
	if holder != "" {
		_, _ = fmt.Fprintf(errOut, "Note: %s already appears on the %s roster on %s's row. An address can be shared (a parent or a lab contact), so the invitation is still being sent — but no second row is written for it, matching the web app. If that row is the same person, cancel this invite and run `gh teacher roster update %s %s %s` instead.\n",
			email, classroom, holder, org, classroom, holder)
	}

	// EnsureInviteTeam mutates (team create, membership drop, description
	// PATCH), so it can hit the same secondary limit the invitation can. It must
	// classify as rate-limited too, or a throttled bulk run keeps hammering the
	// team endpoints instead of deferring the rest. No teardown either way: the
	// record is written last, so anything stranded holds no address and the next
	// invite to this address adopts and heals it.
	inviteTeam, created, err := configrepo.EnsureInviteTeam(client, org, classroom, email, actor)
	if err != nil {
		if cliutil.IsRateLimited(err) {
			return outcomeRateLimited, configrepo.TeamRef{}, err
		}
		return outcomeFailed, configrepo.TeamRef{}, err
	}

	if err := membership.InviteOrgByEmail(client, org, email, []int64{classroomTeam.ID, inviteTeam.ID}); err != nil {
		// A doomed invitation must not leave a fresh, member-less metadata team
		// behind for the GC to reap — but an ADOPTED team may hold an earlier
		// invite's still-unrecovered record, so only delete what this run made.
		// A rate limit is not doomed: the team stays so a retry adopts it rather
		// than re-creating one against the same limit (as the web does).
		if created && !cliutil.IsRateLimited(err) {
			if delErr := configrepo.DeleteInviteTeam(client, org, inviteTeam.Slug); delErr != nil {
				warnStrandedInviteTeam(errOut, "nothing was invited, but cleaning up", org, inviteTeam.Slug, delErr)
			}
		}
		if cliutil.IsRateLimited(err) {
			return outcomeRateLimited, configrepo.TeamRef{}, err
		}
		if errors.Is(err, membership.ErrEmailAlreadyInvitedOrMember) {
			return outcomeSkippedAlready, configrepo.TeamRef{}, nil
		}
		return outcomeFailed, configrepo.TeamRef{}, err
	}
	return outcomeInvited, inviteTeam, nil
}

// runRosterInvite sends one email invitation, then records its pending row. The
// per-address work lives in sendOneEmailInvite, shared with the bulk `--file`
// path; the roster row is appended only once the invitation is real.
func runRosterInvite(client githubapi.Client, out, errOut io.Writer, org, classroom, email, firstName, lastName, section string) error {
	email = configrepo.NormalizeInviteEmail(email)

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
	// Refuse here rather than off outcomePendingBlocked so this path's error can
	// name the sync/cancel-invite remedies; the helper's own check stays
	// authoritative for the bulk path.
	if _, pending := rosterEmailClaim(rows, email); pending {
		return fmt.Errorf("%s is already invited to %s — run `gh teacher roster sync %s %s` if they accepted, or `gh teacher roster cancel-invite %s %s %s` to revoke it; nothing was sent",
			email, classroom, org, classroom, org, classroom, email)
	}

	// EnsureInviteTeam drops the creator GitHub silently adds, so it needs to
	// know who that is.
	actor, _, err := githubapi.CurrentUser(client)
	if err != nil {
		return fmt.Errorf("resolving your GitHub login (needed to keep the invite team free of teachers): %w", err)
	}

	outcome, inviteTeam, sendErr := sendOneEmailInvite(client, errOut, org, classroom, email, classroomTeam, actor, rows)
	switch outcome {
	case outcomeInvited:
		_, _ = fmt.Fprintf(out, "%s: invited %s as direct_member (teams %s, %s)\n",
			org, email, classroomTeam.Slug, inviteTeam.Slug)
	case outcomeSkippedAlready:
		_, _ = fmt.Fprintf(out, "%s: skipped %s — already a member of the org or already invited\n", org, email)
		_, _ = fmt.Fprintf(errOut, "If they accepted an earlier invitation, run `gh teacher roster sync %s %s` to record them on the roster.\n", org, classroom)
		return nil
	case outcomeRateLimited, outcomeFailed:
		return sendErr
	default:
		// Includes outcomePendingBlocked, which the pre-check above already
		// refused with a better message, and the unset zero value.
		return fmt.Errorf("internal error: unhandled invite outcome %d for %s (nothing was recorded)", outcome, email)
	}

	var appended bool
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		appended = false
		current, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		// Re-check under the rebase: a concurrent writer (the web app, or a
		// sync) may have taken the address since the pre-send read. ANY row
		// carrying it blocks the append, matching appendEmailInviteRows' claimed
		// set — a second row for one address is a duplicate the reconcile then
		// has to reason about, and `roster sync` fills the identity in either
		// case.
		if rosterHoldsEmail(current, email) {
			return configwrite.CommitChange{}, nil
		}
		appended = true
		return configrepo.RosterWriteChange(classroom, append(current, configrepo.RosterRow{
			FirstName: firstName,
			LastName:  lastName,
			Email:     email,
			Section:   section,
			Role:      rosterRoleStudent,
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
		_, _ = fmt.Fprintf(out, "%s/%s/%s: %s is already on a row, roster unchanged (no second pending row)\n",
			org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), email)
		_, _ = fmt.Fprintf(errOut, "Advise %s to accept the emailed invitation, then run `gh teacher roster sync %s %s` to record their username and github_id on the row that carries the address.\n",
			email, org, classroom)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: added pending row for %s\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), email)
	_, _ = fmt.Fprintf(errOut, "Advise %s to accept the emailed invitation, then run `gh teacher roster sync %s %s` to record their username and github_id.\n",
		email, org, classroom)
	return nil
}

// rosterEmailClaim reports how the stored roster already holds this address:
// `pending` for an identity-less email-invite row (a second invitation would
// duplicate it, and RosterRow.IsPendingEmailInvite is the shared rule the write
// helpers apply), and `holder` for the username of a row that merely carries the
// address. Only `pending` may block a SEND: the web is explicit that a claimed
// address does NOT filter the send list, since an address can belong to someone
// else's row — a shared family address or a lab contact — and that real person
// still needs inviting (see UploadRoster's claimedEmails). The ROW is a separate
// question, answered by rosterHoldsEmail.
func rosterEmailClaim(rows []configrepo.RosterRow, email string) (holder string, pending bool) {
	key := configrepo.NormalizeInviteEmail(email)
	if key == "" {
		return "", false
	}
	for _, row := range rows {
		if configrepo.NormalizeInviteEmail(row.Email) != key {
			continue
		}
		if row.IsPendingEmailInvite() {
			return "", true
		}
		if holder == "" {
			holder = row.Username
		}
	}
	return holder, false
}

// rosterHoldsEmail reports whether ANY row already carries the address, whatever
// it identifies — the web's appendEmailInviteRows `claimed` set, which is what
// stops a send to a shared address from writing a second row for it.
func rosterHoldsEmail(rows []configrepo.RosterRow, email string) bool {
	key := configrepo.NormalizeInviteEmail(email)
	if key == "" {
		return false
	}
	for _, row := range rows {
		if configrepo.NormalizeInviteEmail(row.Email) == key {
			return true
		}
	}
	return false
}
