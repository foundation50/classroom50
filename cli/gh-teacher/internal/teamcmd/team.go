// Package teamcmd implements the `gh teacher team` command group: creating,
// listing, and editing the GitHub Teams that back a `mode: team` assignment
// (`classroom50-group-<hash>-<n>` secret teams), plus the teams.json snapshot
// in the classroom50 repository. Only NewCmd is exported. Consumes
// internal/configrepo (group-team kit + teams.json) and internal/configwrite.
package teamcmd

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "team",
		Short: "Manage the GitHub Teams behind a team assignment",
		Long: "Manage the groups of a `--mode team` assignment. Each group is a\n" +
			"secret GitHub Team named `classroom50-group-<hash>-<n>` that owns the\n" +
			"shared repository `<classroom>-<assignment>-group-<n>`.\n\n" +
			"Subcommands:\n" +
			"  create  create a group team and add its members\n" +
			"  list    show every group team, its members, and snapshot drift\n" +
			"  add     add a rostered student to a group team\n" +
			"  remove  remove a student from a group team\n" +
			"  delete  delete a group team\n" +
			"  copy    recreate another assignment's teams for this one\n\n" +
			"Membership writes also update <classroom>/teams.json in the\n" +
			"classroom50 repository: the snapshot of intended membership that\n" +
			"survives membership drift. GitHub Teams stay authoritative for who\n" +
			"can push.\n\n" +
			"Teams can be referenced by their counter (for example `2`) or by\n" +
			"the full team slug.",
	}
	cmd.AddCommand(teamCreateCmd())
	cmd.AddCommand(teamListCmd())
	cmd.AddCommand(teamAddCmd())
	cmd.AddCommand(teamRemoveCmd())
	cmd.AddCommand(teamDeleteCmd())
	cmd.AddCommand(teamCopyCmd())
	return cmd
}

// teamScope is the validated <org> <classroom> <assignment> triple every
// subcommand takes.
type teamScope struct {
	Org        string
	Classroom  string
	Assignment string
}

// parseScope validates the three positional args shared by every subcommand.
func parseScope(args []string) (teamScope, error) {
	scope := teamScope{
		Org:        strings.TrimSpace(args[0]),
		Classroom:  strings.TrimSpace(args[1]),
		Assignment: strings.TrimSpace(args[2]),
	}
	if scope.Org == "" || scope.Classroom == "" || scope.Assignment == "" {
		return teamScope{}, errors.New("org, classroom, and assignment must all be non-empty")
	}
	if err := validate.ShortName(scope.Classroom, "classroom"); err != nil {
		return teamScope{}, err
	}
	if err := validate.ShortName(scope.Assignment, "assignment"); err != nil {
		return teamScope{}, err
	}
	return scope, nil
}

// authedScope is the RunE prelude every subcommand shares: silence usage (the
// args parsed, so failures from here are real errors, not usage mistakes),
// validate the scope triple, and authenticate. Subcommands with extra
// positional args pass the full slice; only the first three are the scope.
func authedScope(cmd *cobra.Command, args []string) (githubapi.Client, teamScope, error) {
	cmd.SilenceUsage = true
	scope, err := parseScope(args[:3])
	if err != nil {
		return nil, teamScope{}, err
	}
	client, err := githubapi.RequireAuthClient(cmd)
	if err != nil {
		return nil, teamScope{}, err
	}
	return client, scope, nil
}

// requireUsername trims and validates a positional username argument, shared
// by the membership subcommands.
func requireUsername(arg string) (string, error) {
	username := strings.TrimSpace(arg)
	if username == "" {
		return "", errors.New("username must not be empty")
	}
	return username, nil
}

// teamContext is the resolved per-command state: the config-repo branch and
// the (team-mode) assignment entry.
type teamContext struct {
	teamScope
	Branch string
	Entry  assignment.AssignmentEntry
}

// loadTeamContext resolves the config-repo branch, loads the assignment
// entry, and requires it to be a team assignment.
func loadTeamContext(client githubapi.Client, scope teamScope) (teamContext, error) {
	branch, err := configrepo.ResolveConfigRepoBranch(client, scope.Org)
	if err != nil {
		return teamContext{}, err
	}
	file, err := configrepo.LoadAssignments(client, scope.Org, scope.Classroom, branch)
	if err != nil {
		return teamContext{}, err
	}
	idx, ok := assignment.FindAssignment(file.Assignments, scope.Assignment)
	if !ok {
		return teamContext{}, fmt.Errorf("assignment %q is not registered in %s/%s/%s: run `gh teacher assignment add %s %s %s --mode team ...` first",
			scope.Assignment, scope.Org, configrepo.ConfigRepoName, assignment.AssignmentsFilePath(scope.Classroom),
			scope.Org, scope.Classroom, scope.Assignment)
	}
	entry := file.Assignments[idx]
	if err := requireTeamMode(entry); err != nil {
		return teamContext{}, err
	}
	return teamContext{teamScope: scope, Branch: branch, Entry: entry}, nil
}

// requireTeamMode gates every subcommand on mode: team — group and individual
// assignments have no group teams to manage.
func requireTeamMode(entry assignment.AssignmentEntry) error {
	if entry.Mode != assignment.ModeTeam {
		return fmt.Errorf("assignment %q is not a team assignment (mode %s)", entry.Slug, entry.Mode)
	}
	return nil
}

// resolveTeamArg maps a user-supplied team reference — a bare counter like
// `2`, or the full slug — to the assignment's team slug. Pure so the mapping
// is unit-testable.
func resolveTeamArg(classroom, assignmentSlug, arg string) (string, error) {
	arg = strings.TrimSpace(arg)
	if arg == "" {
		return "", errors.New("team must not be empty")
	}
	if n, err := strconv.Atoi(arg); err == nil {
		if n < 1 {
			return "", fmt.Errorf("team counter %d is invalid: counters start at 1", n)
		}
		return contract.GroupTeamName(classroom, assignmentSlug, n), nil
	}
	if _, ok := contract.ParseGroupTeamCounter(arg, classroom, assignmentSlug); ok {
		return arg, nil
	}
	return "", fmt.Errorf("team %q is neither a counter nor one of this assignment's team slugs (use a counter like 2, or the full %s<n> slug)",
		arg, contract.GroupTeamAssignmentPrefix(classroom, assignmentSlug))
}

// splitRostered partitions usernames into rostered and unknown, matching the
// roster case-insensitively. Pure so the roster gate is unit-testable.
func splitRostered(usernames []string, rosterLogins map[string]bool) (rostered, unknown []string) {
	seen := map[string]bool{}
	for _, u := range usernames {
		u = strings.TrimSpace(u)
		key := strings.ToLower(u)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		if rosterLogins[key] {
			rostered = append(rostered, u)
		} else {
			unknown = append(unknown, u)
		}
	}
	return rostered, unknown
}

// loadRosterLogins reads the classroom roster and returns the lowercased
// login set the membership commands gate on.
func loadRosterLogins(client githubapi.Client, ctx teamContext) (map[string]bool, error) {
	rows, err := configrepo.LoadRoster(client, ctx.Org, ctx.Classroom, ctx.Branch)
	if err != nil {
		return nil, err
	}
	logins := map[string]bool{}
	for _, row := range rows {
		if login := strings.ToLower(strings.TrimSpace(row.Username)); login != "" {
			logins[login] = true
		}
	}
	return logins, nil
}

// commitTeamsUpdate applies `mutate` to <classroom>/teams.json through the
// same optimistic-update-with-rebase loop assignment add uses, so concurrent
// team edits don't lose each other's work. `mutate` runs per attempt against
// the file read at that attempt's parent SHA.
func commitTeamsUpdate(client githubapi.Client, ctx teamContext, message string, mutate func(*configrepo.TeamsFile) error) error {
	build := func(parentSHA string) (map[string]string, error) {
		file, err := configrepo.ReadTeamsFile(client, ctx.Org, ctx.Classroom, parentSHA)
		if err != nil {
			return nil, err
		}
		if err := mutate(&file); err != nil {
			return nil, err
		}
		data, err := configrepo.EncodeTeamsFile(file, ctx.Classroom)
		if err != nil {
			return nil, err
		}
		return map[string]string{configrepo.TeamsFilePath(ctx.Classroom): string(data)}, nil
	}
	_, err := configwrite.CommitTree(client, ctx.Org, configrepo.ConfigRepoName, ctx.Branch, contract.PrefixCommit(message), build)
	return err
}

// warnTeamsSnapshot reports a failed teams.json write without failing the
// command: the live GitHub Team change already landed, so the teacher can
// re-run to reconcile rather than being told the whole operation failed.
func warnTeamsSnapshot(errOut io.Writer, ctx teamContext, err error) {
	_, _ = fmt.Fprintf(errOut, "Warning: the team change landed on GitHub but %s/%s/%s could not be updated (%v). Re-run the command to retry the snapshot update.\n",
		ctx.Org, configrepo.ConfigRepoName, configrepo.TeamsFilePath(ctx.Classroom), err)
}
