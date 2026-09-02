package teamcmd

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

func teamListCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list <org> <classroom> <assignment>",
		Short: "List a team assignment's group teams",
		Long: "Show every live group team for the assignment: counter, display name,\n" +
			"members, member count against max_group_size, and drift against the\n" +
			"<classroom>/teams.json snapshot (members present live but not in the\n" +
			"snapshot, or recorded but missing live).\n\n" +
			"This is a read-only command; no commit lands on the repository.",
		Example: "  gh teacher team list cs50-fall-2026 cs-principles project",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, scope, err := authedScope(cmd, args)
			if err != nil {
				return err
			}
			return runTeamList(client, cmd.OutOrStdout(), scope)
		},
	}
	return cmd
}

func runTeamList(client githubapi.Client, out io.Writer, scope teamScope) error {
	ctx, err := loadTeamContext(client, scope)
	if err != nil {
		return err
	}
	teams, err := configrepo.ListAssignmentGroupTeams(client, ctx.Org, ctx.Classroom, ctx.Assignment)
	if err != nil {
		return err
	}
	snapshot, err := configrepo.ReadTeamsFile(client, ctx.Org, ctx.Classroom, ctx.Branch)
	if err != nil {
		return err
	}
	recorded := map[string]configrepo.TeamRecord{}
	for _, record := range snapshot.Assignments[ctx.Assignment].Teams {
		recorded[record.Slug] = record
	}

	if len(teams) == 0 {
		_, _ = fmt.Fprintf(out, "%s/%s: no teams yet. Create one with `gh teacher team create %s %s %s --member <username>`\n",
			ctx.Classroom, ctx.Assignment, ctx.Org, ctx.Classroom, ctx.Assignment)
		return nil
	}

	w := tabwriter.NewWriter(out, 2, 8, 2, ' ', 0)
	_, _ = fmt.Fprintln(w, "GROUP\tNAME\tMEMBERS\tSIZE\tDRIFT")
	for _, team := range teams {
		record, hasRecord := recorded[team.Slug]
		delete(recorded, team.Slug)
		drift := describeDrift(team.Members, record.Members, hasRecord)
		name := team.Record.Name
		if name == "" {
			name = "-"
		}
		members := strings.Join(team.Members, ", ")
		if members == "" {
			members = "-"
		}
		_, _ = fmt.Fprintf(w, "%d\t%s\t%s\t%d/%d\t%s\n",
			team.Counter, name, members, len(team.Members), ctx.Entry.MaxGroupSize, drift)
	}
	// Snapshot rows with no live team are the other drift direction.
	stale := make([]string, 0, len(recorded))
	for slug := range recorded {
		stale = append(stale, slug)
	}
	sort.Strings(stale)
	if err := w.Flush(); err != nil {
		return err
	}
	for _, slug := range stale {
		_, _ = fmt.Fprintf(out, "Note: %s is in teams.json but has no live team (deleted on GitHub?)\n", slug)
	}
	return nil
}

// describeDrift renders a team's live-vs-snapshot member delta: "in sync",
// "not in teams.json", or the +live-only/-recorded-only sets. Pure so the
// drift rendering is unit-testable.
func describeDrift(live, recorded []string, hasRecord bool) string {
	if !hasRecord {
		return "not in teams.json"
	}
	liveSet := map[string]bool{}
	for _, m := range live {
		liveSet[strings.ToLower(m)] = true
	}
	recordedSet := map[string]bool{}
	for _, m := range recorded {
		recordedSet[strings.ToLower(m)] = true
	}
	var extra, missing []string
	for m := range liveSet {
		if !recordedSet[m] {
			extra = append(extra, "+"+m)
		}
	}
	for m := range recordedSet {
		if !liveSet[m] {
			missing = append(missing, "-"+m)
		}
	}
	if len(extra) == 0 && len(missing) == 0 {
		return "in sync"
	}
	sort.Strings(extra)
	sort.Strings(missing)
	return strings.Join(append(extra, missing...), " ")
}
