package groupcmd

import (
	"encoding/csv"
	"fmt"
	"io"
	"net/url"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
	"github.com/foundation50/gh-teacher/internal/orgrepos"
	"github.com/foundation50/gh-teacher/internal/output"
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
			"Each member is joined against <classroom>/roster.csv by GitHub id,\n" +
			"then by username, so a renamed account keeps its roster row;\n" +
			"`in_roster` is `no` for a collaborator or team member the roster\n" +
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
			scope, err := cliutil.ParseAssignmentScope(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runGroupList(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), scope, resolveFormat(asJSON, asCSV))
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit a JSON array of member objects instead of the table")
	cmd.Flags().BoolVar(&asCSV, "csv", false, "Emit the rows as CSV with the shared group-membership header")
	return cmd
}

type outputFormat int

const (
	formatTable outputFormat = iota
	formatJSON
	formatCSV
)

// resolveFormat is where "--json takes precedence" lives.
func resolveFormat(asJSON, asCSV bool) outputFormat {
	switch {
	case asJSON:
		return formatJSON
	case asCSV:
		return formatCSV
	default:
		return formatTable
	}
}

func runGroupList(client githubapi.Client, out, errOut io.Writer, s cliutil.AssignmentScope, format outputFormat) error {
	resolved, err := configrepo.ResolveAssignment(client, s,
		fmt.Sprintf("run `gh teacher assignment list %s %s` to see the registered slugs", s.Org, s.Classroom))
	if err != nil {
		return err
	}
	entry := resolved.Entry
	if entry.Mode != assignment.ModeTeam && entry.Mode != assignment.ModeGroup {
		return fmt.Errorf("assignment %q is an individual assignment (mode %s); it has no groups to list", entry.Slug, entry.Mode)
	}

	// The roster is the join target, so unlike a display-only read it is not
	// best-effort: without it every member would export as unrostered. Read it
	// first so a missing roster fails before the membership fan-out.
	roster, err := configrepo.LoadRosterLenient(client, s.Org, s.Classroom, resolved.Branch)
	if err != nil {
		return err
	}

	var groups []groupSource
	if entry.Mode == assignment.ModeTeam {
		groups, err = teamGroups(client, errOut, s)
	} else {
		groups, err = legacyGroups(client, errOut, s, siblingPrefixes(resolved.File.Assignments, s))
	}
	if err != nil {
		return err
	}

	rows := buildRows(groups, roster)
	return render(out, errOut, s, groups, rows, format)
}

// teamGroups resolves a team assignment's groups from its live GitHub Teams,
// attaching each team's repo when it has been created. A team whose member
// read fails is kept with nil members (reported as unreadable) rather than
// dropped, matching legacyGroups and the web.
func teamGroups(client githubapi.Client, errOut io.Writer, s cliutil.AssignmentScope) ([]groupSource, error) {
	teams, unreadable, err := configrepo.ListAssignmentGroupTeamsLenient(client, s.Org, s.Classroom, s.Assignment)
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
		g := groupSource{
			Group:    contract.GroupOwnerSegment(t.Counter),
			Name:     contract.GroupExportName(t.Record.Name, t.Counter),
			TeamSlug: t.Slug,
			Repo:     repoByCounter[t.Counter],
		}
		if readErr, failed := unreadable[t.Slug]; failed {
			_, _ = fmt.Fprintf(errOut, "warning: %s: %v\n", t.Slug, readErr)
		} else {
			g.Members = membersFromAccounts(t.MemberRefs)
		}
		groups = append(groups, g)
	}
	return groups, nil
}

// legacyGroups resolves a legacy group assignment's groups from its existing
// `<classroom>-<assignment>-<founder>` repos: the founder plus direct
// collaborators. A failed collaborator read keeps the group with nil members;
// a rate limit aborts, as in ListAssignmentGroupTeamsLenient.
func legacyGroups(client githubapi.Client, errOut io.Writer, s cliutil.AssignmentScope, siblings []string) ([]groupSource, error) {
	names, err := orgrepos.ListNames(client, s.Org)
	if err != nil {
		return nil, err
	}
	prefix := contract.AssignmentRepoPrefix(s.Classroom, s.Assignment)
	var groups []groupSource
	for _, name := range names {
		lower := strings.ToLower(name)
		founder, ok := strings.CutPrefix(lower, prefix)
		if !ok || founder == "" || hasAnyPrefix(lower, siblings) {
			continue
		}
		g := groupSource{Group: founder, Repo: lower}
		// Direct collaborators only (org-inherited access excluded), matching
		// the web's group membership read.
		collaborators, err := membership.ListAccounts(client,
			fmt.Sprintf("repos/%s/%s/collaborators?affiliation=direct", url.PathEscape(s.Org), url.PathEscape(name)), s.Org+"/"+name)
		switch {
		case cliutil.IsRateLimited(err):
			return nil, fmt.Errorf("%s: %w", lower, err)
		case err != nil:
			_, _ = fmt.Fprintf(errOut, "warning: %s: %v\n", lower, err)
		default:
			g.Members = append(membersFromAccounts(collaborators), member{Login: founder, Fallback: true})
		}
		groups = append(groups, g)
	}
	return groups, nil
}

// siblingPrefixes returns the repo-name prefixes of the classroom's other
// assignments that EXTEND this assignment's own prefix, so `hw1` never claims
// `hw1-bonus`'s repos. Mirrors the web's existingAssignmentRepos guard.
func siblingPrefixes(entries []assignment.AssignmentEntry, s cliutil.AssignmentScope) []string {
	own := contract.AssignmentRepoPrefix(s.Classroom, s.Assignment)
	var out []string
	for _, e := range entries {
		if e.Slug == s.Assignment {
			continue
		}
		if p := contract.AssignmentRepoPrefix(s.Classroom, e.Slug); strings.HasPrefix(p, own) {
			out = append(out, p)
		}
	}
	return out
}

func hasAnyPrefix(name string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func membersFromAccounts(accounts []membership.Account) []member {
	members := make([]member, 0, len(accounts))
	for _, a := range accounts {
		members = append(members, member{Login: a.Login, ID: a.ID})
	}
	return members
}

func render(out, errOut io.Writer, s cliutil.AssignmentScope, groups []groupSource, rows []memberRow, format outputFormat) error {
	switch format {
	case formatJSON:
		if rows == nil {
			rows = []memberRow{}
		}
		data, err := output.JSONPretty(rows)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
		return nil
	case formatCSV:
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
	// Student-influenced cells (team name, login, roster text) go through
	// output.Cell; note and in_roster are our own values. CSV and JSON stay
	// byte-exact.
	cell := output.Cell
	for _, r := range rows {
		student := strings.TrimSpace(r.FirstName + " " + r.LastName)
		if r.Note != "" {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t(%s)\t\t\t\t\n", cell(r.Group), cell(r.GroupName), r.Note)
			continue
		}
		if r.Username == "" {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t(no members)\t\t\t\t\n", cell(r.Group), cell(r.GroupName))
			continue
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			cell(r.Group), cell(r.GroupName), cell(r.Username), cell(student), cell(r.Email), cell(r.Section), r.InRoster)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(errOut, summarize(s, groups, rows))
	return nil
}

// summarize is the one-line stderr summary: group and member counts plus how
// many members the roster doesn't know, the number a teacher acts on.
func summarize(s cliutil.AssignmentScope, groups []groupSource, rows []memberRow) string {
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
