import type { GitHubClient } from "@/github-core/client"
import type { AssignmentMode, RepoPermission } from "@/types/classroom"
import { getUser } from "@/github-core/queries"
import { studentRepoName } from "@/util/studentRepo"
import {
  createCommitForAssignment,
  createTreeForAssignment,
  getRepoTreeRecursive,
  updateRefForRepo,
} from "@/github-core/mutations"
import { getRepo } from "@/github-core/repoReads"
import type { GitHubRepo } from "@/github-core/types"
import {
  getBranchRefRepo,
  getCommitByRepo,
  withFreshRepoRetry,
} from "@/github-core/queries"
import {
  ensureFeedbackPullRequest,
  resolveFeedbackBaselineSha,
  type FeedbackPrTemplateRef,
} from "./feedbackPr"
import { fetchAssignmentFromPages } from "../queries/assignments"
import { getAuthenticatedUser } from "../queries/users"
import { acceptAndVerifyOrgMembership } from "../users"
import { isOwnerGitHubOrgRole } from "@/authz"
import { classroomTeamSlugs } from "@/util/teamSlug"
import { GitHubAPIError } from "@/github-core/errors"
import {
  log,
  withAcceptStep,
  AcceptStepError,
  repoContentsPathExists,
  resolveConfigRepoDefaultBranch,
  freshRepoNotReadyError,
  ACCEPT_COMMIT_SUBJECT,
  type OnAcceptStepUpdate,
} from "./accessPrimitives"
import {
  createClassroom50Yaml,
  resolveAutograderWorkflow,
  isDefaultAutograder,
  defaultAutograderWorkflow,
} from "./autograderYaml"
import {
  addFounderCollaborator,
  founderPermission,
  assertAssignmentModeCoherent,
  patchRepoSurface,
  applyRepoAboutTopics,
  resolveRepoFeaturesPatch,
  explicitRepoFeaturesPatch,
  type RepoAboutTopics,
} from "./permissions"
import type { RepoFeaturePatch } from "@/github-core/mutations"
import { createAssignmentRepo } from "./repoCreation"
import type { LocalizedMessage } from "@/types/localizedMessage"
import {
  findMyGroupTeam,
  attachRepoToGroupTeam,
} from "@/domain/teams/groupTeams"
import type { GroupTeamRef } from "@/domain/teams/groupTeams"
import { groupRepoName } from "@/util/studentRepo"

// Land .classroom50.yaml + the autograde workflow as one Tree commit, riding out
// GitHub's git-data lag after POST .../generate (reads 404, the first write 409s
// "Git Repository is empty"). The whole read→build→commit→update runs inside
// withFreshRepoRetry, re-reading the ref + parent commit each attempt and
// requiring non-empty SHAs before writing. Safe because the student's
// just-accepted repo has no concurrent writers.
async function commitAcceptFilesWithFreshRepoRetry(params: {
  client: GitHubClient
  owner: string
  repo: string
  branch: string
  metadataYaml: string
  autogradeYaml: string
  // An init_shim accept creates the repo with auto_init (GitHub needs an
  // initial commit to write against), which seeds a README the assignment
  // contract says must not exist — remove it in the same accept commit so the
  // repo's initial shape lands atomically. The base tree is inspected first:
  // the Trees API rejects deleting a path absent from base_tree (possible on
  // a heal re-run), and an absent README just means nothing to remove.
  removeSeededReadme?: boolean
  // Rebuild the autograde shim for the branch that actually materialized. The
  // default shim's push-trigger branch must match the generated repo's real
  // default branch, which is only known after GitHub's async template copy
  // settles (see below). Omitted for branch-agnostic (teacher-authored) shims.
  rerenderShimForBranch?: (branch: string) => string
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
    const ref = await getBranchRefRepo(client, owner, repo, targetBranch)
    const parentSha = ref.object.sha
    const currentCommit = await getCommitByRepo(client, owner, repo, parentSha)
    const baseTreeSha = currentCommit.tree?.sha

    if (!parentSha || !baseTreeSha) {
      throw freshRepoNotReadyError(owner, repo)
    }

    // Re-render the default shim's push trigger for the branch that actually
    // materialized (targetBranch), so autograde fires on the repo's real
    // default branch rather than a transiently-reported `main`.
    const shim = rerenderShimForBranch
      ? rerenderShimForBranch(targetBranch)
      : autogradeYaml

    let deletePaths: string[] = []
    if (removeSeededReadme) {
      const baseTree = await getRepoTreeRecursive({
        client,
        owner,
        repo,
        treeSha: baseTreeSha,
      })
      deletePaths = baseTree.tree.some((e) => e.path === "README.md")
        ? ["README.md"]
        : []
    }

    const tree = await createTreeForAssignment({
      client,
      owner,
      repo,
      baseTreeSha,
      metadataYaml,
      autogradeYaml: shim,
      deletePaths,
    })

    const commit = await createCommitForAssignment({
      client,
      owner,
      repo,
      // The accept commit that lands `.classroom50.yaml` — the marker the
      // runner uses to resolve the Feedback-PR baseline (see the constant).
      message: ACCEPT_COMMIT_SUBJECT,
      treeSha: tree.sha,
      parentSha,
    })

    await updateRefForRepo({
      client,
      owner,
      repo,
      branch: targetBranch,
      commitSha: commit.sha,
    })

    // The accept commit's SHA (the Feedback-PR base anchor) and the SETTLED
    // branch it actually landed on — the caller's pre-guessed branch may be a
    // transient `main` on a `master` template.
    return { commitSha: commit.sha, branch: targetBranch }
  })
}

type AcceptAssignmentResult = {
  status: "created" | "already-accepted"
  repo: GitHubRepo
  cloneCommand: string
}

// The resolved repo-feature PATCH plus its teacher-forced subset. `full` is
// sent first; on rejection `patchRepoSurface` retries with `explicit` so an
// org-banned inherited key can't drop a forced override. An all-inherit
// assignment carries `{ full: {}, explicit: {} }` (no PATCH).
type RepoFeatureApply = { full: RepoFeaturePatch; explicit: RepoFeaturePatch }

// The tracked "access" step: patch the repo surface + grant the founder role
// (both idempotent upserts). Throws on failure so the checklist surfaces the
// recovery guidance — shared by the templated setup path and the bare-accept
// fresh-create path so that recovery copy lives in one place.
function grantFounderAccessStep(params: {
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

// Provision (or heal) a just-created student repo — land the control files,
// (opt-in) open the Feedback PR, then grant the founder role last. Idempotent,
// so safe to re-run mid-flow.
async function provisionAcceptedRepo(params: {
  client: GitHubClient
  org: string
  repo: GitHubRepo
  username: string
  mode: AssignmentMode
  studentPermission?: RepoPermission
  // Team mode: attach this group team to the repo with push (see
  // grantFounderAccessStep).
  groupTeamSlug?: string
  // Resolved repo-feature PATCH, forwarded to the founder-access step.
  repoFeatures: RepoFeatureApply
  // Template About/Topics to copy, forwarded to the founder-access step.
  repoAboutTopics: RepoAboutTopics
  branch: string
  metadataYaml: string
  autogradeYaml: string
  // Remove the auto_init README in the accept commit (the init_shim shape).
  removeSeededReadme?: boolean
  // Open the accept-time Feedback PR after setup succeeds (issue #228).
  feedbackPr?: boolean
  // When set, the Feedback PR body is read from this template's
  // pull_request_template.md (feedback_pr_template opt-in), best-effort.
  feedbackPrTemplate?: FeedbackPrTemplateRef
  rerenderShimForBranch?: (branch: string) => string
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
    branch,
    metadataYaml,
    autogradeYaml,
    removeSeededReadme = false,
    feedbackPr = false,
    feedbackPrTemplate,
    rerenderShimForBranch,
    onStepUpdate,
  } = params

  // Land the metadata + autograde shim, retrying through GitHub's post-generate
  // git-data lag (see commitAcceptFilesWithFreshRepoRetry).
  const committed = await withAcceptStep(
    {
      id: "setup",
      label: { key: "accept.steps.setup" },
      actions: {
        key: "accept.stepActions.setup",
        params: { org, repo: repo.name, branch },
      },
      doneMessage: { key: "accept.stepDone.setup" },
      onStepUpdate,
    },
    () =>
      commitAcceptFilesWithFreshRepoRetry({
        client,
        owner: org,
        repo: repo.name,
        branch,
        metadataYaml,
        autogradeYaml,
        removeSeededReadme,
        rerenderShimForBranch,
      }),
  )

  // Best-effort: a Feedback PR failure only defers creation to the runner, so it
  // never throws. Runs before the founder grant so the repo is fully set up
  // before we (possibly) narrow the student's own access.
  await openFeedbackPrStep({
    client,
    org,
    repo: repo.name,
    branch: committed.branch,
    resolveAcceptCommitSha: () =>
      resolveFeedbackBaseSha({
        client,
        org,
        repo: repo.name,
        committedSha: committed.commitSha,
      }),
    mode,
    feedbackPr,
    feedbackPrTemplate,
    onStepUpdate,
  })

  // The founder grant is LAST: it can narrow the student's role on their own
  // repo (a below-default student_permission is a self-downgrade), and the
  // member-exact read-back fails loudly when GitHub won't apply it. Running it
  // after setup + feedback means such a failure can't strand the student on a
  // half-provisioned repo — the control files and Feedback PR are already in
  // place; only the final access narrowing is left to retry.
  await grantFounderAccessStep({
    client,
    org,
    repo: repo.name,
    username,
    mode,
    studentPermission,
    groupTeamSlug,
    repoFeatures,
    repoAboutTopics,
    onStepUpdate,
  })
}

// The commit to freeze `feedback` at, preferring the marker's earliest commit
// over the SHA this run just wrote. On the HEAL path the marker already exists,
// so the repair commit is NOT the baseline the runner resolves — freezing there
// would make the runner refuse to maintain the PR for the repo's whole life. On
// a fresh accept the lookup returns the commit just written (or fails on read
// lag), so falling back to it is correct. With no committed SHA to fall back on
// (the already-accepted path, where no commit ran), an unresolvable marker
// leaves nothing to anchor the base and the step defers.
async function resolveFeedbackBaseSha(params: {
  client: GitHubClient
  org: string
  repo: string
  committedSha: string | null
}): Promise<string | null> {
  const { client, org, repo, committedSha } = params
  const oldest = await resolveFeedbackBaselineSha(client, org, repo)
  return oldest ?? committedSha
}

// The "feedback" step's skip message, shared by the disabled-assignment paths.
function skipFeedbackPrStep(onStepUpdate?: OnAcceptStepUpdate) {
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
async function openFeedbackPrStep(params: {
  client: GitHubClient
  org: string
  repo: string
  branch: string
  resolveAcceptCommitSha: () => Promise<string | null>
  mode: AssignmentMode
  feedbackPr: boolean
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
    feedbackPrTemplate,
  })
  onStepUpdate?.({
    id: "feedback",
    status: "complete",
    message: result.ok ? { key: "accept.stepDone.feedback" } : deferred,
  })
}

// Self-scoped "is the viewer active on this team?" probe. 2xx + active =>
// member, a definitive 404 => non-member; any other status (transient) throws
// so the caller fails OPEN rather than blocking a real student on a blip.
async function isActiveTeamMember(
  client: GitHubClient,
  org: string,
  teamSlug: string,
  username: string,
): Promise<boolean> {
  try {
    const membership = await client.request<{ state?: string }>(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
        teamSlug,
      )}/memberships/${encodeURIComponent(username)}`,
    )
    return membership.state === "active"
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return false
    throw err
  }
}

// Enforce that the viewer is enrolled in this classroom before accept: on the
// `classroom50-<classroom>` student team, OR holding a staff role
// (teacher/hta/ta). Owners are filtered by
// the caller. The slug set is single-sourced from classroomTeamSlugs. The slugs
// are derived (a student can't read classroom.json for the GitHub-assigned
// slug); a slug-collision rewrite 404s and reads as non-member, so a miss never
// grants false access.
//
// Fail-OPEN semantics: a definitive membership on ANY probe means enrolled,
// even if a sibling probe hit a transient error — so an enrolled student is
// never blocked by an unrelated blip. Only when every probe returns a
// definitive non-member do we block; a transient error with no definitive
// member rethrows so the flow surfaces a retryable failure rather than a
// wrongful "not enrolled".
export async function assertEnrolledOrStaff(
  client: GitHubClient,
  org: string,
  classroom: string,
  username: string,
): Promise<void> {
  const results = await Promise.allSettled(
    classroomTeamSlugs(classroom).map((slug) =>
      isActiveTeamMember(client, org, slug, username),
    ),
  )
  const isMember = (r: (typeof results)[number]) =>
    r.status === "fulfilled" && r.value
  if (results.some(isMember)) return
  // No definitive membership. If any probe failed transiently, fail open by
  // rethrowing that error (retryable) instead of a wrongful not-enrolled block.
  const rejected = results.find((r) => r.status === "rejected")
  if (rejected && rejected.status === "rejected") throw rejected.reason
  throw new AcceptStepError({ key: "accept.notEnrolled.error" })
}

export async function acceptAssignment(params: {
  client: GitHubClient
  org: string
  classroom: string
  assignmentSlug: string
  // Capability-URL access key from the accept link (?k=). Selects the
  // <classroom>/<secret>/ Pages path for a protected classroom and is written
  // into .classroom50.yaml so submit + the runner can rebuild the URLs.
  // Undefined for an unprotected classroom (plain path). Not read from
  // classroom.json — students can't access the private config repo.
  secret?: string
  // Custom Pages base URL for an org off the github.io default, from the
  // team-description bootstrap record. Undefined = the default host.
  pagesBaseUrl?: string
  onStepUpdate?: OnAcceptStepUpdate
}): Promise<AcceptAssignmentResult> {
  const {
    client,
    org,
    classroom,
    assignmentSlug,
    secret,
    pagesBaseUrl,
    onStepUpdate,
  } = params

  log.info("accept assignment: started", { org, classroom, assignmentSlug })

  const user = await withAcceptStep(
    {
      id: "account",
      label: { key: "accept.steps.account" },
      actions: { key: "accept.stepActions.account" },
      doneMessage: { key: "accept.stepDone.account" },
      onStepUpdate,
    },
    () => getAuthenticatedUser(client),
  )
  const username = user.login

  // Tracked membership step: accept any pending org invite and verify the
  // student is now an ACTIVE member before repo creation (a pending invitee
  // can't create their repo). Verifying here means a SAML-SSO-gated 403 surfaces
  // as an actionable step failure right away (with the SSO/HTTP status) instead
  // of a confusing downstream repo/access failure.
  //
  // Also enforce classroom enrollment: a plain org member who isn't on this
  // classroom's student team (and holds no staff role) can't accept — the same
  // rule the student list and a private template already imply, made consistent
  // for public templates too. Org owners bypass (they administer every
  // classroom). Advisory like every client-side gate; GitHub's private-template
  // permission remains the hard boundary.
  await withAcceptStep(
    {
      id: "membership",
      label: { key: "accept.steps.membership" },
      actions: { key: "accept.stepActions.membership" },
      doneMessage: { key: "accept.stepDone.membership" },
      onStepUpdate,
    },
    async () => {
      const verified = await acceptAndVerifyOrgMembership(client, org)
      if (!isOwnerGitHubOrgRole(verified.role)) {
        await assertEnrolledOrStaff(client, org, classroom, username)
      }
      return verified
    },
  )

  const assignment = await withAcceptStep(
    {
      id: "assignment",
      label: { key: "accept.steps.assignment" },
      actions: {
        key: "accept.stepActions.assignment",
        params: { assignmentSlug, org, classroom },
      },
      doneMessage: {
        key: "accept.stepDone.assignment",
        params: { assignmentSlug },
      },
      onStepUpdate,
    },
    () =>
      fetchAssignmentFromPages(
        org,
        classroom,
        assignmentSlug,
        secret,
        pagesBaseUrl,
      ),
  )

  const sourceOwner = assignment.template?.owner
  const sourceRepo = assignment.template?.repo
  const sourceBranch = assignment.template?.branch ?? "main"

  // Resolve the per-assignment repo-feature override into the PATCH applied at
  // fresh create. "inherit" (an absent key) on a templated assignment must
  // re-apply the TEMPLATE's live setting, because GitHub's POST /generate does
  // NOT copy the template's has_issues/has_wiki/has_projects — the generated
  // repo otherwise gets GitHub defaults (Issues on). So read the template repo's
  // features first (best-effort; a failed read leaves inherited keys unset =
  // GitHub default). Explicit on/off always win; a template-less assignment
  // omits absent keys, leaving GitHub's own create default. Computed once and threaded into every
  // fresh-create access step, never re-asserted on the healthy re-accept path.
  //
  // Skip the template read when every feature is forced explicitly (no key
  // inherits): resolveRepoFeaturesPatch never consults the template then, so the
  // extra GET would be pure waste on every such accept.
  const rf = assignment.repo_features
  const anyInherit =
    !rf ||
    rf.issues === undefined ||
    rf.wiki === undefined ||
    rf.projects === undefined ||
    rf.pull_requests === undefined
  // Also read the template when copy_about / copy_topics is set: like the
  // feature flags, GitHub's POST /generate drops the template's About and
  // Topics, so an opted-in assignment must re-read and re-apply them (#569).
  const wantsAbout = assignment.copy_about === true
  const wantsTopics = assignment.copy_topics === true
  const needsTemplateRead = anyInherit || wantsAbout || wantsTopics
  let templateFeatures: RepoFeaturePatch | null = null
  let repoAboutTopics: RepoAboutTopics = {}
  if (assignment.template && sourceOwner && sourceRepo && needsTemplateRead) {
    try {
      const tmpl = await getRepo(client, sourceOwner, sourceRepo)
      if (tmpl) {
        if (anyInherit) {
          templateFeatures = {
            has_issues: tmpl.has_issues,
            has_wiki: tmpl.has_wiki,
            has_projects: tmpl.has_projects,
            has_pull_requests: tmpl.has_pull_requests,
          }
        }
        // Drop empty values: never blank a repo's About or clear its topics.
        const description = wantsAbout ? tmpl.description?.trim() : undefined
        const topics = wantsTopics ? tmpl.topics : undefined
        repoAboutTopics = {
          ...(description ? { description } : {}),
          ...(topics && topics.length > 0 ? { topics } : {}),
        }
      }
    } catch (err) {
      log.debug("accept: template read failed (non-fatal)", {
        sourceOwner,
        sourceRepo,
        err,
      })
    }
  }
  const repoFeatures: RepoFeatureApply = {
    full: resolveRepoFeaturesPatch(assignment.repo_features, {
      templated: Boolean(assignment.template),
      templateFeatures,
    }),
    explicit: explicitRepoFeaturesPatch(assignment.repo_features),
  }

  // empty_repo assignment: the repo is created bare (no commits) and NO
  // control files are ever committed, so the autograder resolution and the
  // whole setup step are skipped. Mirrors the CLI's acceptIntoBareRepo.
  const isEmptyRepo = assignment.empty_repo === true

  // no_autograder assignment (teacher-supplied CI): a TEMPLATED repo that
  // commits the marker + template content but NO autograde shim of either kind
  // (neither the default shim nor a Pages-fetched workflow), so the teacher's
  // own .github/ CI runs. Unlike empty_repo it keeps the template and permits
  // the Feedback PR. Mirrors the CLI student accept gate (entry.CommitsShim()).
  const isNoAutograder = assignment.no_autograder === true

  // init_shim assignment: a TEMPLATE-LESS repo initialized with only the marker
  // + default shim (no README) that DOES autograde. It sets neither empty_repo
  // nor no_autograder, so it takes the ordinary initialized (non-bare) path and
  // commits the shim — no special-casing beyond the fail-closed guards below.
  const isInitShim = assignment.init_shim === true

  // Whether accept commits an autograde shim at all. Both no-shim states
  // suppress it; the inverse of the CLI's entry.CommitsShim(). empty_repo also
  // skips the whole setup/commit path (it commits nothing); no_autograder still
  // commits the marker + template content, only the shim is omitted.
  const skipsShim = isEmptyRepo || isNoAutograder

  // feedback_pr opts into the accept-time Feedback PR (issue #228). Never
  // set together with empty_repo (the teacher CLI enforces the exclusivity;
  // the bare path below skips the step regardless). no_autograder PERMITS the
  // Feedback PR (a templated repo has a baseline commit), so it is not gated
  // out here — only empty_repo is.
  const wantsFeedbackPr = assignment.feedback_pr === true && !isEmptyRepo

  // feedback_pr_template opts the Feedback PR body into the template repo's
  // native pull_request_template.md. Only meaningful with the Feedback PR on
  // and a template present; resolved once here and passed to every accept path
  // that opens the PR. The read itself (best-effort, fail-open to the built-in
  // body) happens inside ensureFeedbackPullRequest.
  const feedbackPrTemplate: FeedbackPrTemplateRef | undefined =
    wantsFeedbackPr &&
    assignment.feedback_pr_template === true &&
    sourceOwner &&
    sourceRepo
      ? { owner: sourceOwner, repo: sourceRepo, branch: sourceBranch || "main" }
      : undefined

  // empty_repo and template are mutually exclusive at write time, but the
  // published manifest is not re-validated, so a hand-edited entry can carry
  // both. Fail closed rather than half-apply (template content with no
  // control files). Mirrors the CLI's guard.
  if (isEmptyRepo && assignment.template) {
    throw new AcceptStepError({
      key: "accept.errors.emptyRepoWithTemplate",
      params: { assignmentSlug },
    })
  }

  // no_autograder and empty_repo are mutually exclusive at write time, but the
  // published manifest is not re-validated. Both being set is an invalid
  // hand-edited entry — fail closed rather than pick one. Mirrors the CLI
  // student accept guard (accept.go: NoAutograder && EmptyRepo).
  if (isNoAutograder && isEmptyRepo) {
    throw new AcceptStepError({
      key: "accept.errors.noAutograderWithEmptyRepo",
      params: { assignmentSlug },
    })
  }

  // init_shim is the template-less shim-only state; a hand-edited manifest could
  // contradict it. Fail closed rather than half-apply. Mirrors the CLI student
  // accept guards (accept.go: InitShim && Template / EmptyRepo / NoAutograder).
  if (isInitShim && (assignment.template || isEmptyRepo || isNoAutograder)) {
    throw new AcceptStepError({
      key: "accept.errors.initShimInvalidCombo",
      params: { assignmentSlug },
    })
  }

  // Best-effort: resolve the template owner's immutable id (org or user). Never
  // fail accept over this — a missing id is recorded as null.
  let sourceOwnerId: number | null = null
  if (sourceOwner) {
    try {
      sourceOwnerId = (await getUser(client, sourceOwner)).id
    } catch (err) {
      log.debug("accept: template owner id lookup failed (non-fatal)", {
        sourceOwner,
        err,
      })
      sourceOwnerId = null
    }
  }

  // A no-shim accept (empty_repo bare repo, or no_autograder teacher-supplied
  // CI) carries no autograde workflow — mark the step complete (as skipped) so
  // the checklist doesn't look stuck, and never fetch the shim.
  let autogradeYaml = skipsShim
    ? ""
    : await withAcceptStep(
        {
          id: "autograder",
          label: { key: "accept.steps.autograder" },
          actions: {
            key: "accept.stepActions.autograder",
            params: { assignmentSlug },
          },
          doneMessage: { key: "accept.stepDone.autograder" },
          onStepUpdate,
        },
        () =>
          resolveAutograderWorkflow({
            org,
            classroom,
            autograder: assignment.autograder,
            secret,
            pagesBaseUrl,
            // Preliminary branch; the default shim is re-rendered post-create
            // with the assignment repo's actual default branch (below).
            branch: sourceBranch || "main",
            submissionMode: assignment.submission_mode,
            submissionTags: assignment.submission_tags,
          }),
      )
  if (skipsShim) {
    onStepUpdate?.({
      id: "autograder",
      status: "complete",
      message: { key: "accept.stepDone.autograderDisabled" },
    })
  }

  // Team mode: resolve MY group team BEFORE any repo creation — the repo is
  // named after the team's counter, and a student on no team must never mint a
  // username-named repo. The page pre-resolves this too (blocked / create-a-
  // group states); this guard is the authoritative one.
  let groupTeam: GroupTeamRef | null = null
  if (assignment.mode === "team") {
    groupTeam = await withAcceptStep(
      {
        id: "team",
        label: { key: "accept.steps.team" },
        actions: { key: "accept.stepActions.team" },
        doneMessage: { key: "accept.stepDone.team" },
        onStepUpdate,
      },
      async () => {
        const team = await findMyGroupTeam(
          client,
          org,
          classroom,
          assignment.slug,
        )
        if (!team) {
          throw new AcceptStepError(
            (assignment.team_formation ?? "teacher") === "teacher"
              ? { key: "accept.errors.teamTeacherAssigns" }
              : { key: "accept.errors.teamRequired" },
          )
        }
        return team
      },
    )
  }

  const studentRepoNameValue =
    assignment.mode === "team" && groupTeam
      ? groupRepoName(classroom, assignment.slug, groupTeam.n)
      : studentRepoName(classroom, assignment.slug, username)

  const metadataYaml = createClassroom50Yaml({
    classroom,
    assignment: assignment.slug,
    ownerUsername: username,
    ownerId: user.id,
    acceptedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    secret,
    sourceOwner,
    sourceOwnerId,
    sourceRepo,
    sourceBranch,
  })

  const created = await withAcceptStep(
    {
      id: "repo",
      label: { key: "accept.steps.repo" },
      actions: {
        key: "accept.stepActions.repo",
        params: { org, repo: studentRepoNameValue },
      },
      doneMessage: {
        key: "accept.stepDone.repo",
        params: { org, repo: studentRepoNameValue },
      },
      onStepUpdate,
    },
    () =>
      createAssignmentRepo({
        client,
        templateOwner: sourceOwner,
        templateRepo: sourceRepo,
        owner: org,
        name: studentRepoNameValue,
        fallbackBranch: sourceBranch || "main",
        bare: isEmptyRepo,
        includeAllBranches: assignment.include_all_branches === true,
        publicVisibility: assignment.repo_visibility === "public",
      }),
  )

  // The org refused the public create and the repo was created private
  // instead (fail-private, never fail the accept on visibility alone).
  // Overwrite the step's done message so the student learns the actual
  // visibility that landed and who can change it.
  if (created.visibilityFellBackToPrivate) {
    onStepUpdate?.({
      id: "repo",
      status: "complete",
      message: {
        key: "accept.stepDone.repoVisibilityFellBack",
        params: { org, repo: studentRepoNameValue },
      },
    })
  }

  // Bare (empty_repo) path: no control files exist or are ever committed, so
  // the marker probe below is meaningless — an existing repo IS an accepted
  // repo. The only provisioning is the surface patch + founder grant (both
  // idempotent upserts — same least-privilege rule as the normal path), re-run
  // unconditionally to heal a prior accept that died between create and grant.
  // The "setup" step is marked complete (as skipped) so the checklist doesn't
  // look stuck.
  if (isEmptyRepo) {
    const alreadyAccepted = created.kind === "already-accepted"
    if (alreadyAccepted) {
      // Healthy already-accepted bare repo: reconcile the founder role
      // best-effort, matching the templated already-accepted path. A bare
      // repo's only provisioning IS this grant, so a transient failure must
      // not fail a re-run that previously succeeded.
      onStepUpdate?.({
        id: "repo",
        status: "complete",
        message: {
          key: "accept.stepDone.repoExists",
          params: { org, repo: created.repo.name },
        },
      })
      // setup + feedback are structurally skipped for a bare repo; mark them
      // complete before the (last) access reconcile so the checklist order is
      // consistent with the templated path.
      onStepUpdate?.({
        id: "setup",
        status: "complete",
        message: { key: "accept.stepDone.setupSkippedEmptyRepo" },
      })
      skipFeedbackPrStep(onStepUpdate)
      // Re-accept of an already-created bare repo: reconcile ONLY the founder
      // role (best-effort). Repo features are accept-time-only (written at fresh
      // create), so we deliberately do NOT re-PATCH them here — re-asserting
      // would silently revert a student's own later toggle.
      try {
        if (groupTeam) {
          await attachRepoToGroupTeam(
            client,
            org,
            groupTeam.slug,
            created.repo.name,
          )
        }
        await addFounderCollaborator({
          client,
          owner: org,
          repo: created.repo.name,
          username,
          permission: founderPermission(
            assignment.mode,
            assignment.student_permission,
          ),
        })
      } catch (err) {
        log.debug("accept: best-effort role reconcile failed (non-fatal)", {
          org,
          repo: created.repo.name,
          err,
        })
      }
      onStepUpdate?.({ id: "access", status: "complete" })
    } else {
      // Fresh create: setup + feedback are structurally skipped for a bare repo
      // (no control files, no Feedback PR), so mark them complete first and run
      // the founder grant LAST — consistent with the templated path's ordering.
      // The grant hard-fails (an un-granted repo is a broken accept the student
      // can't push to), inside the throwing step so the checklist surfaces the
      // error and its recovery guidance.
      onStepUpdate?.({
        id: "setup",
        status: "complete",
        message: { key: "accept.stepDone.setupSkippedEmptyRepo" },
      })
      skipFeedbackPrStep(onStepUpdate)
      await grantFounderAccessStep({
        client,
        org,
        repo: created.repo.name,
        username,
        mode: assignment.mode,
        studentPermission: assignment.student_permission,
        groupTeamSlug: groupTeam?.slug,
        repoFeatures,
        repoAboutTopics,
        onStepUpdate,
      })
    }

    return {
      status: alreadyAccepted ? "already-accepted" : "created",
      repo: created.repo,
      cloneCommand: `git clone ${created.repo.ssh_url}`,
    }
  }

  // The default shim's push-trigger branch must match the assignment repo's
  // actual default branch (which GitHub, not the template, decides — a `main`
  // template generated into a `master`-default org yields a `master` repo), and
  // its reusable-workflow `uses:` ref must match the config repo's branch. Both
  // are only knowable after the repo exists, so re-render here.
  //
  // The generated repo's real branch lags GitHub's async template copy, so the
  // branch resolved here may still be the transient `main`. rerenderShim lets
  // the commit step rebuild the shim once the true branch materializes.
  let rerenderShim: ((branch: string) => string) | undefined
  if (!skipsShim && isDefaultAutograder(assignment.autograder)) {
    const resolvedBranch =
      created.kind === "fallback-empty"
        ? created.branch
        : created.repo.default_branch || sourceBranch || "main"
    const configBranch = await resolveConfigRepoDefaultBranch(
      client,
      org,
      resolvedBranch,
    )
    autogradeYaml = defaultAutograderWorkflow(
      org,
      resolvedBranch,
      configBranch,
      assignment.submission_mode,
      assignment.submission_tags,
    )
    rerenderShim = (branch: string) =>
      defaultAutograderWorkflow(
        org,
        branch,
        configBranch,
        assignment.submission_mode,
        assignment.submission_tags,
      )
  }

  if (created.kind === "already-accepted") {
    // The repo exists, but a prior accept may have failed AFTER creating it but
    // BEFORE committing the metadata/workflow (seeding lag, transient 5xx),
    // leaving a repo that looks accepted but never autogrades. A repo is only
    // "genuinely accepted" when BOTH the metadata and workflow landed (one
    // commit, so a missing workflow means the prior accept failed mid-flow). If
    // either is missing, re-run the idempotent provisioning.
    //
    // A no_autograder accept commits NO workflow by design, so the workflow
    // probe would always report "missing" and wrongly re-provision a healthy
    // repo forever — for it, the marker alone proves a completed accept.
    const [hasMetadata, hasWorkflow] = await Promise.all([
      repoContentsPathExists(
        client,
        org,
        created.repo.name,
        ".classroom50.yaml",
      ),
      repoContentsPathExists(
        client,
        org,
        created.repo.name,
        ".github/workflows/autograde.yaml",
      ),
    ])
    const provisioned = hasMetadata && (isNoAutograder || hasWorkflow)

    if (provisioned) {
      onStepUpdate?.({
        id: "repo",
        status: "complete",
        message: {
          key: "accept.stepDone.repoExists",
          params: { org, repo: created.repo.name },
        },
      })
      onStepUpdate?.({ id: "setup", status: "complete" })
      // Ensure the Feedback PR exists even on the healthy path: repos
      // accepted before the accept-time-PR feature get their PR by
      // re-accepting — the only Actions-free route. The accept SHA isn't in
      // hand here (no commit ran), so recover it as the oldest commit
      // touching the marker (the runner's baseline_sha() rule); existing PRs
      // short-circuit inside, keeping repeat re-accepts read-only.
      await openFeedbackPrStep({
        client,
        org,
        repo: created.repo.name,
        branch: created.repo.default_branch || sourceBranch,
        resolveAcceptCommitSha: () =>
          resolveFeedbackBaseSha({
            client,
            org,
            repo: created.repo.name,
            committedSha: null,
          }),
        mode: assignment.mode,
        feedbackPr: wantsFeedbackPr,
        feedbackPrTemplate,
        onStepUpdate,
      })
      // Reconcile the founder role LAST (best-effort): a transient failure must
      // not fail a re-run that previously succeeded, and running it after setup
      // + feedback keeps the access step last on every path. Team mode also
      // re-asserts the team attachment (idempotent PUT), healing a prior accept
      // that died between create and attach.
      try {
        if (groupTeam) {
          await attachRepoToGroupTeam(
            client,
            org,
            groupTeam.slug,
            created.repo.name,
          )
        }
        await addFounderCollaborator({
          client,
          owner: org,
          repo: created.repo.name,
          username,
          permission: founderPermission(
            assignment.mode,
            assignment.student_permission,
          ),
        })
      } catch (err) {
        log.debug("accept: best-effort role reconcile failed (non-fatal)", {
          org,
          repo: created.repo.name,
          err,
        })
      }
      onStepUpdate?.({ id: "access", status: "complete" })
      return {
        status: "already-accepted",
        repo: created.repo,
        cloneCommand: `git clone ${created.repo.ssh_url}`,
      }
    }

    // Half-finished prior accept — re-provision to repair it. Re-founding a
    // group-shaped-but-non-group entry would under-privilege the founder, so
    // reject incoherent metadata here (not on the healthy path above).
    assertAssignmentModeCoherent(
      assignment.slug,
      assignment.mode,
      assignment.max_group_size,
    )
    onStepUpdate?.({
      id: "repo",
      status: "complete",
      message: {
        key: "accept.stepDone.repoIncomplete",
        params: { org, repo: created.repo.name },
      },
    })

    await provisionAcceptedRepo({
      client,
      org,
      repo: created.repo,
      username,
      mode: assignment.mode,
      studentPermission: assignment.student_permission,
      groupTeamSlug: groupTeam?.slug,
      // Accept-time only: features are applied on the FRESH create below, never
      // re-asserted when repairing an already-existing repo (this branch runs on
      // a re-accept). Re-PATCHing here would silently revert a student's own
      // later toggle. Pass an empty patch so patchRepoSurface no-ops, matching
      // the healthy already-accepted branch and both CLIs (which skip the PATCH
      // on 422-already-exists).
      repoFeatures: { full: {}, explicit: {} },
      // Same reasoning: About/Topics are copied on FRESH create only, never
      // re-applied when repairing an already-existing repo (a re-accept), so a
      // student's own later edit survives. Nothing to copy on this path.
      repoAboutTopics: {},
      branch: created.repo.default_branch || sourceBranch,
      metadataYaml,
      autogradeYaml,
      removeSeededReadme: isInitShim,
      feedbackPr: wantsFeedbackPr,
      feedbackPrTemplate,
      rerenderShimForBranch: rerenderShim,
      onStepUpdate,
    })

    return {
      status: "already-accepted",
      repo: created.repo,
      cloneCommand: `git clone ${created.repo.ssh_url}`,
    }
  }

  const repo = created.repo

  // Fresh create: reject a group-shaped-but-non-group entry that would found
  // the repo under-privileged (mirrors the half-finished path above).
  assertAssignmentModeCoherent(
    assignment.slug,
    assignment.mode,
    assignment.max_group_size,
  )

  const targetBranch =
    created.kind === "fallback-empty"
      ? created.branch
      : repo.default_branch || sourceBranch

  await provisionAcceptedRepo({
    client,
    org,
    repo,
    username,
    mode: assignment.mode,
    studentPermission: assignment.student_permission,
    groupTeamSlug: groupTeam?.slug,
    repoFeatures,
    repoAboutTopics,
    branch: targetBranch,
    metadataYaml,
    autogradeYaml,
    removeSeededReadme: isInitShim,
    feedbackPr: wantsFeedbackPr,
    feedbackPrTemplate,
    rerenderShimForBranch: rerenderShim,
    onStepUpdate,
  })

  log.info("accept assignment: completed", {
    org,
    classroom,
    assignmentSlug,
    status: "created",
  })
  return {
    status: "created",
    repo,
    cloneCommand: `git clone ${repo.ssh_url}`,
  }
}
