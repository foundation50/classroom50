// Package classroom implements the `gh teacher classroom` command group:
// managing classroom directories inside the <org>/classroom50 config repo
// (add/list/edit/remove) plus `classroom migrate` (imports an existing GitHub
// Classroom). Only NewCmd is exported. The four-file scaffold lands through the
// race-safe internal/configwrite seam.
package classroom

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/scores"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// Schema sentinels for the scaffolded files; schema-aware readers MUST branch
// on this field first. assignmentsSchemaV1 is single-sourced in the shared
// contract; the classroom sentinel is teacher-written only. The scores.json
// sentinel lives in internal/scores (shared with download).
const (
	classroomSchemaV1   = "classroom50/classroom/v1"
	assignmentsSchemaV1 = contract.AssignmentsSchemaV1
)

// rosterCSVHeader derives from configrepo.RosterColumns so they can't drift.
var rosterCSVHeader = strings.Join(configrepo.RosterColumns, ",") + "\n"

// defaultAutograderName is the "use the universal default autograder"
// sentinel, single-sourced from the shared contract; the migrate path stamps
// it onto imported assignments that don't name their own autograder.
const defaultAutograderName = contract.DefaultAutograderName

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "classroom",
		Short: "Manage classroom directories inside the config repo",
		Long: "Manage classrooms within an org's classroom50 config repo.\n\n" +
			"A classroom is a directory at the root of <org>/classroom50,\n" +
			"named by its short-name (e.g., cs-principles). Each classroom\n" +
			"holds four files: classroom.json (metadata), assignments.json\n" +
			"(assignment manifest), roster.csv (roster), and scores.json\n" +
			"(collected scores). The runner-side bootstrap (runner.py)\n" +
			"lives at the org level under .github/scripts/ and is shared\n" +
			"across all classrooms; the student-repo shim is embedded in\n" +
			"gh-student.\n\n" +
			"Per-classroom and per-assignment autograder code is added\n" +
			"after `classroom add`: drop a classroom default at\n" +
			"<classroom>/autograder.py (via `gh teacher autograder\n" +
			"set-default`) and per-assignment overrides at\n" +
			"<classroom>/autograders/<slug>/ via ordinary git operations.",
	}
	cmd.AddCommand(classroomAddCmd())
	cmd.AddCommand(classroomListCmd())
	cmd.AddCommand(classroomEditCmd())
	cmd.AddCommand(classroomArchiveCmd())
	cmd.AddCommand(classroomUnarchiveCmd())
	cmd.AddCommand(classroomRemoveCmd())
	cmd.AddCommand(classroomMigrateCmd())
	return cmd
}

func classroomAddCmd() *cobra.Command {
	var (
		name     string
		term     string
		unlisted bool
		key      string
	)

	cmd := &cobra.Command{
		Use:   "add <org> <short-name>",
		Short: "Add a new classroom directory inside the config repo",
		Long: "Create the directory <short-name>/ inside <org>/classroom50\n" +
			"and populate it with a four-file scaffold: classroom.json,\n" +
			"assignments.json, roster.csv, and scores.json.\n\n" +
			"Short-name rules (must match ^[a-z0-9][a-z0-9-]{1,38}$):\n" +
			"  - 2-39 characters total\n" +
			"  - lowercase letters, digits, or hyphens\n" +
			"  - must start with a letter or digit (not a hyphen)\n\n" +
			"These mirror GitHub's repo-name constraints because the\n" +
			"short-name flows into student repo names like\n" +
			"`<short-name>-<assignment>-<username>` (see `gh student\n" +
			"accept`).\n\n" +
			"Unlisted resources (opt-in): pass --unlisted to publish this\n" +
			"classroom's resources at an unguessable URL path segment\n" +
			"(`<classroom>/<key>/...`) instead of the guessable default. This\n" +
			"is obscurity, not access control — anyone who has the link can\n" +
			"read the files, and links can leak. You'll be shown a generated\n" +
			"key to accept or replace, or supply your own with --key <value>.\n" +
			"Off by default.\n\n" +
			"If <org>/classroom50 doesn't exist yet, run `gh teacher init\n" +
			"<org>` first. If <short-name> already exists in the repo, the\n" +
			"command exits with an error rather than overwriting state —\n" +
			"use `gh teacher roster add` or `gh teacher assignment add` to\n" +
			"modify an existing classroom.",
		Example: "  gh teacher classroom add cs50-fall-2026 cs-principles --name \"CS Principles\" --term Spring-2026\n" +
			"  gh teacher classroom add cs50-fall-2026 intro-java\n" +
			"  gh teacher classroom add cs50-fall-2026 cs-principles --unlisted",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true

			org, shortName, err := parseOrgShortNameArgs(args)
			if err != nil {
				return err
			}

			// Resolve the optional capability-URL key before any API call so
			// an invalid --key fails fast. An explicit --key implies opt-in
			// even without --unlisted.
			resolvedSecret, err := resolveClassroomSecret(
				cmd.InOrStdin(), cmd.ErrOrStderr(),
				cmd.Flags().Changed("unlisted") && unlisted,
				cmd.Flags().Changed("key"), strings.TrimSpace(key),
			)
			if err != nil {
				return err
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return addClassroom(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, shortName, strings.TrimSpace(name), strings.TrimSpace(term), resolvedSecret)
		},
	}

	cmd.Flags().StringVar(&name, "name", "", `Full display name for the classroom (e.g. "CS Principles")`)
	cmd.Flags().StringVar(&term, "term", "", "Term identifier (e.g. Spring-2026)")
	cmd.Flags().BoolVar(&unlisted, "unlisted", false, "Publish this classroom's resources at an unguessable URL path segment (obscurity, not access control; prompts to accept a generated key)")
	cmd.Flags().StringVar(&key, "key", "", "Supply a specific access key for the unlisted URL (implies --unlisted); must match "+configrepo.SecretPatternDescription)
	return cmd
}

// resolveClassroomSecret turns --unlisted / --key into the key to persist
// (empty = normal guessable-URL classroom). Precedence: an explicit --key is
// validated and used (opt-in); --unlisted with no --key generates a candidate
// and prompts; neither → empty. The prompt reads one line from `in`; an empty
// line accepts the candidate.
func resolveClassroomSecret(in io.Reader, errOut io.Writer, unlisted bool, keySet bool, key string) (string, error) {
	if keySet {
		if err := configrepo.ValidateSecret(key); err != nil {
			return "", err
		}
		return key, nil
	}
	if !unlisted {
		return "", nil
	}

	candidate, err := configrepo.GenerateSecret(configrepo.DefaultSecretLength)
	if err != nil {
		return "", err
	}
	_, _ = fmt.Fprintf(errOut, "Generated access key for the unlisted URL: %s\n", candidate)
	_, _ = fmt.Fprintf(errOut, "Press Enter to accept, or type your own (%s): ", configrepo.SecretPatternDescription)
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read access key confirmation: %w", err)
	}
	entered := strings.TrimSpace(line)
	if entered == "" {
		return candidate, nil
	}
	if err := configrepo.ValidateSecret(entered); err != nil {
		return "", err
	}
	return entered, nil
}

// addClassroom writes the four-file scaffold in one Tree commit via
// configwrite.CommitTree. The existence probe runs inside the build callback so
// a same-classroom race surfaces as "already exists" rather than clobbering.
func addClassroom(client githubapi.Client, out, errOut io.Writer, org, shortName, name, term, secret string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	// Cheap up-front existence probe BEFORE any GitHub side effects (team
	// creation, grants, membership). The authoritative race guard still runs
	// in the build callback, but this fails the common "already exists" case
	// fast with zero orphaned teams/grants.
	if exists, err := configrepo.ContentsExists(client, org, configrepo.ConfigRepoName, shortName, branch); err != nil {
		return err
	} else if exists {
		return fmt.Errorf("classroom %q already exists in %s/%s — refusing to overwrite (inspect or edit at https://github.com/%s/%s/tree/%s/%s)",
			shortName, org, configrepo.ConfigRepoName,
			org, configrepo.ConfigRepoName, branch, shortName)
	}

	// Create (or adopt) the per-classroom team before scaffolding so its
	// id/slug can be recorded in classroom.json. This team later lets rostered
	// students read private org-owned templates.
	team, err := configrepo.EnsureClassroomTeam(client, org, shortName)
	if err != nil {
		return fmt.Errorf("create classroom team: %w", err)
	}

	// Create (or adopt) the staff teams (instructor, ta), grant each write on
	// the config repo, and seed the acting teacher as instructor maintainer,
	// mirroring the web.
	staffTeams, err := seedStaffTeams(client, errOut, org, shortName)
	if err != nil {
		return err
	}

	files, err := classroomScaffold(org, shortName, name, term, secret, nil, nil, &team, staffTeams)
	if err != nil {
		return err
	}

	build := func(parentSHA string) (map[string]string, error) {
		// Authoritative race guard; also catches partial-state classrooms
		// (the dir probe is 404 only when nothing exists there).
		exists, err := configrepo.ContentsExists(client, org, configrepo.ConfigRepoName, shortName, parentSHA)
		if err != nil {
			return nil, err
		}
		if exists {
			return nil, fmt.Errorf("classroom %q already exists in %s/%s — refusing to overwrite (inspect or edit at https://github.com/%s/%s/tree/%s/%s)",
				shortName, org, configrepo.ConfigRepoName,
				org, configrepo.ConfigRepoName, branch, shortName)
		}
		return files, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("Add %s classroom (gh teacher classroom add)", shortName))
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	// stdout: parseable confirmation lines. stderr: advisory hints.
	_, _ = fmt.Fprintf(out, "%s/%s: added classroom %s (%d files)\n", org, configrepo.ConfigRepoName, shortName, len(files))
	_, _ = fmt.Fprintf(out, "%s: classroom team %s ready\n", org, team.Slug)
	if staffTeams != nil && staffTeams.Instructor != nil && staffTeams.TA != nil {
		_, _ = fmt.Fprintf(out, "%s: staff teams %s, %s ready\n", org, staffTeams.Instructor.Slug, staffTeams.TA.Slug)
	}
	if secret != "" {
		_, _ = fmt.Fprintf(out, "%s: resources published at an unlisted URL (key %q); share the accept link/command from the assignment page\n", org, secret)
	}
	_, _ = fmt.Fprintf(errOut, "View at https://github.com/%s/%s/tree/%s/%s\n", org, configrepo.ConfigRepoName, branch, shortName)
	_, _ = fmt.Fprintf(errOut, "Next: gh teacher roster add %s %s <username>\n", org, shortName)
	return nil
}

// seedStaffTeams creates (or adopts) the instructor + ta teams, grants each
// write on the config repo, and adds the acting teacher as instructor
// maintainer — shared by `classroom add` and `classroom migrate`. The
// maintainer add is best-effort: a CurrentUser/membership failure warns but
// doesn't fail creation (the teacher can self-add via the web).
func seedStaffTeams(client githubapi.Client, errOut io.Writer, org, shortName string) (*configrepo.StaffTeamsRef, error) {
	staffTeams, err := configrepo.EnsureStaffTeams(client, org, shortName)
	if err != nil {
		return nil, fmt.Errorf("create staff teams: %w", err)
	}
	if staffTeams.Instructor == nil {
		return staffTeams, nil
	}
	login, _, uerr := githubapi.CurrentUser(client)
	if uerr != nil || login == "" {
		// Surface the skip so a silent CurrentUser failure isn't invisible.
		_, _ = fmt.Fprintf(errOut, "Warning: created the instructor team but couldn't resolve your GitHub login to add you (%v); add yourself at https://github.com/orgs/%s/teams/%s.\n",
			uerr, org, staffTeams.Instructor.Slug)
		return staffTeams, nil
	}
	if merr := configrepo.AddTeamMembershipWithRole(client, org, staffTeams.Instructor.Slug, login, configrepo.TeamMaintainer); merr != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: created the instructor team but couldn't add you (%s) to it (%v); add yourself at https://github.com/orgs/%s/teams/%s.\n",
			login, merr, org, staffTeams.Instructor.Slug)
	}
	return staffTeams, nil
}

// classroomSummary is the per-classroom view for `classroom list --json`: the
// human-relevant subset of classroom.json. Active mirrors the lifecycle flag
// (omitted when active/absent, false when archived).
type classroomSummary struct {
	ShortName string              `json:"short_name"`
	Name      string              `json:"name"`
	Term      string              `json:"term"`
	Team      *configrepo.TeamRef `json:"team,omitempty"`
	Active    *bool               `json:"active,omitempty"`
}

func classroomListCmd() *cobra.Command {
	var (
		asJSON bool
		quiet  bool
		all    bool
	)
	cmd := &cobra.Command{
		Use:   "list <org>",
		Short: "List the classrooms registered in the config repo",
		Long: "List every classroom registered in <org>/classroom50.\n\n" +
			"A classroom is a root-level directory holding a classroom.json;\n" +
			"directories without one (e.g. .github) are skipped.\n\n" +
			"Archived classrooms (classroom.json `active: false`) are hidden\n" +
			"by default, mirroring the web's default classes list; pass --all\n" +
			"to include them. In the default output an archived classroom is\n" +
			"tagged ` (archived)` after its short-name; in --json it carries\n" +
			"`\"active\": false`.\n\n" +
			"Default output is one short-name per line on stdout — pipeable\n" +
			"into `xargs`, `grep`, or an agent loop. Pass --json to emit the\n" +
			"full array of {short_name, name, term} objects instead. A\n" +
			"one-line `<org>/<repo>: N classroom(s)` summary goes to stderr\n" +
			"unless --quiet is set.\n\n" +
			"This is a read-only command; no commit lands on the repo.",
		Example: "  gh teacher classroom list cs50-fall-2026\n" +
			"  gh teacher classroom list cs50-fall-2026 --all\n" +
			"  gh teacher classroom list cs50-fall-2026 --json",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			if org == "" {
				return errors.New("org must not be empty")
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runClassroomList(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, asJSON, quiet, all)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the full JSON array of {short_name, name, term, active} objects instead of one short-name per line")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress the stderr summary so stdout is the only output stream")
	cmd.Flags().BoolVar(&all, "all", false, "Include archived classrooms (active:false), which are hidden by default")
	return cmd
}

// runClassroomList: one branch resolve, one root listing, then one
// classroom.json read per directory. No commit. Archived classrooms
// (active:false) are dropped unless `all`.
func runClassroomList(client githubapi.Client, out, errOut io.Writer, org string, asJSON, quiet, all bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	entries, _, err := configrepo.ListDirContents(client, org, configrepo.ConfigRepoName, "", branch)
	if err != nil {
		return err
	}

	var classrooms []classroomSummary
	for _, e := range entries {
		if e.Type != "dir" {
			continue
		}
		c, ok, err := configrepo.LoadClassroom(client, org, e.Name, branch)
		if err != nil {
			return err
		}
		if !ok {
			continue // a dir without classroom.json isn't a classroom
		}
		if c.IsArchived() && !all {
			continue // hidden by default, like the web's classes list
		}
		classrooms = append(classrooms, classroomSummary{
			ShortName: e.Name,
			Name:      c.Name,
			Term:      c.Term,
			Team:      c.Team,
			Active:    c.Active,
		})
	}

	if asJSON {
		if classrooms == nil {
			classrooms = []classroomSummary{}
		}
		data, err := output.JSONPretty(classrooms)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
	} else {
		for _, c := range classrooms {
			if c.Active != nil && !*c.Active {
				_, _ = fmt.Fprintf(out, "%s (archived)\n", c.ShortName)
			} else {
				_, _ = fmt.Fprintln(out, c.ShortName)
			}
		}
	}

	if !quiet {
		_, _ = fmt.Fprintln(errOut, summarizeClassroomList(org, len(classrooms)))
	}
	return nil
}

// summarizeClassroomList: one-line stderr summary `<org>/<repo>: <message>`.
func summarizeClassroomList(org string, count int) string {
	path := fmt.Sprintf("%s/%s", org, configrepo.ConfigRepoName)
	switch count {
	case 0:
		return fmt.Sprintf("%s: no classrooms registered yet — use `gh teacher classroom add %s <short-name>` to create one", path, org)
	case 1:
		return fmt.Sprintf("%s: 1 classroom", path)
	default:
		return fmt.Sprintf("%s: %d classrooms", path, count)
	}
}

func classroomEditCmd() *cobra.Command {
	var (
		name string
		term string
	)
	cmd := &cobra.Command{
		Use:   "edit <org> <short-name>",
		Short: "Update a classroom's display name or term",
		Long: "Update the display name and/or term in\n" +
			"<org>/classroom50/<short-name>/classroom.json. At least one of\n" +
			"--name or --term must be provided.\n\n" +
			"The short-name itself is immutable — it flows into student\n" +
			"repo names (`<short-name>-<assignment>-<username>`), so renaming\n" +
			"would orphan existing repos. To rename, add a new classroom.\n\n" +
			"Lands as a single Tree commit on the config repo. Re-running\n" +
			"with values that already match the file is a no-op.",
		Example: "  gh teacher classroom edit cs50-fall-2026 cs-principles --name \"CS Principles\"\n" +
			"  gh teacher classroom edit cs50-fall-2026 cs-principles --term Fall-2026",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, shortName, err := parseOrgShortNameArgs(args)
			if err != nil {
				return err
			}
			setName := cmd.Flags().Changed("name")
			setTerm := cmd.Flags().Changed("term")
			if !setName && !setTerm {
				return errors.New("nothing to update — pass --name and/or --term")
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return editClassroom(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, shortName, setName, strings.TrimSpace(name), setTerm, strings.TrimSpace(term))
		},
	}
	cmd.Flags().StringVar(&name, "name", "", `New display name for the classroom (e.g. "CS Principles")`)
	cmd.Flags().StringVar(&term, "term", "", "New term identifier (e.g. Fall-2026)")
	return cmd
}

// commitClassroomMutation is the shared read-modify-write skeleton for the
// classroom.json mutators (edit, archive/unarchive): reads the file inside the
// build callback, applies `mutate`, re-commits, short-circuiting to a no-op
// when the body is unchanged. The caller owns all output.
func commitClassroomMutation(client githubapi.Client, org, shortName, message string, mutate func(*configrepo.ClassroomJSON)) (noop bool, branch string, err error) {
	branch, err = configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return false, "", err
	}
	path := configrepo.ClassroomFilePath(shortName)
	build := func(parentSHA string) (map[string]string, error) {
		noop = false
		data, ok, err := configrepo.ReadFileContents(client, org, configrepo.ConfigRepoName, path, parentSHA)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("classroom %q not found in %s/%s — run `gh teacher classroom add %s %s` first",
				shortName, org, configrepo.ConfigRepoName, org, shortName)
		}
		var c configrepo.ClassroomJSON
		if err := json.Unmarshal(data, &c); err != nil {
			return nil, fmt.Errorf("%s/%s/%s: %w", org, configrepo.ConfigRepoName, path, err)
		}
		mutate(&c)
		updated, err := output.JSONPretty(c)
		if err != nil {
			return nil, fmt.Errorf("encode classroom.json: %w", err)
		}
		if string(data) == string(updated) {
			noop = true
			return nil, nil
		}
		return map[string]string{path: string(updated)}, nil
	}
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return false, "", err
	}
	return noop, branch, nil
}

// editClassroom applies the changed display name/term to classroom.json. An
// unchanged body short-circuits to a no-op.
func editClassroom(client githubapi.Client, out, errOut io.Writer, org, shortName string, setName bool, name string, setTerm bool, term string) error {
	message := contract.PrefixCommit(fmt.Sprintf("Edit %s classroom (gh teacher classroom edit)", shortName))
	noop, branch, err := commitClassroomMutation(client, org, shortName, message, func(c *configrepo.ClassroomJSON) {
		if setName {
			c.Name = name
		}
		if setTerm {
			c.Term = term
		}
	})
	if err != nil {
		return err
	}
	if noop {
		_, _ = fmt.Fprintf(out, "%s/%s: classroom %s already up to date (no changes)\n", org, configrepo.ConfigRepoName, shortName)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s: updated classroom %s\n", org, configrepo.ConfigRepoName, shortName)
	_, _ = fmt.Fprintf(errOut, "View at https://github.com/%s/%s/tree/%s/%s\n", org, configrepo.ConfigRepoName, branch, shortName)
	return nil
}

// classroomArchiveCmd / classroomUnarchiveCmd toggle the `active` flag (archive
// → active:false; unarchive → drop the field, so absent = active). Two verbs
// rather than an `--active` flag on `edit` so the intent is obvious and edit's
// "at least one of --name/--term" contract stays unchanged.
func classroomArchiveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "archive <org> <short-name>",
		Short: "Archive a classroom (set active:false)",
		Long: "Mark <org>/classroom50/<short-name>/classroom.json as archived by\n" +
			"setting `active: false` (schema classroom50/classroom/v1).\n\n" +
			"Archived classrooms are hidden from the default `classroom list`\n" +
			"(pass --all to see them) and refuse new `assignment add`/`reuse`\n" +
			"writes, mirroring the web. Existing student repos are untouched.\n\n" +
			"Student `accept` is blocked only once the archival flag has been\n" +
			"published to Pages (the next `publish-pages` run surfaces `active`\n" +
			"in classrooms-index.json); until then the accept-guard is the\n" +
			"documented v1 limitation.\n\n" +
			"Re-running on an already-archived classroom is a no-op. Reverse\n" +
			"with `gh teacher classroom unarchive`.",
		Example: "  gh teacher classroom archive cs50-fall-2026 cs-principles",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, shortName, err := parseOrgShortNameArgs(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return setClassroomActive(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, shortName, false)
		},
	}
	return cmd
}

func classroomUnarchiveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "unarchive <org> <short-name>",
		Short: "Unarchive a classroom (restore it to active)",
		Long: "Restore an archived classroom to active by dropping the `active`\n" +
			"flag from <org>/classroom50/<short-name>/classroom.json. Per the\n" +
			"classroom50/classroom/v1 contract, an absent `active` reads as\n" +
			"active (same state as a classroom that was never archived), so\n" +
			"unarchive removes the key rather than writing `active: true`.\n\n" +
			"Re-running on an already-active classroom is a no-op.",
		Example: "  gh teacher classroom unarchive cs50-fall-2026 cs-principles",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, shortName, err := parseOrgShortNameArgs(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return setClassroomActive(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, shortName, true)
		},
	}
	return cmd
}

// parseOrgShortNameArgs is the shared <org> <short-name> validation for the
// classroom subcommands that take that pair.
func parseOrgShortNameArgs(args []string) (org, shortName string, err error) {
	org = strings.TrimSpace(args[0])
	shortName = strings.TrimSpace(args[1])
	if org == "" {
		return "", "", errors.New("org must not be empty")
	}
	if shortName == "" {
		return "", "", errors.New("short-name must not be empty")
	}
	if err := validate.ShortName(shortName, "short-name"); err != nil {
		return "", "", err
	}
	return org, shortName, nil
}

// setClassroomActive flips the `active` flag: true clears the field (absent =
// active), false stamps `active: false`. No-op when unchanged.
func setClassroomActive(client githubapi.Client, out, errOut io.Writer, org, shortName string, active bool) error {
	verb, verbCap := "archive", "Archive"
	if active {
		verb, verbCap = "unarchive", "Unarchive"
	}
	message := contract.PrefixCommit(fmt.Sprintf("%s %s classroom (gh teacher classroom %s)", verbCap, shortName, verb))
	noop, branch, err := commitClassroomMutation(client, org, shortName, message, func(c *configrepo.ClassroomJSON) {
		if active {
			c.Active = nil // drop the flag: absent = active
		} else {
			f := false
			c.Active = &f
		}
	})
	if err != nil {
		return err
	}
	if noop {
		state := "archived"
		if active {
			state = "active"
		}
		_, _ = fmt.Fprintf(out, "%s/%s: classroom %s already %s (no changes)\n", org, configrepo.ConfigRepoName, shortName, state)
		return nil
	}
	if active {
		_, _ = fmt.Fprintf(out, "%s/%s: unarchived classroom %s (now active)\n", org, configrepo.ConfigRepoName, shortName)
	} else {
		_, _ = fmt.Fprintf(out, "%s/%s: archived classroom %s (active:false)\n", org, configrepo.ConfigRepoName, shortName)
		_, _ = fmt.Fprintf(errOut, "Note: student `accept` is blocked only after the next publish-pages run surfaces `active` in classrooms-index.json.\n")
	}
	_, _ = fmt.Fprintf(errOut, "View at https://github.com/%s/%s/tree/%s/%s\n", org, configrepo.ConfigRepoName, branch, shortName)
	return nil
}

func classroomRemoveCmd() *cobra.Command {
	var skipConfirm bool
	cmd := &cobra.Command{
		Use:   "remove <org> <short-name>",
		Short: "Remove a classroom directory from the config repo",
		Long: "Delete the <short-name>/ directory (classroom.json,\n" +
			"assignments.json, roster.csv, scores.json, and any\n" +
			"autograders/) from <org>/classroom50 in a single commit.\n\n" +
			"This removes the classroom's configuration only. It does NOT\n" +
			"delete student assignment repositories already created in the\n" +
			"org — remove those via the GitHub web UI if intended.\n\n" +
			"You'll be asked to type the short-name to confirm; pass --yes\n" +
			"to skip the prompt (scripted runs only).",
		Example: "  gh teacher classroom remove cs50-fall-2026 cs-principles\n" +
			"  gh teacher classroom remove --yes cs50-fall-2026 cs-principles",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, shortName, err := parseOrgShortNameArgs(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return removeClassroom(client, cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr(), org, shortName, skipConfirm)
		},
	}
	cmd.Flags().BoolVar(&skipConfirm, "yes", false, "Skip the typed-confirmation prompt (scripted runs only)")
	return cmd
}

// removeClassroom deletes the whole <short-name>/ subtree in one commit via
// configwrite.CommitTreeChange. The subtree's blob paths are enumerated inside
// the build callback so the deletion set stays consistent with its parent.
func removeClassroom(client githubapi.Client, in io.Reader, out, errOut io.Writer, org, shortName string, skipConfirm bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	// Preflight existence so a typo doesn't reach the confirmation
	// prompt. The authoritative read happens inside build.
	exists, err := configrepo.ContentsExists(client, org, configrepo.ConfigRepoName, shortName, branch)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("classroom %q not found in %s/%s — nothing to remove", shortName, org, configrepo.ConfigRepoName)
	}

	if !skipConfirm {
		if err := confirmClassroomRemove(in, out, shortName); err != nil {
			return err
		}
	}

	// Resolve the team refs BEFORE the commit deletes classroom.json.
	// DeleteClassroomTeam deletes by the persisted slug and verifies the id,
	// so a re-slugged team is still removed and an unrelated occupant never
	// touched. No team block → empty ref (no-op). Staff teams swept the same
	// way, mirroring the web.
	var team configrepo.TeamRef
	if t, ok, terr := configrepo.ResolveClassroomTeam(client, org, shortName, branch); terr != nil {
		return terr
	} else if ok {
		team = t
	}
	var staffTeams []configrepo.TeamRef
	for _, role := range configrepo.StaffRoles {
		if t, ok, terr := configrepo.ResolveClassroomStaffTeam(client, org, shortName, branch, role); terr != nil {
			return terr
		} else if ok {
			staffTeams = append(staffTeams, t)
		}
	}

	var deleted int
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		deleted = 0
		paths, err := configrepo.ListSubtreeBlobPaths(client, org, configrepo.ConfigRepoName, parentSHA, shortName)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		deleted = len(paths)
		return configwrite.CommitChange{Deletes: paths}, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("Remove %s classroom (gh teacher classroom remove)", shortName))
	sha, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build)
	if err != nil {
		return err
	}
	if sha == "" {
		_, _ = fmt.Fprintf(out, "%s/%s: classroom %s already gone (nothing to remove)\n", org, configrepo.ConfigRepoName, shortName)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s: removed classroom %s (%d files)\n", org, configrepo.ConfigRepoName, shortName, deleted)

	// Delete the per-classroom team (idempotent; 404 = gone). Its grants +
	// memberships go with it. A delete failure is surfaced but doesn't undo
	// the config removal.
	if team.Slug != "" {
		if err := configrepo.DeleteClassroomTeam(client, org, team); err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: removed the classroom config but could not delete its team %q (%v); delete it by hand at https://github.com/orgs/%s/teams if it lingers.\n",
				org, team.Slug, err, org)
			return nil
		}
		_, _ = fmt.Fprintf(out, "%s: deleted classroom team %s\n", org, team.Slug)
	}
	// Sweep the staff teams too (idempotent; 404 = gone). A failure on one is
	// surfaced but doesn't undo the config removal or block the others.
	for _, st := range staffTeams {
		if err := configrepo.DeleteClassroomTeam(client, org, st); err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: removed the classroom config but could not delete its staff team %q (%v); delete it by hand at https://github.com/orgs/%s/teams if it lingers.\n",
				org, st.Slug, err, org)
			continue
		}
		_, _ = fmt.Fprintf(out, "%s: deleted staff team %s\n", org, st.Slug)
	}
	return nil
}

// confirmClassroomRemove prompts on `out` and reads one line from `in`. Returns
// nil iff the trimmed line equals the short-name; any other input (mismatch,
// EOF, error) aborts. Single read, no retry.
func confirmClassroomRemove(in io.Reader, out io.Writer, shortName string) error {
	_, _ = fmt.Fprintf(out, "This will delete classroom %q and all its files. Type the short-name (%s) to confirm: ", shortName, shortName)
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("read confirmation: %w", err)
	}
	if strings.TrimSpace(line) != shortName {
		return errors.New("confirmation did not match short-name — aborted without deleting anything")
	}
	return nil
}

// classroomScaffold returns destination-path → content for the four-file
// scaffold. A nil `entries` normalizes to an empty slice so assignments.json
// marshals as `[]`. `migration` populates classroom.json's optional
// `migrated_from` block.
func classroomScaffold(org, shortName, name, term, secret string, entries []assignment.AssignmentEntry, migration *configrepo.MigratedFromRef, team *configrepo.TeamRef, staffTeams *configrepo.StaffTeamsRef) (map[string]string, error) {
	classroom := configrepo.ClassroomJSON{
		Schema:       classroomSchemaV1,
		Name:         name,
		ShortName:    shortName,
		Term:         term,
		Org:          org,
		Secret:       secret,
		Team:         team,
		Teams:        staffTeams,
		MigratedFrom: migration,
	}
	classroomBytes, err := output.JSONPretty(classroom)
	if err != nil {
		return nil, fmt.Errorf("encode classroom.json: %w", err)
	}

	if entries == nil {
		entries = []assignment.AssignmentEntry{}
	}
	assignmentsBytes, err := assignment.EncodeAssignments(assignment.AssignmentsJSON{
		Schema:      assignmentsSchemaV1,
		Assignments: entries,
	})
	if err != nil {
		return nil, fmt.Errorf("encode assignments.json: %w", err)
	}

	emptyScores := scores.File{
		Schema:      scores.SchemaV1,
		Assignments: map[string]scores.AssignmentBucket{},
	}
	scoresBytes, err := output.JSONPretty(emptyScores)
	if err != nil {
		return nil, fmt.Errorf("encode scores.json: %w", err)
	}

	return map[string]string{
		shortName + "/classroom.json":             string(classroomBytes),
		shortName + "/assignments.json":           string(assignmentsBytes),
		shortName + "/" + contract.RosterFilename: rosterCSVHeader,
		shortName + "/scores.json":                string(scoresBytes),
	}, nil
}
