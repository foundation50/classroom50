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
	"github.com/foundation50/gh-teacher/internal/validate"
)

// assignmentEnableAutograderCmd turns the built-in autograder on for an
// assignment created without it (`no_autograder`) and, by default, adds the
// default autograde shim to every student repo accepted in the meantime. The
// shim is otherwise only ever written at accept time, so without this the
// already-accepted repos would never grade.
func assignmentEnableAutograderCmd() *cobra.Command {
	var (
		addShims bool
		user     string
		dryRun   bool
		quiet    bool
	)
	cmd := &cobra.Command{
		Use:   "enable-autograder <org> <classroom> <slug>",
		Short: "Turn on the built-in autograder and add its workflow to existing repos",
		Long: "Turn on the built-in autograder for an assignment that was created\n" +
			"without it, and add the autograde workflow to every student repo that\n" +
			"was accepted while it was off.\n\n" +
			"Accept writes `.github/workflows/autograde.yaml` into a student repo\n" +
			"only when the built-in autograder is on, so repos accepted earlier\n" +
			"have no workflow and never grade. This command:\n\n" +
			"  - Clears `no_autograder` on the assignment (a no-op if the web app\n" +
			"    already did).\n" +
			"  - Adds the default autograde workflow to each existing repo that\n" +
			"    lacks one, rendered for the assignment's current submission type\n" +
			"    and tags. Repos that already have the file are left untouched.\n" +
			"  - Commits with `[skip ci]`, so adding the workflow never grades the\n" +
			"    commit itself.\n\n" +
			"Afterward:\n\n" +
			"  - Students must `git pull`: clones made before this change will\n" +
			"    conflict on their next push.\n" +
			"  - Work students already pushed is not graded until their next push.\n" +
			"    Run \"Regrade all\" on the submissions page to grade it now.\n" +
			"  - The published assignment list can lag a minute behind the change;\n" +
			"    a push that lands before then fails and grades on the next push.\n" +
			"  - Committing workflow files needs the `workflow` OAuth scope\n" +
			"    (`gh auth refresh -s workflow` if missing).\n\n" +
			"Not supported: empty_repo assignments (a bare repo has no commit to\n" +
			"add the workflow to) and custom autograders (the workflow is\n" +
			"teacher-authored; add it to the repos yourself).\n\n" +
			"Pass --user to add the workflow to a single student's repo (one that\n" +
			"failed on a previous run, say); the field change is idempotent.",
		Example: "  gh teacher assignment enable-autograder cs50-fall-2026 cs-principles hello\n" +
			"  gh teacher assignment enable-autograder cs50-fall-2026 cs-principles hello --user alice\n" +
			"  gh teacher assignment enable-autograder cs50-fall-2026 cs-principles hello --dry-run",
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
			verbose, _ := cmd.Flags().GetBool("verbose")
			return runEnableAutograder(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), enableAutograderParams{
				org: org, classroom: classroom, slug: slug,
				addShims: addShims,
				user:     strings.TrimSpace(user),
				dryRun:   dryRun,
				quiet:    quiet,
				verbose:  verbose,
			})
		},
	}
	cmd.Flags().BoolVar(&addShims, "add-workflows", true, "Add the workflow to existing student repos (--add-workflows=false changes only assignments.json)")
	cmd.Flags().StringVar(&user, "user", "", "Add the workflow only to this student's <classroom>-<slug>-<user> repo")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Report the field change and per-repo additions without writing anything")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress informational output (per-repo and summary lines); errors still go to stderr")
	return cmd
}

type enableAutograderParams struct {
	org, classroom, slug string
	addShims             bool
	user                 string
	dryRun               bool
	quiet, verbose       bool
}

var enableAutograderWords = shimWords{
	done:      "Added autograde workflow to %s\n",
	dryDone:   "dry run: would have added the autograde workflow to %s\n",
	current:   "%s already has the autograde workflow\n",
	countDid:  "added",
	countDry:  "would add",
	countSame: "already had it",
	atAccept:  "the workflow",
}

// runEnableAutograder clears no_autograder (runSubmissionMode's field-flip
// pattern) and then, unless disabled, adds the shim to each student repo
// serially (GitHub's secondary-rate-limit budget makes a concurrent fan-out a
// liability).
func runEnableAutograder(client githubapi.Client, out, errOut io.Writer, p enableAutograderParams) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, p.org)
	if err != nil {
		return err
	}

	// Pre-read for the gating checks so a refused command writes nothing;
	// the flip re-reads inside the commit loop for rebase safety.
	preFile, err := loadAssignments(client, p.org, p.classroom, branch)
	if err != nil {
		return err
	}
	preIdx, ok := assignment.FindAssignment(preFile.Assignments, p.slug)
	if !ok {
		return fmt.Errorf("assignment %q not found in %s/%s/%s",
			p.slug, p.org, configrepo.ConfigRepoName, assignmentsFilePath(p.classroom))
	}
	preEntry := preFile.Assignments[preIdx]
	if preEntry.EmptyRepo {
		return fmt.Errorf("assignment %q is an empty_repo assignment: its repos have no commits to add a workflow to. Change the repository source in the web app first; repos accepted from then on get the workflow", p.slug)
	}
	if preEntry.Autograder != "" && preEntry.Autograder != contract.DefaultAutograderName {
		return fmt.Errorf("assignment %q uses the custom autograder %q, whose workflow is teacher-authored, and this command only adds the default one. Commit your autograder's workflow to the existing repos yourself", p.slug, preEntry.Autograder)
	}

	if p.dryRun {
		if preEntry.NoAutograder {
			_, _ = fmt.Fprintf(out, "dry run: would turn on the built-in autograder for %s\n", p.slug)
		} else {
			_, _ = fmt.Fprintf(out, "dry run: %s already has the built-in autograder on, no field change\n", p.slug)
		}
	} else {
		build := func(parentSHA string) (map[string]string, error) {
			file, err := loadAssignments(client, p.org, p.classroom, parentSHA)
			if err != nil {
				return nil, err
			}
			idx, ok := assignment.FindAssignment(file.Assignments, p.slug)
			if !ok {
				return nil, fmt.Errorf("assignment %q disappeared from %s during the update: retry",
					p.slug, assignmentsFilePath(p.classroom))
			}
			entry := file.Assignments[idx]
			if !entry.NoAutograder {
				return nil, nil // already on — no commit
			}
			entry.NoAutograder = false
			file.Assignments[idx] = entry
			data, err := assignment.EncodeAssignments(file)
			if err != nil {
				return nil, err
			}
			return map[string]string{assignmentsFilePath(p.classroom): string(data)}, nil
		}
		message := contract.PrefixCommit(fmt.Sprintf("assignment: turn on the built-in autograder for %s in %s (gh teacher assignment enable-autograder)", p.slug, p.classroom))
		commitSHA, err := configwrite.CommitTree(client, p.org, configrepo.ConfigRepoName, branch, message, build)
		if err != nil {
			return err
		}
		if !p.quiet {
			if commitSHA != "" {
				_, _ = fmt.Fprintf(out, "%s/%s/%s: turned on the built-in autograder for %s\n",
					p.org, configrepo.ConfigRepoName, assignmentsFilePath(p.classroom), p.slug)
			} else {
				_, _ = fmt.Fprintf(out, "%s/%s/%s: %s already has the built-in autograder on\n",
					p.org, configrepo.ConfigRepoName, assignmentsFilePath(p.classroom), p.slug)
			}
		}
	}

	if !p.addShims {
		if !p.quiet {
			_, _ = fmt.Fprintln(out, "Workflow backfill skipped (--add-workflows=false); existing repos keep grading off until the workflow is added")
		}
		return nil
	}

	repos, err := assignmentTargetRepos(client, p.org, p.classroom, p.slug, p.user, branch)
	if err != nil {
		return err
	}
	if len(repos) == 0 {
		if !p.quiet {
			_, _ = fmt.Fprintf(out, "%s: no repos to process: the classroom's student team has no members (sync the roster, or target one repo with --user <login>)\n", p.org)
		}
		return nil
	}

	report := shimReport{
		out: out, errOut: errOut,
		slug: p.slug, user: p.user,
		dryRun: p.dryRun, quiet: p.quiet, verbose: p.verbose,
		words: enableAutograderWords,
	}
	var results []shimResult
	notAccepted := 0
	for _, repo := range repos {
		res := backfillShim(client, p.org, repo, branch, preEntry.SubmissionMode, preEntry.SubmissionTags, p.dryRun)
		if res.outcome == shimNotAccepted {
			notAccepted++
			report.notAccepted(repo)
			continue
		}
		results = append(results, res)
		report.result(res)
	}

	if err := report.summarize(p.org, results, notAccepted); err != nil {
		return err
	}
	if !p.quiet && !p.dryRun {
		for _, res := range results {
			if res.outcome == shimUpdated {
				_, _ = fmt.Fprintln(out, "Work already pushed is not graded until the next push. Run \"Regrade all\" on the submissions page to grade it now.")
				break
			}
		}
	}
	return nil
}

// backfillShim adds the default shim to one repo that lacks it. A repo that
// already has the file is reported current and never rewritten (the
// submission-mode retrofit owns reconciling an existing shim's trigger). The
// existence check runs inside the commit build against the parent SHA, like
// retrofitShim, so it's authoritative and rebase-safe.
func backfillShim(client githubapi.Client, org, repo, configBranch, submissionMode string, submissionTags []string, dryRun bool) shimResult {
	branch, notFound, err := studentRepoDefaultBranch(client, org, repo)
	if err != nil {
		return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
	}
	if notFound {
		return shimResult{repo: repo, outcome: shimNotAccepted}
	}

	build := func(parentSHA string) (map[string]string, error) {
		_, exists, err := configrepo.ReadFileContents(client, org, repo, autogradeShimPath, parentSHA)
		if err != nil {
			return nil, err
		}
		if exists {
			return nil, nil
		}
		shim := contract.RenderDefaultShim(org, branch, configBranch, submissionMode, submissionTags)
		return map[string]string{autogradeShimPath: shim}, nil
	}

	if dryRun {
		files, err := build(branch)
		switch {
		case err != nil:
			return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
		case files == nil:
			return shimResult{repo: repo, outcome: shimCurrent}
		default:
			return shimResult{repo: repo, outcome: shimUpdated}
		}
	}

	commitSHA, err := configwrite.CommitTree(client, org, repo, branch, contract.ShimBackfillCommitMessage(), build)
	if err != nil {
		if errors.Is(err, configwrite.ErrMissingWorkflowScope) {
			return shimResult{repo: repo, outcome: shimFailed, reason: "token lacks the `workflow` OAuth scope: run `gh auth refresh -s workflow` and re-run"}
		}
		return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
	}
	if commitSHA == "" {
		return shimResult{repo: repo, outcome: shimCurrent}
	}
	return shimResult{repo: repo, outcome: shimUpdated}
}
