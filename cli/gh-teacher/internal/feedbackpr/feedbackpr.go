// Package feedbackpr implements `gh teacher assignment feedback-pr`: open (or
// repair) the long-lived Feedback PR on every existing student repo for an
// assignment, retroactively and idempotently, from the teacher's side.
//
// This is the CLI twin of the web app's "Open all Feedback PRs" / per-row
// Repair (issue #347): the Feedback PR is opened at accept time now, so a
// GitHub outage or a repo that predates the feature can leave a student
// without one. Running this re-runs the same idempotent ensure flow — the one
// `gh student accept` and the autograde runner use — with the teacher's token,
// so the PR it produces is byte-identical and the runner still adopts it by
// base+head. Only NewCmd is exported.
package feedbackpr

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

func NewCmd() *cobra.Command {
	var (
		user  string
		quiet bool
	)

	cmd := &cobra.Command{
		Use:   "feedback-pr <org> <classroom> <assignment>",
		Short: "Open or repair the Feedback PR on every student repo for an assignment",
		Long: "Open (or repair) the Feedback PR on every existing student repo for an\n" +
			"assignment, retroactively and idempotently.\n\n" +
			"The Feedback PR is normally opened at accept time (by `gh student\n" +
			"accept` / the web app) or by the autograde runner. A GitHub outage, a\n" +
			"transient error, or a repo that predates the feature can leave a student\n" +
			"without one. This command re-runs the SAME idempotent ensure flow with\n" +
			"your (teacher) token: base = the frozen `feedback` branch at the repo's\n" +
			"accept commit, head = the default branch. The PR it produces is\n" +
			"byte-identical to an accept-time or runner-opened one, so the runner\n" +
			"still adopts it and teachers never see two.\n\n" +
			"Enrollment comes from the classroom GitHub team (the same source\n" +
			"`gh teacher download` uses); the expected <classroom>-<assignment>-<user>\n" +
			"repo is derived for each member and skipped when it doesn't exist yet\n" +
			"(not accepted). Pass --user to target a single student's repo.\n\n" +
			"Idempotent: a repo that already has a Feedback PR (in any state) is left\n" +
			"as-is, so re-running only fills the gaps. A student-precreated `feedback`\n" +
			"branch frozen at the wrong commit is reported as BLOCKED — an org admin\n" +
			"must delete that branch before the PR can open; re-running never fixes\n" +
			"it. Requires owner/admin access to the org's repos.",
		Example: "  gh teacher assignment feedback-pr cs50-fall-2026 cs-principles hello\n" +
			"  gh teacher assignment feedback-pr --user alice cs50-fall-2026 cs-principles hello",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true

			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			assignmentSlug := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || assignmentSlug == "" {
				return fmt.Errorf("invalid arguments: org, classroom, and assignment must all be non-empty")
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}

			// verbose is a persistent flag on the root command (main.go); read it
			// here and thread it down rather than reaching for a package global.
			verbose, _ := cmd.Flags().GetBool("verbose")

			return run(client, cmd.OutOrStdout(), cmd.ErrOrStderr(),
				runParams{
					org:        org,
					classroom:  classroom,
					assignment: assignmentSlug,
					user:       strings.TrimSpace(user),
					quiet:      quiet,
					verbose:    verbose,
				})
		},
	}

	cmd.Flags().StringVar(&user, "user", "", "Repair a single student's repo (their <classroom>-<assignment>-<user> repo) instead of every team member's")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress informational output (per-repo and summary lines); errors still go to stderr")
	return cmd
}

type runParams struct {
	org, classroom, assignment string
	user                       string
	quiet, verbose             bool
}

// outcome is one repo's classified result, kept for the summary. The blocked /
// failed split matters because their remedies differ: blocked needs an org
// admin (never retryable), failed is transient (re-run fills the gap). Mirrors
// the web bulk summary's buckets (web/src/domain/assignments/feedbackPr.ts).
type outcome int

const (
	outcomeCreated outcome = iota // opened a new Feedback PR
	outcomeExisted                // already had one (any state) — idempotent no-op
	outcomeBlocked                // `feedback` frozen at the wrong SHA — org admin must delete it
	outcomeFailed                 // transient error — re-running retries
)

type repoResult struct {
	repo    string
	outcome outcome
	reason  string // set for blocked/failed
}

// run enumerates the assignment's student repos from the classroom team and
// fans the idempotent ensure flow over each existing one, serially (matching
// every other teacher command; GitHub's secondary-rate-limit budget makes a
// concurrent fan-out a liability, not a win). Returns a non-nil error when any
// repo is blocked or failed so scripts see a non-zero exit.
func run(client githubapi.Client, out, errOut io.Writer, p runParams) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, p.org)
	if err != nil {
		return err
	}

	assignments, err := configrepo.LoadAssignments(client, p.org, p.classroom, branch)
	if err != nil {
		return err
	}
	entry, ok := findAssignment(assignments, p.assignment)
	if !ok {
		return fmt.Errorf("assignment %q is not registered in %s/%s/%s — run `gh teacher assignment add %s %s %s --name <name> --template <owner>/<repo>` first",
			p.assignment, p.org, configrepo.ConfigRepoName, assignment.AssignmentsFilePath(p.classroom), p.org, p.classroom, p.assignment)
	}

	// A bare repo has no baseline commit to freeze `feedback` at, and an
	// assignment with feedback_pr off never gets a PR — the runner and web
	// refuse the same cases. Fail loudly rather than churn through every repo
	// only to report "no baseline" on each.
	if entry.EmptyRepo {
		return fmt.Errorf("assignment %q is an empty_repo assignment: it has no baseline commit, so no Feedback PR is possible", p.assignment)
	}
	if !entry.FeedbackPR {
		return fmt.Errorf("assignment %q has feedback_pr disabled: no Feedback PR is opened for its repos", p.assignment)
	}

	repos, err := targetRepos(client, p, branch)
	if err != nil {
		return err
	}
	if len(repos) == 0 {
		if !p.quiet {
			_, _ = fmt.Fprintf(out, "%s: no repos to process\n", p.org)
		}
		return nil
	}

	var results []repoResult
	for _, repo := range repos {
		// One repo-object read serves both purposes: distinguish
		// not-accepted-yet (404) from a real error, and hand the ensure the
		// settled default branch it needs (the branch the accept commit landed
		// on — may be `master`). Folding the two avoids a second identical GET.
		branch, notFound, err := defaultBranch(client, p.org, repo)
		if err != nil {
			results = append(results, repoResult{repo: repo, outcome: outcomeFailed, reason: err.Error()})
			_, _ = fmt.Fprintf(errOut, "%s: probe failed: %v\n", repo, err)
			continue
		}
		if notFound {
			// Enrolled but not accepted yet (or a group teammate who joined a
			// founder's repo and owns none). Not a failure — nothing to open.
			// On the explicit --user path the teacher named this one repo, so a
			// missing repo is the answer they asked for: report it unconditionally.
			if p.user != "" {
				_, _ = fmt.Fprintf(out, "%s does not exist — %s has not accepted %s yet\n", repo, p.user, p.assignment)
			} else if p.verbose && !p.quiet {
				_, _ = fmt.Fprintf(out, "Skipped %s (no repo — not accepted yet?)\n", repo)
			}
			continue
		}

		res := ensureOne(client, p.org, repo, branch, entry.Mode)
		results = append(results, res)
		reportRepo(out, res, p.quiet, p.verbose)
	}

	return summarize(out, errOut, p, results)
}

// ensureOne runs the idempotent ensure flow for one repo and classifies the
// result into a summary bucket.
func ensureOne(client githubapi.Client, org, repo, branch, mode string) repoResult {
	err := ensureFeedbackPullRequest(client, org, repo, branch, mode)
	switch {
	case err == nil:
		return repoResult{repo: repo, outcome: outcomeCreated}
	case isAlreadyExists(err):
		return repoResult{repo: repo, outcome: outcomeExisted}
	case isBaseMismatch(err):
		return repoResult{repo: repo, outcome: outcomeBlocked, reason: err.Error()}
	default:
		return repoResult{repo: repo, outcome: outcomeFailed, reason: err.Error()}
	}
}

// targetRepos resolves the repo names to process: a single --user repo, or the
// derived repo for every classroom-team member.
func targetRepos(client githubapi.Client, p runParams, branch string) ([]string, error) {
	if p.user != "" {
		return []string{contract.AssignmentRepoName(p.classroom, p.assignment, p.user)}, nil
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
		repos = append(repos, contract.AssignmentRepoName(p.classroom, p.assignment, login))
	}
	return repos, nil
}

// findAssignment returns the entry for slug (case-insensitive: the slug flows
// into repo names lowercased, so a mixed-case argument still matches).
func findAssignment(assignments assignment.AssignmentsJSON, slug string) (assignment.AssignmentEntry, bool) {
	for _, entry := range assignments.Assignments {
		if strings.EqualFold(entry.Slug, slug) {
			return entry, true
		}
	}
	return assignment.AssignmentEntry{}, false
}

// defaultBranch reads the repo's settled default branch (the branch the accept
// commit landed on — may be `master`, not a pre-guessed `main`), and reports
// whether the repo is missing. A 404 -> notFound=true (enrolled but not
// accepted yet), so this one read both gates the skip and hands the ensure the
// head branch it needs. Any other error propagates so a network/auth failure
// isn't mistaken for "not accepted".
func defaultBranch(client githubapi.Client, org, repoName string) (branch string, notFound bool, err error) {
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

// reportRepo prints one repo's per-line outcome on the human channel.
func reportRepo(out io.Writer, res repoResult, quiet, verbose bool) {
	if quiet {
		return
	}
	switch res.outcome {
	case outcomeCreated:
		_, _ = fmt.Fprintf(out, "Opened Feedback PR on %s\n", res.repo)
	case outcomeExisted:
		if verbose {
			_, _ = fmt.Fprintf(out, "%s already has a Feedback PR\n", res.repo)
		}
	case outcomeBlocked:
		_, _ = fmt.Fprintf(out, "Blocked: %s (%s)\n", res.repo, res.reason)
	case outcomeFailed:
		_, _ = fmt.Fprintf(out, "Failed: %s (%s)\n", res.repo, res.reason)
	}
}

// summarize prints the aggregate counts plus the blocked/failed detail lists,
// and returns a non-nil error when any repo is blocked or failed.
func summarize(out, errOut io.Writer, p runParams, results []repoResult) error {
	var created, existed int
	var blocked, failed []repoResult
	for _, r := range results {
		switch r.outcome {
		case outcomeCreated:
			created++
		case outcomeExisted:
			existed++
		case outcomeBlocked:
			blocked = append(blocked, r)
		case outcomeFailed:
			failed = append(failed, r)
		}
	}

	if !p.quiet {
		_, _ = fmt.Fprintf(out, "%s: %d opened, %d already had one, %d blocked, %d failed (of %d repo(s))\n",
			p.org, created, existed, len(blocked), len(failed), len(results))
	}

	if len(blocked) > 0 {
		_, _ = fmt.Fprintln(errOut, "Blocked (an org admin must delete the mis-frozen `feedback` branch, then re-run):")
		for _, r := range blocked {
			_, _ = fmt.Fprintf(errOut, "  %s: %s\n", r.repo, r.reason)
		}
	}
	if len(failed) > 0 {
		_, _ = fmt.Fprintln(errOut, "Failed (transient — re-run to retry just these):")
		for _, r := range failed {
			_, _ = fmt.Fprintf(errOut, "  %s: %s\n", r.repo, r.reason)
		}
	}

	switch {
	case len(failed) > 0 && len(blocked) > 0:
		return fmt.Errorf("%d repo(s) failed and %d blocked; see stderr above", len(failed), len(blocked))
	case len(failed) > 0:
		return fmt.Errorf("%d of %d repo(s) failed", len(failed), len(results))
	case len(blocked) > 0:
		return fmt.Errorf("%d of %d repo(s) blocked by a mis-frozen `feedback` branch (an org admin must delete it)", len(blocked), len(results))
	}
	return nil
}
