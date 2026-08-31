package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/orgpolicy"
	"github.com/foundation50/gh-teacher/internal/ui"
)

func initCmd() *cobra.Command {
	var (
		skipConfirm bool
		dryRun      bool
		asJSON      bool
		quiet       bool
	)

	cmd := &cobra.Command{
		Use:   "init <org>",
		Short: "Bootstrap the classroom50 repository in an organization",
		Long: "Bootstrap the classroom50 repository for a teaching organization.\n" +
			"Run once per organization; re-running is safe and picks up where a\n" +
			"prior run left off.\n\n" +
			"What it sets up, in order:\n" +
			"  1.  Org member-privilege lockdown (least-privilege: members keep\n" +
			"      only private-repo creation and public Pages creation).\n" +
			"  2.  GitHub Actions enabled for the org.\n" +
			"  3.  A $0 GitHub Actions spending cap (created only if none exists;\n" +
			"      an existing teacher-set budget is left untouched).\n" +
			"  4.  Actions allowed to create pull requests (for Feedback PRs).\n" +
			"  5.  Branch rulesets protecting submission history and the\n" +
			"      Feedback base.\n" +
			"  6.  The private classroom50 repository (auto-initialized).\n" +
			"  7.  Repo-level Actions re-enabled.\n" +
			"  8.  The embedded workflow and script files (single commit).\n" +
			"  9.  GitHub Pages (workflow build, visibility public).\n" +
			"  10. Branch protection on the default branch.\n" +
			"  11. Workflow GITHUB_TOKEN permissions.\n" +
			"  12. Reusable-workflow access for the org.\n" +
			"  13. The repo-level CLASSROOM50_SERVICE_TOKEN secret.\n\n" +
			"Setup checks run first: init verifies your OAuth scopes, your\n" +
			"organization access and ownership, the organization plan, and that\n" +
			"a service token is available. If a hard check fails, init stops\n" +
			"before changing anything.\n\n" +
			"Service token:\n" +
			"  - Read from the CLASSROOM50_SERVICE_TOKEN environment variable,\n" +
			"    or a hidden interactive prompt on first setup. There is no\n" +
			"    --token flag: a token on the command line leaks via shell\n" +
			"    history, process listings, and CI logs.\n" +
			"  - Create a fine-grained personal access token with Resource\n" +
			"    owner = your organization, Repository access = All repositories,\n" +
			"    Contents: Read and write, Actions: Read and write, and\n" +
			"    Organization permissions -> Members: Read and Administration:\n" +
			"    Read and write. Student repos are created on demand, so an\n" +
			"    \"Only select repositories\" scope silently misses them.\n" +
			"  - Why each permission: Contents read collects scores; Contents\n" +
			"    write pushes submit/* tags; Actions write re-runs autograde\n" +
			"    workflows when regrading; Members read lists the classroom\n" +
			"    team (collection is team-driven); Organization Administration\n" +
			"    sets the $0 Actions spending cap.\n" +
			"  - init validates the token before storing it. A re-run leaves an\n" +
			"    already-configured token untouched; replace it with\n" +
			"    `gh teacher rotate-service-token <org>`.\n" +
			"  - Since init requires you to be an org owner, your own token is\n" +
			"    auto-approved.\n\n" +
			"Re-running:\n" +
			"  - init picks up where a prior run left off.\n" +
			"  - Workflow and script files that differ from this CLI's embedded\n" +
			"    version are refreshed (so orgs gain new features) after a\n" +
			"    confirmation prompt; --yes skips that prompt for scripted runs.\n\n" +
			"Four org member-privilege settings have no REST API; init reports\n" +
			"them as a manual checklist (and in --json's\n" +
			"manual_hardening_required). See the CLI Teacher Guide for the full\n" +
			"hardening context.",
		Example: "  CLASSROOM50_SERVICE_TOKEN=github_pat_xxx gh teacher init cs50-fall-2026\n" +
			"  gh teacher init cs50-fall-2026              # interactive prompt for the token\n" +
			"  gh teacher init cs50-fall-2026 --dry-run    # preview without changes\n" +
			"  gh teacher init cs50-fall-2026 --json       # machine-readable summary",
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
			out := cmd.OutOrStdout()
			errOut := cmd.ErrOrStderr()

			// --json implies --quiet so stdout stays a single machine-readable
			// object with no interleaved chatter.
			if asJSON {
				quiet = true
			}
			u := ui.New(errOut)

			// Preflight: read-only checks before any mutation. A hard failure
			// stops here so init never leaves a half-configured org. Plan is
			// read once and reused by the lockdown read-back's warning.
			tok := currentTokenSource()
			pre := runPreflight(client, org, tok)
			renderPreflight(u, pre, quiet)
			if pre.Failed {
				return preflightFailError(pre)
			}

			if dryRun {
				if asJSON {
					s := newInitSummary(org)
					s.DryRun = true
					s.Plan = pre.Plan
					s.Preflight = pre.Checks
					s.finalize()
					return s.renderJSON(out)
				}
				renderDryRunSteps(errOut)
				return nil
			}

			// summary is the canonical record every renderer reads from.
			// Plan came from preflight (read once); the manual-hardening
			// checklist is pre-populated.
			summary := newInitSummary(org)
			summary.Plan = pre.Plan
			summary.Preflight = pre.Checks

			total := len(initStepLabels)
			prog := u.NewProgress(total)
			interactive := prog.Active()

			// On an interactive terminal, fold per-step output into one
			// self-rewriting progress line: route helpers' stdout to discard
			// and stderr to a buffer replayed after the line finalizes, so
			// nothing scrolls it away. On a non-TTY/piped/--quiet/--json run,
			// keep stable per-line output.
			stepOut, stepErr := out, errOut
			var capturedErr bytes.Buffer
			if interactive {
				stepOut = io.Discard
				stepErr = &capturedErr
			}
			stepNum := 0
			step := func(label string) {
				stepNum++
				switch {
				case asJSON:
					// no progress output
				case interactive:
					prog.Update(stepNum, label)
				case !quiet:
					u.Step(stepNum, total, label)
				}
			}
			// flushStepWarnings replays warnings the helpers buffered during the
			// interactive progress phase, after the line is done.
			flushStepWarnings := func() {
				if interactive && capturedErr.Len() > 0 {
					_, _ = io.Copy(errOut, &capturedErr)
				}
			}

			// Tighten org-level member defaults before any repos land so the
			// classroom starts in a known-safe state.
			step(initStepLabels[0])
			lockdownComplete, unenforced, err := applyOrgMemberDefaults(client, stepOut, stepErr, org, pre.Plan)
			if err != nil {
				prog.Abort()
				return err
			}
			summary.LockdownComplete = lockdownComplete
			// Build one consolidated, verified checklist of the settings init
			// couldn't apply (plan-gated 422 or silently ignored) from the
			// read-back, each with its GitHub-UI instruction.
			settingsURL := fmt.Sprintf("https://github.com/organizations/%s/settings/member_privileges", org)
			for _, item := range unenforced {
				summary.LockdownManualSteps = append(summary.LockdownManualSteps, orgpolicy.ManualStep{Setting: item.manualFix, URL: settingsURL})
			}
			if !lockdownComplete {
				// The org-level locks defang the repo-admin `student accept`
				// grants each founder. Record the warning; the checklist is
				// rendered at the end so it isn't lost above the progress line.
				summary.addWarning("%s: org member-privilege lockdown is incomplete: %d setting(s) must be set by hand at %s (see the summary checklist). Until then, the repo admin access that `gh student accept` grants founders is not fully contained org-wide.", org, len(unenforced), settingsURL)
			}

			// On Team/Free, "private repos only" doesn't exist: GitHub couples
			// public+private creation into one switch and the student flow
			// needs private, so init can't lock public off (the field is
			// enterpriseOnly, filtered out). Note it so a clean banner isn't
			// read as "members can't create public repos".
			if pre.Plan != "enterprise" {
				planName := pre.Plan
				if planName == "" {
					planName = "your"
				}
				summary.addNote("Member public-repo creation stays enabled on the %s plan: GitHub couples public+private repo creation into one control and the student flow needs private creation, so \"private repos only\" (an Enterprise Cloud capability) can't be applied here.", planName)
			}

			// Enable Actions before any repo/Pages/workflow setup — the
			// classroom workflows all depend on it.
			step(initStepLabels[1])
			if err := ensureOrgActionsEnabled(client, stepOut, stepErr, org); err != nil {
				prog.Abort()
				return err
			}

			// Reconcile the $0 Actions spending cap right after enabling
			// Actions: it's create-only (never overrides a teacher's budget)
			// and best-effort, so it never aborts init.
			step(initStepLabels[2])
			summary.BudgetCap = ensureOrgActionsBudgetCap(client, stepOut, stepErr, org)

			// Allow Actions' GITHUB_TOKEN to open the opt-in Feedback PR.
			// Org-level so student repos inherit it; a maintain student can't
			// set it per-repo. Even with pull-requests: write, PR creation is
			// rejected unless this org toggle is on, and it defaults off.
			step(initStepLabels[3])
			prCreateReady, err := ensureOrgCanCreatePRs(client, stepOut, stepErr, org)
			if err != nil {
				prog.Abort()
				return err
			}

			// Install the org-level rulesets protecting submission history and
			// the Feedback PR base. Org-level so they auto-cover every
			// current/future student repo; warn-and-continue if blocked.
			step(initStepLabels[4])
			rulesetsReady, err := ensureClassroomRulesets(client, stepOut, stepErr, org)
			if err != nil {
				prog.Abort()
				return err
			}

			// Default branch comes from the create/fetch response (org policy
			// can rename it).
			step(initStepLabels[5])
			repo, created, err := ensureConfigRepo(client, org)
			if err != nil {
				prog.Abort()
				return err
			}
			if created {
				_, _ = fmt.Fprintf(stepOut, "%s/%s: created %s\n", org, configrepo.ConfigRepoName, repo.HTMLURL)
			} else {
				_, _ = fmt.Fprintf(stepOut, "%s/%s: already exists, continuing setup\n", org, configrepo.ConfigRepoName)
			}
			summary.ConfigRepo = repoSummary{Name: configrepo.ConfigRepoName, URL: repo.HTMLURL, Created: created}
			branch := repo.DefaultBranch
			if branch == "" {
				branch = "main"
			}

			// Re-enable repo-level Actions before the skeleton push so the
			// workflows' first run isn't blocked.
			step(initStepLabels[6])
			if err := ensureRepoActionsEnabled(client, stepOut, stepErr, org, configrepo.ConfigRepoName); err != nil {
				prog.Abort()
				return err
			}

			step(initStepLabels[7])
			// commitSkeleton may prompt (skeleton-refresh confirmation) on
			// stderr and read stdin, so clear the in-place line first and give
			// it the REAL stderr; success chatter still goes to discard.
			if interactive {
				prog.Abort()
			}
			if err := commitSkeleton(client, cmd.InOrStdin(), stepOut, errOut, org, configrepo.ConfigRepoName, branch, skipConfirm); err != nil {
				prog.Abort()
				return err
			}
			step(initStepLabels[8])
			if err := enablePages(client, stepOut, stepErr, org, configrepo.ConfigRepoName); err != nil {
				prog.Abort()
				return err
			}
			step(initStepLabels[9])
			if err := applyBranchProtection(client, stepOut, org, configrepo.ConfigRepoName, branch); err != nil {
				prog.Abort()
				return err
			}
			step(initStepLabels[10])
			if err := setWorkflowPermissions(client, stepOut, org, configrepo.ConfigRepoName); err != nil {
				prog.Abort()
				return err
			}
			step(initStepLabels[11])
			if err := enableReusableWorkflowAccess(client, stepOut, stepErr, org, configrepo.ConfigRepoName); err != nil {
				prog.Abort()
				return err
			}

			step(initStepLabels[12])
			// The service-token prompt (when needed) must not hide behind the
			// progress line: finalize progress and flush buffered warnings
			// first.
			prog.Done()
			flushStepWarnings()
			if err := provisionServiceToken(cmd, client, summary, org, pre.SecretExists); err != nil {
				return err
			}

			// Consolidated Feedback PR readiness signal.
			summary.FeedbackPRReady = prCreateReady && rulesetsReady
			if !summary.FeedbackPRReady {
				var missing []string
				if !prCreateReady {
					missing = append(missing, "the org Actions-PR setting")
				}
				if !rulesetsReady {
					missing = append(missing, "the submission-history / feedback-base rulesets")
				}
				summary.addWarning("%s: Feedback PR prerequisites are incomplete: %s could not be applied. Assignments created with `--feedback-pr` may not open PRs or may leave submissions unprotected until you apply these at https://github.com/organizations/%s/settings, then re-run `gh teacher init`.",
					org, strings.Join(missing, " and "), org)
			}

			// Pages takes a few seconds after the first publish-pages run
			// before the URL serves.
			summary.PagesURL = fmt.Sprintf("https://%s.github.io/%s/", org, configrepo.ConfigRepoName)
			summary.finalize()

			// Render the canonical summary: JSON to stdout, or the human report
			// to stderr. The human report conveys everything the warnings say,
			// so we don't separately replay summary.Warnings to the terminal.
			if asJSON {
				return summary.renderJSON(out)
			}
			summary.renderHuman(u)
			return nil
		},
	}

	cmd.Flags().BoolVar(&skipConfirm, "yes", false, "Skip the refresh confirmation prompt (scripted runs only)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Run read-only setup checks and list the steps init would perform, without making any changes")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit a machine-readable JSON summary on stdout (implies --quiet); suppresses human output")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress per-step progress and success chatter; keep warnings and the final summary")
	return cmd
}
