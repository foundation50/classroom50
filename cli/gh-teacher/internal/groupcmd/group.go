package groupcmd

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
	"github.com/foundation50/gh-teacher/internal/orgrepos"
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "group",
		Short: "Inspect the groups of a group or team assignment",
		Long: "Read-only views of who belongs to which group of a `--mode group`\n" +
			"or `--mode team` assignment, joined against the roster, so you can\n" +
			"reconcile groups with your LMS or verify that every collaborator on\n" +
			"a group repository is a rostered student.\n\n" +
			"Subcommands:\n" +
			"  list   one row per group member, as a table, --json, or --csv\n\n" +
			"To create or edit the groups of a team assignment, use `gh teacher team`.",
	}
	cmd.AddCommand(groupListCmd())
	return cmd
}

func groupListCmd() *cobra.Command {
	var (
		asJSON bool
		asCSV  bool
	)
	cmd := &cobra.Command{
		Use:   "list <org> <classroom> <assignment>",
		Short: "List every group's members, joined against the roster",
		Long: "Show one row per member of every group of the assignment. For a\n" +
			"team assignment the groups are its live GitHub Teams (a team with\n" +
			"no members or no repository yet still gets a row); for a legacy\n" +
			"group assignment they are the existing group repositories, each\n" +
			"with its founder and direct collaborators.\n\n" +
			"Each member is joined against <classroom>/roster.csv by username,\n" +
			"and `in_roster` is `no` for a collaborator or team member the roster\n" +
			"doesn't know, so an extra account on a repository stands out.\n\n" +
			"Default output is an aligned table on stdout with a one-line\n" +
			"summary on stderr. Pass --csv for the same rows as CSV with the\n" +
			"header\n\n" +
			"  " + strings.Join(contract.GroupMembershipCSVColumns, ",") + "\n\n" +
			"(the file the web app's \"Download groups (CSV)\" action produces),\n" +
			"or --json for an array of objects with those keys. --json takes\n" +
			"precedence. Read-only; no commit lands on the repository.",
		Example: "  gh teacher group list cs50-fall-2026 cs-principles project\n" +
			"  gh teacher group list cs50-fall-2026 cs-principles project --csv > groups.csv\n" +
			"  gh teacher group list cs50-fall-2026 cs-principles project --json | jq '.[] | select(.in_roster == \"no\")'",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			scope, err := parseScope(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runGroupList(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), scope, asJSON, asCSV)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit a JSON array of member objects instead of the table")
	cmd.Flags().BoolVar(&asCSV, "csv", false, "Emit the rows as CSV with the shared group-membership header")
	return cmd
}

type scope struct {
	Org, Classroom, Assignment string
}

func parseScope(args []string) (scope, error) {
	s := scope{
		Org:        strings.TrimSpace(args[0]),
		Classroom:  strings.TrimSpace(args[1]),
		Assignment: strings.TrimSpace(args[2]),
	}
	if s.Org == "" || s.Classroom == "" || s.Assignment == "" {
		return scope{}, errors.New("org, classroom, and assignment must all be non-empty")
	}
	if err := validate.ShortName(s.Classroom, "classroom"); err != nil {
		return scope{}, err
	}
	if err := validate.ShortName(s.Assignment, "assignment"); err != nil {
		return scope{}, err
	}
	return s, nil
}

func runGroupList(client githubapi.Client, out, errOut io.Writer, s scope, asJSON, asCSV bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, s.Org)
	if err != nil {
		return err
	}
	file, err := configrepo.LoadAssignments(client, s.Org, s.Classroom, branch)
	if err != nil {
		return err
	}
	idx, ok := assignment.FindAssignment(file.Assignments, s.Assignment)
	if !ok {
		return fmt.Errorf("assignment %q is not registered in %s/%s/%s", s.Assignment, s.Org, configrepo.ConfigRepoName, assignment.AssignmentsFilePath(s.Classroom))
	}
	entry := file.Assignments[idx]

	var groups []groupSource
	switch entry.Mode {
	case assignment.ModeTeam:
		groups, err = teamGroups(client, s)
	case assignment.ModeGroup:
		groups, err = legacyGroups(client, errOut, s, siblingSlugs(file.Assignments, s.Assignment))
	default:
		return fmt.Errorf("assignment %q is an individual assignment (mode %s); it has no groups to list", entry.Slug, entry.Mode)
	}
	if err != nil {
		return err
	}
	// The roster is the join target, so unlike a display-only read it is not
	// best-effort: without it every member would export as unrostered.
	roster, err := configrepo.LoadRosterLenient(client, s.Org, s.Classroom, branch)
	if err != nil {
		return err
	}

	rows := buildRows(groups, roster)
	return render(out, errOut, s, groups, rows, asJSON, asCSV)
}

// teamGroups resolves a team assignment's groups from its live GitHub Teams,
// attaching each team's repo when it has been created.
func teamGroups(client githubapi.Client, s scope) ([]groupSource, error) {
	teams, err := configrepo.ListAssignmentGroupTeams(client, s.Org, s.Classroom, s.Assignment)
	if err != nil {
		return nil, err
	}
	names, err := orgrepos.ListNames(client, s.Org)
	if err != nil {
		return nil, err
	}
	repoByCounter := map[int]string{}
	for _, name := range names {
		if n, ok := contract.ParseGroupRepoCounter(name, s.Classroom, s.Assignment); ok {
			repoByCounter[n] = strings.ToLower(name)
		}
	}
	groups := make([]groupSource, 0, len(teams))
	for _, t := range teams {
		name := t.Record.Name
		if name == "" {
			// Mirrors the web's default display name (groupTeams.defaultName).
			name = fmt.Sprintf("Group %d", t.Counter)
		}
		members := t.Members
		if members == nil {
			members = []string{}
		}
		groups = append(groups, groupSource{
			Group:    fmt.Sprintf("%s%d", contract.GroupRepoSegment, t.Counter),
			Name:     name,
			TeamSlug: t.Slug,
			Repo:     repoByCounter[t.Counter],
			Members:  members,
		})
	}
	return groups, nil
}

// legacyGroups resolves a legacy group assignment's groups from its existing
// repos: `<classroom>-<assignment>-<founder>`, each with the founder plus its
// direct collaborators. A repo whose collaborator read fails is kept with nil
// members (reported as unreadable) rather than dropped or emptied.
func legacyGroups(client githubapi.Client, errOut io.Writer, s scope, siblings []string) ([]groupSource, error) {
	names, err := orgrepos.ListNames(client, s.Org)
	if err != nil {
		return nil, err
	}
	prefix := contract.AssignmentRepoPrefix(s.Classroom, s.Assignment)
	var groups []groupSource
	for _, name := range names {
		lower := strings.ToLower(name)
		founder, ok := strings.CutPrefix(lower, prefix)
		if !ok || founder == "" || matchesSibling(lower, s.Classroom, s.Assignment, siblings) {
			continue
		}
		g := groupSource{Group: founder, Repo: lower}
		collaborators, err := listDirectCollaborators(client, s.Org, name)
		if err != nil {
			_, _ = fmt.Fprintf(errOut, "warning: %s: %v\n", lower, err)
		} else {
			g.Members = append([]string{founder}, collaborators...)
		}
		groups = append(groups, g)
	}
	return groups, nil
}

// siblingSlugs returns the other assignment slugs of the classroom, for the
// slug-extending guard (`hw1` must not claim `hw1-bonus`'s repos).
func siblingSlugs(entries []assignment.AssignmentEntry, self string) []string {
	var out []string
	for _, e := range entries {
		if e.Slug != self {
			out = append(out, e.Slug)
		}
	}
	return out
}

// matchesSibling reports whether a repo name belongs to a sibling assignment
// whose prefix extends ours. Mirrors the web's existingAssignmentRepos guard.
func matchesSibling(lowerName, classroom, assignment string, siblings []string) bool {
	own := contract.AssignmentRepoPrefix(classroom, assignment)
	for _, slug := range siblings {
		sibling := contract.AssignmentRepoPrefix(classroom, slug)
		if strings.HasPrefix(sibling, own) && strings.HasPrefix(lowerName, sibling) {
			return true
		}
	}
	return false
}

// listDirectCollaborators reads a repo's direct collaborators (org-inherited
// access excluded, matching the web's group membership read).
func listDirectCollaborators(client githubapi.Client, org, repo string) ([]string, error) {
	base := fmt.Sprintf("repos/%s/%s/collaborators?affiliation=direct", url.PathEscape(org), url.PathEscape(repo))
	subject := org + "/" + repo
	collabs, err := githubapi.PaginateAll[struct {
		Login string `json:"login"`
	}](client, githubapi.ListPerPage, githubapi.ListMaxPages,
		func(page int) string {
			return fmt.Sprintf("%s&per_page=%d&page=%d", base, githubapi.ListPerPage, page)
		},
		func(path string, err error) error {
			return membership.ClassifyMembershipReadError(path, subject, err)
		})
	if err != nil {
		return nil, err
	}
	logins := make([]string, 0, len(collabs))
	for _, c := range collabs {
		logins = append(logins, c.Login)
	}
	return logins, nil
}

func render(out, errOut io.Writer, s scope, groups []groupSource, rows []memberRow, asJSON, asCSV bool) error {
	if asJSON {
		if rows == nil {
			rows = []memberRow{}
		}
		data, err := output.JSONPretty(rows)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
		return nil
	}
	if asCSV {
		w := csv.NewWriter(out)
		if err := w.Write(contract.GroupMembershipCSVColumns); err != nil {
			return err
		}
		for _, r := range rows {
			if err := w.Write(defangCells(r.cells())); err != nil {
				return err
			}
		}
		w.Flush()
		return w.Error()
	}

	if len(groups) == 0 {
		_, _ = fmt.Fprintf(out, "%s/%s: no groups yet\n", s.Classroom, s.Assignment)
		return nil
	}
	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "GROUP\tNAME\tUSERNAME\tSTUDENT\tEMAIL\tSECTION\tIN_ROSTER")
	for _, r := range rows {
		student := strings.TrimSpace(r.FirstName + " " + r.LastName)
		if r.Note != "" {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t(%s)\t\t\t\t\n", r.Group, dash(r.GroupName), r.Note)
			continue
		}
		if r.Username == "" {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t(no members)\t\t\t\t\n", r.Group, dash(r.GroupName))
			continue
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			r.Group, dash(r.GroupName), r.Username, dash(student), dash(r.Email), dash(r.Section), r.InRoster)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(errOut, summarize(s, groups, rows))
	return nil
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// summarize is the one-line stderr summary: group and member counts plus how
// many members the roster doesn't know, the number a teacher acts on.
func summarize(s scope, groups []groupSource, rows []memberRow) string {
	members, unknown := 0, 0
	for _, r := range rows {
		if r.Username == "" {
			continue
		}
		members++
		if r.InRoster == "no" {
			unknown++
		}
	}
	msg := fmt.Sprintf("%s/%s: %d group(s), %d member(s)", s.Classroom, s.Assignment, len(groups), members)
	if unknown > 0 {
		msg += fmt.Sprintf(", %d not on the roster", unknown)
	}
	return msg
}

// defangCells prefixes a `'` to any cell a spreadsheet would read as a
// formula, matching the web export and the roster writer. github_id is numeric
// and never matches; the enum columns are our own values.
func defangCells(cells []string) []string {
	out := make([]string, len(cells))
	for i, c := range cells {
		out[i] = configrepo.DefangCSVCell(c)
	}
	return out
}
