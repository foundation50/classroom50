// Package staff implements the `gh teacher staff` command: managing the
// per-classroom staff teams (instructor, ta) that back the web GUI's in-app
// roles. Membership lives in the GitHub teams (`classroom50-<classroom>-{...}`),
// not roster.csv, so staff is identical from CLI or web. Only NewCmd is
// exported.
package staff

import (
	"encoding/json"
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
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "staff",
		Short: "Manage a classroom's staff teams (instructor, ta)",
		Long: "Add or remove instructors and teaching assistants on a\n" +
			"classroom's staff teams (classroom50-<classroom>-{instructor,ta}).\n\n" +
			"Staff roles are GitHub Teams, granted write on the config repo so\n" +
			"members can author assignments. This mirrors the web GUI's\n" +
			"\"Staff & roles\" section — a classroom managed from either surface\n" +
			"has the same staff.\n\n" +
			"Subcommands:\n" +
			"  add     add a user to a classroom's instructor or ta team\n" +
			"  remove  remove a user from a classroom's instructor or ta team\n\n" +
			"The staff teams are normally created by `gh teacher classroom\n" +
			"add`; if a classroom predates that (no `teams` block in\n" +
			"classroom.json), `staff add` creates and records the team on\n" +
			"first use.",
	}
	cmd.AddCommand(staffAddCmd())
	cmd.AddCommand(staffRemoveCmd())
	return cmd
}

// parseRole maps --role to a StaffRole (default instructor). Accepts
// "instructor" or "ta" (case-insensitive).
func parseRole(role string) (configrepo.StaffRole, error) {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "", "instructor":
		return configrepo.RoleInstructor, nil
	case "ta":
		return configrepo.RoleTA, nil
	default:
		return "", fmt.Errorf("invalid --role %q: must be \"instructor\" or \"ta\"", role)
	}
}

func staffAddCmd() *cobra.Command {
	var role string

	cmd := &cobra.Command{
		Use:   "add <org> <classroom> <username>",
		Short: "Add a user to a classroom's staff team",
		Long: "Add <username> to the classroom's instructor (default) or ta\n" +
			"staff team. The user gets write on the config repo through the\n" +
			"team, so they can author assignments.\n\n" +
			"If the user isn't yet an org member the membership goes pending\n" +
			"until they accept the org invitation (same as roster add).\n\n" +
			"If the classroom predates the staff-teams feature (or its\n" +
			"`teams` block is partial), this self-heals: it creates/adopts\n" +
			"the missing team, grants it config-repo write, and records the\n" +
			"ref in classroom.json before adding the user.\n\n" +
			"Returns non-zero on: classroom not found, or GitHub user not\n" +
			"found.",
		Example: "  gh teacher staff add cs50-fall-2026 cs-principles alice\n" +
			"  gh teacher staff add cs50-fall-2026 cs-principles bob --role ta",
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
			r, err := parseRole(role)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runStaffAdd(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, username, r)
		},
	}
	cmd.Flags().StringVar(&role, "role", "instructor", `Staff role: "instructor" or "ta"`)
	return cmd
}

func staffRemoveCmd() *cobra.Command {
	var role string

	cmd := &cobra.Command{
		Use:   "remove <org> <classroom> <username>",
		Short: "Remove a user from a classroom's staff team",
		Long: "Remove <username> from the classroom's instructor (default) or\n" +
			"ta staff team. Does NOT touch the user's org membership. A user\n" +
			"who isn't on the team is a clean no-op (idempotent).",
		Example: "  gh teacher staff remove cs50-fall-2026 cs-principles alice\n" +
			"  gh teacher staff remove cs50-fall-2026 cs-principles bob --role ta",
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
			r, err := parseRole(role)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runStaffRemove(client, cmd.OutOrStdout(), org, classroom, username, r)
		},
	}
	cmd.Flags().StringVar(&role, "role", "instructor", `Staff role: "instructor" or "ta"`)
	return cmd
}

// runStaffAdd resolves the staff team from classroom.json and adds the
// canonical-login user. If the `teams` block is missing/partial, it self-heals
// (create/adopt the team, grant config-repo write, record the ref).
func runStaffAdd(client githubapi.Client, out, errOut io.Writer, org, classroom, username string, role configrepo.StaffRole) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	// Resolve the canonical login and confirm the user exists first.
	login, _, err := membership.LookupUser(client, username)
	if err != nil {
		return err
	}
	team, ok, err := configrepo.ResolveClassroomStaffTeam(client, org, classroom, branch, role)
	if err != nil {
		return err
	}
	if !ok {
		// Self-heal a missing/partial `teams` block: ensure the team, grant
		// config-repo write, persist its ref, then proceed. Makes `staff add`
		// idempotent for pre-feature classrooms rather than dead-ending at
		// `classroom add` (which can't repair an existing classroom).
		team, err = ensureStaffTeamRecorded(client, out, org, classroom, branch, role)
		if err != nil {
			return err
		}
	}
	if err := configrepo.AddTeamMembership(client, org, team.Slug, login); err != nil {
		return fmt.Errorf("adding %s to the %s team failed: %w", login, role, err)
	}
	_, _ = fmt.Fprintf(out, "%s: added %s to %s team %s\n", org, login, role, team.Slug)
	return nil
}

// ensureStaffTeamRecorded adopts-or-creates the classroom's staff team for
// `role`, grants it config-repo write, and records its ref under
// classroom.json `teams.<role>` in one commit. Confirms the classroom exists
// first (so a typo doesn't mint a stray team); no-op-safe if already recorded.
func ensureStaffTeamRecorded(client githubapi.Client, out io.Writer, org, classroom, branch string, role configrepo.StaffRole) (configrepo.TeamRef, error) {
	if _, ok, err := configrepo.LoadClassroom(client, org, classroom, branch); err != nil {
		return configrepo.TeamRef{}, err
	} else if !ok {
		return configrepo.TeamRef{}, fmt.Errorf("%s: classroom %s not found in %s — run `gh teacher classroom add %s %s` first",
			org, classroom, configrepo.ConfigRepoName, org, classroom)
	}
	team, err := configrepo.EnsureClassroomStaffTeam(client, org, classroom, role)
	if err != nil {
		return configrepo.TeamRef{}, err
	}
	if _, err := configrepo.GrantTeamRepoWrite(client, org, team.Slug, org, configrepo.ConfigRepoName); err != nil {
		return configrepo.TeamRef{}, fmt.Errorf("grant %s staff team write on %s: %w", role, configrepo.ConfigRepoName, err)
	}
	// Persist the ref so future resolves and the delete/teardown sweeps find
	// it. RMW classroom.json in one commit.
	path := configrepo.ClassroomFilePath(classroom)
	message := contract.PrefixCommit(fmt.Sprintf("Record %s staff team for %s (gh teacher staff add)", role, classroom))
	build := func(parentSHA string) (map[string]string, error) {
		data, ok, err := configrepo.ReadFileContents(client, org, configrepo.ConfigRepoName, path, parentSHA)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("%s: classroom %s not found in %s/%s", org, classroom, configrepo.ConfigRepoName, path)
		}
		var c configrepo.ClassroomJSON
		if err := json.Unmarshal(data, &c); err != nil {
			return nil, fmt.Errorf("%s/%s/%s: %w", org, configrepo.ConfigRepoName, path, err)
		}
		if c.Teams == nil {
			c.Teams = &configrepo.StaffTeamsRef{}
		}
		ref := team
		switch role {
		case configrepo.RoleInstructor:
			c.Teams.Instructor = &ref
		case configrepo.RoleTA:
			c.Teams.TA = &ref
		}
		updated, err := output.JSONPretty(c)
		if err != nil {
			return nil, fmt.Errorf("encode classroom.json: %w", err)
		}
		if string(data) == string(updated) {
			return nil, nil // already recorded — no commit
		}
		return map[string]string{path: string(updated)}, nil
	}
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return configrepo.TeamRef{}, err
	}
	_, _ = fmt.Fprintf(out, "%s: recorded %s staff team %s in classroom.json\n", org, role, team.Slug)
	return team, nil
}

// runStaffRemove resolves the staff team and removes the user. Idempotent — a
// non-member or already-gone team is a no-op.
func runStaffRemove(client githubapi.Client, out io.Writer, org, classroom, username string, role configrepo.StaffRole) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	login, _, err := membership.LookupUser(client, username)
	if err != nil {
		return err
	}
	team, ok, err := configrepo.ResolveClassroomStaffTeam(client, org, classroom, branch, role)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%s: classroom %s has no %s staff team recorded in classroom.json — nothing to remove",
			org, classroom, role)
	}
	if err := configrepo.RemoveTeamMembership(client, org, team.Slug, login); err != nil {
		return fmt.Errorf("removing %s from the %s team failed: %w", login, role, err)
	}
	_, _ = fmt.Fprintf(out, "%s: removed %s from %s team %s\n", org, login, role, team.Slug)
	return nil
}
