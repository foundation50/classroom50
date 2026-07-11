// Package roster implements the `gh teacher roster` command: managing the
// classroom roster in <org>/classroom50/<classroom>/roster.csv (list, add,
// update, remove, import, migrate), including resolving each student's GitHub
// id and inviting them to the org. Only NewCmd is exported.
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
			"  update   correct fields on an existing student (roster-only; never invites)\n" +
			"  remove   remove one student from the roster (does NOT touch org membership)\n" +
			"  import   bulk upsert from a local CSV (5-column input accepted; github_id auto-filled)\n" +
			"  migrate  rename a legacy students.csv to roster.csv (one commit)\n\n" +
			"Reads fall back to that legacy name for classrooms\n" +
			"bootstrapped before the rename; writes always target roster.csv.\n\n" +
			"All writes use a single Tree commit on <org>/classroom50's\n" +
			"default branch and retry with an optimistic rebase loop\n" +
			"(up to 5 attempts) so concurrent edits don't silently lose\n" +
			"each other's work. Each row stores the student's immutable\n" +
			"numeric github_id (resolved via GET /users/{username}) so a\n" +
			"username change mid-class doesn't desynchronize records.",
	}
	cmd.AddCommand(rosterListCmd())
	cmd.AddCommand(rosterAddCmd())
	cmd.AddCommand(rosterUpdateCmd())
	cmd.AddCommand(rosterRemoveCmd())
	cmd.AddCommand(rosterImportCmd())
	cmd.AddCommand(rosterMigrateCmd())
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
			"After the roster write lands, if the student isn't already a\n" +
			"member of <org> (and doesn't already have a pending invite),\n" +
			"this command sends an org invitation (same path `gh teacher\n" +
			"invite` uses).\n\n" +
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
			emailVal := strings.TrimSpace(email)
			if err := configrepo.ValidateRosterEmail(emailVal); err != nil {
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
	cmd.Flags().StringVar(&email, "email", "", "Student's email address (written into the email column; bare local@domain form, e.g. alice@example.edu; optional)")
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
			"Only the flags you pass are changed; every other column —\n" +
			"including the immutable github_id — is left untouched. This is\n" +
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
				v := strings.TrimSpace(email)
				if err := configrepo.ValidateRosterEmail(v); err != nil {
					return err
				}
				patch.Email = &v
			}
			if cmd.Flags().Changed("section") {
				v := strings.TrimSpace(section)
				patch.Section = &v
			}
			if patch.FirstName == nil && patch.LastName == nil && patch.Email == nil && patch.Section == nil {
				return errors.New("nothing to update — pass --first-name, --last-name, --email, and/or --section")
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
			"Does NOT remove the student from the org. Use\n" +
			"`gh teacher remove <org> <username>` for that — it's a\n" +
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
			"<org>/classroom50/<classroom>/roster.csv. The local CSV\n" +
			"header must be `username,first_name,last_name,email,section`\n" +
			"(the canonical 5 columns). A trailing `github_id` column\n" +
			"is accepted but its value is ignored — the CLI re-resolves\n" +
			"github_id from `GET /users/{username}` at import time so\n" +
			"the on-disk roster always carries the GitHub-authoritative\n" +
			"ID. The `email` column may have empty values per row.\n\n" +
			"The whole file is written in one Tree commit, not one PUT\n" +
			"per row, so partial-import states can't appear on the repo.\n" +
			"After the commit lands, any student who isn't already in\n" +
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
		rows, sourcePath, err := configrepo.LoadRosterWithSource(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		updated, replaced := configrepo.UpsertRosterRow(rows, newRow)
		if replaced {
			action = "updated"
		} else {
			action = "added"
		}
		return configrepo.RosterWriteChange(classroom, sourcePath, updated)
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
	return nil
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
		rows, sourcePath, err := configrepo.LoadRosterWithSource(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		next, found, changed := configrepo.UpdateRosterRow(rows, username, patch)
		if !found {
			return configwrite.CommitChange{}, fmt.Errorf("%s not in %s roster — add them with `gh teacher roster add %s %s %s` first",
				username, classroom, org, classroom, username)
		}
		if !changed {
			noChange = true // empty change → CommitTreeChange skips the commit.
			return configwrite.CommitChange{}, nil
		}
		return configrepo.RosterWriteChange(classroom, sourcePath, next)
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
		rows, sourcePath, err := configrepo.LoadRosterWithSource(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		next, ok := configrepo.RemoveRosterRow(rows, username)
		removed = ok
		if !ok {
			return configwrite.CommitChange{}, nil // empty → skips the commit (already absent)
		}
		return configrepo.RosterWriteChange(classroom, sourcePath, next)
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

func runRosterImport(client githubapi.Client, out, errOut io.Writer, org, classroom, csvPath string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	abs, err := filepath.Abs(csvPath)
	if err != nil {
		return fmt.Errorf("resolve import path: %w", err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return fmt.Errorf("read %s: %w", abs, err)
	}
	imported, err := configrepo.ParseImportCSV(data)
	if err != nil {
		return fmt.Errorf("%s: %w", abs, err)
	}
	if len(imported) == 0 {
		return fmt.Errorf("%s: contains a header but no student rows", abs)
	}

	// Resolve every username up front so rebase retries don't repeat API
	// lookups — only the file write is retried. CSV lines are 1-based (header =
	// line 1) to match parseImportCSV.
	resolved := make([]configrepo.RosterRow, 0, len(imported))
	for i, row := range imported {
		line := i + 2
		login, userID, err := membership.LookupUser(client, row.Username)
		if err != nil {
			return fmt.Errorf("line %d (%s): %w", line, row.Username, err)
		}
		resolved = append(resolved, configrepo.RosterRow{
			Username:  login,
			FirstName: row.FirstName,
			LastName:  row.LastName,
			Email:     row.Email,
			Section:   row.Section,
			GitHubID:  userID,
		})
	}
	// Case-insensitive dedup within the batch; last occurrence wins.
	resolved = configrepo.DedupeByUsername(resolved)

	var (
		added   int
		updated int
	)
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		rows, sourcePath, err := configrepo.LoadRosterWithSource(client, org, classroom, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		// Reset counters per attempt — rebase may split new/replaced differently.
		added, updated = 0, 0
		for _, row := range resolved {
			var replaced bool
			rows, replaced = configrepo.UpsertRosterRow(rows, row)
			if replaced {
				updated++
			} else {
				added++
			}
		}
		return configrepo.RosterWriteChange(classroom, sourcePath, rows)
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: import %d row(s) into %s (gh teacher roster import)", len(resolved), classroom))
	if _, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	_, _ = fmt.Fprintf(out, "%s/%s/%s: imported %d row(s) (%d new, %d updated)\n",
		org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom), len(resolved), added, updated)

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

	invited, alreadyActive, alreadyPending := 0, 0, 0
	var failures []string
	for _, row := range resolved {
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
