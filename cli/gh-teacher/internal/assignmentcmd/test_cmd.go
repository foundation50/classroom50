package assignmentcmd

import (
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
	"github.com/foundation50/gh-teacher/internal/validate"
)

// assignmentTestCmd is the `gh teacher assignment test` command group: add /
// list / remove declarative tests on an assignment's `tests` block (graded by
// runner.py, no autograder.py needed). Mutually exclusive with a per-assignment
// autograder.py — see ensureNoPerAssignmentAutograder.
func assignmentTestCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "test",
		Short: "Add, list, or remove declarative tests on an assignment",
		Long: "Manage the declarative `tests` block on an assignment in\n" +
			"<org>/classroom50/<classroom>/assignments.json. Each test is one\n" +
			"of three types -- io (compare stdout), run (check exit code), or\n" +
			"python (run pytest) -- mirroring GitHub Classroom's autograding.\n" +
			"Describe tests here instead of writing an autograder.py: the\n" +
			"publish-pages workflow materializes them into the assignment's\n" +
			"Pages bundle and runner.py grades them on every submission. See\n" +
			"the Autograders wiki page for the field reference.\n\n" +
			"For bulk edits (or a GUI/agent export), `gh teacher assignment\n" +
			"add <org> <classroom> <slug> --tests <file.json>` sets the whole\n" +
			"array at once; these subcommands edit one test at a time.",
	}
	cmd.AddCommand(assignmentTestAddCmd())
	cmd.AddCommand(assignmentTestListCmd())
	cmd.AddCommand(assignmentTestRemoveCmd())
	return cmd
}

func assignmentTestAddCmd() *cobra.Command {
	var (
		name         string
		ttype        string
		setup        string
		run          string
		input        string
		inputFile    string
		expected     string
		expectedFile string
		comparison   string
		timeout      int
		exitCode     int
		points       int
	)

	cmd := &cobra.Command{
		Use:   "add <org> <classroom> <slug>",
		Short: "Add or update one declarative test on an assignment",
		Long: "Add a test to the assignment's `tests` block, or replace the\n" +
			"existing test with the same --name (names are unique within an\n" +
			"assignment). Required: --name, --type, --run.\n\n" +
			"--type io: feed --input (or --input-file) on stdin, compare the\n" +
			"  command's stdout against --expected (or --expected-file) using\n" +
			"  --comparison (included | exact | regex).\n" +
			"--type run: pass iff the command's exit code matches --exit-code\n" +
			"  (default 0).\n" +
			"--type python: run pytest; points are split across discovered\n" +
			"  cases at grade time.\n\n" +
			"--input-file / --expected-file name a fixture file the teacher\n" +
			"has committed alongside the assignment at\n" +
			"<classroom>/autograders/<slug>/ in the config repo; it is bundled\n" +
			"and read at grade time. Fails if the assignment slug isn't\n" +
			"registered yet, or if the assignment already has a hand-written\n" +
			"per-assignment autograder.py (the two are mutually exclusive).",
		Example: "  gh teacher assignment test add cs50-fall-2026 cs-principles hello \\\n" +
			"      --name compiles --type run --run \"gcc -o hello hello.c\" --points 1\n" +
			"  gh teacher assignment test add cs50-fall-2026 cs-principles hello \\\n" +
			"      --name \"prints hello\" --type io --setup \"gcc -o hello hello.c\" \\\n" +
			"      --run ./hello --expected \"Hello, world!\" --comparison included --points 2",
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

			spec := assignment.TestSpec{
				Name:         strings.TrimSpace(name),
				Type:         strings.TrimSpace(ttype),
				Setup:        setup,
				Run:          run,
				Input:        input,
				InputFile:    strings.TrimSpace(inputFile),
				Expected:     expected,
				ExpectedFile: strings.TrimSpace(expectedFile),
				Comparison:   strings.TrimSpace(comparison),
				Timeout:      timeout,
				Points:       points,
			}
			// ExitCode is a pointer so "unset" stays distinct from
			// "explicitly require 0"; set it only when the flag was passed.
			if cmd.Flags().Changed("exit-code") {
				ec := exitCode
				spec.ExitCode = &ec
			}
			if err := assignment.ValidateTestSpec(spec); err != nil {
				return err
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAssignmentTestAdd(client, cmd.OutOrStdout(), org, classroom, slug, spec)
		},
	}

	cmd.Flags().StringVar(&name, "name", "", "Test name, unique within the assignment (required)")
	cmd.Flags().StringVar(&ttype, "type", "", "Test type: io | run | python (required)")
	cmd.Flags().StringVar(&run, "run", "", "Command to run (required)")
	cmd.Flags().StringVar(&setup, "setup", "", "Optional command run before --run (e.g. compile)")
	cmd.Flags().StringVar(&input, "input", "", "io only: inline stdin for the run command")
	cmd.Flags().StringVar(&inputFile, "input-file", "", "io only: bundled fixture file fed on stdin")
	cmd.Flags().StringVar(&expected, "expected", "", "io only: inline expected stdout")
	cmd.Flags().StringVar(&expectedFile, "expected-file", "", "io only: bundled fixture file holding expected stdout")
	cmd.Flags().StringVar(&comparison, "comparison", "", "io only: included | exact | regex")
	cmd.Flags().IntVar(&timeout, "timeout", 0, "Seconds before the test fails (0 = default of 10s)")
	cmd.Flags().IntVar(&exitCode, "exit-code", 0, "run only: required exit code (default 0); pass to require a specific code")
	cmd.Flags().IntVar(&points, "points", 0, "Points the test is worth")
	return cmd
}

// runAssignmentTestAdd upserts one test into an existing entry. The conflict
// check and lookup run inside the build closure against each attempt's parent
// SHA, so concurrent edits rebase cleanly. ValidateAssignmentEntry re-runs to
// enforce the count cap + name uniqueness against the merged array.
func runAssignmentTestAdd(client githubapi.Client, out io.Writer, org, classroom, slug string, spec assignment.TestSpec) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	var action string
	build := func(parentSHA string) (map[string]string, error) {
		if err := ensureDeclarativeTestsSupported(client, org, parentSHA); err != nil {
			return nil, err
		}
		if err := ensureNoPerAssignmentAutograder(client, org, classroom, slug, parentSHA); err != nil {
			return nil, err
		}
		file, err := loadAssignments(client, org, classroom, parentSHA)
		if err != nil {
			return nil, err
		}
		idx, ok := assignment.FindAssignment(file.Assignments, slug)
		if !ok {
			return nil, fmt.Errorf("assignment %q is not registered in %s/%s/%s — run `gh teacher assignment add %s %s %s ...` first",
				slug, org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), org, classroom, slug)
		}
		entry := file.Assignments[idx]
		updated, replaced := assignment.UpsertTest(entry.Tests, spec)
		entry.Tests = updated
		if replaced {
			action = "updated"
		} else {
			action = "added"
		}
		if err := assignment.ValidateAssignmentEntry(entry); err != nil {
			return nil, err
		}
		file.Assignments[idx] = entry
		data, err := assignment.EncodeAssignments(file)
		if err != nil {
			return nil, err
		}
		return map[string]string{assignmentsFilePath(classroom): string(data)}, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("assignment: set test %q on %s/%s (gh teacher assignment test add)", spec.Name, classroom, slug))
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: %s test %q on %s (type %s, %d pts)\n",
		org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), action, spec.Name, slug, spec.Type, spec.Points)
	return nil
}

func assignmentTestListCmd() *cobra.Command {
	var (
		asJSON bool
		quiet  bool
	)
	cmd := &cobra.Command{
		Use:   "list <org> <classroom> <slug>",
		Short: "List the declarative tests on an assignment",
		Long: "Print the test names on an assignment, one per line on stdout\n" +
			"(pipeable into `gh teacher assignment test remove`). Pass --json\n" +
			"for the full JSON array of test specs. A one-line summary is\n" +
			"written to stderr unless --quiet. Read-only; no commit lands.",
		Example: "  gh teacher assignment test list cs50-fall-2026 cs-principles hello\n" +
			"  gh teacher assignment test list cs50-fall-2026 cs-principles hello --json",
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
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAssignmentTestList(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, slug, asJSON, quiet)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the full JSON array of test specs instead of one name per line")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress the stderr summary so stdout is the only output stream")
	return cmd
}

func runAssignmentTestList(client githubapi.Client, out, errOut io.Writer, org, classroom, slug string, asJSON, quiet bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	file, err := loadAssignments(client, org, classroom, branch)
	if err != nil {
		return err
	}
	idx, ok := assignment.FindAssignment(file.Assignments, slug)
	if !ok {
		return fmt.Errorf("assignment %q is not registered in %s/%s/%s",
			slug, org, configrepo.ConfigRepoName, assignmentsFilePath(classroom))
	}
	tests := file.Assignments[idx].Tests

	if asJSON {
		if tests == nil {
			tests = []assignment.TestSpec{}
		}
		data, err := output.JSONPretty(tests)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
	} else {
		for _, t := range tests {
			_, _ = fmt.Fprintln(out, t.Name)
		}
	}

	if !quiet {
		path := fmt.Sprintf("%s/%s/%s [%s]", org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), slug)
		switch len(tests) {
		case 0:
			_, _ = fmt.Fprintf(errOut, "%s: no declarative tests — add one with `gh teacher assignment test add %s %s %s ...`\n", path, org, classroom, slug)
		case 1:
			_, _ = fmt.Fprintf(errOut, "%s: 1 test\n", path)
		default:
			_, _ = fmt.Fprintf(errOut, "%s: %d tests\n", path, len(tests))
		}
	}
	return nil
}

func assignmentTestRemoveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remove <org> <classroom> <slug> <test-name>",
		Short: "Remove a declarative test from an assignment",
		Long: "Drop the test with matching name from the assignment's `tests`\n" +
			"block. Idempotent: if the test name is already absent, exits 0\n" +
			"with a note. Errors only if the assignment slug itself isn't\n" +
			"registered.",
		Example: "  gh teacher assignment test remove cs50-fall-2026 cs-principles hello compiles",
		Args:    cobra.ExactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			slug := strings.TrimSpace(args[2])
			testName := strings.TrimSpace(args[3])
			if org == "" || classroom == "" || slug == "" || testName == "" {
				return errors.New("org, classroom, slug, and test-name must all be non-empty")
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
			return runAssignmentTestRemove(client, cmd.OutOrStdout(), org, classroom, slug, testName)
		},
	}
	return cmd
}

func runAssignmentTestRemove(client githubapi.Client, out io.Writer, org, classroom, slug, testName string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	// removed resets at the top of build so a retry never reports stale state.
	// Missing assignment = hard error; missing test = idempotent no-op.
	var removed bool
	build := func(parentSHA string) (map[string]string, error) {
		removed = false
		file, err := loadAssignments(client, org, classroom, parentSHA)
		if err != nil {
			return nil, err
		}
		idx, ok := assignment.FindAssignment(file.Assignments, slug)
		if !ok {
			return nil, fmt.Errorf("assignment %q is not registered in %s/%s/%s",
				slug, org, configrepo.ConfigRepoName, assignmentsFilePath(classroom))
		}
		entry := file.Assignments[idx]
		next, ok := assignment.RemoveTest(entry.Tests, testName)
		removed = ok
		if !ok {
			return nil, nil // test already absent: no-op
		}
		entry.Tests = next
		if err := assignment.ValidateAssignmentEntry(entry); err != nil {
			return nil, err
		}
		file.Assignments[idx] = entry
		data, err := assignment.EncodeAssignments(file)
		if err != nil {
			return nil, err
		}
		return map[string]string{assignmentsFilePath(classroom): string(data)}, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("assignment: remove test %q from %s/%s (gh teacher assignment test remove)", testName, classroom, slug))
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	path := fmt.Sprintf("%s/%s/%s", org, configrepo.ConfigRepoName, assignmentsFilePath(classroom))
	if removed {
		_, _ = fmt.Fprintf(out, "%s: removed test %q from %s\n", path, testName, slug)
	} else {
		_, _ = fmt.Fprintf(out, "%s: test %q not found on %s, nothing to do\n", path, testName, slug)
	}
	return nil
}

// materializeScriptPath is the skeleton script publish-pages runs to translate
// `tests` blocks into bundled tests.json files.
const materializeScriptPath = ".github/scripts/materialize_tests.py"

// ensureDeclarativeTestsSupported rejects writing declarative tests when the
// skeleton predates materialize_tests.py. Without it, tests would land in
// assignments.json but never reach the Pages bundle, so submissions silently
// fall back while looking graded.
func ensureDeclarativeTestsSupported(client githubapi.Client, org, ref string) error {
	exists, err := configrepo.ContentsExists(client, org, configrepo.ConfigRepoName, materializeScriptPath, ref)
	if err != nil {
		return fmt.Errorf("check %s/%s/%s: %w", org, configrepo.ConfigRepoName, materializeScriptPath, err)
	}
	if !exists {
		return fmt.Errorf("%s/%s is missing %s, so declarative tests would never run — re-run `gh teacher init %s` to update the skeleton, then retry",
			org, configrepo.ConfigRepoName, materializeScriptPath, org)
	}
	return nil
}

// ensureNoPerAssignmentAutograder rejects writing declarative tests for a slug
// that already has a hand-written autograder.py: the runner prefers
// autograder.py, so the tests would silently never run. Probed against `ref`.
func ensureNoPerAssignmentAutograder(client githubapi.Client, org, classroom, slug, ref string) error {
	path := assignment.PerAssignmentAutograderPath(classroom, slug)
	exists, err := configrepo.ContentsExists(client, org, configrepo.ConfigRepoName, path, ref)
	if err != nil {
		return fmt.Errorf("check %s/%s/%s: %w", org, configrepo.ConfigRepoName, path, err)
	}
	if exists {
		return fmt.Errorf("assignment %q has a per-assignment autograder at %s/%s/%s — declarative tests and a hand-written autograder.py are mutually exclusive (the runner prefers autograder.py); remove it before adding tests",
			slug, org, configrepo.ConfigRepoName, path)
	}
	return nil
}
