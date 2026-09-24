import type { GitHubClient } from "@/github-core/client"
import type { Assignment } from "@/types/classroom"
import type { GroupTeamRef } from "@/domain/teams/groupTeams"
import { attachRepoToGroupTeam } from "@/domain/teams/groupTeams"
import type { PagesEnableReason } from "@/github-core/mutations"
import type { FeedbackPrTemplateRef } from "./feedbackPr"
import { log, type OnAcceptStepUpdate } from "./accessPrimitives"
import {
  addFounderCollaborator,
  founderPermission,
  type RepoAboutTopics,
} from "./permissions"
import type { AcceptRepoCreationResult } from "./repoCreation"
import {
  enablePagesBestEffort,
  grantFounderAccessStep,
  openFeedbackPrStep,
  PAGES_SKIPPED_MESSAGE_KEYS,
  resolveFeedbackBaseSha,
  settleFreshRepoBranch,
  type AcceptAssignmentResult,
  type RepoFeatureApply,
} from "./acceptSteps"

// Accept for the shapes that commit nothing (empty_repo, no_autograder): with no
// marker to probe, an existing repo IS an accepted repo, and the founder grant is
// re-run to heal an accept that died between create and grant. no_autograder
// additionally gets Pages (fresh create) and the Feedback PR, anchored on the
// branch that materializes after GitHub's async template copy. CLI twin:
// gh-student's acceptWithoutSetupCommit.
export async function acceptWithoutSetupCommit(params: {
  client: GitHubClient
  org: string
  classroom: string
  assignmentSlug: string
  assignment: Assignment
  username: string
  created: AcceptRepoCreationResult
  // The branch the create reported; a fresh no_autograder create re-reads it
  // once GitHub's async template copy settles.
  createdBranch: string
  isNoAutograder: boolean
  wantsFeedbackPr: boolean
  feedbackPrTemplate?: FeedbackPrTemplateRef
  groupTeam: GroupTeamRef | null
  repoFeatures: RepoFeatureApply
  repoAboutTopics: RepoAboutTopics
  onStepUpdate?: OnAcceptStepUpdate
}): Promise<AcceptAssignmentResult> {
  const {
    client,
    org,
    classroom,
    assignmentSlug,
    assignment,
    username,
    created,
    createdBranch,
    isNoAutograder,
    wantsFeedbackPr,
    feedbackPrTemplate,
    groupTeam,
    repoFeatures,
    repoAboutTopics,
    onStepUpdate,
  } = params
  const alreadyAccepted = created.kind === "already-accepted"
  const repoName = created.repo.name

  // Open the Feedback PR against the root commit (no marker to resolve; an
  // older marker still wins inside resolveFeedbackBaseSha). A fresh create
  // whose settled head IS the root commit passes it as `knownBaseSha` and
  // skips the history walks. Best-effort and always resolves complete, like
  // every feedback step.
  const feedbackStep = (branch: string, knownBaseSha?: string) =>
    openFeedbackPrStep({
      client,
      org,
      repo: repoName,
      branch,
      resolveAcceptCommitSha: () =>
        knownBaseSha
          ? Promise.resolve(knownBaseSha)
          : resolveFeedbackBaseSha({
              client,
              org,
              repo: repoName,
              committedSha: null,
              branch,
              rootIsBaseline: true,
            }),
      mode: assignment.mode,
      feedbackPr: wantsFeedbackPr,
      autograded: false,
      feedbackPrTemplate,
      onStepUpdate,
    })

  if (alreadyAccepted) {
    // Healthy already-accepted repo: reconcile the founder role best-effort,
    // matching the templated already-accepted path. This repo's only
    // provisioning IS this grant, so a transient failure must not fail a
    // re-run that previously succeeded.
    onStepUpdate?.({
      id: "repo",
      status: "complete",
      message: {
        key: "accept.stepDone.repoExists",
        params: { org, repo: repoName },
      },
    })
    // setup is structurally skipped; mark it complete before feedback and
    // the (last) access reconcile so the checklist order is consistent with
    // the templated path.
    onStepUpdate?.({
      id: "setup",
      status: "complete",
      message: { key: "accept.stepDone.setupSkipped" },
    })
    // Repos accepted before the accept-time-PR feature get their PR by
    // re-accepting — the only Actions-free route. Existing PRs
    // short-circuit inside, keeping repeat re-accepts read-only.
    await feedbackStep(createdBranch)
    // Re-accept of an already-created repo: reconcile ONLY the founder role
    // (best-effort). Repo features are accept-time-only (written at fresh
    // create), so we deliberately do NOT re-PATCH them here — re-asserting
    // would silently revert a student's own later toggle.
    try {
      if (groupTeam) {
        await attachRepoToGroupTeam(client, org, groupTeam.slug, repoName)
      }
      await addFounderCollaborator({
        client,
        owner: org,
        repo: repoName,
        username,
        permission: founderPermission(
          assignment.mode,
          assignment.student_permission,
        ),
      })
    } catch (err) {
      log.debug("accept: best-effort role reconcile failed (non-fatal)", {
        org,
        repo: repoName,
        err,
      })
    }
    onStepUpdate?.({ id: "access", status: "complete" })
  } else {
    // The branch wait is best-effort (Pages and the PR defer to a re-run); the
    // founder grant is not: an un-granted repo is one the student can't push
    // to, so it runs last inside the throwing step, like the templated path.
    let settledBranch = createdBranch
    // Root head (no parents): also the Feedback PR baseline, see feedbackStep.
    let rootSha: string | undefined
    let branchReady = false
    let pagesRefusal: PagesEnableReason | null = null
    const needsBranch =
      isNoAutograder && (wantsFeedbackPr || assignment.pages !== undefined)
    if (needsBranch) {
      onStepUpdate?.({
        id: "setup",
        status: "running",
        message: { key: "accept.steps.setup" },
      })
      try {
        const { branch, head } = await settleFreshRepoBranch(
          client,
          org,
          repoName,
          createdBranch,
          () =>
            onStepUpdate?.({
              id: "setup",
              status: "running",
              message: { key: "accept.steps.setupWaiting" },
            }),
        )
        settledBranch = branch
        branchReady = true
        if ((head.commit.parents?.length ?? 0) === 0) {
          rootSha = head.headSha
        }
      } catch (err) {
        log.warn("accept: fresh repo branch never settled (non-fatal)", {
          org,
          repo: repoName,
          err,
        })
      }
      if (branchReady && assignment.pages) {
        pagesRefusal = await enablePagesBestEffort(
          client,
          org,
          repoName,
          assignment.pages,
          settledBranch,
        )
      }
      onStepUpdate?.({
        id: "setup",
        status: "complete",
        message: {
          // The feedback step reports its own deferral below, so the setup
          // message speaks only for Pages, and only when Pages was asked for.
          key:
            !branchReady && assignment.pages
              ? "accept.stepDone.setupBranchUnsettled"
              : pagesRefusal
                ? PAGES_SKIPPED_MESSAGE_KEYS[pagesRefusal]
                : "accept.stepDone.setupSkipped",
        },
      })
    } else {
      onStepUpdate?.({
        id: "setup",
        status: "complete",
        message: { key: "accept.stepDone.setupSkipped" },
      })
    }
    if (needsBranch && !branchReady && wantsFeedbackPr) {
      // Nothing to anchor the PR on yet; the re-run heals it.
      onStepUpdate?.({
        id: "feedback",
        status: "complete",
        message: { key: "accept.stepDone.feedbackDeferred" },
      })
    } else {
      await feedbackStep(settledBranch, rootSha)
    }
    await grantFounderAccessStep({
      client,
      org,
      repo: repoName,
      username,
      mode: assignment.mode,
      studentPermission: assignment.student_permission,
      groupTeamSlug: groupTeam?.slug,
      repoFeatures,
      repoAboutTopics,
      onStepUpdate,
    })
  }

  log.info("accept assignment: completed", {
    org,
    classroom,
    assignmentSlug,
    status: alreadyAccepted ? "already-accepted" : "created",
  })
  return {
    status: alreadyAccepted ? "already-accepted" : "created",
    repo: created.repo,
    cloneCommand: `git clone ${created.repo.ssh_url}`,
  }
}
