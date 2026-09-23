import type { GitHubClient } from "@/github-core/client"
import type {
  AssignmentMode,
  AssignmentPages,
  RepoPermission,
} from "@/types/classroom"
import { getUser } from "@/github-core/queries"
import { studentRepoName } from "@/util/studentRepo"
import type { PagesEnableReason } from "@/github-core/mutations"
import { getRepo } from "@/github-core/repoReads"
import type { GitHubRepo } from "@/github-core/types"
import type { FeedbackPrTemplateRef } from "./feedbackPr"
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
  type OnAcceptStepUpdate,
} from "./accessPrimitives"
import {
  createClassroom50Yaml,
  resolveAutograderWorkflow,
  isDefaultAutograder,
  defaultAutograderWorkflow,
} from "./autograderYaml"
import { ACCEPT_MARKER_PATH } from "@/util/yaml"
import {
  addFounderCollaborator,
  founderPermission,
  assertAssignmentModeCoherent,
  resolveRepoFeaturesPatch,
  explicitRepoFeaturesPatch,
  type RepoAboutTopics,
} from "./permissions"
import type { RepoFeaturePatch } from "@/github-core/mutations"
import { createAssignmentRepo } from "./repoCreation"
import {
  findMyGroupTeam,
  attachRepoToGroupTeam,
} from "@/domain/teams/groupTeams"
import type { GroupTeamRef } from "@/domain/teams/groupTeams"
import { groupRepoName } from "@/util/studentRepo"
import {
  commitAcceptFilesWithFreshRepoRetry,
  grantFounderAccessStep,
  openFeedbackPrStep,
  PAGES_SKIPPED_MESSAGE_KEYS,
  resolveFeedbackBaseSha,
  enablePagesBestEffort,
  type AcceptAssignmentResult,
  type RepoFeatureApply,
} from "./acceptSteps"
import { acceptWithoutSetupCommit } from "./acceptWithoutSetupCommit"

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
  // The assignment's Pages block, configured before the accept commit. Fresh
  // create only: the heal/re-accept paths pass undefined so a student's own
  // later Pages change survives.
  pages?: AssignmentPages
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
    pages,
    branch,
    metadataYaml,
    autogradeYaml,
    removeSeededReadme = false,
    feedbackPr = false,
    feedbackPrTemplate,
    rerenderShimForBranch,
    onStepUpdate,
  } = params

  // Pages goes before the accept commit so that commit's push is the site's
  // first deploy (a deploy workflow's first run would otherwise fail: no site
  // yet). Best-effort: any refusal, including a rate limit enableRepoPages
  // rethrows for the bulk fan-out's sake, is remembered for the setup step's
  // done message and never thrown.
  let pagesRefusal: PagesEnableReason | null = null
  const configurePages = pages
    ? async (settledBranch: string) => {
        pagesRefusal = await enablePagesBestEffort(
          client,
          org,
          repo.name,
          pages,
          settledBranch,
        )
      }
    : undefined

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
        beforeCommit: configurePages,
        onStillInitializing: () =>
          onStepUpdate?.({
            id: "setup",
            status: "running",
            message: { key: "accept.steps.setupWaiting" },
          }),
      }),
  )

  // Tell the student the site was not configured and why; the teacher can
  // enable it from the submissions page.
  if (pagesRefusal) {
    onStepUpdate?.({
      id: "setup",
      status: "complete",
      message: { key: PAGES_SKIPPED_MESSAGE_KEYS[pagesRefusal] },
    })
  }

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
        branch: committed.branch,
      }),
    mode,
    feedbackPr,
    // Every accept reaching this path commits the shim (the no-shim shapes
    // never provision), so the PR body keeps its autograding lines.
    autograded: true,
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
  // whole setup step are skipped. Mirrors the CLI's acceptWithoutSetupCommit.
  const isEmptyRepo = assignment.empty_repo === true

  // no_autograder assignment: an initialized repo (template or README) that
  // is left exactly as GitHub created it. Accept commits NOTHING: no autograde
  // shim of either kind (neither the default shim nor a Pages-fetched
  // workflow) and no .classroom50.yaml marker, so a template's own .github/
  // CI runs, or nothing does, and a grader importing the repo sees only the
  // student's files (discussion #1045). Unlike empty_repo it keeps the starter
  // content and permits the Feedback PR, whose baseline is then the repo's
  // root commit. Mirrors the CLI student accept gate (entry.CommitsShim()).
  const isNoAutograder = assignment.no_autograder === true

  // init_shim assignment: a TEMPLATE-LESS repo initialized with only the marker
  // + default shim (no README) that DOES autograde. It sets neither empty_repo
  // nor no_autograder, so it takes the ordinary initialized (non-bare) path and
  // commits the shim — no special-casing beyond the fail-closed guards below.
  const isInitShim = assignment.init_shim === true

  // Whether accept commits anything at all. Both no-shim states skip the whole
  // setup commit (marker + shim); the inverse of the CLI's entry.CommitsShim().
  const skipsSetupCommit = isEmptyRepo || isNoAutograder

  // feedback_pr opts into the accept-time Feedback PR (issue #228). Never
  // set together with empty_repo (the teacher CLI enforces the exclusivity;
  // a false here makes openFeedbackPrStep record the skip). no_autograder
  // PERMITS the Feedback PR (an initialized repo has a root commit to freeze
  // the base at), so it is not gated out here — only empty_repo is.
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
  let autogradeYaml = skipsSetupCommit
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
  if (skipsSetupCommit) {
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
        // Teacher formation never makes a student a maintainer (the teacher
        // creates the team and drops out; students are added as members), so
        // a maintainer membership marks a self-created team: the group-team
        // name is derivable from public data, and accepting through it would
        // bypass "your teacher assigns the groups" entirely. Fail closed on
        // the role read too — an unverifiable membership must not become the
        // bypass.
        if ((assignment.team_formation ?? "teacher") === "teacher") {
          const membership = await client.request<{ role?: string }>(
            `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
              team.slug,
            )}/memberships/${encodeURIComponent(username)}`,
          )
          if (membership.role === "maintainer") {
            throw new AcceptStepError({
              key: "accept.errors.teamSelfCreated",
              params: { n: team.n },
            })
          }
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

  // The branch the created repo reports. For a generated repo this can still
  // be the org default while GitHub's async template copy settles; the paths
  // below re-resolve the live branch before writing against it.
  const createdBranch =
    created.kind === "fallback-empty"
      ? created.branch
      : created.repo.default_branch || sourceBranch || "main"

  // No-setup-commit path (empty_repo bare repo, or no_autograder): see
  // acceptWithoutSetupCommit. Everything below assumes control files.
  if (skipsSetupCommit) {
    return acceptWithoutSetupCommit({
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
    })
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
  if (isDefaultAutograder(assignment.autograder)) {
    const configBranch = await resolveConfigRepoDefaultBranch(
      client,
      org,
      createdBranch,
    )
    autogradeYaml = defaultAutograderWorkflow(
      org,
      createdBranch,
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
    // either is missing, re-run the idempotent provisioning. (The no-commit
    // shapes returned above; every accept reaching here writes both files.)
    const [hasMetadata, hasWorkflow] = await Promise.all([
      repoContentsPathExists(
        client,
        org,
        created.repo.name,
        ACCEPT_MARKER_PATH,
      ),
      repoContentsPathExists(
        client,
        org,
        created.repo.name,
        ".github/workflows/autograde.yaml",
      ),
    ])
    const provisioned = hasMetadata && hasWorkflow

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
            branch: created.repo.default_branch || sourceBranch,
          }),
        mode: assignment.mode,
        feedbackPr: wantsFeedbackPr,
        autograded: true,
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
      // Pages too: fresh create only.
      pages: undefined,
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
    pages: assignment.pages,
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
