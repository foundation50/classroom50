package teamcmd

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

func teamAddCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "add <org> <classroom> <assignment> <team> <username>",
		Short: "Add a student to a group team",
		Long: "Add a rostered student to the group team referenced by counter or\n" +
			"slug, and record them in <classroom>/teams.json.\n\n" +
			"  - The student must be on the classroom roster.\n" +
			"  - The team's live member count is capped by the assignment's\n" +
			"    max_group_size.\n" +
			"  - Adding a student who is already on the team changes nothing.",
		Example: "  gh teacher team add cs50-fall-2026 cs-principles project 2 alice",
		Args:    cobra.ExactArgs(5),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			scope, err := parseScope(args[:3])
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runTeamAdd(client, cmd.OutOrStdout(), scope, args[3], args[4])
		},
	}
	return cmd
}

func runTeamAdd(client githubapi.Client, out io.Writer, scope teamScope, teamArg, username string) error {
	username = strings.TrimSpace(username)
	if username == "" {
		return fmt.Errorf("username must not be empty")
	}
	ctx, err := loadTeamContext(client, scope)
	if err != nil {
		return err
	}
	slug, err := resolveTeamArg(ctx.Classroom, ctx.Assignment, teamArg)
	if err != nil {
		return err
	}
	rosterLogins, err := loadRosterLogins(client, ctx)
	if err != nil {
		return err
	}
	if !rosterLogins[strings.ToLower(username)] {
		return fmt.Errorf("%q is not on %s/%s/%s: add them with `gh teacher roster add %s %s %s`, then re-run",
			username, ctx.Org, configrepo.ConfigRepoName, configrepo.RosterFilePath(ctx.Classroom),
			ctx.Org, ctx.Classroom, username)
	}

	members, err := configrepo.ListTeamMembers(client, ctx.Org, slug)
	if err != nil {
		return err
	}
	alreadyMember := false
	for _, m := range members {
		if strings.EqualFold(m, username) {
			alreadyMember = true
			break
		}
	}
	if limit := ctx.Entry.MaxGroupSize; !alreadyMember && limit > 0 && len(members) >= limit {
		return fmt.Errorf("team %s is full: it has %d member(s), the assignment's maximum of %d. Remove a member first, or raise max_group_size with `gh teacher assignment add`",
			slug, len(members), limit)
	}
	if !alreadyMember {
		if err := configrepo.AddGroupTeamMember(client, ctx.Org, slug, username); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(out, "%s: added %s to %s\n", ctx.Org, username, slug)
	} else {
		_, _ = fmt.Fprintf(out, "%s: %s is already on %s, nothing to do\n", ctx.Org, username, slug)
	}

	message := fmt.Sprintf("team: add %s to %s in %s/%s (gh teacher team add)", username, slug, ctx.Classroom, ctx.Assignment)
	return commitTeamsUpdate(client, ctx, message, func(file *configrepo.TeamsFile) error {
		mutateTeamMembers(file, ctx, slug, func(recorded []string) []string {
			return appendMember(recorded, username)
		})
		return nil
	})
}

func teamRemoveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remove <org> <classroom> <assignment> <team> <username>",
		Short: "Remove a student from a group team",
		Long: "Remove a student from the group team referenced by counter or slug,\n" +
			"and drop them from <classroom>/teams.json. Removing a student who is\n" +
			"not on the team changes nothing.",
		Example: "  gh teacher team remove cs50-fall-2026 cs-principles project 2 alice",
		Args:    cobra.ExactArgs(5),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			scope, err := parseScope(args[:3])
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runTeamRemove(client, cmd.OutOrStdout(), scope, args[3], args[4])
		},
	}
	return cmd
}

func runTeamRemove(client githubapi.Client, out io.Writer, scope teamScope, teamArg, username string) error {
	username = strings.TrimSpace(username)
	if username == "" {
		return fmt.Errorf("username must not be empty")
	}
	ctx, err := loadTeamContext(client, scope)
	if err != nil {
		return err
	}
	slug, err := resolveTeamArg(ctx.Classroom, ctx.Assignment, teamArg)
	if err != nil {
		return err
	}
	if err := configrepo.RemoveGroupTeamMember(client, ctx.Org, slug, username); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "%s: removed %s from %s\n", ctx.Org, username, slug)

	message := fmt.Sprintf("team: remove %s from %s in %s/%s (gh teacher team remove)", username, slug, ctx.Classroom, ctx.Assignment)
	return commitTeamsUpdate(client, ctx, message, func(file *configrepo.TeamsFile) error {
		mutateTeamMembers(file, ctx, slug, func(recorded []string) []string {
			return dropMember(recorded, username)
		})
		return nil
	})
}

// mutateTeamMembers rewrites one recorded team's member list inside the
// snapshot, creating the record when the team was never snapshotted (a
// student-formed team a teacher is now editing).
func mutateTeamMembers(file *configrepo.TeamsFile, ctx teamContext, slug string, change func([]string) []string) {
	var record configrepo.TeamRecord
	found := false
	for _, r := range file.Assignments[ctx.Assignment].Teams {
		if r.Slug == slug {
			record = r
			found = true
			break
		}
	}
	if !found {
		record = configrepo.TeamRecord{Slug: slug, Formation: ctx.Entry.TeamFormation}
	}
	record.Members = change(record.Members)
	configrepo.UpsertTeam(file, ctx.Assignment, record)
}

// appendMember adds username to a member list unless already present
// (case-insensitive).
func appendMember(members []string, username string) []string {
	for _, m := range members {
		if strings.EqualFold(m, username) {
			return members
		}
	}
	return append(members, username)
}

// dropMember removes username from a member list (case-insensitive).
func dropMember(members []string, username string) []string {
	out := members[:0]
	for _, m := range members {
		if !strings.EqualFold(m, username) {
			out = append(out, m)
		}
	}
	return out
}
