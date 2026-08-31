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
	"github.com/foundation50/gh-teacher/internal/feedbackpr"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "assignment",
		Short: "Manage assignments inside the classroom50 repository",
		Long: "Manage assignment entries in <org>/classroom50/<classroom>/assignments.json.\n\n" +
			"Subcommands:\n" +
			"  add     register or upsert an assignment\n" +
			"  remove  drop an assignment entry (does not touch existing student repos)\n" +
			"  list    print every assignment slug registered in a classroom\n\n" +
			"Writes use a single commit on <org>/classroom50's default branch\n" +
			"with the same optimistic-update-with-rebase loop the roster\n" +
			"commands use, so concurrent edits don't silently lose each\n" +
			"other's work.\n\n" +
			"Each entry carries:\n" +
			"  - an immutable `slug`, the same name used in student repo names\n" +
			"    like `<classroom>-<slug>-<username>`\n" +
			"  - a template ref pointing at the starter-code repository\n" +
			"  - the autograder name, which picks the shim YAML\n" +
			"    (`<classroom>/autograders/<name>.yaml`) and thus the reusable\n" +
			"    runner that handles submissions for this assignment\n\n" +
			"Per-assignment grading lives separately at\n" +
			"`<classroom>/autograders/<slug>/autograder.py` (entrypoint), with\n" +
			"optional sibling fixtures alongside (see the Advanced-Autograding\n" +
			"wiki page).",
	}
	cmd.AddCommand(assignmentAddCmd())
	cmd.AddCommand(assignmentReuseCmd())
	cmd.AddCommand(assignmentRenameCmd())
	cmd.AddCommand(assignmentRemoveCmd())
	cmd.AddCommand(assignmentListCmd())
	cmd.AddCommand(assignmentLockCmd())
	cmd.AddCommand(assignmentSubmissionModeCmd())
	cmd.AddCommand(assignmentTestCmd())
	cmd.AddCommand(feedbackpr.NewCmd())
	return cmd
}

// assignmentAddCmd: `--mode` accepts `individual` (default) or `group`. Group
// mode requires `--max-group-size` (>= 2), enforced within the CLI when
// students join (direct GitHub-UI invites can bypass it — documented).
func assignmentAddCmd() *cobra.Command {
	var (
		name           string
		template       string
		description    string
		due            string
		availableFrom  string
		mode           string
		maxGroupSize   int
		teamFormation  string
		autograder     string
		runtimeFile    string
		testsFile      string
		feedbackPR     bool
		emptyRepo      bool
		allowedFiles   []string
		passThreshold  int
		studentPerm    string
		submissionMd   string
		submissionTags []string
		repoVisibility string
	)

	cmd := &cobra.Command{
		Use:   "add <org> <classroom> <slug>",
		Short: "Add or upsert an assignment in assignments.json",
		Long: "Register an assignment (its template repository and the autograder\n" +
			"it runs against) in <org>/classroom50/<classroom>/assignments.json.\n\n" +
			"  - `<slug>` must match ^[a-z0-9][a-z0-9-]{1,99}$ (the same shape\n" +
			"    as classroom short-names) because student repos are named\n" +
			"    `<classroom>-<slug>-<username>`.\n" +
			"  - Only --name is required; --template is optional (omit it for\n" +
			"    a template-less assignment).\n" +
			"  - If the slug already exists in assignments.json, the entry is\n" +
			"    replaced in place (idempotent for repeated edits to the same\n" +
			"    assignment).\n\n" +
			"--empty-repo creates truly bare student repos:\n" +
			"  - No README, no .classroom50.yaml marker, no autograde workflow:\n" +
			"    for assignments where students build everything (including\n" +
			"    their own GitHub Actions) from scratch.\n" +
			"  - Autograding and the Feedback PR are disabled.\n" +
			"  - Changing this on a same-slug re-add applies only to accepts\n" +
			"    from now on; repositories students already accepted are not\n" +
			"    retrofitted (a warning is printed).\n" +
			"  - Mutually exclusive with --template, --tests, --feedback-pr,\n" +
			"    --allowed-files, --pass-threshold, --submission-mode, and\n" +
			"    --submission-tag.\n\n" +
			"--template parses `<owner>/<repo>` (or `<owner>/<repo>@<branch>`):\n" +
			"  - A custom source branch is tolerated but ignored; the\n" +
			"    assignment uses the template repository's default branch. To\n" +
			"    use a different branch, change the template repository's\n" +
			"    default branch first.\n" +
			"  - The template repository must be marked `is_template: true`\n" +
			"    (set in Settings -> \"Template repository\").\n" +
			"  - If your account can't see the repository, the CLI returns the\n" +
			"    cross-org visibility message.\n\n" +
			"--runtime points at a JSON file describing the runtime environment\n" +
			"for this assignment's autograde job:\n" +
			"  - Which runner label(s), optional language toolchains\n" +
			"    (python/node/java/go/rust), optional apt packages, or a custom\n" +
			"    container image.\n" +
			"  - `runs-on` mirrors GitHub Actions itself: a single label\n" +
			"    (\"ubuntu-latest\") or an array of labels\n" +
			"    ([\"self-hosted\", \"gpu\"]) for a custom or self-hosted runner.\n" +
			"  - Pass `-` to read the JSON from stdin instead of a file\n" +
			"    (one-shot agent flows).\n" +
			"  - Omit for the defaults (ubuntu-latest and Python 3.14). See the\n" +
			"    Advanced-Autograding wiki page for the JSON schema and worked\n" +
			"    examples.\n\n" +
			"--autograder is reserved for the rare case where you need to call\n" +
			"a different reusable workflow entirely (for different language\n" +
			"toolchains, use --runtime instead):\n" +
			"  - The name resolves to <classroom>/autograders/<name>.yaml; the\n" +
			"    referenced file must exist at write time.\n" +
			"  - The default is `default`, the universal shim embedded in\n" +
			"    gh-student, which `uses:` the autograde-runner workflow in the\n" +
			"    classroom50 repository.\n\n" +
			"There are three ways to grade:\n" +
			"  1. Declarative tests: pass --tests <file.json> here (or use\n" +
			"     `gh teacher assignment test add`) to describe io/run/python\n" +
			"     checks that the runner grades with no autograder script.\n" +
			"  2. A per-assignment autograder: drop an entrypoint plus any\n" +
			"     sibling fixtures at <classroom>/autograders/<slug>/ in the\n" +
			"     classroom50 repository (mutually exclusive with --tests).\n" +
			"  3. A classroom default: run\n" +
			"     `gh teacher autograder set-default <org> <classroom>` to\n" +
			"     install <classroom>/autograder.py for every assignment.\n\n" +
			"See the Advanced-Autograding wiki page for the result.json\n" +
			"contract and templates (pytest, custom).",
		Example: "  gh teacher assignment add cs50-fall-2026 cs-principles hello \\\n" +
			"      --name \"Hello\" --template cs50/hello-template \\\n" +
			"      --due 2026-09-15T23:59:00-04:00\n" +
			"  gh teacher assignment add cs50-fall-2026 cs-principles intro \\\n" +
			"      --name \"Intro\" --template cs50/intro-template\n" +
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
			modeVal, formationVal, err := validateModeAndSizeFlags(modeSizeFlagState{
				Mode:              mode,
				MaxGroupSize:      maxGroupSize,
				SizeProvided:      cmd.Flags().Changed("max-group-size"),
				TeamFormation:     teamFormation,
				FormationProvided: cmd.Flags().Changed("team-formation"),
			})
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
			studentPermVal := strings.TrimSpace(studentPerm)
			if err := assignment.ValidateStudentPermission(studentPermVal); err != nil {
				return err
			}
			// Normalize the wire default away so an every-push assignment's
			// entry stays byte-identical to one written before the field
			// existed. --empty-repo excludes it (no shim to trigger).
			submissionModeVal := strings.TrimSpace(submissionMd)
			if submissionModeVal == contract.SubmissionModeEveryPush {
				submissionModeVal = ""
			}
			if submissionModeVal != "" {
				if err := assignment.ValidateSubmissionMode(submissionModeVal); err != nil {
					return err
				}
				if emptyRepo {
					return errors.New("--empty-repo is mutually exclusive with --submission-mode: a bare repo has no autograde shim to trigger")
				}
			}
			if len(submissionTags) > 0 {
				if err := assignment.ValidateSubmissionTags(submissionTags); err != nil {
					return err
				}
				if emptyRepo {
					return errors.New("--empty-repo is mutually exclusive with --submission-tag: a bare repo has no autograde shim to trigger")
				}
			}
			// Normalize the wire default away so a private assignment's entry
			// stays byte-identical to one written before the field existed.
			repoVisibilityVal := strings.TrimSpace(repoVisibility)
			if repoVisibilityVal == contract.RepoVisibilityPrivate {
				repoVisibilityVal = ""
			}
			if err := assignment.ValidateRepoVisibility(repoVisibilityVal); err != nil {
				return err
			}
			if err := autograderseam.ValidateName(autograderVal); err != nil {
				return err
			}
			dueVal, dueMetaVal, err := normalizeDueDate(strings.TrimSpace(due))
			if err != nil {
				return err
			}
			availableFromVal, availableFromMetaVal, err := normalizeAvailableFrom(strings.TrimSpace(availableFrom))
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
				// A `@branch` is tolerated but ignored (#673): the assignment
				// uses the template's default branch. Warn so a teacher isn't
				// surprised the branch had no effect.
				if parsed.IgnoredBranch != "" {
					_, _ = fmt.Fprintf(cmd.ErrOrStderr(),
						"warning: --template branch %q is ignored; the assignment uses %s/%s's default branch. To use a different branch, change the template repository's default branch.\n",
						parsed.IgnoredBranch, parsed.Owner, parsed.Repo)
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
					Org:                   org,
					Classroom:             classroom,
					Slug:                  slug,
					Name:                  nameVal,
					Description:           strings.TrimSpace(description),
					Tmpl:                  tmplArg,
					Due:                   dueVal,
					DueMeta:               dueMetaVal,
					AvailableFrom:         availableFromVal,
					AvailableFromMeta:     availableFromMetaVal,
					Mode:                  modeVal,
					MaxGroupSize:          maxGroupSize,
					TeamFormation:         formationVal,
					Autograder:            autograderVal,
					Runtime:               runtime,
					Tests:                 tests,
					FeedbackPR:            feedbackPRVal,
					EmptyRepo:             emptyRepo,
					AllowedFiles:          allowedFiles,
					PassThreshold:         passThresholdPtr,
					StudentPermission:     studentPermVal,
					SubmissionMode:        submissionModeVal,
					SubmissionModeChanged: cmd.Flags().Changed("submission-mode"),
					SubmissionTags:        submissionTags,
					SubmissionTagsChanged: cmd.Flags().Changed("submission-tag"),
					RepoVisibility:        repoVisibilityVal,
					RepoVisibilityChanged: cmd.Flags().Changed("repo-visibility"),
				})
		},
	}

	cmd.Flags().StringVar(&name, "name", "", `Display name written into the assignment entry, for example "Hello" (required)`)
	cmd.Flags().StringVar(&template, "template", "", "Optional template repository as <owner>/<repo> (or <owner>/<repo>@<branch>). Omit for a template-less assignment (students get an initialized repo: a README plus the autograding setup). A custom source branch (@<branch>) is tolerated but ignored; the assignment uses the template's default branch, so change that to use a different one")
	cmd.Flags().StringVar(&description, "description", "", "Optional one-line description")
	cmd.Flags().StringVar(&due, "due", "", "Optional due date, for example 2026-09-15T23:59:00-04:00; stored as UTC. Omit the offset to use the machine's local timezone")
	cmd.Flags().StringVar(&availableFrom, "available-from", "", "Optional release date, for example 2026-09-15T00:00:00-04:00; stored as UTC. Assignments are hidden from the student list by default (invite-link accept only); set this to list it for everyone once the date passes. Students who already accepted always see it (listing-only, not access control). Omit the offset to use the machine's local timezone")
	cmd.Flags().StringVar(&mode, "mode", assignment.ModeIndividual, "Assignment mode: `individual` (default), `group` (legacy shared repo via collaborators), or `team` (shared repo via a GitHub Team). Group and team modes require --max-group-size; team mode also requires --team-formation")
	cmd.Flags().IntVar(&maxGroupSize, "max-group-size", 0, "Maximum group size (>= 2; required with --mode group or --mode team). Enforced within Classroom 50 clients when groups form; direct GitHub-UI changes can bypass it")
	cmd.Flags().StringVar(&teamFormation, "team-formation", "", "Who forms the groups of a team assignment: `teacher` (you create the teams) or `student` (the first student founds a team and adds teammates). Required with --mode team")
	cmd.Flags().StringVar(&autograder, "autograder", contract.DefaultAutograderName, "Autograder workflow shim this assignment opts into; resolves to <classroom>/autograders/<name>.yaml in the classroom50 repository")
	cmd.Flags().StringVar(&runtimeFile, "runtime", "", "Path to a JSON file describing the runtime environment (runs-on as a single label or an array of labels for self-hosted runners, python/node/java/go/rust versions, apt packages, or container image), or `-` to read from stdin. Omit for ubuntu-latest and Python 3.14")
	cmd.Flags().StringVar(&testsFile, "tests", "", "Path to a JSON file with a bare array of declarative test specs (io/run/python), or `-` to read from stdin. Sets the assignment's `tests` block; mutually exclusive with a per-assignment autograder. See `gh teacher assignment test --help`")
	cmd.Flags().BoolVar(&feedbackPR, "feedback-pr", true, "Open one long-lived Feedback pull request per student repo so you can leave inline review comments on the full starter-to-submission diff. Accept freezes a base branch at the baseline commit and opens the PR right away, so it exists even with GitHub Actions disabled; the autograde runner then adopts and maintains it (and opens it on the first submission if accept could not). Default on; pass --feedback-pr=false to disable. Requires `gh teacher init` to have set up the org prerequisites")
	cmd.Flags().BoolVar(&emptyRepo, "empty-repo", false, "Create truly bare student repos (no README or initial commit, no .classroom50.yaml marker, no autograde workflow) for assignments where students build the repo, including their own GitHub Actions, from scratch. Autograding and the Feedback PR are disabled. Changing this on a same-slug re-add applies only to accepts from now on (repositories students already accepted are not retrofitted; a warning is printed). Mutually exclusive with --template, --tests, --feedback-pr, --allowed-files, --pass-threshold, --submission-mode, and --submission-tag")
	cmd.Flags().StringArrayVar(&allowedFiles, "allowed-files", nil, "Ordered .gitignore-style pattern (repeatable, order preserved) defining which files belong to the submission. Last match wins; `!` re-includes. Pass `--allowed-files '*' --allowed-files '!hello.py'` to allow only hello.py. The autograde runner removes disallowed files before grading (control files are always kept); `gh student submit` filters them too. Omit to allow every file")
	cmd.Flags().IntVar(&passThreshold, "pass-threshold", 0, "Opt-in passing bar as a percentage of max score (0-100): at or above it the submissions page shows a submission as passing. Advisory and display-only: it does not change a student's score. Omit to leave it off (no passing concept); pass --pass-threshold 0 for an explicit 0%")
	cmd.Flags().StringVar(&studentPerm, "student-permission", "", "Optional collaborator role each student gets on their own assignment repo at accept time: one of pull, triage, push, maintain, admin. Omit for the default (push for individual, admin for group). Choose admin to let students manage repo settings and enable GitHub Pages. Applies to students who accept from now on; existing repos are unchanged. Caution: admin lets the student manage the repo's settings and collaborators; the org lockdown from `gh teacher init` still blocks members from changing repo visibility (verify with `gh teacher audit`)")
	cmd.Flags().StringVar(&submissionMd, "submission-mode", contract.SubmissionModeEveryPush, "When the autograder fires: `every-push` (default; every push to the default branch grades) or `tag` (only submit/* tag pushes grade: `gh student submit` pushes the tag, or push any submit/* tag by hand; plain `git push` costs no Actions minutes). Baked into each student repo's shim at accept time; change it later with `gh teacher assignment submission-mode`, which also retrofits existing repos. Mutually exclusive with --empty-repo")
	cmd.Flags().StringArrayVar(&submissionTags, "submission-tag", nil, "Milestone tag pattern (repeatable) that also triggers grading, for example --submission-tag phase1 --submission-tag phase2, or a glob like 'v*'. A student pushing a matching tag (`git tag phase1 && git push origin phase1`) gets that commit graded; the grading record still lives at the canonical submit/* tag the runner mints, so history and collection are unchanged. The canonical submit/* namespace always triggers too. Baked into the shim at accept time like --submission-mode (same retrofit to change later). Caution: a broad glob like 'v*' grades every matching tag a student pushes. Mutually exclusive with --empty-repo")
	cmd.Flags().StringVar(&repoVisibility, "repo-visibility", contract.RepoVisibilityPrivate, "Visibility each student repo is created with at accept time: `private` (default) or `public` (for peer-review, portfolio, or showcase assignments; students are told upfront their work will be publicly visible). Applies to students who accept from now on; existing repos are unchanged (flip those from the gradebook's visibility actions). Caution with public: student work (names, emails, commit history) is visible to anyone on the internet from the moment the repo is created. If org policy blocks members from creating public repos, accept falls back to a private repo and tells the student")
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
			"Existing student repos created against this assignment are not\n" +
			"touched. The starter code and submission history stay intact;\n" +
			"only new `gh student accept` invocations stop finding the slug.\n\n" +
			"Because the repos survive, re-adding the same slug is not a\n" +
			"clean reset: an --empty-repo flag that differs from the removed\n" +
			"entry leaves already-accepted repos on the old behavior. The\n" +
			"change applies only to accepts from now on (a warning is\n" +
			"printed; update existing repositories yourself).",
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
			"  - Default output is one slug per line on stdout, pipeable\n" +
			"    directly into `xargs gh teacher download`, `grep`, or an\n" +
			"    agent loop.\n" +
			"  - Pass --json to emit the full JSON array of assignment entries\n" +
			"    instead; that form preserves every field (template ref, due,\n" +
			"    mode, tests) so an agent can introspect the manifest without\n" +
			"    a second API call.\n" +
			"  - A one-line summary (`<repo-path>: N assignment(s)`) is printed\n" +
			"    to stderr by default; pass --quiet to suppress it so stdout is\n" +
			"    the only output stream a capturing script has to parse.\n\n" +
			"This is a read-only command; no commit lands on the repository.",
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
		return fmt.Sprintf("%s: no assignments registered yet. Create one with `gh teacher assignment add %s %s <slug>`", path, org, classroom)
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

// modeSizeFlagState carries the --mode / --max-group-size / --team-formation
// values plus "was this flag passed" booleans, mirroring emptyRepoFlagState.
type modeSizeFlagState struct {
	Mode              string
	MaxGroupSize      int
	SizeProvided      bool
	TeamFormation     string
	FormationProvided bool
}

// validateModeAndSizeFlags normalizes/validates the --mode, --max-group-size,
// and --team-formation flags for `assignment add`. Group and team modes
// require --max-group-size (2..cap); team mode also requires --team-formation;
// individual mode must set neither. Extracted as a pure function so the flag
// contract is unit-testable.
func validateModeAndSizeFlags(s modeSizeFlagState) (mode, formation string, err error) {
	modeVal := strings.TrimSpace(s.Mode)
	if modeVal == "" {
		modeVal = assignment.ModeIndividual
	}
	if !assignment.IsValidAssignmentMode(modeVal) {
		return "", "", fmt.Errorf("invalid --mode %q: expected one of %s", modeVal, strings.Join(assignment.AssignmentModes, ", "))
	}
	formationVal := strings.TrimSpace(s.TeamFormation)
	switch modeVal {
	case assignment.ModeGroup, assignment.ModeTeam:
		if s.MaxGroupSize < 2 {
			return "", "", fmt.Errorf("--max-group-size must be >= 2 for a %s assignment (got %d)", modeVal, s.MaxGroupSize)
		}
		if err := assignment.ValidateMaxGroupSize(s.MaxGroupSize); err != nil {
			return "", "", err
		}
	default:
		if s.SizeProvided {
			return "", "", errors.New("--max-group-size is only valid with --mode group or --mode team")
		}
	}
	if modeVal == assignment.ModeTeam {
		if formationVal == "" {
			return "", "", fmt.Errorf("--team-formation is required for a team assignment: pass one of %s", strings.Join(contract.TeamFormations, ", "))
		}
		if err := assignment.ValidateTeamFormation(formationVal); err != nil {
			return "", "", err
		}
	} else if s.FormationProvided {
		return "", "", errors.New("--team-formation is only valid with --mode team")
	}
	if modeVal != assignment.ModeTeam {
		formationVal = ""
	}
	return modeVal, formationVal, nil
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
	Org               string
	Classroom         string
	Slug              string
	Name              string
	Description       string
	Tmpl              *templateArg
	Due               string
	DueMeta           *assignment.DueMeta
	AvailableFrom     string
	AvailableFromMeta *assignment.DueMeta
	Mode              string
	MaxGroupSize      int
	TeamFormation     string
	Autograder        string
	Runtime           *assignment.RuntimeRef
	Tests             []assignment.TestSpec
	FeedbackPR        bool
	EmptyRepo         bool
	AllowedFiles      []string
	PassThreshold     *int
	StudentPermission string
	SubmissionMode    string
	// Whether --submission-mode was explicitly passed. Distinguishes "omitted"
	// (carry a prior entry's mode forward, like Locked) from an explicit
	// --submission-mode every-push (a deliberate reset). Without this a
	// same-slug re-add would silently flip a tag-mode assignment back to
	// every-push while its deployed shims still only fire on tags — submit
	// would stop pushing tags and NOTHING would grade.
	SubmissionModeChanged bool
	SubmissionTags        []string
	// Same omitted-vs-explicit distinction for --submission-tag: an omitted
	// flag carries a prior entry's patterns forward (deployed shims were
	// rendered with them); passing the flag replaces the set.
	SubmissionTagsChanged bool
	RepoVisibility        string
	// Same omitted-vs-explicit distinction for --repo-visibility: an omitted
	// flag carries a prior entry's visibility forward (often GUI-authored);
	// an explicit --repo-visibility private is a deliberate reset.
	RepoVisibilityChanged bool
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
	availableFrom, availableFromMetaVal := p.AvailableFrom, p.AvailableFromMeta
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
		ref, private, crossOrgForkParent, err := validateTemplateRepo(client, *tmpl, org)
		if err != nil {
			return err
		}
		templatePrivate = private

		// Private-template access matrix: a private template outside the org
		// can't be shared with the classroom team, so reject up front rather
		// than letting every `student accept` 404 later.
		inOrg = templateInOrg(ref.Owner, org)
		if templatePrivate && !inOrg {
			return fmt.Errorf("template `%s/%s` is private and outside the org %s, so students can't be granted access to it and `gh student accept` would fail. Copy it into %s and reference the copy, or make the template public",
				ref.Owner, ref.Repo, org, org)
		}
		// A cross-org fork works only while its upstream org keeps Classroom 50
		// approved — if that approval is removed, `student accept` 403s copying
		// the fork (issue #468). Warn, don't block: it generates fine today.
		if crossOrgForkParent != "" {
			_, _ = fmt.Fprintf(errOut,
				"Warning: template %s/%s is a fork of a repo in the %q organization. Copying it works only while %q keeps the Classroom 50 app approved; if that approval is removed, students will fail to accept. Use a fresh (non-fork) template repo to avoid depending on %q.\n",
				ref.Owner, ref.Repo, crossOrgForkParent, crossOrgForkParent, crossOrgForkParent)
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
		Slug:              slug,
		Name:              name,
		Description:       description,
		Template:          resolved,
		Due:               due,
		DueMeta:           dueMetaVal,
		AvailableFrom:     availableFrom,
		AvailableFromMeta: availableFromMetaVal,
		Mode:              mode,
		MaxGroupSize:      maxGroupSize,
		TeamFormation:     p.TeamFormation,
		Autograder:        autograder,
		Runtime:           runtime,
		Tests:             tests,
		FeedbackPR:        feedbackPR,
		EmptyRepo:         p.EmptyRepo,
		AllowedFiles:      allowedFiles,
		PassThreshold:     passThreshold,
		StudentPermission: p.StudentPermission,
		SubmissionMode:    p.SubmissionMode,
		SubmissionTags:    p.SubmissionTags,
		RepoVisibility:    p.RepoVisibility,
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
		droppedStudentPerm   string
		// empty_repo changed on a same-slug re-add. No longer blocked — the
		// change only affects repos accepted from now on (already-accepted repos
		// aren't retrofitted), so warn instead of erroring. Mirrors the web app's
		// edit-time confirmation. (no_autograder / init_shim have no `add` flag
		// and are carried forward from the prior entry below, so `add` can never
		// change them — only empty_repo is detectable here.)
		changedEmptyRepo bool
		// The locked state that actually landed (carried forward from a prior
		// same-slug entry). Read after the commit to decide the template grant,
		// since `entry` (rebuilt from flags) never carries Locked.
		committedLocked bool
	)
	build := func(parentSHA string) (map[string]string, error) {
		droppedTests = 0
		droppedTemplate = nil
		droppedAllowedCnt = 0
		droppedPassThreshold = nil
		droppedStudentPerm = ""
		changedEmptyRepo = false
		attemptEntry := entry
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
				return nil, fmt.Errorf("autograder %q does not exist at %s/%s/%s: create it (or pass --autograder default) before registering this assignment",
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
		// #691: a NEW slug must fit the composed repo-name budget, or every
		// long-username accept fails after the fact. Checked inside the build
		// (before the commit) so a blocked add leaves nothing behind. A
		// same-slug replace stays allowed — the rule is creation-time only, and
		// a pre-cap over-budget entry must remain editable.
		if !hasPrev {
			if err := validate.ComposedRepoNameBudget(classroom, slug); err != nil {
				return nil, err
			}
			// A renamed assignment's old slug is reserved: a new assignment
			// there would mint repos at renamed student repos' old names,
			// permanently severing GitHub's redirects for every student clone.
			if current, reserved := assignment.SlugReservedFold(file.Assignments, slug); reserved {
				return nil, fmt.Errorf("slug %q is reserved: it is the pre-rename slug of assignment %q, and reusing it would permanently break GitHub's redirects for that assignment's renamed student repos. Choose a different slug",
					slug, current)
			}
		}
		// no_autograder is owned by the gradebook GUI, not `assignment add`
		// (there is no --no-autograder flag), so `entry`/`attemptEntry` rebuilt
		// from flags never carry it. Carry it forward from the prior entry
		// BEFORE the change detection below — otherwise a same-slug re-add
		// (e.g. editing the due date) would compare the flag-default false
		// against a stored true and spuriously warn that no_autograder changed,
		// even though the CLI can't change it. Mirrors the Locked carry-forward
		// (also GUI/other-command-owned).
		if hasPrev {
			entry.NoAutograder = file.Assignments[prevIdx].NoAutograder
			attemptEntry.NoAutograder = entry.NoAutograder
		}
		// init_shim is likewise GUI/manifest-owned (no --init-shim flag), so
		// carry it forward before the change detection for the same reason as
		// no_autograder above.
		if hasPrev {
			entry.InitShim = file.Assignments[prevIdx].InitShim
			attemptEntry.InitShim = entry.InitShim
		}
		// include_all_branches is likewise GUI/manifest-owned (no flag), so carry
		// it forward so a same-slug CLI re-add doesn't silently reset it. Like
		// the above it is MUTABLE — a teacher may change it; it only affects
		// repos generated from now on. Gate on the current template: a re-add
		// that drops --template turns the entry template-less, and
		// include_all_branches only affects the generate call — carrying it onto
		// a template-less entry would write a combination ValidateExistingEntry
		// rejects, wedging every future read of the file.
		if hasPrev && attemptEntry.Template != nil {
			entry.IncludeAllBranches = file.Assignments[prevIdx].IncludeAllBranches
			attemptEntry.IncludeAllBranches = entry.IncludeAllBranches
		}
		// empty_repo is MUTABLE on a same-slug re-add: student repos are
		// provisioned at accept time and never retrofitted, so a change only
		// affects repos accepted from now on. Detect a change and warn after the
		// commit rather than blocking it (mirrors the web app, which confirms the
		// same change when students have already accepted). Checked at parentSHA
		// inside the build so a concurrent add/remove is observed on retry.
		// no_autograder / init_shim are carried forward above (no `add` flag), so
		// they can't change here — only empty_repo is detectable.
		if hasPrev {
			changedEmptyRepo = assignment.EmptyRepoChanged(file.Assignments[prevIdx], entry)
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
		// Same footgun for student_permission (often set in the web app):
		// re-running add without --student-permission drops a prior value back
		// to the mode default. Empty = omitted (warn if the prior entry set one).
		if hasPrev && entry.StudentPermission == "" && file.Assignments[prevIdx].StudentPermission != "" {
			droppedStudentPerm = file.Assignments[prevIdx].StudentPermission
		}
		// The CLI has no release-assets authoring flag. Preserve this typed field and
		// unknown Extra keys when a same-slug add rebuilds the rest from flags. This
		// stays inside the retry callback so a rebase observes the latest parent.
		//
		// Locked is likewise preserved: it's owned by `assignment lock`, not `add`,
		// and `locked` is a known key (so it decodes onto the struct, not Extra).
		// Without this carry-forward a same-slug re-add would clear the lock AND
		// re-grant the student-team template read (the !entry.Locked guard below
		// would see false), silently re-opening a locked assignment.
		if hasPrev {
			previous := file.Assignments[prevIdx]
			attemptEntry.ReleaseAssets = append([]string(nil), previous.ReleaseAssets...)
			attemptEntry.Extra = previous.Extra
			attemptEntry.Locked = previous.Locked
			// renamed_from and migrated_from are provenance owned by the slug
			// rename and the retired `classroom migrate` respectively — `add`
			// has no flags for them, and both are known keys (they decode onto
			// the struct, not Extra), so a same-slug re-add must carry them or
			// it silently erases the rename reservation / migration record.
			attemptEntry.RenamedFrom = previous.RenamedFrom
			attemptEntry.MigratedFrom = previous.MigratedFrom
			// Closed is likewise preserved: it's owned out of band by the web
			// "Close submission" action, not `add`, and `closed` is a known key
			// (decodes onto the struct, not Extra). Without this carry-forward a
			// same-slug re-add would silently re-open a closed submission window.
			attemptEntry.Closed = previous.Closed
			// grading is a GUI/manifest-owned field with no `assignment add`
			// flag; since it was promoted to a known key it no longer rides
			// through Extra, so a same-slug re-add would silently drop a
			// GUI-authored grading block (its max_points feeds the gradebook).
			// The mode is mutable via the GUI; `add` carries it forward only
			// because it has no --grading flag. Deep-copy the *Grading + *int so
			// the carried value doesn't alias the previous entry.
			if attemptEntry.Grading == nil && previous.Grading != nil {
				carried := *previous.Grading
				if previous.Grading.MaxPoints != nil {
					maxPoints := *previous.Grading.MaxPoints
					carried.MaxPoints = &maxPoints
				}
				attemptEntry.Grading = &carried
			}
			// submission_mode is carried forward when --submission-mode was
			// omitted: deployed shims were rendered under the prior mode, so a
			// silent reset to every-push would strand a tag-mode assignment
			// (tag-only shims + a submit client that stops pushing tags =
			// nothing grades). An explicit flag is a deliberate change — the
			// teacher owns retrofitting via `assignment submission-mode`.
			if !p.SubmissionModeChanged {
				attemptEntry.SubmissionMode = previous.SubmissionMode
			}
			// submission_tags gets the same treatment: deployed shims were
			// rendered with the prior patterns, so an omitted flag must not
			// silently drop them (milestone tags would stop grading).
			if !p.SubmissionTagsChanged {
				attemptEntry.SubmissionTags = append([]string(nil), previous.SubmissionTags...)
			}
			// repo_visibility is carried forward when --repo-visibility was
			// omitted: it's often GUI-authored, and a silent reset to private
			// would surprise a showcase assignment's future accepters.
			if !p.RepoVisibilityChanged {
				attemptEntry.RepoVisibility = previous.RepoVisibility
			}
		}
		committedLocked = attemptEntry.Locked
		// Re-validate the fully assembled entry after every carry-forward: the
		// initial ValidateAssignmentEntry ran on the flag-built `entry` before
		// GUI/manifest-owned fields (include_all_branches, submission_mode, …)
		// were carried forward, so a carry-forward that reconstructs an invalid
		// combination (e.g. include_all_branches on a now-template-less entry)
		// would otherwise be caught only on the next read — by which point the
		// bad entry is already committed and wedges the file. Fail here instead.
		if err := assignment.ValidateAssignmentEntry(attemptEntry); err != nil {
			return nil, err
		}
		updated, replaced := assignment.UpsertAssignment(file.Assignments, attemptEntry)
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
	// A LOCKED assignment intentionally has no student-team template read, so
	// skip the grant here — otherwise re-running add would silently re-open it
	// (the lock command removed it on purpose). Staff grants aren't reached
	// because grantStaffTeamTemplateRead runs inside the student grant path.
	// committedLocked (not entry.Locked) is authoritative: `entry` is rebuilt
	// from flags and never carries a prior lock, so the closure captures the
	// value that actually landed.
	if resolved != nil && templatePrivate && inOrg && !committedLocked {
		if err := grantClassroomTeamTemplateRead(client, out, errOut, org, classroom, branch, slug, resolved.Owner, resolved.Repo,
			grantContext{verb: "committed", classroomNoun: "classroom", rerunHint: ", then re-run `gh teacher assignment add`"}); err != nil {
			return err
		}
	}
	if resolved != nil && templatePrivate && inOrg && committedLocked {
		_, _ = fmt.Fprintf(errOut, "Note: %q is locked, so the classroom student team was not granted read on the private template %s/%s. Unlock it with `gh teacher assignment lock %s %s %s --unlock` when you want students to accept again.\n",
			slug, resolved.Owner, resolved.Repo, org, classroom, slug)
	}
	if droppedTests > 0 {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its %d declarative test(s): `assignment add` rewrites the whole entry. Pass --tests to keep them, or re-add with `gh teacher assignment test add`.\n",
			slug, droppedTests)
	}
	if droppedTemplate != nil {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its template %s/%s@%s: `assignment add` rewrites the whole entry, and you re-ran it without --template. The assignment is now template-less (students get an empty shim-only repo). Pass --template %s/%s@%s to keep it.\n",
			slug, droppedTemplate.Owner, droppedTemplate.Repo, droppedTemplate.Branch,
			droppedTemplate.Owner, droppedTemplate.Repo, droppedTemplate.Branch)
	}
	if droppedAllowedCnt > 0 {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its %d allowed_files pattern(s): `assignment add` rewrites the whole entry, and you re-ran it without --allowed-files. Submissions are now unrestricted. Pass --allowed-files to keep the allowlist.\n",
			slug, droppedAllowedCnt)
	}
	if droppedPassThreshold != nil {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its pass_threshold (%d%%): `assignment add` rewrites the whole entry, and you re-ran it without --pass-threshold. The passing bar (often set in the web app) is now off. Pass --pass-threshold %d to keep it.\n",
			slug, *droppedPassThreshold, *droppedPassThreshold)
	}
	if droppedStudentPerm != "" {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q dropped its student_permission (%s): `assignment add` rewrites the whole entry, and you re-ran it without --student-permission. New accepters revert to the mode default. Pass --student-permission %s to keep it.\n",
			slug, droppedStudentPerm, droppedStudentPerm)
	}
	// Provisioning-class changes only affect repos accepted from now on;
	// already-accepted repos keep their original starter content/shim, which
	// this CLI does not retrofit. Warn (not block) so the teacher knows they own
	// reconciling any resulting inconsistency (mirrors the web app's confirm).
	if changedEmptyRepo {
		_, _ = fmt.Fprintf(errOut,
			"Warning: replacing %q changed its empty_repo setting. Repositories students already accepted are not retrofitted: they keep their original setup, and if autograding is now off their autograde runs start failing and drop out of the collected scores. The new setting applies only to accepts from now on; update existing repositories yourself.\n",
			slug)
	}
	// Heads-up if the encoded file nears GitHub's ~1 MiB contents-API limit
	// (past which encoding flips to "none", wedging future reads/writes).
	// Diagnostic only. See assignment.LargeAssignmentsWarnBytes.
	if lastEncodedSize > assignment.LargeAssignmentsWarnBytes {
		_, _ = fmt.Fprintf(errOut,
			"Warning: %s/%s/%s is %d bytes, approaching GitHub's ~1 MiB contents-API ceiling. Past that, the API returns encoding:\"none\" and future `gh teacher assignment add/remove` calls will fail to read the file. Consider splitting the classroom or shrinking per-entry fields.\n",
			org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), lastEncodedSize)
	}
	// #691: a NEW over-budget slug is blocked in the build above, so reaching
	// here over budget means a pre-cap entry was REPLACED (kept editable on
	// purpose). Warn so the standing accept risk stays visible on every edit.
	if worst, overflows := validate.ComposedRepoNameOverflows(classroom, slug); overflows {
		_, _ = fmt.Fprintf(errOut,
			"Warning: student repos are named `<classroom>-<assignment>-<username>`; %q + %q reaches %d characters with a 39-char username, over GitHub's %d-char repo-name limit. Students with long usernames won't be able to accept. Reuse the assignment under a shorter slug or classroom.\n",
			classroom, slug, worst, validate.GitHubRepoNameMaxLen)
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
		return fmt.Errorf("classroom %q is archived (classroom.json active:false), so new assignments are refused. Run `gh teacher classroom unarchive %s %s` to re-activate it first",
			classroom, org, classroom)
	}
	return nil
}

// templateArg is the parsed `--template` flag. A custom `@branch` is TOLERATED
// but IGNORED (#673 — GitHub's create-from-template API can't select a source
// branch, and changing a generated repo's default branch is blocked by org
// branch rulesets); the assignment always uses the template repo's
// default_branch, resolved by validateTemplateRepo. IgnoredBranch carries a
// specified branch so the caller can warn it won't take effect. Kept distinct
// from assignment.TemplateRef because on-disk Branch must be populated.
type templateArg struct {
	Owner         string
	Repo          string
	IgnoredBranch string // a specified `@branch` we tolerate but ignore; "" when absent
}

// parseTemplateRef parses `<owner>/<repo>[@branch]`. A custom `@branch` is
// tolerated but ignored (#673) — carried as IgnoredBranch so the caller can
// warn — and the assignment uses the template's default branch. Rejects an
// empty ref, a malformed `@` (multiple, or empty after `@`), or a malformed
// `<owner>/<repo>`.
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
		Owner:         parts[0],
		Repo:          parts[1],
		IgnoredBranch: branch,
	}, nil
}

// normalizeDueDate turns a --due value into the stored UTC instant plus its
// provenance (due_meta). Empty → ("", nil, nil). A value with an offset is
// converted to UTC; a zone-less value is interpreted in the machine's local
// zone, then converted. The original input and applied offset/zone are kept in
// due_meta so a wrong-zone deadline stays auditable.
func normalizeDueDate(raw string) (string, *assignment.DueMeta, error) {
	return normalizeLocalDate("--due", raw)
}

// normalizeAvailableFrom is the --available-from release-date counterpart of
// normalizeDueDate; both share normalizeLocalDate and reuse the DueMeta pair.
func normalizeAvailableFrom(raw string) (string, *assignment.DueMeta, error) {
	return normalizeLocalDate("--available-from", raw)
}

// normalizeLocalDate normalizes a wall-clock date flag value to a stored UTC
// instant plus provenance. `flag` names the source flag for error messages. A
// value with an offset is converted to UTC; a zone-less value is interpreted in
// the machine's local zone (failing loudly when it can't be resolved) so the
// stored instant is never a guess.
func normalizeLocalDate(flag, raw string) (string, *assignment.DueMeta, error) {
	if raw == "" {
		return "", nil, nil
	}
	loc, locErr := localDueLocation()
	t, hadOffset, err := assignment.ParseDueTime(raw, loc)
	if err != nil {
		return "", nil, fmt.Errorf("invalid %s: %w", flag, err)
	}
	if !hadOffset && locErr != nil {
		// Zone-less value depends entirely on the local zone, but $TZ was
		// unresolvable. Fail loudly rather than storing the wrong instant.
		return "", nil, fmt.Errorf(
			"invalid %s: %q has no timezone offset and the local timezone "+
				"could not be resolved (%v); pass an explicit offset like -04:00", flag, raw, locErr)
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
// (e.g., "EDT"). due_meta.offset is always exact regardless.
func dueZoneName(loc *time.Location, t time.Time) string {
	if name := loc.String(); name != "" && name != "Local" {
		return name
	}
	abbr, _ := t.Zone()
	return abbr
}

// validateTemplateRepo checks <owner>/<repo> exists and is a template repo,
// then resolves a missing @branch to default_branch. Also returns whether the
// template is private (so add can decide the classroom-team read grant) and the
// fork's cross-org parent owner when it is one (empty otherwise), so add can
// warn that a cross-org fork depends on the upstream org keeping the app
// approved (issue #468). Post-HTTP decisions live in resolveTemplateBranch so
// they're unit-testable without httptest.
func validateTemplateRepo(client githubapi.Client, t templateArg, org string) (ref assignment.TemplateRef, private bool, crossOrgForkParent string, err error) {
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(t.Owner), url.PathEscape(t.Repo))
	var resp struct {
		IsTemplate    bool   `json:"is_template"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
		Fork          bool   `json:"fork"`
		// Repo size in KB. size is populated by an async background job, so a
		// freshly-created/pushed repo with real commits reads 0 for minutes
		// (issue #544) — size alone is NOT a reliable emptiness signal. A non-fork
		// size 0 is only a suspicion, confirmed by an authoritative branches probe
		// below. Forks report size 0 while sharing parent objects (regression
		// #528), so they're never probed and never treated as empty.
		Size   int `json:"size"`
		Parent struct {
			FullName string `json:"full_name"`
		} `json:"parent"`
	}
	if err := client.Get(path, &resp); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return assignment.TemplateRef{}, false, "", fmt.Errorf("template `%s/%s` is not visible to your account: either make it public, or copy it into your org and reference the copy",
				t.Owner, t.Repo)
		}
		return assignment.TemplateRef{}, false, "", fmt.Errorf("GET %s: %w", path, err)
	}
	// Resolve emptiness only for an actual template (mirrors the web path, which
	// returns not-template before probing): a non-template short-circuits in
	// resolveTemplateBranch below, so a non-template size-0 repo issues no probe.
	// For a template, hasCommits resolves the ambiguous non-fork size-0 case with
	// an authoritative branches probe; forks and size > 0 issue no extra request.
	hasCommits := true
	if resp.IsTemplate {
		hasCommits = templateHasCommits(client, t, resp.Fork, resp.Size)
	}
	ref, err = resolveTemplateBranch(t, resp.IsTemplate, hasCommits, resp.DefaultBranch)
	if err != nil {
		return assignment.TemplateRef{}, false, "", err
	}
	// A fork whose upstream lives in a DIFFERENT org: generate copies the fork's
	// own objects, but the copy is governed by the upstream org's OAuth-App
	// policy, so accept fails if that org ever revokes the app.
	if resp.Fork {
		if parentOwner, _, found := strings.Cut(resp.Parent.FullName, "/"); found &&
			parentOwner != "" && !strings.EqualFold(parentOwner, org) {
			crossOrgForkParent = parentOwner
		}
	}
	return ref, resp.Private, crossOrgForkParent, nil
}

// templateInOrg reports whether the template repo is owned by <org>
// (case-insensitive). An in-org private template can be shared with the
// classroom team; an out-of-org private one can't, so add rejects it.
func templateInOrg(templateOwner, org string) bool {
	return strings.EqualFold(templateOwner, org)
}

// resolveTemplateBranch picks the final assignment.TemplateRef from
// --template + repo fields: not-a-template, empty (commitless), or the repo's
// default_branch (a custom `@branch` is tolerated but ignored — #673). Emptiness
// is passed in as a resolved `hasCommits` (the HTTP-aware caller owns the
// branches probe) so this stays a pure, unit-testable function.
func resolveTemplateBranch(t templateArg, isTemplate, hasCommits bool, defaultBranch string) (assignment.TemplateRef, error) {
	if !isTemplate {
		return assignment.TemplateRef{}, fmt.Errorf("`%s/%s` is not a template repository: toggle Settings -> \"Template repository\" on the repo, then re-run", t.Owner, t.Repo)
	}
	// Caught before the empty-branch guard below (which a commitless repo's
	// phantom default_branch would slip past). `hasCommits` is resolved by the
	// caller: size > 0, or a fork (regression #528 — GitHub reports size 0 for a
	// fork sharing objects with its parent), or an authoritative branches probe
	// when size is 0 (size is async and lags a fresh repo's real commits —
	// issue #544).
	if !hasCommits {
		return assignment.TemplateRef{}, fmt.Errorf("template `%s/%s` has no commits: add at least one commit (a README is enough) so students can generate from it, then re-run", t.Owner, t.Repo)
	}
	branch := defaultBranch
	if branch == "" {
		// Not expected once size > 0, but a blank on-disk Branch would trip
		// `student accept`, so guard it anyway.
		return assignment.TemplateRef{}, fmt.Errorf("template `%s/%s` has no default branch: push a commit to it, then re-run", t.Owner, t.Repo)
	}
	return assignment.TemplateRef{Owner: t.Owner, Repo: t.Repo, Branch: branch}, nil
}

// templateHasCommits resolves whether a template has any commits. Forks and a
// reported size > 0 short-circuit to true with no extra request (regression
// #528; fast path). Only the ambiguous non-fork size-0 case issues an
// authoritative branches probe (GET /branches?per_page=1): a non-empty array
// means the repo has commits, an empty array means it is genuinely commitless
// (verified: a truly-empty repo returns 200 [] — issue #544, where size lags a
// fresh repo's real commits). Only a 404 (repo gone) is a definite empty; any
// other error — including a 409 "Git Repository is empty." (the fresh-repo
// warmup window this codebase treats as transient, see gh-student's
// isFreshRepoRetryable) — fails toward has-commits rather than manufacturing a
// false "has no commits". `add`'s real emptiness gate is GitHub's generate at
// accept, and the fresh-repo 409 is already tolerated there.
func templateHasCommits(client githubapi.Client, t templateArg, isFork bool, size int) bool {
	if isFork || size > 0 {
		return true
	}
	path := fmt.Sprintf("repos/%s/%s/branches?per_page=1", url.PathEscape(t.Owner), url.PathEscape(t.Repo))
	var branches []struct {
		Name string `json:"name"`
	}
	if err := client.Get(path, &branches); err != nil {
		// 404 (gone) is a definite empty; any other error (incl. a transient
		// fresh-repo 409, rate-limit 403, or 5xx) is inconclusive, so fail toward
		// has-commits and let generate-at-accept be the real gate.
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return false
		}
		return true
	}
	return len(branches) > 0
}
