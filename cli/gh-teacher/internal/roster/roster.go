// Package roster implements the `gh teacher roster` command: managing the
// classroom roster in <org>/classroom50/<classroom>/roster.csv (list, add,
// invite, cancel-invite, sync, update, remove, import), including resolving each
// student's GitHub id and inviting them to the org. Only NewCmd is exported.
package roster

import (
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "roster",
		Short: "Manage the classroom roster (roster.csv)",
		Long: "Manage student rows in <org>/classroom50/<classroom>/roster.csv.\n\n" +
			"Subcommands:\n" +
			"  list     print the roster (table, --json, or --quiet username-only)\n" +
			"  add      append or upsert one student (resolves github_id, invites to org)\n" +
			"  invite   invite one student by email address, or a whole list with --file (no GitHub account needed yet)\n" +
			"  cancel-invite  revoke a pending email invitation and clear what it left behind\n" +
			"  sync     sync the roster with GitHub (dry run; --write applies)\n" +
			"  update   correct fields on an existing student (roster-only; never invites)\n" +
			"  remove   remove one student from the roster (does NOT touch org membership)\n" +
			"  import   bulk upsert from a local CSV (the stored 7-column roster.csv, or 6/5-column forms)\n\n" +
			"All writes use a single commit on <org>/classroom50's\n" +
			"default branch and retry with an optimistic rebase loop\n" +
			"(up to 5 attempts) so concurrent edits don't silently lose\n" +
			"each other's work. Each row that names an account stores the\n" +
			"student's immutable numeric github_id (resolved from\n" +
			"GET /users/{username} on add/import, or from the classroom team\n" +
			"on sync), so a username change mid-class doesn't desynchronize\n" +
			"records. A row awaiting an email invitation carries only the\n" +
			"address until a sync records the account.",
	}
	cmd.AddCommand(rosterListCmd())
	cmd.AddCommand(rosterAddCmd())
	cmd.AddCommand(rosterInviteCmd())
	cmd.AddCommand(rosterCancelInviteCmd())
	cmd.AddCommand(rosterSyncCmd())
	cmd.AddCommand(rosterUpdateCmd())
	cmd.AddCommand(rosterRemoveCmd())
	cmd.AddCommand(rosterImportCmd())
	return cmd
}

func rosterAddCmd() *cobra.Command {
	var (
		firstName string
		lastName  string
		email     string
		section   string
	)

	cmd := &cobra.Command{
		Use:   "add <org> <classroom> <username>",
		Short: "Append or upsert one student in roster.csv",
		Long: "Append a student to <org>/classroom50/<classroom>/roster.csv,\n" +
			"or update the existing row if their username already appears\n" +
			"(case-insensitive match). The student's GitHub-assigned\n" +
			"numeric ID is resolved at write time and stored in the\n" +
			"`github_id` column, defending against mid-class username\n" +
			"changes.\n\n" +
			"If no username matches and --email is given, an existing row\n" +
			"holding only that address is completed in place instead of a\n" +
			"second row being added: that is the pending row an email\n" +
			"invitation created, from `gh teacher roster invite` or the\n" +
			"web app. Only a row with no username and no github_id can be\n" +
			"completed this way, and it does not carry over that row's\n" +
			"recorded role.\n\n" +
			"After the roster write lands, if the student isn't already a\n" +
			"member of <org> (and doesn't already have a pending invite),\n" +
			"this command sends an org invitation (same path `gh teacher\n" +
			"invite` uses).\n\n" +
			"Adding a user who is already a teacher/TA on this classroom is\n" +
			"not disallowed: they become an enrolled student too and show\n" +
			"both roles in the app. The roster's `role` column records only\n" +
			"their highest role (teacher, say), so a later sync rewriting it\n" +
			"doesn't change the student enrollment.\n\n" +
			"Returns non-zero on: classroom directory missing, roster\n" +
			"missing or malformed, GitHub user not found, or after 5\n" +
			"failed rebase attempts against a concurrently-edited\n" +
			"roster.",
		Example: "  gh teacher roster add cs50-fall-2026 cs-principles alice --first-name Alice --last-name Andersson --email alice@example.edu --section section-1\n" +
			"  gh teacher roster add cs50-fall-2026 cs-principles bob",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			username := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || username == "" {
				return errors.New("org, classroom, and username must all be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			emailVal, err := configrepo.CanonicalRosterEmail(strings.TrimSpace(email))
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runRosterAdd(client, cmd.OutOrStdout(), cmd.ErrOrStderr(),
				org, classroom, username,
				strings.TrimSpace(firstName), strings.TrimSpace(lastName),
				emailVal, strings.TrimSpace(section))
		},
	}
	cmd.Flags().StringVar(&firstName, "first-name", "", "Student's first name (written into the first_name column)")
	cmd.Flags().StringVar(&lastName, "last-name", "", "Student's last name (written into the last_name column)")
	cmd.Flags().StringVar(&email, "email", "", "Student's email address (written into the email column; bare local@domain form like alice@example.edu; optional)")
	cmd.Flags().StringVar(&section, "section", "", "Section identifier (free-form text, written into the section column)")
	return cmd
}

func rosterUpdateCmd() *cobra.Command {
	var (
		firstName string
		lastName  string
		email     string
		section   string
	)

	cmd := &cobra.Command{
		Use:   "update <org> <classroom> <username>",
		Short: "Correct one student's details in roster.csv",
		Long: "Update fields on an existing row in\n" +
			"<org>/classroom50/<classroom>/roster.csv, matched by\n" +
			"<username> (case-insensitive).\n\n" +
			"Only the flags you pass are changed; every other column,\n" +
			"including the immutable github_id, is left untouched. This is\n" +
			"the key difference from `roster add`, which rewrites the whole\n" +
			"row and blanks any field you don't re-supply.\n\n" +
			"Roster-only: unlike `roster add`, this never sends an org invite\n" +
			"and never re-resolves github_id. Pass --email \"\" to clear an\n" +
			"address.\n\n" +
			"Errors if <username> isn't already on the roster (add them with\n" +
			"`gh teacher roster add` first). At least one of --first-name,\n" +
			"--last-name, --email, or --section is required.",
		Example: "  gh teacher roster update cs50-fall-2026 cs-principles alice --email alice@example.edu\n" +
			"  gh teacher roster update cs50-fall-2026 cs-principles alice --first-name Alice --section section-2",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			username := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || username == "" {
				return errors.New("org, classroom, and username must all be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}

			// Only flags actually passed (Changed) join the patch; an
			// unset flag leaves its column alone.
			var patch configrepo.RosterPatch
			if cmd.Flags().Changed("first-name") {
				v := strings.TrimSpace(firstName)
				patch.FirstName = &v
			}
			if cmd.Flags().Changed("last-name") {
				v := strings.TrimSpace(lastName)
				patch.LastName = &v
			}
			if cmd.Flags().Changed("email") {
				v, err := configrepo.CanonicalRosterEmail(strings.TrimSpace(email))
				if err != nil {
					return err
				}
				patch.Email = &v
			}
			if cmd.Flags().Changed("section") {
				v := strings.TrimSpace(section)
				patch.Section = &v
			}
			if patch.FirstName == nil && patch.LastName == nil && patch.Email == nil && patch.Section == nil {
				return errors.New("nothing to update: pass --first-name, --last-name, --email, and/or --section")
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runRosterUpdate(client, cmd.OutOrStdout(), org, classroom, username, patch)
		},
	}
	cmd.Flags().StringVar(&firstName, "first-name", "", "New first name (first_name column)")
	cmd.Flags().StringVar(&lastName, "last-name", "", "New last name (last_name column)")
	cmd.Flags().StringVar(&email, "email", "", "New email address (email column; bare local@domain form; pass \"\" to clear)")
	cmd.Flags().StringVar(&section, "section", "", "New section identifier (section column)")
	return cmd
}

func rosterRemoveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remove <org> <classroom> <username>",
		Short: "Remove one student from roster.csv",
		Long: "Drop the row whose username matches <username> (case-insensitive)\n" +
			"from <org>/classroom50/<classroom>/roster.csv.\n\n" +
			"Does not remove the student from the org. Use\n" +
			"`gh teacher remove <org> <username>` for that: it's a\n" +
			"deliberate two-step process so an off-by-one roster edit\n" +
			"can't accidentally revoke a student's access to every repo\n" +
			"in the org.\n\n" +
			"Idempotent: if the row is absent, exits 0 with a note.",
		Example: "  gh teacher roster remove cs50-fall-2026 cs-principles alice",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			username := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || username == "" {
				return errors.New("org, classroom, and username must all be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runRosterRemove(client, cmd.OutOrStdout(), org, classroom, username)
		},
	}
	return cmd
}

func rosterImportCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "import <org> <classroom> <path-to-csv>",
		Short: "Bulk upsert roster.csv from a local CSV",
		Long: "Read <path-to-csv> and upsert every row into\n" +
			"<org>/classroom50/<classroom>/roster.csv. The header may be\n" +
			"the stored roster shape\n" +
			"`username,first_name,last_name,email,section,github_id,role`,\n" +
			"the same without `role`, or just the first five columns, so\n" +
			"a roster.csv exported from the web app imports as-is. The\n" +
			"`email` column may be empty per row.\n\n" +
			"github_id is re-resolved from `GET /users/{username}` so the\n" +
			"on-disk roster always carries the GitHub-authoritative ID; a\n" +
			"github_id cell that names a different account than the\n" +
			"username fails that line. `role` is carried, never applied:\n" +
			"import grants no role beyond the student invite below, and an\n" +
			"already-recorded role is never overwritten.\n\n" +
			"A row with only an email is a pending email invitation: it\n" +
			"updates that invitation's stored name/section and nothing\n" +
			"else; import never sends or cancels an invitation. A row with\n" +
			"a github_id but no username is skipped with a notice.\n\n" +
			"Every unusable line is reported in one pass and nothing is\n" +
			"committed. The whole file is written in one Tree commit, not\n" +
			"one PUT per row, so partial-import states can't appear on the\n" +
			"repo. After the commit lands, any student who isn't already in\n" +
			"the org (and doesn't have a pending invite) is invited.",
		Example: "  gh teacher roster import cs50-fall-2026 cs-principles ./section-1.csv",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			path := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || path == "" {
				return errors.New("org, classroom, and path must all be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runRosterImport(client, cmd.OutOrStdout(), cmd.ErrOrStderr(),
				org, classroom, path)
		},
	}
	return cmd
}

// parseEmailArgs validates the `<org> <classroom> <email>` shape
// `roster cancel-invite` uses, BEFORE any auth or network happens so a typo can
// never reach GitHub. The returned email is canonical: cancel-invite recomputes
// the invite-team hash from it, and a raw `<a@b.edu>` would hash to a team that
// does not exist. (`roster invite` validates inline because its email arg is
// optional when --file is given.)
func parseEmailArgs(args []string) (org, classroom, email string, err error) {
	org = strings.TrimSpace(args[0])
	classroom = strings.TrimSpace(args[1])
	email = strings.TrimSpace(args[2])
	if org == "" || classroom == "" || email == "" {
		return "", "", "", errors.New("org, classroom, and email must all be non-empty")
	}
	if err := validate.ShortName(classroom, "classroom"); err != nil {
		return "", "", "", err
	}
	canonical, err := configrepo.CanonicalRosterEmail(email)
	if err != nil {
		return "", "", "", err
	}
	return org, classroom, canonical, nil
}

// warnStrandedInviteTeam reports a metadata team a teardown couldn't remove.
// Always a warning, never a failure: the action it followed has already landed,
// so a stranded team must not read as that action failing — `roster sync`'s GC
// is the backstop.
func warnStrandedInviteTeam(errOut io.Writer, lead, org, slug string, err error) {
	_, _ = fmt.Fprintf(errOut, "Warning: %s: %s the metadata team %s failed (%v); delete it by hand or let `gh teacher roster sync` collect it.\n",
		org, lead, slug, err)
}

// inviteIfNotMember invites <username> when not already active/pending, and
// returns the membership state at decision time. The pre-resolved userID avoids
// redundant lookups during a bulk import. A 422 "already member/pending" is
// recovered as success so a TOCTOU race can't surface a spurious failure.
func inviteIfNotMember(client githubapi.Client, org, username string, userID int64) (state string, err error) {
	if s, ok := membership.MembershipState(client, org, username); ok {
		switch s {
		case "active":
			return "active", nil
		case "pending":
			return "pending", nil
		}
	}
	if err := membership.InviteOrgByID(client, org, username, userID, "direct_member"); err != nil {
		var known *membership.OrgMembershipKnownError
		if errors.As(err, &known) {
			return known.State, nil
		}
		return "", err
	}
	return "invited", nil
}

// runRosterAdd commits the roster row first, then invites. Committing first
// leaves the roster ahead of org membership (a re-run reconciles), which is
// safer than an invite landing before a failed commit.
func runRosterAdd(client githubapi.Client, out, errOut io.Writer, org, classroom, username, firstName, lastName, email, section string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	login, userID, err := membership.LookupUser(client, username)
	if err != nil {
		return err
	}

	newRow := configrepo.RosterRow{
		Username:  login,
		FirstName: firstName,
		LastName:  lastName,
		Email:     email,
		Section:   section,
		GitHubID:  userID,
	}

	var action string
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		rows, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		updated, replaced := configrepo.UpsertRosterRow(rows, newRow)
		if replaced {
			action = "updated"
		} else {
			action = "added"
		}
		return configrepo.RosterWriteChange(classroom, updated)
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: add %s to %s (gh teacher roster add)", login, classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	_, _ = fmt.Fprintf(out, "%s/%s/%s: %s %s (github_id %d)\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), action, login, userID)

	state, err := inviteIfNotMember(client, org, login, userID)
	if err != nil {
		return fmt.Errorf("roster row committed, but org invite failed: %w", err)
	}
	switch state {
	case "active":
		_, _ = fmt.Fprintf(out, "%s: %s already a member of the org\n", org, login)
	case "pending":
		_, _ = fmt.Fprintf(out, "%s: %s already has a pending invitation\n", org, login)
	case "invited":
		_, _ = fmt.Fprintf(out, "%s: invited %s as direct_member\n", org, login)
		_, _ = fmt.Fprintf(errOut, "Advise %s to sign in to https://github.com as %s, then visit https://github.com/%s to accept the invitation.\n", login, login, org)
	}

	// Add the student to the classroom team so they inherit read on private
	// org-owned templates. The PUT covers both an active member (immediate) and
	// a not-yet-member (pending). Idempotent. Slug from classroom.json.
	team, ok, err := configrepo.ResolveClassroomTeam(client, org, classroom, branch)
	if err != nil {
		return fmt.Errorf("roster row committed and org invite sent, but reading the classroom team failed: %w", err)
	}
	if !ok {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: classroom %s has no team recorded in classroom.json; skipped adding %s to it. Re-run `gh teacher classroom add %s %s` to create the team, then `gh teacher roster add` again.\n",
			org, classroom, login, org, classroom)
		return nil
	}
	if err := configrepo.AddTeamMembership(client, org, team.Slug, login); err != nil {
		return fmt.Errorf("roster row committed and org invite sent, but adding %s to the classroom team failed: %w", login, err)
	}
	_, _ = fmt.Fprintf(out, "%s: added %s to classroom team %s\n", org, login, team.Slug)

	// Dual-role note: best-effort and advisory (a read failure here is swallowed
	// — the add already landed). See staffRoleForLogin for the rationale.
	if staffRole, ok := staffRoleForLogin(client, org, classroom, branch, login); ok {
		_, _ = fmt.Fprintf(errOut,
			"Note: %s is also a %s on classroom %s. Dual roles aren't disallowed: they'll show both roles in the app and stay an enrolled student, but the automatic sync records their highest role (%s) in the roster's `role` column. That doesn't change the student enrollment.\n",
			login, staffRole, classroom, staffRole)
	}
	return nil
}

// staffRoleForLogin reports the highest-precedence staff role (teacher > hta >
// ta) the login already holds on this classroom, or ("", false) when they're on
// no staff team (or the check can't be completed). Best-effort and never
// fatal: it reads classroom.json ONCE for the persisted staff-team slugs and
// membership-checks each. A missing classroom/team block, an unresolved slug,
// or any read error yields ("", false) so the caller silently skips the
// advisory note rather than failing an add that already succeeded.
func staffRoleForLogin(client githubapi.Client, org, classroom, branch, login string) (configrepo.StaffRole, bool) {
	key := loginKey(login)
	if key == "" {
		return "", false
	}
	c, ok, err := configrepo.LoadClassroom(client, org, classroom, branch)
	if err != nil || !ok {
		return "", false
	}
	for _, role := range configrepo.StaffRoles {
		team := c.Teams.RefForRole(role)
		if team == nil || team.Slug == "" {
			continue
		}
		members, err := configrepo.ListTeamMembers(client, org, team.Slug)
		if err != nil {
			continue
		}
		for _, m := range members {
			if loginKey(m) == key {
				return role, true
			}
		}
	}
	return "", false
}

// runRosterUpdate edits an existing roster row only: it never invites or
// re-resolves github_id. A patch matching the current row is a no-op; an
// unknown username is an error (not a silent append).
func runRosterUpdate(client githubapi.Client, out io.Writer, org, classroom, username string, patch configrepo.RosterPatch) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	var noChange bool
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		noChange = false
		rows, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		next, found, changed := configrepo.UpdateRosterRow(rows, username, patch)
		if !found {
			return configwrite.CommitChange{}, fmt.Errorf("%s not in %s roster: add them with `gh teacher roster add %s %s %s` first",
				username, classroom, org, classroom, username)
		}
		if !changed {
			noChange = true // empty change → CommitTreeChange skips the commit.
			return configwrite.CommitChange{}, nil
		}
		return configrepo.RosterWriteChange(classroom, next)
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: update %s in %s (gh teacher roster update)", username, classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	if noChange {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: %s already up to date (no changes)\n",
			org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), username)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: updated %s\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), username)
	return nil
}

func runRosterRemove(client githubapi.Client, out io.Writer, org, classroom, username string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	var removed bool
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		rows, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		next, ok := configrepo.RemoveRosterRow(rows, username)
		removed = ok
		if !ok {
			return configwrite.CommitChange{}, nil // empty → skips the commit (already absent)
		}
		return configrepo.RosterWriteChange(classroom, next)
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: remove %s from %s (gh teacher roster remove)", username, classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	if removed {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: removed %s (org membership unchanged)\n",
			org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), username)
		// Symmetric with roster add: drop the student from the classroom team
		// so they lose template read. Idempotent (404 = not a member/gone).
		// Org membership untouched. Slug from classroom.json.
		team, ok, err := configrepo.ResolveClassroomTeam(client, org, classroom, branch)
		if err != nil {
			return fmt.Errorf("roster row removed, but reading the classroom team failed: %w", err)
		}
		if ok {
			if err := configrepo.RemoveTeamMembership(client, org, team.Slug, username); err != nil {
				return fmt.Errorf("roster row removed, but removing %s from the classroom team failed: %w", username, err)
			}
			_, _ = fmt.Fprintf(out, "%s: removed %s from classroom team %s\n", org, username, team.Slug)
		}
		// Org removal is a separate, deliberate step (no cascade).
		_, _ = fmt.Fprintf(out, "  to also remove %s from the org: gh teacher remove %s %s\n",
			username, org, username)
	} else {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: %s not in roster, nothing to do\n",
			org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), username)
	}
	return nil
}

// importedPendingRow is an email-only import row: metadata for a pending
// invite row an invitation already created, matched by address. line is kept so
// a no-match notice names the file line the teacher would edit.
type importedPendingRow struct {
	line int
	row  configrepo.RosterRow
}

// planRosterImport resolves every account row up front so rebase retries don't
// repeat API lookups — only the file write is retried. It routes each row to
// the one thing import may do with it, and collects ALL line failures on top of
// parseFailures so the teacher sees every unusable line before the refusal
// (nothing is committed). Line numbers come from RosterRow.Line, not the slice
// index, since a file with a bad line has no row for it.
func planRosterImport(client githubapi.Client, imported []configrepo.RosterRow, parseFailures []error) (accounts []configrepo.RosterRow, pending []importedPendingRow, cargoNotices []string, err error) {
	// Parse-level failures lead: those lines never reached resolution, so there
	// is no line number to interleave them by. Cloned because the caller's slice
	// is the joined error's own.
	failures := slices.Clone(parseFailures)
	for _, row := range imported {
		line := row.Line
		switch {
		case row.Username != "":
			login, userID, err := membership.LookupUser(client, row.Username)
			if err != nil {
				failures = append(failures, fmt.Errorf("line %d (%s): %w", line, row.Username, err))
				continue
			}
			// Username-primary resolution with a fail-closed cross-check: a row
			// naming an account AND a different id addresses two students, so
			// guessing which one the teacher meant is worse than refusing.
			if row.GitHubID != 0 && row.GitHubID != userID {
				failures = append(failures, fmt.Errorf("line %d (%s): github_id %d in the file is not this account's id (%s is github_id %d); fix the username or clear the github_id cell",
					line, row.Username, row.GitHubID, login, userID))
				continue
			}
			accounts = append(accounts, configrepo.RosterRow{
				Username:  login,
				FirstName: row.FirstName,
				LastName:  row.LastName,
				Email:     row.Email,
				Section:   row.Section,
				GitHubID:  userID,
				// Role stays empty on purpose: an imported role is cargo, never a
				// grant, so the stored role (preserved by UpsertRosterRow for an
				// empty incoming Role) or the next sync decides it.
			})
		case row.GitHubID != 0:
			// Round-trip cargo: import resolves students by username and has no
			// id→account lookup, so acting on an id alone would guess. Skipping
			// leaves any stored row for that id exactly as it is.
			cargoNotices = append(cargoNotices, fmt.Sprintf("line %d: row has a github_id but no username, so it was skipped. `roster import` resolves students by username; import id-keyed rows with the web app's roster Upload instead. Any stored row for that id is untouched.", line))
		case row.Email != "":
			pending = append(pending, importedPendingRow{line: line, row: row})
		default:
			// ParseImportCSV enforces one identity column, so this is a row whose
			// only identity is an unusable github_id cell — cargo as well.
			cargoNotices = append(cargoNotices, fmt.Sprintf("line %d: row has no username and no usable github_id, so it was skipped; nothing stored was changed.", line))
		}
	}
	if len(failures) > 0 {
		return nil, nil, nil, fmt.Errorf("%d row(s) can't be imported, so nothing was committed:\n%w", len(failures), errors.Join(failures...))
	}
	// Case-insensitive dedup within the batch; last occurrence wins.
	return configrepo.DedupeByUsername(accounts), dedupePendingByEmail(pending), cargoNotices, nil
}

// dedupePendingByEmail collapses repeated addresses (last wins, mirroring
// DedupeByUsername) so one stored row isn't patched twice from one file.
func dedupePendingByEmail(rows []importedPendingRow) []importedPendingRow {
	latest := make(map[string]importedPendingRow, len(rows))
	order := make([]string, 0, len(rows))
	for _, row := range rows {
		key := configrepo.NormalizeInviteEmail(row.row.Email)
		if _, seen := latest[key]; !seen {
			order = append(order, key)
		}
		latest[key] = row
	}
	out := make([]importedPendingRow, 0, len(order))
	for _, key := range order {
		out = append(out, latest[key])
	}
	return out
}

func runRosterImport(client githubapi.Client, out, errOut io.Writer, org, classroom, csvPath string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	abs, data, err := readTeacherFile(errOut, csvPath, "import path")
	if err != nil {
		return err
	}
	imported, parseErr := configrepo.ParseImportCSV(data)
	// A row-level parse failure must not short-circuit resolution: fixing the
	// one line it named would only reveal the next. The joined row errors seed
	// the plan's failure list instead, so both classes report in one pass. A
	// header/empty-file error is not per-row and has nothing to join.
	var parseFailures []error
	if parseErr != nil {
		var joined interface{ Unwrap() []error }
		if !errors.As(parseErr, &joined) {
			return fmt.Errorf("%s: %w", abs, parseErr)
		}
		parseFailures = joined.Unwrap()
	}
	if len(imported) == 0 && len(parseFailures) == 0 {
		return fmt.Errorf("%s: contains a header but no student rows", abs)
	}

	accounts, pending, cargoNotices, err := planRosterImport(client, imported, parseFailures)
	if err != nil {
		return fmt.Errorf("%s: %w", abs, err)
	}
	for _, notice := range cargoNotices {
		_, _ = fmt.Fprintf(errOut, "Notice: %s\n", notice)
	}

	var (
		added          int
		updated        int
		pendingUpdated int
		pendingMissing []string
	)
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		rows, err := configrepo.LoadRosterLenient(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		// Reset accumulators per attempt — rebase may split new/replaced (and
		// pending matches) differently.
		added, updated, pendingUpdated, pendingMissing = 0, 0, 0, nil
		for _, row := range accounts {
			var replaced bool
			rows, replaced = configrepo.UpsertRosterRow(rows, row)
			if replaced {
				updated++
			} else {
				added++
			}
		}
		for _, p := range pending {
			// Name/section come wholesale from the file, like an account row's;
			// the address and role stay as the invitation recorded them.
			var found bool
			rows, found = configrepo.UpdatePendingEmailRow(rows, p.row.Email, configrepo.RosterPatch{
				FirstName: &p.row.FirstName,
				LastName:  &p.row.LastName,
				Section:   &p.row.Section,
			})
			if found {
				pendingUpdated++
				continue
			}
			pendingMissing = append(pendingMissing, fmt.Sprintf("line %d (%s): no pending email-invite row with this address, so it was skipped; import never sends an invitation, so it can't create one.", p.line, p.row.Email))
		}
		// Reachable with a file of nothing but cargo and unmatched addresses:
		// the rows come back untouched, and committing their re-encoding lands a
		// real commit with an empty diff. Nothing applied → nothing to write.
		if added == 0 && updated == 0 && pendingUpdated == 0 {
			return configwrite.CommitChange{}, nil
		}
		return configrepo.RosterWriteChange(classroom, rows)
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: import %d row(s) into %s (gh teacher roster import)", len(accounts)+len(pending), classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	skipped := len(cargoNotices) + len(pendingMissing)
	_, _ = fmt.Fprintf(out, "%s/%s/%s: imported %d row(s) (%d new, %d updated, %d pending metadata updated, %d skipped)\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom),
		len(accounts)+len(pending), added, updated, pendingUpdated, skipped)
	for _, notice := range pendingMissing {
		_, _ = fmt.Fprintf(errOut, "Notice: %s\n", notice)
	}

	// Resolve the classroom team once (slug from classroom.json). No team →
	// warn-and-skip the membership step.
	team, teamOK, err := configrepo.ResolveClassroomTeam(client, org, classroom, branch)
	if err != nil {
		return fmt.Errorf("roster rows committed, but reading the classroom team failed: %w", err)
	}
	if !teamOK {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: classroom %s has no team recorded in classroom.json; skipped team membership for the imported students. Re-run `gh teacher classroom add %s %s`, then `gh teacher roster import` again.\n",
			org, classroom, org, classroom)
	}

	// Only account rows are onboarded: an email-only row's invitation was
	// already sent (import never sends one), and a cargo row names nobody.
	invited, alreadyActive, alreadyPending := 0, 0, 0
	var failures []string
	for _, row := range accounts {
		state, err := inviteIfNotMember(client, org, row.Username, row.GitHubID)
		if err != nil {
			// Warn-and-continue (not hard-fail): the commit already landed and
			// the per-student calls are idempotent, so a transient failure on
			// one student mustn't strand the rest.
			failures = append(failures, fmt.Sprintf("%s (invite: %v)", row.Username, err))
			continue
		}
		switch state {
		case "active":
			alreadyActive++
		case "pending":
			alreadyPending++
		case "invited":
			invited++
		}
		// Add each student to the classroom team (idempotent; active+pending).
		if teamOK {
			if err := configrepo.AddTeamMembership(client, org, team.Slug, row.Username); err != nil {
				failures = append(failures, fmt.Sprintf("%s (team add: %v)", row.Username, err))
				continue
			}
		}
	}
	teamNote := ""
	if teamOK {
		teamNote = fmt.Sprintf("; all added to classroom team %s", team.Slug)
	}
	_, _ = fmt.Fprintf(out, "%s: %d invited, %d already members, %d already pending%s\n",
		org, invited, alreadyActive, alreadyPending, teamNote)
	if len(failures) > 0 {
		_, _ = fmt.Fprintf(errOut, "Warning: %s: %d student(s) could not be fully onboarded (roster rows are committed; re-run `gh teacher roster import` to retry, it's idempotent): %s\n",
			org, len(failures), strings.Join(failures, "; "))
	}
	if invited > 0 {
		_, _ = fmt.Fprintf(errOut, "Newly-invited students should visit https://github.com/%s to accept their invitation.\n", org)
	}
	return nil
}
