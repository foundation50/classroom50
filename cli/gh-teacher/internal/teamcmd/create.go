package teamcmd

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

func teamCreateCmd() *cobra.Command {
	var (
		name    string
		members []string
	)
	cmd := &cobra.Command{
		Use:   "create <org> <classroom> <assignment>",
		Short: "Create a group team for a team assignment",
		Long: "Create the next free `classroom50-group-<hash>-<n>` secret GitHub Team\n" +
			"for the assignment and add the given members.\n\n" +
			"  - Members must be on the classroom roster; usernames not on\n" +
			"    roster.csv are skipped with a warning.\n" +
			"  - The member count is capped by the assignment's max_group_size.\n" +
			"  - The new team is recorded in <classroom>/teams.json.\n" +
			"  - The team is attached to its shared repository when a student\n" +
			"    accepts; creating the team first is the teacher-formation flow.\n\n" +
			"If a member add fails partway, re-run `gh teacher team add` for the\n" +
			"missing members; the team itself is already created.",
		Example: "  gh teacher team create cs50-fall-2026 cs-principles project --name \"The Sharks\" --member alice --member bob",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, scope, err := authedScope(cmd, args)
			if err != nil {
				return err
			}
			return runTeamCreate(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), scope, strings.TrimSpace(name), members)
		},
	}
	cmd.Flags().StringVar(&name, "name", "", `Display name recorded for the team, for example "The Sharks"`)
	cmd.Flags().StringArrayVar(&members, "member", nil, "Username to add to the new team (repeatable). Must be on the classroom roster")
	return cmd
}

func runTeamCreate(client githubapi.Client, out, errOut io.Writer, scope teamScope, name string, members []string) error {
	ctx, err := loadTeamContext(client, scope)
	if err != nil {
		return err
	}
	rosterLogins, err := loadRosterLogins(client, ctx)
	if err != nil {
		return err
	}
	rostered, unknown := splitRostered(members, rosterLogins)
	for _, u := range unknown {
		_, _ = fmt.Fprintf(errOut, "Warning: %q is not on %s/%s/%s; skipping. Add them with `gh teacher roster add`, then `gh teacher team add`.\n",
			u, ctx.Org, configrepo.ConfigRepoName, configrepo.RosterFilePath(ctx.Classroom))
	}
	if limit := ctx.Entry.MaxGroupSize; limit > 0 && len(rostered) > limit {
		return fmt.Errorf("cannot create a team with %d members: the assignment's max_group_size is %d", len(rostered), limit)
	}

	slug, id, counter, err := createTeamWithMembers(client, errOut, ctx, name, rostered)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "%s: created team %s (group %d, %d member(s))\n", ctx.Org, slug, counter, len(rostered))

	record := configrepo.TeamRecord{
		Slug:      slug,
		ID:        id,
		Name:      name,
		Members:   rostered,
		Formation: ctx.Entry.TeamFormation,
	}
	message := fmt.Sprintf("team: add group %d to %s/%s (gh teacher team create)", counter, ctx.Classroom, ctx.Assignment)
	if err := commitTeamsUpdate(client, ctx, message, func(file *configrepo.TeamsFile) error {
		configrepo.UpsertTeam(file, ctx.Assignment, record)
		return nil
	}); err != nil {
		warnTeamsSnapshot(errOut, ctx, err)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: recorded %s\n", ctx.Org, configrepo.ConfigRepoName, configrepo.TeamsFilePath(ctx.Classroom), slug)
	return nil
}

// createTeamWithMembers creates the group team, drops the acting teacher
// (GitHub silently adds the creator as maintainer, and a teacher on a group
// team would look like a member to every counting client), then adds the
// rostered members. A member add failing is an error AFTER the create, so the
// message can point at `team add` to finish rather than re-running create
// (which would mint a second team).
func createTeamWithMembers(client githubapi.Client, errOut io.Writer, ctx teamContext, name string, members []string) (slug string, id int64, counter int, err error) {
	slug, id, counter, err = configrepo.CreateGroupTeam(client, ctx.Org, ctx.Classroom, ctx.Assignment, name, nil, ctx.Entry.TeamFormation)
	if err != nil {
		return "", 0, 0, err
	}
	if actor, _, err := githubapi.CurrentUser(client); err == nil {
		if err := configrepo.RemoveGroupTeamMember(client, ctx.Org, slug, actor); err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: could not remove you (%s) from the new team %s (%v). Remove yourself by hand so you are not counted as a member.\n", actor, slug, err)
		}
	}
	for _, member := range members {
		if err := configrepo.AddGroupTeamMember(client, ctx.Org, slug, member); err != nil {
			return "", 0, 0, fmt.Errorf("team %s was created but adding %s failed: %w. Add the remaining members with `gh teacher team add %s %s %s %d <username>`",
				slug, member, err, ctx.Org, ctx.Classroom, ctx.Assignment, counter)
		}
	}
	return slug, id, counter, nil
}

func teamDeleteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "delete <org> <classroom> <assignment> <team>",
		Short: "Delete a group team",
		Long: "Delete the group team referenced by counter or slug and drop it from\n" +
			"<classroom>/teams.json. The shared repository is not touched.\n\n" +
			"The delete is guarded: the live team must match the full group-team\n" +
			"shape, its recorded id, and a verified classroom50/group/v1\n" +
			"description record. A team that is already gone counts as deleted.",
		Example: "  gh teacher team delete cs50-fall-2026 cs-principles project 2",
		Args:    cobra.ExactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, scope, err := authedScope(cmd, args)
			if err != nil {
				return err
			}
			return runTeamDelete(client, cmd.OutOrStdout(), scope, args[3])
		},
	}
	return cmd
}

func runTeamDelete(client githubapi.Client, out io.Writer, scope teamScope, teamArg string) error {
	ctx, err := loadTeamContext(client, scope)
	if err != nil {
		return err
	}
	slug, err := resolveTeamArg(ctx.Classroom, ctx.Assignment, teamArg)
	if err != nil {
		return err
	}

	// Prefer the recorded id from teams.json; fall back to the live listing
	// for a team never snapshotted (e.g. student-formed before any teacher
	// write). Either way DeleteGroupTeam re-verifies the live team.
	recordedID := int64(0)
	file, err := configrepo.ReadTeamsFile(client, ctx.Org, ctx.Classroom, ctx.Branch)
	if err != nil {
		return err
	}
	for _, record := range file.Assignments[ctx.Assignment].Teams {
		if record.Slug == slug {
			recordedID = record.ID
			break
		}
	}
	if recordedID == 0 {
		teams, err := configrepo.ListAssignmentGroupTeams(client, ctx.Org, ctx.Classroom, ctx.Assignment)
		if err != nil {
			return err
		}
		for _, team := range teams {
			if team.Slug == slug {
				recordedID = team.ID
				break
			}
		}
	}
	if recordedID == 0 {
		// Neither the snapshot nor the live listing knows the team: nothing
		// to delete, but still drop a stale snapshot row below.
		_, _ = fmt.Fprintf(out, "%s: team %s not found (already deleted?)\n", ctx.Org, slug)
	} else {
		if err := configrepo.DeleteGroupTeam(client, ctx.Org, slug, recordedID); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(out, "%s: deleted team %s\n", ctx.Org, slug)
	}

	message := fmt.Sprintf("team: remove %s from %s/%s (gh teacher team delete)", slug, ctx.Classroom, ctx.Assignment)
	return commitTeamsUpdate(client, ctx, message, func(file *configrepo.TeamsFile) error {
		configrepo.RemoveTeam(file, ctx.Assignment, slug)
		return nil
	})
}

func teamCopyCmd() *cobra.Command {
	var from string
	cmd := &cobra.Command{
		Use:   "copy <org> <classroom> <assignment> --from <assignment>",
		Short: "Copy another assignment's teams to this one",
		Long: "Recreate the source assignment's group teams for the target assignment:\n" +
			"same members and display names, fresh counters under the target's own\n" +
			"team namespace. Both assignments must be team assignments in the same\n" +
			"classroom. The new teams are recorded in <classroom>/teams.json.",
		Example: "  gh teacher team copy cs50-fall-2026 cs-principles project2 --from project",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			scope, err := parseScope(args)
			if err != nil {
				return err
			}
			source := strings.TrimSpace(from)
			if source == "" {
				return errors.New("--from is required: name the assignment to copy teams from")
			}
			if source == scope.Assignment {
				return errors.New("--from must name a different assignment")
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runTeamCopy(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), scope, source)
		},
	}
	cmd.Flags().StringVar(&from, "from", "", "Assignment slug to copy teams from (required)")
	return cmd
}

func runTeamCopy(client githubapi.Client, out, errOut io.Writer, scope teamScope, source string) error {
	ctx, err := loadTeamContext(client, scope)
	if err != nil {
		return err
	}
	// The source must be a team assignment too; reuse the same gate so the
	// error wording matches.
	if _, err := loadTeamContext(client, teamScope{Org: scope.Org, Classroom: scope.Classroom, Assignment: source}); err != nil {
		return fmt.Errorf("--from %s: %w", source, err)
	}
	sourceTeams, err := configrepo.ListAssignmentGroupTeams(client, ctx.Org, ctx.Classroom, source)
	if err != nil {
		return err
	}
	if len(sourceTeams) == 0 {
		_, _ = fmt.Fprintf(out, "%s/%s: no teams to copy\n", ctx.Classroom, source)
		return nil
	}
	rosterLogins, err := loadRosterLogins(client, ctx)
	if err != nil {
		return err
	}

	var records []configrepo.TeamRecord
	for _, sourceTeam := range sourceTeams {
		rostered, unknown := splitRostered(sourceTeam.Members, rosterLogins)
		for _, u := range unknown {
			_, _ = fmt.Fprintf(errOut, "Warning: %s member %q is not on the roster; skipping them in the copy.\n", sourceTeam.Slug, u)
		}
		if limit := ctx.Entry.MaxGroupSize; limit > 0 && len(rostered) > limit {
			return fmt.Errorf("cannot copy %s: it has %d rostered member(s), over the target assignment's max_group_size %d",
				sourceTeam.Slug, len(rostered), limit)
		}
		slug, id, counter, err := createTeamWithMembers(client, errOut, ctx, sourceTeam.Record.Name, rostered)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(out, "%s: created team %s (group %d, %d member(s), copied from %s)\n",
			ctx.Org, slug, counter, len(rostered), sourceTeam.Slug)
		records = append(records, configrepo.TeamRecord{
			Slug:      slug,
			ID:        id,
			Name:      sourceTeam.Record.Name,
			Members:   rostered,
			Formation: ctx.Entry.TeamFormation,
		})
	}

	message := fmt.Sprintf("team: copy %d team(s) from %s to %s in %s (gh teacher team copy)",
		len(records), source, ctx.Assignment, ctx.Classroom)
	if err := commitTeamsUpdate(client, ctx, message, func(file *configrepo.TeamsFile) error {
		for _, record := range records {
			configrepo.UpsertTeam(file, ctx.Assignment, record)
		}
		return nil
	}); err != nil {
		warnTeamsSnapshot(errOut, ctx, err)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: recorded %d team(s)\n", ctx.Org, configrepo.ConfigRepoName, configrepo.TeamsFilePath(ctx.Classroom), len(records))
	return nil
}
