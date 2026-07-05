package roster

import (
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// rosterListEntry is the `--json` view of one students.csv row. Field names
// mirror the CSV columns. github_id is always present; 0 for an unresolved row
// — consumers branch on `github_id == 0`, not key presence.
type rosterListEntry struct {
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Email     string `json:"email"`
	Section   string `json:"section"`
	GitHubID  int64  `json:"github_id"`
}

func rosterListCmd() *cobra.Command {
	var (
		asJSON bool
		quiet  bool
	)
	cmd := &cobra.Command{
		Use:   "list <org> <classroom>",
		Short: "List the students in students.csv",
		Long: "List every student row in\n" +
			"<org>/classroom50/<classroom>/students.csv.\n\n" +
			"Default output is an aligned table on stdout (username, name,\n" +
			"email, section, github_id) with a one-line\n" +
			"`<org>/<repo>/<classroom>/students.csv: N student(s)` summary\n" +
			"on stderr.\n\n" +
			"Pass --json for the full array of\n" +
			"{username, first_name, last_name, email, section, github_id}\n" +
			"objects. Pass --quiet for one username per line on stdout (no\n" +
			"table, no stderr summary) -- pipeable into `xargs`, `grep`, or\n" +
			"an agent loop. --json takes precedence over --quiet.\n\n" +
			"An empty roster is a clean exit-0 (empty stdout under --json /\n" +
			"--quiet, a 'no students' note on stderr otherwise). A missing\n" +
			"students.csv points at `gh teacher classroom add`. This is a\n" +
			"read-only command; no commit lands on the repo.",
		Example: "  gh teacher roster list cs50-fall-2026 cs-principles\n" +
			"  gh teacher roster list cs50-fall-2026 cs-principles --json\n" +
			"  gh teacher roster list cs50-fall-2026 cs-principles --quiet",
		Args: cobra.ExactArgs(2),
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
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runRosterList(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, asJSON, quiet)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the full JSON array of {username, first_name, last_name, email, section, github_id} objects instead of the table")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Print one username per line (no table, no stderr summary)")
	return cmd
}

// runRosterList reads students.csv at the config repo's default branch
// and renders it as a table (default), a JSON array (--json), or
// username-only lines (--quiet). Read-only; no commit.
func runRosterList(client githubapi.Client, out, errOut io.Writer, org, classroom string, asJSON, quiet bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	rows, err := configrepo.LoadRoster(client, org, classroom, branch)
	if err != nil {
		return err
	}

	if asJSON {
		entries := make([]rosterListEntry, 0, len(rows))
		for _, r := range rows {
			// Only canonical fields are part of the `roster list --json`
			// contract; r.Extra is internal round-trip state, not output.
			entries = append(entries, rosterListEntry{
				Username:  r.Username,
				FirstName: r.FirstName,
				LastName:  r.LastName,
				Email:     r.Email,
				Section:   r.Section,
				GitHubID:  r.GitHubID,
			})
		}
		data, err := output.JSONPretty(entries)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
		return nil
	}

	if quiet {
		for _, r := range rows {
			_, _ = fmt.Fprintln(out, r.Username)
		}
		return nil
	}

	writeRosterTable(out, rows)
	_, _ = fmt.Fprintln(errOut, summarizeRosterList(org, classroom, len(rows)))
	return nil
}

// writeRosterTable renders rows as a tab-aligned table with a header.
// An empty roster prints just the header so the columns are still
// discoverable; the "no students" signal is the stderr summary.
func writeRosterTable(out io.Writer, rows []configrepo.RosterRow) {
	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "USERNAME\tNAME\tEMAIL\tSECTION\tGITHUB_ID")
	for _, r := range rows {
		name := strings.TrimSpace(r.FirstName + " " + r.LastName)
		githubID := ""
		if r.GitHubID != 0 {
			githubID = strconv.FormatInt(r.GitHubID, 10)
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n",
			dashIfEmpty(r.Username), dashIfEmpty(name),
			dashIfEmpty(r.Email), dashIfEmpty(r.Section), dashIfEmpty(githubID))
	}
	_ = tw.Flush()
}

// dashIfEmpty renders an empty cell as "-" so a blank column reads as
// "intentionally empty" rather than a layout glitch in the table.
func dashIfEmpty(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// summarizeRosterList: one-line stderr summary
// `<org>/<repo>/<classroom>/students.csv: <message>`.
func summarizeRosterList(org, classroom string, count int) string {
	path := fmt.Sprintf("%s/%s/%s", org, configrepo.ConfigRepoName, configrepo.RosterFilePath(classroom))
	if count == 0 {
		return fmt.Sprintf("%s: no students on the roster — add some with `gh teacher roster add %s %s <username>`", path, org, classroom)
	}
	return fmt.Sprintf("%s: %d student(s)", path, count)
}
