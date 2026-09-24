package assignmentcmd

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/repoconfig"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
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
			"    and tags. An existing workflow file is never rewritten.\n" +
			"  - Adds the `.classroom50.yaml` marker in the same commit when the\n" +
			"    repo has none (accept writes no marker while the autograder is\n" +
			"    off), since the autograder reads it to find the assignment.\n" +
			"  - Commits with `[skip ci]`, so adding the workflow never grades the\n" +
			"    commit itself.\n\n" +
			"Afterward:\n\n" +
			"  - Students must `git pull`: clones made before this change will\n" +
			"    conflict on their next push.\n" +
			"  - Work students already pushed is graded on their next push, not\n" +
			"    before: a workflow only runs for commits that contain it, so\n" +
			"    \"Regrade all\" cannot reach earlier commits. To grade now, have\n" +
			"    students push once (an empty commit works).\n" +
			"  - The published assignment list can lag a minute behind the change;\n" +
			"    a push that lands before then fails and grades on the next push.\n" +
			"  - Committing workflow files needs the `workflow` OAuth scope\n" +
			"    (`gh auth refresh -s workflow` if missing).\n\n" +
			"Not supported: empty_repo assignments (a bare repo has no commit to\n" +
			"add the workflow to), custom autograders (the workflow is\n" +
			"teacher-authored; add it to the repos yourself), and group or team\n" +
			"assignments (add the workflow from each group repository's row on\n" +
			"the submissions page).\n\n" +
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
	afterUpdated: "Work students already pushed is graded on their next push. To grade it now, have them push once " +
		"(`git commit --allow-empty -m \"Grade\" && git push`).",
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
	// Repos are derived per classroom-team member; group and team repos carry
	// a group segment instead, so every probe would read as "not accepted".
	if preEntry.Mode != "" && preEntry.Mode != assignment.ModeIndividual {
		return fmt.Errorf("assignment %q is a %s assignment: this command adds the workflow to individual repos only. Add it from each group repository's row on the submissions page", p.slug, preEntry.Mode)
	}

	if p.dryRun {
		if preEntry.NoAutograder {
			_, _ = fmt.Fprintf(out, "dry run: would turn on the built-in autograder for %s\n", p.slug)
		} else {
			_, _ = fmt.Fprintf(out, "dry run: %s already has the built-in autograder on, no field change\n", p.slug)
		}
	} else {
		message := contract.PrefixCommit(fmt.Sprintf("assignment: turn on the built-in autograder for %s in %s (gh teacher assignment enable-autograder)", p.slug, p.classroom))
		commitSHA, err := flipAssignmentField(client, p.org, p.classroom, p.slug, branch, message, func(entry *assignment.AssignmentEntry) bool {
			if !entry.NoAutograder {
				return false
			}
			entry.NoAutograder = false
			return true
		})
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
			_, _ = fmt.Fprintln(out, "Workflow not added to existing repos (--add-workflows=false); they keep grading off until it is added")
		}
		return nil
	}

	report := shimReport{
		out: out, errOut: errOut,
		slug: p.slug, user: p.user,
		dryRun: p.dryRun, quiet: p.quiet, verbose: p.verbose,
		words: enableAutograderWords,
	}
	repos, err := assignmentTargetRepos(client, p.org, p.classroom, p.slug, p.user, branch)
	if err != nil {
		return err
	}
	if len(repos) == 0 {
		report.noRepos(p.org)
		return nil
	}

	// A no_autograder accept writes no `.classroom50.yaml`, and the runner the
	// shim calls refuses a repo without one, so a missing marker is rebuilt in
	// the same commit. The secret comes from classroom.json (a protected
	// classroom's Pages path); the template source from the entry, its owner
	// id resolved once for the whole run.
	marker := backfillMarker{classroom: p.classroom, slug: p.slug}
	if cls, ok, err := configrepo.LoadClassroom(client, p.org, p.classroom, branch); err != nil {
		return err
	} else if ok {
		marker.secret = cls.Secret
	}
	if t := preEntry.Template; t != nil {
		marker.source = &repoconfig.Source{
			Owner:   t.Owner,
			OwnerID: lookupUserID(client, t.Owner),
			Repo:    t.Repo,
			Branch:  t.Branch,
		}
	}

	var results []shimResult
	notAccepted := 0
	for _, repo := range repos {
		res := backfillShim(client, p.org, repo, branch, preEntry.SubmissionMode, preEntry.SubmissionTags, p.dryRun, marker)
		if res.outcome == shimNotAccepted {
			notAccepted++
			report.notAccepted(repo)
			continue
		}
		results = append(results, res)
		report.result(res)
	}

	return report.summarize(p.org, results, notAccepted)
}

// backfillMarker is what a repo's missing `.classroom50.yaml` is rebuilt from.
// The student login is recovered from the repo name (the backfill is
// individual-only, so the suffix after `<classroom>-<slug>-` is the login).
type backfillMarker struct {
	classroom, slug, secret string
	// source is the template block, resolved once per run (nil = template-less).
	source *repoconfig.Source
}

// render builds the marker accept would have written for repo, minus
// accepted_at (this is not the accept).
func (m backfillMarker) render(client githubapi.Client, org, repo string) (string, error) {
	login := strings.TrimPrefix(repo, contract.AssignmentRepoPrefix(m.classroom, m.slug))
	out, err := repoconfig.Render(repoconfig.Config{
		Schema:     repoconfig.SchemaV1,
		Classroom:  m.classroom,
		Assignment: m.slug,
		Secret:     m.secret,
		Owner:      &repoconfig.Identity{Username: login, ID: lookupUserID(client, login)},
		Source:     m.source,
	})
	if err != nil {
		return "", fmt.Errorf("render %s for %s/%s: %w", contract.MetadataPath, org, repo, err)
	}
	return string(out), nil
}

// lookupUserID resolves a login's immutable numeric id best-effort: any failure
// (404, transient 5xx, rate limit) yields nil so the marker records null rather
// than the backfill failing over a lookup. Mirrors gh-student's accept.
func lookupUserID(client githubapi.Client, login string) *int64 {
	_, id, err := membership.LookupUser(client, login)
	if err != nil {
		return nil
	}
	return &id
}

// backfillShim adds the default shim to one repo that lacks it, plus the
// marker when that is missing too. An existing default shim is never rewritten
// (the submission-mode retrofit owns reconciling its trigger) and, with its
// marker in place, is reported current; any other file at the reserved path is
// reported unrecognized and left alone, since calling it "present" would hide
// that nothing grades. The check runs inside the commit build against the
// parent SHA, like retrofitShim, so it's rebase-safe.
func backfillShim(client githubapi.Client, org, repo, configBranch, submissionMode string, submissionTags []string, dryRun bool, marker backfillMarker) shimResult {
	branch, notFound, err := studentRepoDefaultBranch(client, org, repo)
	if err != nil {
		return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
	}
	if notFound {
		return shimResult{repo: repo, outcome: shimNotAccepted}
	}

	// The marker render (one user lookup) runs at most once per repo: the
	// build closure re-runs on a rebase retry, and nothing in it depends on the
	// parent SHA.
	renderMarker := sync.OnceValues(func() (string, error) {
		return marker.render(client, org, repo)
	})

	var unrecognized error
	// markerOnly: the default shim was already in place and only the marker was
	// written (a template that ships the shim, or a backfill that wrote the shim
	// alone); reported as shimMarkerAdded.
	markerOnly := false
	build := func(parentSHA string) (map[string]string, error) {
		unrecognized = nil
		markerOnly = false
		current, exists, err := configrepo.ReadFileContents(client, org, repo, autogradeShimPath, parentSHA)
		if err != nil {
			return nil, err
		}
		if exists && !isDefaultShim(string(current)) {
			unrecognized = errors.New("a workflow already exists at " + autogradeShimPath + " but is not the default autograde shim; left untouched")
			return nil, nil
		}
		files := map[string]string{}
		if !exists {
			files[autogradeShimPath] = contract.RenderDefaultShim(org, branch, configBranch, submissionMode, submissionTags)
		}
		_, hasMarker, err := configrepo.ReadFileContents(client, org, repo, contract.MetadataPath, parentSHA)
		if err != nil {
			return nil, err
		}
		if !hasMarker {
			// Landing the marker here does not move the repo's baseline: every
			// reader (runner.py, collect_scores.py, both CLIs, the web) recognizes
			// ShimBackfillCommitSubject and keeps the root commit, so a Feedback
			// PR the no_autograder accept froze there stays valid.
			rendered, err := renderMarker()
			if err != nil {
				return nil, err
			}
			files[contract.MetadataPath] = rendered
			markerOnly = exists
		}
		if len(files) == 0 {
			return nil, nil
		}
		return files, nil
	}
	written := func() shimResult {
		if markerOnly {
			return shimResult{repo: repo, outcome: shimMarkerAdded}
		}
		return shimResult{repo: repo, outcome: shimUpdated}
	}

	if dryRun {
		files, err := build(branch)
		switch {
		case err != nil:
			return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
		case unrecognized != nil:
			return shimResult{repo: repo, outcome: shimUnrecognized, reason: unrecognized.Error()}
		case files == nil:
			return shimResult{repo: repo, outcome: shimCurrent}
		default:
			return written()
		}
	}

	commitSHA, err := configwrite.CommitTree(client, org, repo, branch, contract.ShimBackfillCommitMessage(), build)
	if err != nil {
		if errors.Is(err, configwrite.ErrMissingWorkflowScope) {
			return shimResult{repo: repo, outcome: shimFailed, reason: "token lacks the `workflow` OAuth scope: run `gh auth refresh -s workflow` and re-run"}
		}
		return shimResult{repo: repo, outcome: shimFailed, reason: err.Error()}
	}
	if unrecognized != nil {
		return shimResult{repo: repo, outcome: shimUnrecognized, reason: unrecognized.Error()}
	}
	if commitSHA == "" {
		return shimResult{repo: repo, outcome: shimCurrent}
	}
	return written()
}

// isDefaultShim recognizes a default autograde shim from either accept client:
// the known trigger block plus a `uses:` of the org's reusable runner. Mirrors
// the web isDefaultShim (submissionTrigger.ts).
func isDefaultShim(content string) bool {
	return shimTriggerBlock.MatchString(content) &&
		strings.Contains(content, "/classroom50/.github/workflows/autograde-runner.yaml@")
}
