package assignmentcmd

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// autogradeShimPath is the shim's path inside every student repo. Hand-
// mirrored with NO compile-time link from gh-student's
// classroomcfg.AutogradeWorkflowPath and runner.py's SHIM_UPDATE_COMMIT_PATHS
// — keep byte-identical.
const autogradeShimPath = ".github/workflows/autograde.yaml"

// shimTriggerBlock matches the default shim's `on:` block in either mode: the
// optional `branches:` line (group 1) followed by the submit/* tags line. Both
// accept clients emit exactly this shape (their comment headers differ, which
// is why the retrofit is line surgery on the trigger block and never a full
// re-render); anything else is teacher-/student-authored and is never touched.
var shimTriggerBlock = regexp.MustCompile(
	`(?m)^on:\n  push:\n(    branches: \[[^\n]*\]\n)?    tags: \["submit/\*"\]\n`,
)

// assignmentSubmissionModeCmd flips an assignment's `submission_mode` and, by
// default, retrofits the autograde shim in every existing student repo to
// match (the trigger lives in each repo's workflow file, which is otherwise
// frozen at accept time).
func assignmentSubmissionModeCmd() *cobra.Command {
	var (
		everyPush   bool
		tagMode     bool
		updateShims bool
		user        string
		dryRun      bool
		quiet       bool
	)
	cmd := &cobra.Command{
		Use:   "submission-mode <org> <classroom> <slug> (--every-push | --tag)",
		Short: "Set when the autograder fires (every push vs. submit tags) and retrofit existing repos",
		Long: "Set the assignment's submission mode and update the autograde shim in\n" +
			"every existing student repo to match.\n\n" +
			"Modes:\n" +
			"  --every-push  every push to the default branch grades (the default\n" +
			"                behavior); submit/* tag pushes grade too\n" +
			"  --tag         ONLY submit/* tag pushes grade. `gh student submit` and\n" +
			"                the web submit page push the tag; a hand-pushed submit/*\n" +
			"                tag works too. Plain `git push` costs no Actions minutes —\n" +
			"                the cost lever for large cohorts.\n\n" +
			"The trigger lives in each student repo's shim (GitHub evaluates a\n" +
			"workflow's `on:` block before any job runs), so changing the mode must\n" +
			"rewrite `.github/workflows/autograde.yaml` across existing repos. That\n" +
			"retrofit runs by default: enrollment comes from the classroom team, each\n" +
			"member's <classroom>-<slug>-<user> repo is updated idempotently, and the\n" +
			"commit carries `[skip ci]` so it never triggers grading. Repos whose shim\n" +
			"doesn't match a known default-shim trigger shape (e.g., student-edited)\n" +
			"are reported and left untouched. Students must `git pull` afterward —\n" +
			"stale clones will conflict on their next push.\n\n" +
			"Committing workflow files needs the `workflow` OAuth scope\n" +
			"(`gh auth refresh -s workflow` if missing).\n\n" +
			"Custom-autograder assignments: the shim is teacher-authored, so this\n" +
			"command refuses to rewrite it. Edit your autograder's `on:` block\n" +
			"yourself, then re-run with --update-shims=false to flip only the field\n" +
			"(which still controls whether submit clients push the tag).\n\n" +
			"Pass --user to retrofit a single student's repo (e.g., one that was\n" +
			"skipped or failed on a previous run); the field flip is idempotent.",
		Example: "  gh teacher assignment submission-mode cs50-fall-2026 cs-principles hello --tag\n" +
			"  gh teacher assignment submission-mode cs50-fall-2026 cs-principles hello --every-push\n" +
			"  gh teacher assignment submission-mode cs50-fall-2026 cs-principles hello --tag --user alice\n" +
			"  gh teacher assignment submission-mode cs50-fall-2026 cs-principles hello --tag --dry-run",
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
			if everyPush == tagMode {
				return errors.New("pass exactly one of --every-push or --tag")
			}
			mode := contract.SubmissionModeEveryPush
			if tagMode {
				mode = contract.SubmissionModeTag
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			verbose, _ := cmd.Flags().GetBool("verbose")
			return runSubmissionMode(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), submissionModeParams{
				org: org, classroom: classroom, slug: slug,
				mode:        mode,
				updateShims: updateShims,
				user:        strings.TrimSpace(user),
				dryRun:      dryRun,
				quiet:       quiet,
				verbose:     verbose,
			})
		},
	}
	cmd.Flags().BoolVar(&everyPush, "every-push", false, "Grade every push to the default branch (the default behavior)")
	cmd.Flags().BoolVar(&tagMode, "tag", false, "Grade only submit/* tag pushes (submit clients push the tag; plain `git push` does not grade)")
	cmd.Flags().BoolVar(&updateShims, "update-shims", true, "Retrofit each existing student repo's autograde shim to the new trigger; pass --update-shims=false to flip only the assignments.json field")
	cmd.Flags().StringVar(&user, "user", "", "Retrofit a single student's repo (their <classroom>-<slug>-<user> repo) instead of every team member's")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Report the field flip and per-repo shim changes without writing anything")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress informational output (per-repo and summary lines); errors still go to stderr")
	return cmd
}

type submissionModeParams struct {
	org, classroom, slug string
	mode                 string // contract.SubmissionModeEveryPush | contract.SubmissionModeTag
	updateShims          bool
	user                 string
	dryRun               bool
	quiet, verbose       bool
}

// shimOutcome is one repo's classified retrofit result. updated/current are
// the happy paths; unrecognized needs the teacher's judgment (never
// overwritten); notAccepted is a skip; failed is transient (re-run retries).
type shimOutcome int

const (
	shimUpdated      shimOutcome = iota // trigger block rewritten
	shimCurrent                         // already on the target trigger — no commit
	shimUnrecognized                    // content doesn't match a known default-shim shape — left untouched
	shimNotAccepted                     // repo (or shim file) doesn't exist yet
	shimFailed                          // transient error — re-running retries
)

type shimResult struct {
	repo    string
	outcome shimOutcome
	reason  string // set for unrecognized/failed
}

// runSubmissionMode flips the field (lock.go's CommitTree pattern, idempotent)
// and then, unless disabled, retrofits each student repo's shim serially
// (feedbackpr.go's enumeration pattern; GitHub's secondary-rate-limit budget
// makes a concurrent fan-out a liability).
func runSubmissionMode(client githubapi.Client, out, errOut io.Writer, p submissionModeParams) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, p.org)
	if err != nil {
		return err
	}

	// Wire form: every-push collapses to absent (writers omit the default).
	wireMode := p.mode
	if wireMode == contract.SubmissionModeEveryPush {
		wireMode = ""
	}

	// Pre-read the entry for the gating checks (empty_repo, custom
	// autograder) so a refused command writes nothing. The flip itself
	// re-reads inside the commit loop for rebase safety.
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
		return fmt.Errorf("assignment %q is an empty_repo assignment: its repos carry no autograde shim, so submission_mode does not apply", p.slug)
	}
	customAutograder := preEntry.Autograder != "" && preEntry.Autograder != contract.DefaultAutograderName
	if customAutograder && p.updateShims {
		return fmt.Errorf("assignment %q uses the custom autograder %q — its shim is teacher-authored and this command never rewrites it. Edit that autograder's `on:` trigger yourself, then re-run with --update-shims=false to flip only the field (which controls whether submit clients push the tag)",
			p.slug, preEntry.Autograder)
	}

	if p.dryRun {
		if preEntry.SubmissionMode == wireMode {
			_, _ = fmt.Fprintf(out, "dry run: %s already has submission_mode %s — no field change\n", p.slug, p.mode)
		} else {
			_, _ = fmt.Fprintf(out, "dry run: would set submission_mode of %s to %s\n", p.slug, p.mode)
		}
	} else {
		changed := false
		build := func(parentSHA string) (map[string]string, error) {
			file, err := loadAssignments(client, p.org, p.classroom, parentSHA)
			if err != nil {
				return nil, err
			}
			idx, ok := assignment.FindAssignment(file.Assignments, p.slug)
			if !ok {
				return nil, fmt.Errorf("assignment %q disappeared from %s during the update — retry",
					p.slug, assignmentsFilePath(p.classroom))
			}
			entry := file.Assignments[idx]
			if entry.SubmissionMode == wireMode {
				changed = false
				return nil, nil // already in the desired state — no commit
			}
			entry.SubmissionMode = wireMode
			file.Assignments[idx] = entry
			changed = true
			data, err := assignment.EncodeAssignments(file)
			if err != nil {
				return nil, err
			}
			return map[string]string{assignmentsFilePath(p.classroom): string(data)}, nil
		}
		message := contract.PrefixCommit(fmt.Sprintf("assignment: set submission_mode of %s to %s in %s (gh teacher assignment submission-mode)", p.slug, p.mode, p.classroom))
		if _, err := configwrite.CommitTree(client, p.org, configrepo.ConfigRepoName, branch, message, build); err != nil {
			return err
		}
		if !p.quiet {
			if changed {
				_, _ = fmt.Fprintf(out, "%s/%s/%s: set submission_mode of %s to %s\n",
					p.org, configrepo.ConfigRepoName, assignmentsFilePath(p.classroom), p.slug, p.mode)
			} else {
				_, _ = fmt.Fprintf(out, "%s/%s/%s: %s already has submission_mode %s\n",
					p.org, configrepo.ConfigRepoName, assignmentsFilePath(p.classroom), p.slug, p.mode)
			}
		}
	}

	if !p.updateShims {
		if !p.quiet {
			_, _ = fmt.Fprintln(out, "Shim retrofit skipped (--update-shims=false); existing repos keep their current trigger until updated")
		}
		return nil
	}

	repos, err := submissionModeTargetRepos(client, p, branch)
	if err != nil {
		return err
	}
	if len(repos) == 0 {
		if !p.quiet {
			_, _ = fmt.Fprintf(out, "%s: no repos to process — the classroom's student team has no members (sync the roster, or target one repo with --user <login>)\n", p.org)
		}
		return nil
	}

	var results []shimResult
	notAccepted := 0
	for _, repo := range repos {
		res := retrofitShim(client, p.org, repo, p.mode, p.dryRun)
		if res.outcome == shimNotAccepted {
			// Enrolled but not accepted yet. On the explicit --user path the
			// teacher named this repo, so report it unconditionally; the bulk
			// summary still counts it so "of N repo(s)" reflects the roster
			// actually probed (a team full of non-accepters must not read as
			// "0 repo(s)" — that looks like an enumeration failure).
			notAccepted++
			if p.user != "" {
				_, _ = fmt.Fprintf(out, "%s does not exist — %s has not accepted %s yet\n", repo, p.user, p.slug)
			} else if p.verbose && !p.quiet {
				_, _ = fmt.Fprintf(out, "Skipped %s (no repo — not accepted yet?)\n", repo)
			}
			continue
		}
		results = append(results, res)
		reportShimResult(out, res, p)
	}

	return summarizeShimResults(out, errOut, p, results, notAccepted)
}

// submissionModeTargetRepos resolves the repo names to process: a single
// --user repo, or the derived repo for every classroom-team member.
func submissionModeTargetRepos(client githubapi.Client, p submissionModeParams, branch string) ([]string, error) {
	if p.user != "" {
		return []string{contract.AssignmentRepoName(p.classroom, p.slug, p.user)}, nil
	}
	teamSlug, err := configrepo.ResolveClassroomTeamSlug(client, p.org, p.classroom, branch)
	if err != nil {
		return nil, err
	}
	logins, err := configrepo.ListTeamMembers(client, p.org, teamSlug)
	if err != nil {
		return nil, fmt.Errorf("list team %q members: %w", teamSlug, err)
	}
	repos := make([]string, 0, len(logins))
	for _, login := range logins {
		repos = append(repos, contract.AssignmentRepoName(p.classroom, p.slug, login))
	}
	return repos, nil
}

// retrofitShim rewrites one repo's shim trigger block to `mode`. Line surgery
// only: the two accept clients' shim comment headers differ, so a full
// re-render would churn repos accepted by the other client — instead the
// known trigger block is swapped in place and everything else is preserved
// byte-for-byte. Unrecognized content is never overwritten.
func retrofitShim(client githubapi.Client, org, repo, mode string, dryRun bool) shimResult {
	branch, notFound, err := studentRepoDefaultBranch(client, org, repo)
	if err != nil {
		return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
	}
	if notFound {
		return shimResult{repo: repo, outcome: shimNotAccepted}
	}

	current, exists, err := configrepo.ReadFileContents(client, org, repo, autogradeShimPath, branch)
	if err != nil {
		return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
	}
	if !exists {
		// Repo exists but the shim never landed (a mid-flow accept failure).
		// Accept's self-heal owns that case; nothing safe to rewrite here.
		return shimResult{repo: repo, outcome: shimUnrecognized, reason: "no " + autogradeShimPath + " — accept may not have completed; re-accept heals it"}
	}

	updated, changed, err := rewriteShimTrigger(string(current), mode, branch)
	if err != nil {
		return shimResult{repo: repo, outcome: shimUnrecognized, reason: err.Error()}
	}
	if !changed {
		return shimResult{repo: repo, outcome: shimCurrent}
	}
	if dryRun {
		return shimResult{repo: repo, outcome: shimUpdated}
	}

	build := func(parentSHA string) (map[string]string, error) {
		return map[string]string{autogradeShimPath: updated}, nil
	}
	if _, err := configwrite.CommitTree(client, org, repo, branch, contract.ShimUpdateCommitMessage(mode), build); err != nil {
		if errors.Is(err, configwrite.ErrMissingWorkflowScope) {
			return shimResult{repo: repo, outcome: shimFailed, reason: "token lacks the `workflow` OAuth scope — run `gh auth refresh -s workflow` and re-run"}
		}
		return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
	}
	return shimResult{repo: repo, outcome: shimUpdated}
}

// rewriteShimTrigger swaps the shim's trigger block to `mode`, returning the
// rewritten content and whether anything changed. An error means the content
// doesn't carry a recognizable default-shim trigger block.
//
// every-push → tag removes the `branches:` line; tag → every-push inserts it
// with the repo's CURRENT default branch (better than any stale frozen name —
// the shim must fire on the branch pushes actually land on).
func rewriteShimTrigger(content, mode, branch string) (string, bool, error) {
	loc := shimTriggerBlock.FindStringSubmatchIndex(content)
	if loc == nil {
		return "", false, errors.New("shim does not carry a recognizable default trigger block — left untouched (student-edited?)")
	}
	hasBranches := loc[2] != -1

	switch mode {
	case contract.SubmissionModeTag:
		if !hasBranches {
			return content, false, nil
		}
		// Delete exactly the branches line (group 1).
		return content[:loc[2]] + content[loc[3]:], true, nil
	case contract.SubmissionModeEveryPush:
		if hasBranches {
			// A branches line is already present; its (possibly stale) branch
			// name is accept-time behavior, not this command's to correct.
			return content, false, nil
		}
		// Insert the branches line where group 1 would sit: right after
		// "on:\n  push:\n" (the tags line starts there when absent).
		insertAt := loc[0] + len("on:\n  push:\n")
		line := `    branches: ["` + branch + `"]` + "\n"
		return content[:insertAt] + line + content[insertAt:], true, nil
	default:
		return "", false, fmt.Errorf("unknown submission mode %q", mode)
	}
}

// studentRepoDefaultBranch reads the repo's settled default branch and
// reports whether the repo is missing (enrolled but not accepted). Mirrors
// feedbackpr.go's defaultBranch.
func studentRepoDefaultBranch(client githubapi.Client, org, repoName string) (branch string, notFound bool, err error) {
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(repoName))
	var repo struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := client.Get(path, &repo); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return "", true, nil
		}
		return "", false, fmt.Errorf("GET %s: %w", path, err)
	}
	if repo.DefaultBranch == "" {
		return "main", false, nil
	}
	return repo.DefaultBranch, false, nil
}

// reportShimResult prints one repo's per-line outcome on the human channel.
func reportShimResult(out io.Writer, res shimResult, p submissionModeParams) {
	if p.quiet {
		return
	}
	prefix := ""
	if p.dryRun {
		prefix = "dry run: would have "
	}
	switch res.outcome {
	case shimUpdated:
		if p.dryRun {
			_, _ = fmt.Fprintf(out, "%supdated the autograde trigger on %s\n", prefix, res.repo)
		} else {
			_, _ = fmt.Fprintf(out, "Updated autograde trigger on %s\n", res.repo)
		}
	case shimCurrent:
		if p.verbose {
			_, _ = fmt.Fprintf(out, "%s already has the target trigger\n", res.repo)
		}
	case shimUnrecognized:
		_, _ = fmt.Fprintf(out, "Skipped %s: %s\n", res.repo, res.reason)
	case shimFailed:
		_, _ = fmt.Fprintf(out, "Failed: %s (%s)\n", res.repo, res.reason)
	}
}

// summarizeShimResults prints the aggregate counts plus the skipped/failed
// detail lists, and returns a non-nil error when any repo failed.
func summarizeShimResults(out, errOut io.Writer, p submissionModeParams, results []shimResult, notAccepted int) error {
	var updated, current int
	var unrecognized, failed []shimResult
	for _, r := range results {
		switch r.outcome {
		case shimUpdated:
			updated++
		case shimCurrent:
			current++
		case shimUnrecognized:
			unrecognized = append(unrecognized, r)
		case shimFailed:
			failed = append(failed, r)
		}
	}

	if !p.quiet {
		verb := "updated"
		if p.dryRun {
			verb = "would update"
		}
		_, _ = fmt.Fprintf(out, "%s: %d %s, %d already current, %d skipped, %d failed (of %d repo(s))\n",
			p.org, updated, verb, current, len(unrecognized), len(failed), len(results)+notAccepted)
		if notAccepted > 0 {
			_, _ = fmt.Fprintf(out, "%d enrolled student(s) have not accepted %s yet — their repos will get the new trigger at accept time\n", notAccepted, p.slug)
		}
		if updated > 0 && !p.dryRun {
			_, _ = fmt.Fprintln(out, "Tell students to `git pull` — clones made before this change will conflict on their next push.")
		}
	}

	if len(unrecognized) > 0 {
		_, _ = fmt.Fprintln(errOut, "Skipped (shim content not recognized — review and update by hand if intended):")
		for _, r := range unrecognized {
			_, _ = fmt.Fprintf(errOut, "  %s: %s\n", r.repo, r.reason)
		}
	}
	if len(failed) > 0 {
		_, _ = fmt.Fprintln(errOut, "Failed (re-run to retry just these, or pass --user for one repo):")
		for _, r := range failed {
			_, _ = fmt.Fprintf(errOut, "  %s: %s\n", r.repo, r.reason)
		}
		return fmt.Errorf("%d of %d repo(s) failed", len(failed), len(results))
	}
	return nil
}
