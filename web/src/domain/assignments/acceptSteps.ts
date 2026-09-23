import type { GitHubClient } from "@/github-core/client"
import type {
  AssignmentMode,
  AssignmentPages,
  RepoPermission,
} from "@/types/classroom"
import { pagesCreateBody } from "@/util/repoPages"
import {
  assignmentAcceptTree,
  commitRepoFiles,
  readRepoHead,
  getRepoTreeRecursive,
  enableRepoPages,
  type PagesEnableReason,
  type RepoFeaturePatch,
  type RepoHead,
} from "@/github-core/mutations"
import { getRepo } from "@/github-core/repoReads"
import type { GitHubRepo } from "@/github-core/types"
import { withFreshRepoRetry } from "@/github-core/queries"
import {
  ensureFeedbackPullRequest,
  resolveFeedbackBaselineSha,
  type FeedbackPrTemplateRef,
} from "./feedbackPr"
import {
  log,
  withAcceptStep,
  freshRepoNotReadyError,
  ACCEPT_COMMIT_SUBJECT,
  type OnAcceptStepUpdate,
} from "./accessPrimitives"
import {
  addFounderCollaborator,
  founderPermission,
  patchRepoSurface,
  applyRepoAboutTopics,
  type RepoAboutTopics,
} from "./permissions"
import type { LocalizedMessage } from "@/types/localizedMessage"
import { attachRepoToGroupTeam } from "@/domain/teams/groupTeams"

// The tracked steps acceptAssignment and acceptWithoutSetupCommit compose:
// landing the control files, enabling Pages, settling a fresh repo's branch,
// opening the Feedback PR, and the founder grant. Each owns its own recovery
// copy so the two flows report failures identically.
// Land .classroom50.yaml + the autograde workflow as one Tree commit, riding out
// GitHub's git-data lag after POST .../generate (reads 404, the first write 409s
// "Git Repository is empty"). The whole read→build→commit→update runs inside
// withFreshRepoRetry, re-reading the ref + parent commit each attempt and
// requiring non-empty SHAs before writing. Safe because the student's
// just-accepted repo has no concurrent writers.
//
// The budget is deliberately generous (~50s, polling every 8s once warmed up):
// the accept flow can't resume itself, so giving up here strands the student
// on a repo without its setup files (issue #502). The CLI waits a comparable
// span (WaitForStableBranch + CommitWithFreshRepoRetry).
const ACCEPT_SETUP_RETRY = {
  attempts: 10,
  baseDelayMs: 500,
  backoffFactor: 2,
  maxDelayMs: 8_000,
} as const

// Retries before the step message switches from "Setting up" to "still
// initializing": ~3.5s in, long enough that silence would start to read as a
// hang.
const SETUP_WAITING_AFTER_RETRIES = 2

const setupRetryOptions = (onStillInitializing?: () => void) => ({
  ...ACCEPT_SETUP_RETRY,
  onRetry: (attempt: number) => {
    if (attempt === SETUP_WAITING_AFTER_RETRIES) onStillInitializing?.()
  },
})

export async function commitAcceptFilesWithFreshRepoRetry(params: {
  client: GitHubClient
  owner: string
  repo: string
  branch: string
  metadataYaml: string
  autogradeYaml: string
  // An init_shim accept creates the repo with auto_init (GitHub needs an
  // initial commit to write against), which seeds a README the assignment
  // contract says must not exist — remove it in the same accept commit so the
  // repo's initial shape lands atomically. Only while the branch is still at
  // that seed (a root commit): on a heal re-run after the student has pushed,
  // README.md is theirs to keep (issue #502). The base tree is inspected first
  // because the Trees API rejects deleting a path absent from base_tree.
  removeSeededReadme?: boolean
  // Rebuild the autograde shim for the branch that actually materialized. The
  // default shim's push-trigger branch must match the generated repo's real
  // default branch, which is only known after GitHub's async template copy
  // settles (see below). Omitted for branch-agnostic (teacher-authored) shims.
  rerenderShimForBranch?: (branch: string) => string
  // Runs after the fresh repo is readable and before the accept commit, so a
  // side effect the commit's push should see (the Pages site) exists first.
  // Re-invoked on retry, so it must be idempotent, and it must not throw.
  beforeCommit?: (settledBranch: string) => Promise<void>
  // Called once the wait has gone on long enough to be worth explaining.
  onStillInitializing?: () => void
}): Promise<{ commitSha: string; branch: string }> {
  const {
    client,
    owner,
    repo,
    branch,
    metadataYaml,
    autogradeYaml,
    removeSeededReadme = false,
    rerenderShimForBranch,
    beforeCommit,
    onStillInitializing,
  } = params

  return await withFreshRepoRetry(async () => {
    // A freshly template-generated repo's real branch (copied from the template,
    // e.g., `master`) only materializes after GitHub finishes the async copy —
    // until then `default_branch` transiently reports the org default (`main`)
    // and no ref exists. Re-resolve the live default branch each attempt so we
    // commit to the branch that actually appears, not a pre-guessed `main` that
    // may never exist. Fall back to the caller's branch while it's still empty.
    const live = await getRepo(client, owner, repo)
    const targetBranch = live?.default_branch || branch
    const head = await readRepoHead(client, { owner, repo }, targetBranch, () =>
      freshRepoNotReadyError(owner, repo),
    )

    // Re-render the default shim's push trigger for the branch that actually
    // materialized (targetBranch), so autograde fires on the repo's real
    // default branch rather than a transiently-reported `main`.
    const shim = rerenderShimForBranch
      ? rerenderShimForBranch(targetBranch)
      : autogradeYaml

    let deletePaths: string[] = []
    const atSeedCommit = (head.commit.parents?.length ?? 0) === 0
    if (removeSeededReadme && atSeedCommit) {
      const baseTree = await getRepoTreeRecursive({
        client,
        owner,
        repo,
        treeSha: head.baseTreeSha,
      })
      deletePaths = baseTree.tree.some((e) => e.path === "README.md")
        ? ["README.md"]
        : []
    }

    await beforeCommit?.(targetBranch)

    // The accept commit that lands `.classroom50.yaml`, the marker the runner
    // uses to resolve the Feedback-PR baseline (see the constant).
    const { commitSha } = await commitRepoFiles(
      client,
      { owner, repo },
      head,
      assignmentAcceptTree({
        metadataYaml,
        autogradeYaml: shim,
        deletePaths,
      }),
      ACCEPT_COMMIT_SUBJECT,
    )

    // The accept commit's SHA (the Feedback-PR base anchor) and the SETTLED
    // branch it actually landed on — the caller's pre-guessed branch may be a
    // transient `main` on a `master` template.
    return { commitSha, branch: targetBranch }
  }, setupRetryOptions(onStillInitializing))
}

export type AcceptAssignmentResult = {
  status: "created" | "already-accepted"
  repo: GitHubRepo
  cloneCommand: string
}

// The resolved repo-feature PATCH plus its teacher-forced subset. `full` is
// sent first; on rejection `patchRepoSurface` retries with `explicit` so an
// org-banned inherited key can't drop a forced override. An all-inherit
// assignment carries `{ full: {}, explicit: {} }` (no PATCH).
export type RepoFeatureApply = {
  full: RepoFeaturePatch
  explicit: RepoFeaturePatch
}

// The setup step's done message when the Pages create was refused, by reason.
export const PAGES_SKIPPED_MESSAGE_KEYS: Record<PagesEnableReason, string> = {
  plan: "accept.stepDone.pagesSkipped.plan",
  policy: "accept.stepDone.pagesSkipped.policy",
  branch: "accept.stepDone.pagesSkipped.branch",
  access: "accept.stepDone.pagesSkipped.access",
  unknown: "accept.stepDone.pagesSkipped.unknown",
}

// Enable the assignment's Pages site on a fresh repo. Best-effort: returns the
// refusal reason for the setup step's done message and never throws (a rate
// limit enableRepoPages rethrows for the bulk fan-out's sake included).
// Idempotent, so a retrying caller may invoke it again.
export async function enablePagesBestEffort(
  client: GitHubClient,
  org: string,
  repo: string,
  pages: AssignmentPages,
  branch: string,
): Promise<PagesEnableReason | null> {
  const body = pagesCreateBody(pages, branch)
  if (!body) {
    log.warn("pages: unknown source, skipped (non-fatal)", {
      org,
      repo,
      source: pages.source,
    })
    return "unknown"
  }
  try {
    const result = await enableRepoPages(client, org, repo, body)
    if (result.enabled) return null
    log.warn("pages: enable refused (non-fatal)", {
      org,
      repo,
      reason: result.reason,
      error: result.error,
    })
    return result.reason
  } catch (err) {
    log.warn("pages: enable failed (non-fatal)", { org, repo, error: err })
    return "unknown"
  }
}

// Wait for a just-created repo's default branch to become readable, resolving
// the branch that actually materialized (GitHub's async template copy can
// briefly report the org default instead) and its head. The no-setup-commit
// accept path needs it before enabling Pages or anchoring the Feedback PR; the
// committing path does the same inside commitAcceptFilesWithFreshRepoRetry.
export async function settleFreshRepoBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
  fallbackBranch: string,
  onStillInitializing?: () => void,
): Promise<{ branch: string; head: RepoHead }> {
  return withFreshRepoRetry(async () => {
    const live = await getRepo(client, owner, repo)
    const branch = live?.default_branch || fallbackBranch
    const head = await readRepoHead(client, { owner, repo }, branch, () =>
      freshRepoNotReadyError(owner, repo),
    )
    return { branch, head }
  }, setupRetryOptions(onStillInitializing))
}

// The tracked "access" step: patch the repo surface + grant the founder role
// (both idempotent upserts). Throws on failure so the checklist surfaces the
// recovery guidance — shared by the templated setup path and the
// no-setup-commit fresh-create path so that recovery copy lives in one place.
export function grantFounderAccessStep(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
  mode: AssignmentMode
  studentPermission?: RepoPermission
  // Team mode: the group team to attach to the repo with push — the
  // authoritative repo<->team link, asserted before the founder grant.
  groupTeamSlug?: string
  // Resolved repo-feature PATCH to apply before the founder grant. `full` is
  // every resolved key; `explicit` is the teacher-forced subset used as the
  // fail-open retry body. Empty `full` ({}) skips the request (templated +
  // all-inherit); best-effort/fail-open.
  repoFeatures: RepoFeatureApply
  // Template About/Topics to copy onto the repo (issue #569), applied after the
  // feature PATCH, best-effort/fail-open. `{}` = nothing to copy.
  repoAboutTopics: RepoAboutTopics
  onStepUpdate?: OnAcceptStepUpdate
}) {
  const {
    client,
    org,
    repo,
    username,
    mode,
    studentPermission,
    groupTeamSlug,
    repoFeatures,
    repoAboutTopics,
    onStepUpdate,
  } = params
  return withAcceptStep(
    {
      id: "access",
      label: { key: "accept.steps.access" },
      actions: {
        key: "accept.stepActions.access",
        params: { org, repo, username },
      },
      doneMessage: { key: "accept.stepDone.access" },
      onStepUpdate,
    },
    async () => {
      await patchRepoSurface(
        client,
        org,
        repo,
        repoFeatures.full,
        repoFeatures.explicit,
      )
      await applyRepoAboutTopics(client, org, repo, repoAboutTopics)
      // The team attachment is the load-bearing access grant for team mode
      // (each member's push flows through it), so it lands before the
      // (narrower) per-student founder grant. Idempotent PUT.
      if (groupTeamSlug) {
        await attachRepoToGroupTeam(client, org, groupTeamSlug, repo)
      }
      await addFounderCollaborator({
        client,
        owner: org,
        repo,
        username,
        permission: founderPermission(mode, studentPermission),
      })
    },
  )
}

// The commit to freeze `feedback` at, preferring the marker's earliest commit
// over the SHA this run just wrote. On the HEAL path the marker already exists,
// so the repair commit is NOT the baseline the runner resolves — freezing there
// would make the runner refuse to maintain the PR for the repo's whole life. On
// a fresh accept the lookup returns the commit just written (or fails on read
// lag), so falling back to it is correct. With no committed SHA to fall back on
// (the already-accepted path, where no commit ran), an unresolvable marker
// leaves nothing to anchor the base and the step defers.
export async function resolveFeedbackBaseSha(params: {
  client: GitHubClient
  org: string
  repo: string
  committedSha: string | null
  // The repo's default branch, for the root-commit cases (a backfilled marker,
  // or no marker on a no_autograder repo); see resolveFeedbackBaselineSha.
  branch: string
  // no_autograder: no marker is ever written, so the root commit is the
  // baseline even with an empty marker history.
  rootIsBaseline?: boolean
}): Promise<string | null> {
  const { client, org, repo, committedSha, branch, rootIsBaseline } = params
  const oldest = await resolveFeedbackBaselineSha(client, org, repo, {
    branch,
    rootIsBaseline,
  })
  return oldest ?? committedSha
}

// The "feedback" step's skip message, shared by the disabled-assignment paths.
export function skipFeedbackPrStep(onStepUpdate?: OnAcceptStepUpdate) {
  onStepUpdate?.({
    id: "feedback",
    status: "complete",
    message: { key: "accept.stepDone.feedbackSkipped" },
  })
}

// The tracked "feedback" step around ensureFeedbackPullRequest. Unlike the
// throwing withAcceptStep steps, this ALWAYS resolves complete: a red error
// row on an accept that succeeded would mislead, and the deferred message
// names the retry instead. Skips (feedbackPr false / missing accept SHA) also
// complete, so the checklist never looks stuck.
//
// resolveAcceptCommitSha is called lazily, only once the step is actually going
// to run — it costs a paginated commit-history read.
export async function openFeedbackPrStep(params: {
  client: GitHubClient
  org: string
  repo: string
  branch: string
  resolveAcceptCommitSha: () => Promise<string | null>
  mode: AssignmentMode
  feedbackPr: boolean
  autograded: boolean
  feedbackPrTemplate?: FeedbackPrTemplateRef
  onStepUpdate?: OnAcceptStepUpdate
}) {
  const {
    client,
    org,
    repo,
    branch,
    resolveAcceptCommitSha,
    mode,
    feedbackPr,
    autograded,
    feedbackPrTemplate,
    onStepUpdate,
  } = params

  if (!feedbackPr) {
    skipFeedbackPrStep(onStepUpdate)
    return
  }

  onStepUpdate?.({
    id: "feedback",
    status: "running",
    message: { key: "accept.steps.feedback" },
  })

  const deferred: LocalizedMessage = { key: "accept.stepDone.feedbackDeferred" }

  const acceptCommitSha = await resolveAcceptCommitSha()
  if (!acceptCommitSha) {
    log.warn("feedback PR: accept commit not resolvable (non-fatal)", {
      org,
      repo,
    })
    onStepUpdate?.({ id: "feedback", status: "complete", message: deferred })
    return
  }

  const result = await ensureFeedbackPullRequest({
    client,
    owner: org,
    repo,
    branch,
    acceptCommitSha,
    mode,
    autograded,
    feedbackPrTemplate,
  })
  onStepUpdate?.({
    id: "feedback",
    status: "complete",
    message: result.ok ? { key: "accept.stepDone.feedback" } : deferred,
  })
}
