// Package assignmentcmd implements the `gh teacher assignment` command group:
// add / reuse / list / remove entries in a classroom's assignments.json, plus
// the `assignment test` subgroup for declarative test specs. Only NewCmd is
// exported. Distinct from internal/assignment, the pure data layer it consumes.
package assignmentcmd

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	autograderseam "github.com/foundation50/gh-teacher/internal/autograder"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "assignment",
		Short: "Manage assignments inside the config repo",
		Long: "Manage assignment entries in <org>/classroom50/<classroom>/assignments.json.\n\n" +
			"Subcommands:\n" +
			"  add     register or upsert an assignment\n" +
			"  remove  drop an assignment entry (does not touch existing student repos)\n" +
			"  list    print every assignment slug registered in a classroom\n\n" +
			"Writes use a single Tree commit on <org>/classroom50's default\n" +
			"branch with the same optimistic-update-with-rebase loop the roster\n" +
			"commands use, so concurrent edits don't silently lose each other's\n" +
			"work. Each entry carries an immutable `slug` (the same name used in\n" +
			"student repo names like `<classroom>-<slug>-<username>`), a\n" +
			"template ref pointing at the starter-code repo, and the autograder\n" +
			"name that picks which shim YAML (`<classroom>/autograders/<name>.yaml`)\n" +
			"— and thus which reusable runner — handles submissions for this\n" +
			"assignment. Per-assignment grading lives separately at\n" +
			"`<classroom>/autograders/<slug>/autograder.py` (entrypoint),\n" +
			"with optional sibling fixtures alongside (see the Autograders\n" +
			"wiki page).",
	}
	cmd.AddCommand(assignmentAddCmd())
	cmd.AddCommand(assignmentReuseCmd())
	cmd.AddCommand(assignmentRemoveCmd())
	cmd.AddCommand(assignmentListCmd())
	cmd.AddCommand(assignmentTestCmd())
	return cmd
}

// assignmentAddCmd: `--mode` accepts `individual` (default) or `group`. Group
// mode requires `--max-group-size` (>= 2), enforced within the CLI when
// students join (direct GitHub-UI invites can bypass it — documented).
func assignmentAddCmd() *cobra.Command {
	var (
		name          string
		template      string
		description   string
		due           string
		mode          string
		maxGroupSize  int
		autograder    string
		runtimeFile   string
		testsFile     string
		feedbackPR    bool
		emptyRepo     bool
		allowedFiles  []string
		passThreshold int
	)

	cmd := &cobra.Command{
		Use:   "add <org> <classroom> <slug>",
		Short: "Add or upsert an assignment in assignments.json",
		Long: "Register an assignment — its template repo and the autograder it\n" +
			"runs against — in <org>/classroom50/<classroom>/assignments.json.\n\n" +
			"`<slug>` must match ^[a-z0-9][a-z0-9-]{1,38}$ (the same shape as\n" +
			"classroom short-names) because student repos are named\n" +
			"`<classroom>-<slug>-<username>`. Required flags: --name and\n" +
			"--template. If the assignment slug already exists in\n" +
			"assignments.json, this command replaces the entry in place\n" +
			"(idempotent for repeated edits to the same assignment).\n\n" +
			"--empty-repo creates truly bare student repos: no README, no\n" +
			".classroom50.yaml marker, no autograde workflow — for assignments\n" +
			"where students build everything (including their own GitHub\n" +
			"Actions) from scratch. Autograding and the Feedback PR are\n" +
			"disabled, and the setting is immutable after creation: enabling\n" +
			"autograding later would require retrofitting control files into\n" +
			"every already-accepted repo, which classroom50 does not do.\n" +
			"Mutually exclusive with --template, --tests, --feedback-pr,\n" +
			"--allowed-files, and --pass-threshold.\n\n" +
			"--template parses `<owner>/<repo>` or `<owner>/<repo>@<branch>`.\n" +
			"When the branch is omitted, the template repo's default branch is\n" +
			"used. The template repo must be marked `is_template: true` (set\n" +
			"in Settings → \"Template repository\"); if your account can't see\n" +
			"the repo, the CLI returns the cross-org visibility message.\n\n" +
			"--runtime points at a JSON file describing the runtime\n" +
			"environment for this assignment's autograde job: which\n" +
			"runner label(s), optional language toolchains\n" +
			"(python/node/java/go/rust), optional apt packages, or a custom\n" +
			"container image. `runs-on` mirrors GitHub Actions itself —\n" +
			"a single label (\"ubuntu-latest\") or an array of labels\n" +
			"([\"self-hosted\", \"gpu\"]) for a custom / self-hosted runner.\n" +
			"Pass `-` to read the JSON from stdin instead of a file\n" +
			"(one-shot agent flows).\n" +
			"Omit for the defaults (ubuntu-latest + Python 3.12).\n" +
			"See the Autograders wiki page for the JSON schema and\n" +
			"worked examples.\n\n" +
			"--autograder is reserved for the rare case where you need to\n" +
			"call a *different reusable workflow* entirely (not just\n" +
			"different language toolchains — for that, use --runtime). The\n" +
			"name resolves to <classroom>/autograders/<name>.yaml; the\n" +
			"referenced file must exist at write time. The default is\n" +
			"`default`, which uses the universal shim embedded in\n" +
			"gh-student — that shim `uses:` the autograde-runner workflow\n" +
			"in the config repo.\n\n" +
			"There are three ways to grade. (1) Declarative tests: pass\n" +
			"--tests <file.json> here (or use `gh teacher assignment test\n" +
			"add`) to describe io/run/python checks that the runner grades\n" +
			"with no autograder.py. (2) A per-assignment autograder.py: drop\n" +
			"an entrypoint plus any sibling fixtures at\n" +
			"<classroom>/autograders/<slug>/ in the config repo (mutually\n" +
			"exclusive with --tests). (3) A classroom default: run\n" +
			"`gh teacher autograder set-default <org> <classroom>` to install\n" +
			"<classroom>/autograder.py for every assignment. See the\n" +
			"Autograders wiki page for the result.json contract and\n" +
			"templates (pytest, check50, custom).",
		Example: "  gh teacher assignment add cs50-fall-2026 cs-principles hello \\\n" +
			"      --name \"Hello\" --template cs50/hello-template \\\n" +
			"      --due 2026-09-15T23:59:00-04:00\n" +
			"  gh teacher assignment add cs50-fall-2026 cs-principles intro \\\n" +
			"      --name \"Intro\" --template cs50/intro-template@main\n" +
			"  gh teacher assignment add cs50-fall-2026 cs-principles greet \\\n" +
			"      --name \"Greet\" --template cs50/greet-template \\\n" +
			"      --runtime ./runtime-c.json",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			slug := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || slug == "" {
				return errors.New("org, classroom, and slug must all be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			if err := validate.ShortName(slug, "slug"); err != nil {
				return err
			}

			nameVal := strings.TrimSpace(name)
			if nameVal == "" {
				return errors.New("--name is required")
			}
			templateVal := strings.TrimSpace(template)
			// --empty-repo rules out every grading-adjacent flag. Checked at
			// the flag layer (before any parsing/network) so the error names
			// the flags the teacher actually typed; ValidateAssignmentEntry
			// re-checks the built entry as the backstop.
			feedbackPRVal, err := validateEmptyRepoFlags(emptyRepoFlagState{
				EmptyRepo:            emptyRepo,
				Template:             templateVal != "",
				Tests:                strings.TrimSpace(testsFile) != "",
				AllowedFiles:         len(allowedFiles) > 0,
				PassThresholdChanged: cmd.Flags().Changed("pass-threshold"),
				FeedbackPR:           feedbackPR,
				FeedbackPRChanged:    cmd.Flags().Changed("feedback-pr"),
			})
			if err != nil {
				return err
			}
			modeVal, err := validateModeAndSizeFlags(mode, maxGroupSize, cmd.Flags().Changed("max-group-size"))
			if err != nil {
				return err
			}
			autograderVal := strings.TrimSpace(autograder)
			if autograderVal == "" {
				autograderVal = contract.DefaultAutograderName
			}
			// pass_threshold is opt-in: set the pointer only when the flag was
			// passed, so an omitted flag stays nil (off) while an explicit
			// --pass-threshold 0 is a real 0% threshold.
			passThresholdPtr := passThresholdFromFlag(cmd.Flags().Changed("pass-threshold"), passThreshold)
			if err := autograderseam.ValidateName(autograderVal); err != nil {
				return err
			}
			dueVal, dueMetaVal, err := normalizeDueDate(strings.TrimSpace(due))
			if err != nil {
				return err
			}
			// --template is optional. When omitted, the assignment has no
			// starter repo and `student accept` creates an empty shim-only
			// repo. When present, parse + (later) validate it.
			var tmplArg *templateArg
			if templateVal != "" {
				parsed, err := parseTemplateRef(templateVal)
				if err != nil {
					return err
				}
				tmplArg = &parsed
			}
			runtime, err := assignment.ParseRuntimeFile(strings.TrimSpace(runtimeFile))
			if err != nil {
				return err
			}
			tests, err := assignment.ParseTestsFile(strings.TrimSpace(testsFile))
			if err != nil {
				return err
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAssignmentAdd(client, cmd.OutOrStdout(), cmd.ErrOrStderr(),
				addAssignmentParams{
					Org:           org,
					Classroom:     classroom,
					Slug:          slug,
					Name:          nameVal,
					Description:   strings.TrimSpace(description),
					Tmpl:          tmplArg,
					Due:           dueVal,
					DueMeta:       dueMetaVal,
					Mode:          modeVal,
					MaxGroupSize:  maxGroupSize,
					Autograder:    autograderVal,
					Runtime:       runtime,
					Tests:         tests,
					FeedbackPR:    feedbackPRVal,
					EmptyRepo:     emptyRepo,
					AllowedFiles:  allowedFiles,
					PassThreshold: passThresholdPtr,
				})
		},
	}

	cmd.Flags().StringVar(&name, "name", "", `Display name written into the assignment entry (e.g. "Hello") (required)`)
	cmd.Flags().StringVar(&template, "template", "", "Optional template repo as <owner>/<repo> or <owner>/<repo>@<branch>. Omit for a template-less assignment (students get an empty repo with just the autograder shim).")
	cmd.Flags().StringVar(&description, "description", "", "Optional one-line description")
	cmd.Flags().StringVar(&due, "due", "", "Optional due date (e.g. 2026-09-15T23:59:00-04:00); stored as UTC. Omit the offset to use the machine's local timezone")
	cmd.Flags().StringVar(&mode, "mode", assignment.ModeIndividual, "Assignment mode: `individual` (default) or `group`. Group mode requires --max-group-size.")
	cmd.Flags().IntVar(&maxGroupSize, "max-group-size", 0, "Maximum collaborators on a group repo (>= 2; required with --mode group). Enforced within the CLI when students join; direct GitHub-UI invites can bypass it.")
	cmd.Flags().StringVar(&autograder, "autograder", contract.DefaultAutograderName, "Autograder workflow shim this assignment opts into; resolves to <classroom>/autograders/<name>.yaml in the config repo")
	cmd.Flags().StringVar(&runtimeFile, "runtime", "", "Path to a JSON file describing the runtime environment (runs-on as a single label or an array of labels for self-hosted runners, python/node/java/go/rust versions, apt packages, or container image), or `-` to read from stdin. Omit for ubuntu-latest + Python 3.12.")
	cmd.Flags().StringVar(&testsFile, "tests", "", "Path to a JSON file with a bare array of declarative test specs (io/run/python), or `-` to read from stdin. Sets the assignment's `tests` block; mutually exclusive with a per-assignment autograder.py. See `gh teacher assignment test --help`.")
	cmd.Flags().BoolVar(&feedbackPR, "feedback-pr", true, "Open one long-lived Feedback pull request per student repo so you can leave inline review comments on the full starter→submission diff. The autograde runner freezes a base branch at the baseline commit and opens the PR on the first submission that has a diff. Default on; pass --feedback-pr=false to disable. Requires `gh teacher init` to have set up the org prerequisites.")
	cmd.Flags().BoolVar(&emptyRepo, "empty-repo", false, "Create truly bare student repos: no README/initial commit, no .classroom50.yaml marker, no autograde workflow — for assignments where students build the repo (including their own GitHub Actions) from scratch. Autograding and the Feedback PR are disabled and cannot be enabled later (the setting is immutable after creation). Mutually exclusive with --template, --tests, --feedback-pr, --allowed-files, and --pass-threshold.")
	cmd.Flags().StringArrayVar(&allowedFiles, "allowed-files", nil, "Ordered .gitignore-style pattern (repeatable, order preserved) defining which files belong to the submission. Last match wins; `!` re-includes. Pass `--allowed-files '*' --allowed-files '!hello.py'` to allow only hello.py. The autograde runner removes disallowed files before grading (control files are always kept); `gh student submit` filters them too. Omit to allow every file.")
	cmd.Flags().IntVar(&passThreshold, "pass-threshold", 0, "Opt-in passing bar as a percentage of max score (0–100): at/above it a gradebook client shows a submission as passing. Advisory/display-only — it does not change a student's score. Omit to leave it off (no passing concept); pass --pass-threshold 0 for an explicit 0%.")
	return cmd
}

// assignmentRemoveCmd is idempotent (missing slug exits 0) and leaves existing
// student repos untouched — only future `student accept` calls stop finding the
// slug.
func assignmentRemoveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remove <org> <classroom> <slug>",
		Short: "Remove an assignment entry from assignments.json",
		Long: "Drop the assignment entry with matching slug from\n" +
			"<org>/classroom50/<classroom>/assignments.json. Idempotent:\n" +
			"if the slug is already absent, exits 0 with a note.\n\n" +
			"Does NOT touch any existing student repos that were created\n" +
			"against this assignment. The starter code and submission\n" +
			"history stay intact; only new `gh student accept` invocations\n" +
			"stop finding the slug.\n\n" +
			"Because the repos survive, re-adding the SAME slug is not a\n" +
			"clean reset: an --empty-repo flag that differs from the removed\n" +
			"entry would leave already-accepted repos on the old behavior\n" +
			"(the immutability guard only fires on an in-place edit, which a\n" +
			"remove+add bypasses). To change empty_repo, add under a NEW slug.",
		Example: "  gh teacher assignment remove cs50-fall-2026 cs-principles hello",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			slug := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || slug == "" {
				return errors.New("org, classroom, and slug must all be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			if err := validate.ShortName(slug, "slug"); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAssignmentRemove(client, cmd.OutOrStdout(), org, classroom, slug)
		},
	}
	return cmd
}

// assignmentListCmd: read-only. stdout = one slug per line by default; `--json`
// emits the full entries array; `-q` suppresses the stderr summary.
func assignmentListCmd() *cobra.Command {
	var (
		asJSON bool
		quiet  bool
	)

	cmd := &cobra.Command{
		Use:   "list <org> <classroom>",
		Short: "Print every assignment slug registered in a classroom",
		Long: "List the slugs of every assignment registered in\n" +
			"<org>/classroom50/<classroom>/assignments.json.\n\n" +
			"Default output is one slug per line on stdout — pipeable\n" +
			"directly into `xargs gh teacher download`, `grep`, or an\n" +
			"agent loop. Pass --json to emit the full JSON array of\n" +
			"assignment entries instead; that form preserves every field\n" +
			"(template ref, due, mode, tests) so an agent can introspect\n" +
			"the manifest without a second API call.\n\n" +
			"A one-line summary (`<repo-path>: N assignment(s)`) is\n" +
			"printed to stderr by default; pass --quiet to suppress it\n" +
			"so stdout is the only output stream a capturing script has\n" +
			"to parse.\n\n" +
			"This is a read-only command; no commit lands on the repo.",
		Example: "  gh teacher assignment list cs50-fall-2026 cs-principles\n" +
			"  gh teacher assignment list cs50-fall-2026 cs-principles --json\n" +
			"  gh teacher assignment list -q cs50-fall-2026 cs-principles | xargs -I{} gh teacher download cs50-fall-2026 cs-principles {}",
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
			return runAssignmentList(client, cmd.OutOrStdout(), cmd.ErrOrStderr(),
				org, classroom, asJSON, quiet)
		},
	}

	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the full JSON array of assignment entries instead of one slug per line")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress the stderr summary so stdout is the only output stream")
	return cmd
}

// runAssignmentList: one branch resolve, one file read, no commit. Missing
// assignments.json points the teacher at `classroom add`.
func runAssignmentList(client githubapi.Client, out, errOut io.Writer, org, classroom string, asJSON, quiet bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	file, err := loadAssignments(client, org, classroom, branch)
	if err != nil {
		return err
	}

	if asJSON {
		data, err := formatAssignmentListJSON(file.Assignments)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
	} else {
		for _, entry := range file.Assignments {
			_, _ = fmt.Fprintln(out, entry.Slug)
		}
	}

	if !quiet {
		_, _ = fmt.Fprintln(errOut, summarizeAssignmentList(org, classroom, len(file.Assignments)))
	}
	return nil
}

// formatAssignmentListJSON marshals the bare entries array (no envelope) with
// on-disk pretty-print + trailing newline so terminal and `jq` output match.
// Empty Autograder normalizes to "default" so consumers can index without nil
// guards.
func formatAssignmentListJSON(entries []assignment.AssignmentEntry) ([]byte, error) {
	if entries == nil {
		entries = []assignment.AssignmentEntry{}
	}
	for i := range entries {
		if entries[i].Autograder == "" {
			entries[i].Autograder = contract.DefaultAutograderName
		}
	}
	return output.JSONPretty(entries)
}

// summarizeAssignmentList: one-line stderr summary shaped
// `<org>/<repo>/<path>: <message>` to match other CLI commands.
func summarizeAssignmentList(org, classroom string, count int) string {
	path := fmt.Sprintf("%s/%s/%s", org, configrepo.ConfigRepoName, assignmentsFilePath(classroom))
	switch count {
	case 0:
		return fmt.Sprintf("%s: no assignments registered yet — use `gh teacher assignment add %s %s <slug>` to create one", path, org, classroom)
	case 1:
		return fmt.Sprintf("%s: 1 assignment", path)
	default:
		return fmt.Sprintf("%s: %d assignments", path, count)
	}
}

// assignmentsFilePath: on-repo path to a classroom's assignments.json.
func assignmentsFilePath(classroom string) string {
	return assignment.AssignmentsFilePath(classroom)
}

// validateModeAndSizeFlags normalizes/validates the --mode and --max-group-size
// pair for `assignment add`. Group mode requires --max-group-size (2..cap);
// individual mode must not set it. Extracted as a pure function so the flag
// contract is unit-testable.
func validateModeAndSizeFlags(mode string, maxGroupSize int, sizeProvided bool) (string, error) {
	modeVal := strings.TrimSpace(mode)
	if modeVal == "" {
		modeVal = assignment.ModeIndividual
	}
	if !assignment.IsValidAssignmentMode(modeVal) {
		return "", fmt.Errorf("invalid --mode %q: expected one of %s", modeVal, strings.Join(assignment.AssignmentModes, ", "))
	}
	switch modeVal {
	case assignment.ModeGroup:
		if maxGroupSize < 2 {
			return "", fmt.Errorf("--max-group-size must be >= 2 for a group assignment (got %d)", maxGroupSize)
		}
		if err := assignment.ValidateMaxGroupSize(maxGroupSize); err != nil {
			return "", err
		}
	default:
		if sizeProvided {
			return "", errors.New("--max-group-size is only valid with --mode group")
		}
	}
	return modeVal, nil
}

// emptyRepoFlagState is the flag-layer view validateEmptyRepoFlags checks:
// booleans for "was this conflicting flag used", plus the --feedback-pr
// value/changed pair (it defaults to true, so only an EXPLICIT --feedback-pr
// conflicts; the silent default is coerced off instead).
type emptyRepoFlagState struct {
	EmptyRepo            bool
	Template             bool
	Tests                bool
	AllowedFiles         bool
	PassThresholdChanged bool
	FeedbackPR           bool
	FeedbackPRChanged    bool
}

// validateEmptyRepoFlags enforces --empty-repo's mutual exclusions at the flag
// layer and returns the feedback_pr value to write. Without --empty-repo the
// flag value passes through untouched. With it, conflicting flags error —
// except the defaulted-on --feedback-pr, which only errors when the teacher
// explicitly passed --feedback-pr=true (an untouched default silently becomes
// false, since demanding --feedback-pr=false alongside --empty-repo would be
// pedantry). Extracted as a pure function so the flag contract is
// unit-testable, mirroring validateModeAndSizeFlags.
func validateEmptyRepoFlags(s emptyRepoFlagState) (feedbackPR bool, err error) {
	if !s.EmptyRepo {
		return s.FeedbackPR, nil
	}
	if s.Template {
		return false, errors.New("--empty-repo is mutually exclusive with --template: a bare repo starts with no content at all")
	}
	if s.Tests {
		return false, errors.New("--empty-repo is mutually exclusive with --tests: a bare repo has no autograde workflow, so tests would never run")
	}
	if s.AllowedFiles {
		return false, errors.New("--empty-repo is mutually exclusive with --allowed-files: a bare repo never autogrades, so there is no submission to filter")
	}
	if s.PassThresholdChanged {
		return false, errors.New("--empty-repo is mutually exclusive with --pass-threshold: a bare repo never autogrades, so there are no scores to grade against")
	}
	if s.FeedbackPRChanged && s.FeedbackPR {
		return false, errors.New("--empty-repo is mutually exclusive with --feedback-pr: a bare repo has no baseline commit for the Feedback PR")
	}
	return false, nil
}

// passThresholdFromFlag maps --pass-threshold to the optional *int: an omitted
// flag stays nil (off); an explicit --pass-threshold 0 is *int(0), a real 0%
// bar distinct from off.
func passThresholdFromFlag(changed bool, value int) *int {
	if !changed {
		return nil
	}
	v := value
	return &v
}

// addAssignmentParams carries runAssignmentAdd's inputs as named fields. Many
// share types (strings, pointers, slices), so positional passing made arg
// transposition a compile-clean footgun; field names keep call sites
// order-independent.
type addAssignmentParams struct {
	Org           string
	Classroom     string
	Slug          string
	Name          string
	Description   string
	Tmpl          *templateArg
	Due           string
	DueMeta       *assignment.DueMeta
	Mode          string
	MaxGroupSize  int
	Autograder    string
	Runtime       *assignment.RuntimeRef
	Tests         []assignment.TestSpec
	FeedbackPR    bool
	EmptyRepo     bool
	AllowedFiles  []string
	PassThreshold *int
}

// runAssignmentAdd validates template visibility and entry shape before the
// configwrite.CommitTree loop so a bad input never produces a partial-state
// commit. The autograder existence probe runs inside the build callback against
// each attempt's parent SHA, so a concurrent delete loses cleanly on retry.
// Same-slug races are last-writer-wins.
func runAssignmentAdd(client githubapi.Client, out, errOut io.Writer, p addAssignmentParams) error {
	org, classroom, slug := p.Org, p.Classroom, p.Slug
	name, description := p.Name, p.Description
	tmpl, due, dueMetaVal := p.Tmpl, p.Due, p.DueMeta
	mode, maxGroupSize, autograder := p.Mode, p.MaxGroupSize, p.Autograder
	runtime, tests := p.Runtime, p.Tests
	feedbackPR, allowedFiles := p.FeedbackPR, p.AllowedFiles
	passThreshold := p.PassThreshold
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	// Template is optional. When present, validate it and decide the
	// private-access grant; when absent, `student accept` creates an empty
	// shim-only repo.
	var (
		resolved        *assignment.TemplateRef
		templatePrivate bool
		inOrg           bool
	)
	if tmpl != nil {
		ref, private, err := validateTemplateRepo(client, *tmpl)
		if err != nil {
			return err
		}
		templatePrivate = private

		// Private-template access matrix: a private template outside the org
		// can't be shared with the classroom team, so reject up front rather
		// than letting every `student accept` 404 later.
		inOrg = templateInOrg(ref.Owner, org)
		if templatePrivate && !inOrg {
			return fmt.Errorf("template `%s/%s` is private and outside the org %s — students can't be granted access to it, so `gh student accept` would fail. Copy it into %s and reference the copy, or make the template public",
				ref.Owner, ref.Repo, org, org)
		}
		// Working assumption is `main`. A non-main template default branch is
		// supported (student repos inherit it), but warn so the teacher knows
		// autograde/submit will key off that branch, not `main`.
		if ref.Branch != "main" {
			_, _ = fmt.Fprintf(errOut,
				"Warning: template %s/%s uses default branch %q, not \"main\". The assignment will use %q; students' repos and autograding key off that branch.\n",
				ref.Owner, ref.Repo, ref.Branch, ref.Branch)
		}
		resolved = &ref
	}

	entry := assignment.AssignmentEntry{
		Slug:          slug,
		Name:          name,
		Description:   description,
		Template:      resolved,
		Due:           due,
		DueMeta:       dueMetaVal,
		Mode:          mode,
		MaxGroupSize:  maxGroupSize,
		Autograder:    autograder,
		Runtime:       runtime,
		Tests:         tests,
		FeedbackPR:    feedbackPR,
		EmptyRepo:     p.EmptyRepo,
		AllowedFiles:  allowedFiles,
		PassThreshold: passThreshold,
	}
	if err := assignment.ValidateAssignmentEntry(entry); err != nil {
		return err
	}

	var (
		action               string
		lastEncodedSize      int
		droppedTests         int
		droppedTemplate      *assignment.TemplateRef
		droppedAllowedCnt    int
		droppedPassThreshold *int
	)
	build := func(parentSHA string) (map[string]string, error) {
		droppedTests = 0
		droppedTemplate = nil
		droppedAllowedCnt = 0
		droppedPassThreshold = nil
		// Refuse on an archived classroom (active:false), mirroring the web.
		// Checked at parentSHA so a concurrent unarchive is observed on retry.
		if err := ensureClassroomActive(client, org, classroom, parentSHA); err != nil {
			return nil, err
		}
		// Verify the autograder shim exists at parent SHA before writing —
		// else the assignment lands and every accept 404s on the Pages fetch.
		// The default autograder is embedded in gh-student (no on-disk
		// counterpart), so skip the probe there.
		if entry.Autograder != contract.DefaultAutograderName {
			exists, err := autograderseam.Exists(client, org, configrepo.ConfigRepoName, classroom, entry.Autograder, parentSHA)
			if err != nil {
				return nil, fmt.Errorf("check autograder %s/%s/%s: %w",
					org, configrepo.ConfigRepoName, autograderseam.FilePath(classroom, entry.Autograder), err)
			}
			if !exists {
				return nil, fmt.Errorf("autograder %q does not exist at %s/%s/%s — create it (or pass --autograder default) before registering this assignment",
					entry.Autograder, org, configrepo.ConfigRepoName, autograderseam.FilePath(classroom, entry.Autograder))
			}
		}

		// Declarative tests and a per-assignment autograder.py are mutually
		// exclusive (the runner prefers autograder.py, so the tests would
		// silently never run). Probed at parentSHA so a concurrent
		// autograder.py add loses cleanly on retry. The skeleton probe catches
		// config repos predating materialize_tests.py.
		if len(entry.Tests) > 0 {
			if err := ensureDeclarativeTestsSupported(client, org, parentSHA); err != nil {
				return nil, err
			}
			if err := ensureNoPerAssignmentAutograder(client, org, classroom, slug, parentSHA); err != nil {
				return nil, err
			}
		}

		file, err := loadAssignments(client, org, classroom, parentSHA)
		if err != nil {
			return nil, err
		}
		// One lookup of the entry this upsert replaces, shared by the
		// wholesale-replace footgun checks and the Extra carry-forward.
		prevIdx, hasPrev := assignment.FindAssignment(file.Assignments, slug)
		// empty_repo is immutable: student repos were provisioned (or left
		// bare) at accept time and are never retrofitted. Checked at parentSHA
		// inside the build so a concurrent add/remove is observed on retry.
		if hasPrev {
			if err := assignment.ValidateEmptyRepoUnchanged(file.Assignments[prevIdx], entry); err != nil {
				return nil, err
			}
		}
		// Upsert replaces the whole entry, so re-running add without --tests
		// drops tests authored via `assignment test add`. Count them for the
		// warning. nil = flag omitted; an explicit `[]` is a deliberate clear.
		if hasPrev && entry.Tests == nil {
			droppedTests = len(file.Assignments[prevIdx].Tests)
		}
		// Same footgun for the template: re-running add without --template on
		// a templated assignment silently drops its starter-repo binding.
		if hasPrev && entry.Template == nil && file.Assignments[prevIdx].Template != nil {
			droppedTemplate = file.Assignments[prevIdx].Template
		}
		// Same footgun for allowed_files: re-running without --allowed-files
		// drops a prior allowlist. Via the CLI the value is nil (omitted →
		// warn) or non-empty; a non-nil empty slice (programmatic clear) is
		// deliberate and doesn't warn.
		if hasPrev && entry.AllowedFiles == nil {
			droppedAllowedCnt = len(file.Assignments[prevIdx].AllowedFiles)
		}
		// Same footgun for pass_threshold, sharper because it's usually
		// authored by the gradebook GUI. nil = omitted (warn); an explicit 0
		// is a non-nil pointer (real 0% bar), not a drop.
		if hasPrev && entry.PassThreshold == nil && file.Assignments[prevIdx].PassThreshold != nil {
			droppedPassThreshold = file.Assignments[prevIdx].PassThreshold
		}
		// Carry forward the existing entry's Extra (unknown/future keys):
		// `entry` is rebuilt from CLI flags and carries none, so without this
		// the wholesale-replace upsert would drop them.
		if hasPrev {
			entry.Extra = file.Assignments[prevIdx].Extra
		}
		updated, replaced := assignment.UpsertAssignment(file.Assignments, entry)
		if replaced {
			action = "updated"
		} else {
			action = "added"
		}
		file.Assignments = updated
		data, err := assignment.EncodeAssignments(file)
		if err != nil {
			return nil, err
		}
		// Captured by the closure so the post-commit warning sees the final
		// size that landed (after any rebase retries).
		lastEncodedSize = len(data)
		return map[string]string{assignmentsFilePath(classroom): string(data)}, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("assignment: add %s to %s (gh teacher assignment add)", slug, classroom))
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	templateDesc := "no template"
	if entry.EmptyRepo {
		templateDesc = "empty repo, autograding disabled"
	}
	if resolved != nil {
		templateDesc = fmt.Sprintf("template %s/%s@%s", resolved.Owner, resolved.Repo, resolved.Branch)
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: %s %s (%s, autograder %s)\n",
		org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), action, slug,
		templateDesc, entry.Autograder)

	// In-org private template: grant the classroom team read so rostered
	// students can generate from it. Idempotent. The team slug comes from
	// classroom.json; a classroom with no team gets an actionable message.
	if resolved != nil && templatePrivate && inOrg {
		if err := grantClassroomTeamTemplateRead(client, out, errOut, org, classroom, branch, slug, resolved.Owner, resolved.Repo,
			grantContext{verb: "committed", classroomNoun: "classroom", rerunHint: ", then re-run `gh teacher assignment add`"}); err != nil {
			return err
		}
	}
	if droppedTests > 0 {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its %d declarative test(s) — `assignment add` rewrites the whole entry. Pass --tests to keep them, or re-add with `gh teacher assignment test add`.\n",
			slug, droppedTests)
	}
	if droppedTemplate != nil {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its template %s/%s@%s — `assignment add` rewrites the whole entry, and you re-ran it without --template. The assignment is now template-less (students get an empty shim-only repo). Pass --template %s/%s@%s to keep it.\n",
			slug, droppedTemplate.Owner, droppedTemplate.Repo, droppedTemplate.Branch,
			droppedTemplate.Owner, droppedTemplate.Repo, droppedTemplate.Branch)
	}
	if droppedAllowedCnt > 0 {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its %d allowed_files pattern(s) — `assignment add` rewrites the whole entry, and you re-ran it without --allowed-files. Submissions are now unrestricted. Pass --allowed-files to keep the allowlist.\n",
			slug, droppedAllowedCnt)
	}
	if droppedPassThreshold != nil {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its pass_threshold (%d%%) — `assignment add` rewrites the whole entry, and you re-ran it without --pass-threshold. The passing bar (often set in the gradebook GUI) is now off. Pass --pass-threshold %d to keep it.\n",
			slug, *droppedPassThreshold, *droppedPassThreshold)
	}
	// Heads-up if the encoded file nears GitHub's ~1 MiB contents-API limit
	// (past which encoding flips to "none", wedging future reads/writes).
	// Diagnostic only. See assignment.LargeAssignmentsWarnBytes.
	if lastEncodedSize > assignment.LargeAssignmentsWarnBytes {
		_, _ = fmt.Fprintf(errOut,
			"Warning: %s/%s/%s is %d bytes — approaching GitHub's ~1 MiB contents-API ceiling. Past that, the API returns encoding:\"none\" and future `gh teacher assignment add/remove` calls will fail to read the file. Consider splitting the classroom or shrinking per-entry fields.\n",
			org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), lastEncodedSize)
	}
	_, _ = fmt.Fprintf(errOut, "Students can now run: gh student accept %s %s %s\n", org, classroom, slug)
	return nil
}

func runAssignmentRemove(client githubapi.Client, out io.Writer, org, classroom, slug string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	var removed bool
	build := func(parentSHA string) (map[string]string, error) {
		file, err := loadAssignments(client, org, classroom, parentSHA)
		if err != nil {
			return nil, err
		}
		next, ok := assignment.RemoveAssignment(file.Assignments, slug)
		removed = ok
		if !ok {
			// configwrite.CommitTree treats nil-or-empty as a no-op so a
			// missing slug doesn't produce an empty commit.
			return nil, nil
		}
		file.Assignments = next
		data, err := assignment.EncodeAssignments(file)
		if err != nil {
			return nil, err
		}
		return map[string]string{assignmentsFilePath(classroom): string(data)}, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("assignment: remove %s from %s (gh teacher assignment remove)", slug, classroom))
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	if removed {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: removed %s (existing student repos untouched)\n",
			org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), slug)
	} else {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: %s not in assignments.json, nothing to do\n",
			org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), slug)
	}
	return nil
}

// loadAssignments reads assignments.json at `ref` (commit SHA for
// rebase-consistent reads inside CommitTree, or a branch name for the read-only
// list path). Missing file → points the teacher at `classroom add`.
func loadAssignments(client githubapi.Client, org, classroom, ref string) (assignment.AssignmentsJSON, error) {
	return configrepo.LoadAssignments(client, org, classroom, ref)
}

// ensureClassroomActive refuses a write into an archived classroom
// (classroom.json `active: false`), mirroring the web. Read at `ref` inside the
// build callback so a concurrent archive/unarchive is observed consistently. A
// missing/legacy classroom.json reads as active.
func ensureClassroomActive(client githubapi.Client, org, classroom, ref string) error {
	c, ok, err := configrepo.LoadClassroom(client, org, classroom, ref)
	if err != nil {
		return err
	}
	if ok && c.IsArchived() {
		return fmt.Errorf("classroom %q is archived (classroom.json active:false) — new assignments are refused; run `gh teacher classroom unarchive %s %s` to re-activate it first",
			classroom, org, classroom)
	}
	return nil
}

// templateArg is the parsed `--template` flag. Branch is empty if `@branch` is
// omitted; validateTemplateRepo then fills it from default_branch. Kept
// distinct from assignment.TemplateRef because on-disk Branch must be populated.
type templateArg struct {
	Owner  string
	Repo   string
	Branch string // empty → use the repo's default_branch
}

// parseTemplateRef parses `<owner>/<repo>[@branch]`. Rejects empty
// parts and extra `/` or `@` (e.g. `cs50//hello`, `cs50/hello@@main`).
func parseTemplateRef(raw string) (templateArg, error) {
	if raw == "" {
		return templateArg{}, errors.New("--template must not be empty")
	}
	ownerRepo, branch, hasBranch := strings.Cut(raw, "@")
	if hasBranch && strings.Contains(branch, "@") {
		return templateArg{}, fmt.Errorf("invalid --template %q: branch contains '@' (expected <owner>/<repo>[@branch])", raw)
	}
	if hasBranch && branch == "" {
		return templateArg{}, fmt.Errorf("invalid --template %q: branch is empty after '@'", raw)
	}
	parts := strings.Split(ownerRepo, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return templateArg{}, fmt.Errorf("invalid --template %q: expected <owner>/<repo>[@branch]", raw)
	}
	return templateArg{
		Owner:  parts[0],
		Repo:   parts[1],
		Branch: branch,
	}, nil
}

// normalizeDueDate turns a --due value into the stored UTC instant plus its
// provenance (due_meta). Empty → ("", nil, nil). A value with an offset is
// converted to UTC; a zone-less value is interpreted in the machine's local
// zone, then converted. The original input and applied offset/zone are kept in
// due_meta so a wrong-zone deadline stays auditable.
func normalizeDueDate(raw string) (string, *assignment.DueMeta, error) {
	if raw == "" {
		return "", nil, nil
	}
	loc, locErr := localDueLocation()
	t, hadOffset, err := assignment.ParseDueTime(raw, loc)
	if err != nil {
		return "", nil, fmt.Errorf("invalid --due: %w", err)
	}
	if !hadOffset && locErr != nil {
		// Zone-less value depends entirely on the local zone, but $TZ was
		// unresolvable. Fail loudly rather than storing the wrong instant.
		return "", nil, fmt.Errorf(
			"invalid --due: %q has no timezone offset and the local timezone "+
				"could not be resolved (%v); pass an explicit offset like -04:00", raw, locErr)
	}
	if hadOffset {
		return t.UTC().Format(time.RFC3339), assignment.NewDueMeta(raw, t, assignment.DueSourceExplicit), nil
	}
	meta := assignment.NewDueMeta(raw, t, assignment.DueSourceAuto)
	meta.Zone = dueZoneName(loc, t)
	return t.UTC().Format(time.RFC3339), meta, nil
}

// localDueLocation resolves the machine's local timezone for a zone-less --due.
// $TZ is preferred (its IANA name round-trips into due_meta.zone). When $TZ is
// set but unresolvable, return the error (with time.Local) so the caller
// refuses to guess; an empty $TZ falls back to time.Local with no error.
func localDueLocation() (*time.Location, error) {
	if tz := strings.TrimSpace(os.Getenv("TZ")); tz != "" {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			return time.Local, fmt.Errorf("$TZ=%q: %w", tz, err)
		}
		return loc, nil
	}
	return time.Local, nil
}

// dueZoneName is the best-effort human-readable zone recorded in due_meta when
// the offset was auto-detected. A named location reports its IANA name;
// time.Local reports "Local", so fall back to the abbreviation at that instant
// (e.g. "EDT"). due_meta.offset is always exact regardless.
func dueZoneName(loc *time.Location, t time.Time) string {
	if name := loc.String(); name != "" && name != "Local" {
		return name
	}
	abbr, _ := t.Zone()
	return abbr
}

// validateTemplateRepo checks <owner>/<repo> exists and is a template repo,
// then resolves a missing @branch to default_branch. Also returns whether the
// template is private, so add can decide the classroom-team read grant (in-org
// private) or rejection (out-of-org private). Post-HTTP decisions live in
// resolveTemplateBranch so they're unit-testable without httptest.
func validateTemplateRepo(client githubapi.Client, t templateArg) (ref assignment.TemplateRef, private bool, err error) {
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(t.Owner), url.PathEscape(t.Repo))
	var resp struct {
		IsTemplate    bool   `json:"is_template"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
	}
	if err := client.Get(path, &resp); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return assignment.TemplateRef{}, false, fmt.Errorf("template `%s/%s` is not visible to your account — either make it public, or copy it into your org and reference the copy",
				t.Owner, t.Repo)
		}
		return assignment.TemplateRef{}, false, fmt.Errorf("GET %s: %w", path, err)
	}
	ref, err = resolveTemplateBranch(t, resp.IsTemplate, resp.DefaultBranch)
	if err != nil {
		return assignment.TemplateRef{}, false, err
	}
	return ref, resp.Private, nil
}

// templateInOrg reports whether the template repo is owned by <org>
// (case-insensitive). An in-org private template can be shared with the
// classroom team; an out-of-org private one can't, so add rejects it.
func templateInOrg(templateOwner, org string) bool {
	return strings.EqualFold(templateOwner, org)
}

// resolveTemplateBranch picks the final assignment.TemplateRef from
// --template + repo fields: not-a-template, explicit @branch,
// default_branch fallback, or empty-default_branch guard.
func resolveTemplateBranch(t templateArg, isTemplate bool, defaultBranch string) (assignment.TemplateRef, error) {
	if !isTemplate {
		return assignment.TemplateRef{}, fmt.Errorf("`%s/%s` is not a template repository — toggle Settings → \"Template repository\" on the repo, then re-run", t.Owner, t.Repo)
	}
	branch := t.Branch
	if branch == "" {
		branch = defaultBranch
	}
	if branch == "" {
		// Defensive: a fresh repo can return empty default_branch, and an
		// empty on-disk Branch would trip `student accept`.
		return assignment.TemplateRef{}, fmt.Errorf("template `%s/%s` has no default branch — pass --template %s/%s@<branch> explicitly", t.Owner, t.Repo, t.Owner, t.Repo)
	}
	return assignment.TemplateRef{Owner: t.Owner, Repo: t.Repo, Branch: branch}, nil
}
