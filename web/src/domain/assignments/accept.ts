import type { GitHubClient } from "@/github-core/client"
import type { AssignmentMode } from "@/types/classroom"
import { getUser } from "@/github-core/queries"
import { studentRepoName } from "@/util/studentRepo"
import {
  createCommitForAssignment,
  createTreeForAssignment,
  updateRefForRepo,
} from "@/github-core/mutations"
import { getRepo } from "@/github-core/repoReads"
import type { GitHubRepo } from "@/github-core/types"
import {
  getBranchRefRepo,
  getCommitByRepo,
  withFreshRepoRetry,
} from "@/github-core/queries"
import { fetchAssignmentFromPages } from "../queries/assignments"
import { getAuthenticatedUser } from "../queries/users"
import { acceptAndVerifyOrgMembership } from "../users"
import { isOwnerGitHubOrgRole } from "@/authz"
import {
  log,
  withAcceptStep,
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
} from "./permissions"
import { createAssignmentRepo } from "./repoCreation"

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
  // Rebuild the autograde shim for the branch that actually materialized. The
  // default shim's push-trigger branch must match the generated repo's real
  // default branch, which is only known after GitHub's async template copy
  // settles (see below). Omitted for branch-agnostic (teacher-authored) shims.
  rerenderShimForBranch?: (branch: string) => string
}) {
  const {
    client,
    owner,
    repo,
    branch,
    metadataYaml,
    autogradeYaml,
    rerenderShimForBranch,
  } = params

  await withFreshRepoRetry(async () => {
    // A freshly template-generated repo's real branch (copied from the template,
    // e.g. `master`) only materializes after GitHub finishes the async copy —
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

    const tree = await createTreeForAssignment({
      client,
      owner,
      repo,
      baseTreeSha,
      metadataYaml,
      autogradeYaml: shim,
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
  })
}

type AcceptAssignmentResult = {
  status: "created" | "already-accepted"
  repo: GitHubRepo
  cloneCommand: string
}

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
  isOwner: boolean
  onStepUpdate?: OnAcceptStepUpdate
}) {
  const { client, org, repo, username, mode, isOwner, onStepUpdate } = params
  return withAcceptStep(
    {
      id: "access",
      label: "Granting you access to your repository",
      actions: `Your repository ${org}/${repo} was created, but adding you (${username}) as a collaborator failed. This usually means your GitHub username changed or you left ${org}. Confirm you're a member of ${org}, then use "Re-run setup".`,
      doneMessage: "Granted you access to your repository",
      onStepUpdate,
    },
    async () => {
      await patchRepoSurface(client, org, repo)
      await addFounderCollaborator({
        client,
        owner: org,
        repo,
        username,
        permission: founderPermission(mode),
        isOwner,
      })
    },
  )
}

// Provision (or heal) a just-created student repo — grant the founder role,
// land the control files. Idempotent, so safe to re-run mid-flow.
async function provisionAcceptedRepo(params: {
  client: GitHubClient
  org: string
  repo: GitHubRepo
  username: string
  mode: AssignmentMode
  branch: string
  metadataYaml: string
  autogradeYaml: string
  isOwner?: boolean
  rerenderShimForBranch?: (branch: string) => string
  onStepUpdate?: OnAcceptStepUpdate
}) {
  const {
    client,
    org,
    repo,
    username,
    mode,
    branch,
    metadataYaml,
    autogradeYaml,
    isOwner = false,
    rerenderShimForBranch,
    onStepUpdate,
  } = params

  await grantFounderAccessStep({
    client,
    org,
    repo: repo.name,
    username,
    mode,
    isOwner,
    onStepUpdate,
  })

  // Land the metadata + autograde shim, retrying through GitHub's post-generate
  // git-data lag (see commitAcceptFilesWithFreshRepoRetry).
  await withAcceptStep(
    {
      id: "setup",
      label: "Setting up autograding",
      actions: `Your repository ${org}/${repo.name} exists, but writing the setup files to branch "${branch}" failed. The repository may still be initializing — wait a minute and use "Re-run setup".`,
      doneMessage: "Autograding configured",
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
        rerenderShimForBranch,
      }),
  )
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
  onStepUpdate?: OnAcceptStepUpdate
}): Promise<AcceptAssignmentResult> {
  const { client, org, classroom, assignmentSlug, secret, onStepUpdate } =
    params

  log.info("accept assignment: started", { org, classroom, assignmentSlug })

  const user = await withAcceptStep(
    {
      id: "account",
      label: "Checking your GitHub account",
      actions:
        "Couldn't read your GitHub account. Sign out and sign back in, then accept again.",
      doneMessage: "Checked your GitHub account",
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
  const membership = await withAcceptStep(
    {
      id: "membership",
      label: "Confirming your classroom membership",
      actions:
        "Couldn't confirm your membership. If your organization uses single sign-on (SSO), authorize it for this org (or open this link from your LMS), then accept again. Otherwise ask your instructor to confirm your invitation.",
      doneMessage: "Confirmed your classroom membership",
      onStepUpdate,
    },
    () => acceptAndVerifyOrgMembership(client, org),
  )

  // An org owner who creates the repo holds admin and can't self-downgrade to
  // the push we grant (org policy blocks it); tolerate that residual admin at
  // the founder read-back so an owner can still accept.
  const isOwner = isOwnerGitHubOrgRole(membership.role)

  const assignment = await withAcceptStep(
    {
      id: "assignment",
      label: `Looking up ${assignmentSlug}`,
      actions: `Couldn't load assignment "${assignmentSlug}" for ${org}/${classroom}. Check the link, or ask your instructor to confirm the assignment is published.`,
      doneMessage: `Found assignment ${assignmentSlug}`,
      onStepUpdate,
    },
    () => fetchAssignmentFromPages(org, classroom, assignmentSlug, secret),
  )

  const sourceOwner = assignment.template?.owner
  const sourceRepo = assignment.template?.repo
  const sourceBranch = assignment.template?.branch ?? "main"

  // empty_repo assignment: the repo is created bare (no commits) and NO
  // control files are ever committed, so the autograder resolution and the
  // whole setup step are skipped. Mirrors the CLI's acceptIntoBareRepo.
  const isEmptyRepo = assignment.empty_repo === true

  // empty_repo and template are mutually exclusive at write time, but the
  // published manifest is not re-validated, so a hand-edited entry can carry
  // both. Fail closed rather than half-apply (template content with no
  // control files). Mirrors the CLI's guard.
  if (isEmptyRepo && assignment.template) {
    throw new Error(
      `Assignment "${assignmentSlug}" sets both empty_repo and a template — the entry is invalid; ask your instructor to re-run assignment setup.`,
    )
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

  // A bare (empty_repo) repo carries no autograde workflow — mark the step
  // complete (as skipped) so the checklist doesn't look stuck, and never fetch
  // the shim.
  let autogradeYaml = isEmptyRepo
    ? ""
    : await withAcceptStep(
        {
          id: "autograder",
          label: "Resolving the autograder",
          actions: `Couldn't resolve the autograder for "${assignmentSlug}". Ask your instructor to confirm it's published, then accept again.`,
          doneMessage: "Resolved the autograder",
          onStepUpdate,
        },
        () =>
          resolveAutograderWorkflow({
            org,
            classroom,
            autograder: assignment.autograder,
            secret,
            // Preliminary branch; the default shim is re-rendered post-create
            // with the assignment repo's actual default branch (below).
            branch: sourceBranch || "main",
          }),
      )
  if (isEmptyRepo) {
    onStepUpdate?.({
      id: "autograder",
      status: "complete",
      message: "Autograding is disabled for this assignment",
    })
  }

  const studentRepoNameValue = studentRepoName(
    classroom,
    assignment.slug,
    username,
  )

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
      label: "Creating your repository",
      actions: `Couldn't create ${org}/${studentRepoNameValue}. Confirm you're a member of ${org} and ask your instructor to verify the assignment's template repository is configured correctly, then accept again.`,
      doneMessage: `Created ${org}/${studentRepoNameValue}`,
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
      }),
  )

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
        message: `Repository already exists: ${org}/${created.repo.name}`,
      })
      try {
        await patchRepoSurface(client, org, created.repo.name)
        await addFounderCollaborator({
          client,
          owner: org,
          repo: created.repo.name,
          username,
          permission: founderPermission(assignment.mode),
          isOwner,
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
      // Fresh create: the grant hard-fails (an un-granted repo is a broken
      // accept the student can't push to), inside the throwing step so the
      // checklist surfaces the error and its recovery guidance.
      await grantFounderAccessStep({
        client,
        org,
        repo: created.repo.name,
        username,
        mode: assignment.mode,
        isOwner,
        onStepUpdate,
      })
    }
    onStepUpdate?.({
      id: "setup",
      status: "complete",
      message: "No setup needed — this assignment uses an empty repository",
    })

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
  if (isDefaultAutograder(assignment.autograder)) {
    const resolvedBranch =
      created.kind === "fallback-empty"
        ? created.branch
        : created.repo.default_branch || sourceBranch || "main"
    const configBranch = await resolveConfigRepoDefaultBranch(
      client,
      org,
      resolvedBranch,
    )
    autogradeYaml = defaultAutograderWorkflow(org, resolvedBranch, configBranch)
    rerenderShim = (branch: string) =>
      defaultAutograderWorkflow(org, branch, configBranch)
  }

  if (created.kind === "already-accepted") {
    // The repo exists, but a prior accept may have failed AFTER creating it but
    // BEFORE committing the metadata/workflow (seeding lag, transient 5xx),
    // leaving a repo that looks accepted but never autogrades. A repo is only
    // "genuinely accepted" when BOTH the metadata and workflow landed (one
    // commit, so a missing workflow means the prior accept failed mid-flow). If
    // either is missing, re-run the idempotent provisioning.
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
    const provisioned = hasMetadata && hasWorkflow

    if (provisioned) {
      // Healthy already-accepted: reconcile the founder role best-effort. A
      // transient failure must not fail a re-run that previously succeeded.
      try {
        await addFounderCollaborator({
          client,
          owner: org,
          repo: created.repo.name,
          username,
          permission: founderPermission(assignment.mode),
          isOwner,
        })
      } catch (err) {
        log.debug("accept: best-effort role reconcile failed (non-fatal)", {
          org,
          repo: created.repo.name,
          err,
        })
      }
      onStepUpdate?.({
        id: "repo",
        status: "complete",
        message: `Repository already exists: ${org}/${created.repo.name}`,
      })
      onStepUpdate?.({ id: "access", status: "complete" })
      onStepUpdate?.({ id: "setup", status: "complete" })
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
      message: `Found incomplete setup: ${org}/${created.repo.name}`,
    })

    await provisionAcceptedRepo({
      client,
      org,
      repo: created.repo,
      username,
      mode: assignment.mode,
      branch: created.repo.default_branch || sourceBranch,
      metadataYaml,
      autogradeYaml,
      isOwner,
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
    branch: targetBranch,
    metadataYaml,
    autogradeYaml,
    isOwner,
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
