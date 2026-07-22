import type { GitHubClient } from "../client"
import { type GitHubRepo, type GitHubTreeResponse } from "../types"
import { GitHubAPIError } from "../errors"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "../configRepoReads"
import { getRepo } from "../repoReads"
import { getErrorMessage } from "../errorMessage"
import { checkPages, repairOrgDefaults } from "../orgChecks"
import {
  BUDGET_PRODUCT_SKU_ACTIONS,
  BUDGET_SCOPE_ORG,
  BUDGET_TYPE_PRODUCT_PRICING,
  classifyBudget,
  orgBudgetsApiPath,
  orgBudgetsUrl,
  type BudgetsListResponse,
} from "@/orgPolicy/budget"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { githubOrgActionsSettingsUrl } from "@/util/orgUrl"
import { prefixCommit } from "@/util/commit"
import { repairRulesets } from "../rulesets"
import { buildSkeletonFiles, type SkeletonFile } from "@/skeleton/skeleton"
import { bytesToHex } from "@/util/hex"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_SETUP } from "@/lib/logScopes"
import {
  CONFIG_REPO_BRANCH,
  createTreeRepo,
  createCommitRepo,
  updateRefForRepo,
} from "./gitObjects"

const logSetup = logger.scope(LOG_SCOPE_GITHUB_SETUP)

// Sentinel returned by tryStep when fn throws: a warning (a tolerated status
// code) or a hard error. Callers detect the hard case via stepFailed().
type StepOutcome =
  { status: "warning"; message: string } | { status: "error"; message: string }

async function tryStep<T>({
  id,
  fn,
  onStepUpdate,
  options,
}: {
  id: InitStepId
  fn: () => Promise<T>
  onStepUpdate?: (update: InitStepUpdate) => void
  options?: { warningCodes: number[] }
}): Promise<T | StepOutcome> {
  const { warningCodes } = options || {}

  logSetup.info(`setup step: ${id} started`, { step: id })
  onStepUpdate?.({
    id,
    status: "running",
  })

  try {
    const result = await fn()

    const maybeStatus =
      typeof result === "object" &&
      result !== null &&
      "status" in result &&
      typeof result.status === "string"
        ? result.status
        : "complete"

    logSetup.info(
      `setup step: ${id} ${maybeStatus === "warning" ? "warning" : "complete"}`,
      {
        step: id,
      },
    )
    onStepUpdate?.({
      id,
      status: maybeStatus === "warning" ? "warning" : "complete",
      data: result,
      message:
        typeof result === "object" &&
        result !== null &&
        "message" in result &&
        typeof result.message === "string"
          ? result.message
          : undefined,
    })

    return result
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      warningCodes?.some((code) => err.status === code)
    ) {
      logSetup.warn(`setup step: ${id} warning`, {
        step: id,
        status: err.status,
      })
      onStepUpdate?.({
        id,
        status: "warning",
        error: err.message,
      })
      return {
        status: "warning" as const,
        message: err.message,
      }
    }

    const message = err instanceof Error ? err.message : "Unknown error"
    logSetup.error(`setup step: ${id} failed`, { step: id, err })
    onStepUpdate?.({
      id,
      status: "error",
      error: message,
    })
    return {
      status: "error" as const,
      message,
    }
  }
}

export type InitStepStatus =
  "pending" | "running" | "complete" | "warning" | "error" | "skipped"

export async function createOrgRepo(client: GitHubClient, org: string) {
  return client.request<GitHubRepo>(`/orgs/${org}/repos`, {
    method: "POST",
    body: {
      name: CONFIG_REPO,
      private: true,
      auto_init: true,
      description:
        "Classroom 50 configuration, manifests, workflows, and scores",
    },
  })
}

// Rename the config repo's default branch to `main` (org policy can seed it as
// `master`). Guarded (skips when already main) and best-effort; failure swallowed.
// `freshlyCreated` gates the rename: an existing config repo may already have
// student repos whose frozen shim `uses:@<branch>` ref would dangle after a
// rename, so we only auto-rename a brand-new repo and warn otherwise.
async function normalizeConfigRepoBranch(
  client: GitHubClient,
  org: string,
  repo: GitHubRepo,
  freshlyCreated: boolean,
): Promise<GitHubRepo> {
  const current = repo.default_branch
  if (!current || current === CONFIG_REPO_BRANCH) {
    return repo
  }

  if (!freshlyCreated) {
    // Existing repo on a non-main branch: renaming now could strand the
    // `@<branch>` reusable-workflow ref frozen in already-accepted student
    // repos. Leave it (reads/writes resolve the real branch) and let the audit
    // recommendation nudge the teacher to fix the org default by hand.
    logSetup.warn(
      "config repo default branch is not main; skipping rename on an existing repo (may have student repos referencing it)",
      { org, current },
    )
    return repo
  }

  try {
    const renamed = await client.request<GitHubRepo>(
      `/repos/${org}/${CONFIG_REPO}/branches/${encodePathPart(current)}/rename`,
      { method: "POST", body: { new_name: CONFIG_REPO_BRANCH } },
    )
    logSetup.info("config repo default branch renamed to main", {
      org,
      from: current,
    })
    return renamed
  } catch (err) {
    logSetup.warn("config repo branch rename to main failed (continuing)", {
      org,
      from: current,
      err,
    })
    return repo
  }
}

export async function ensureClassroom50Repo(client: GitHubClient, org: string) {
  const existing = await getRepo(client, org, CONFIG_REPO)

  if (existing) {
    const repo = await normalizeConfigRepoBranch(client, org, existing, false)
    return { status: "complete" as const, created: false, repo }
  }

  const created = await createOrgRepo(client, org)
  const repo = await normalizeConfigRepoBranch(client, org, created, true)

  return { status: "complete" as const, created: true, repo }
}

// Rename the classroom50 config repo's default branch to `main` on demand (the
// audit pane's one-click fix for a repo that drifted onto `master`). Unlike
// normalizeConfigRepoBranch this runs on an EXISTING repo, so the caller must
// warn first: already-accepted student repos pin the old branch in their frozen
// autograde-shim `uses:@<branch>` ref and would stop grading after the rename.
// A no-op (already `main`) resolves without a request.
export async function renameConfigRepoToMain(
  client: GitHubClient,
  org: string,
): Promise<{ renamed: boolean; from: string }> {
  const current =
    (await getRepo(client, org, CONFIG_REPO))?.default_branch || DEFAULT_BRANCH
  if (current === CONFIG_REPO_BRANCH) {
    return { renamed: false, from: current }
  }
  await client.request(
    `/repos/${org}/${CONFIG_REPO}/branches/${encodePathPart(current)}/rename`,
    { method: "POST", body: { new_name: CONFIG_REPO_BRANCH } },
  )
  return { renamed: true, from: current }
}

async function listTargetRepoBlobs(
  client: GitHubClient,
  org: string,
  branch: string,
): Promise<Map<string, string>> {
  const ref = await client.request<{
    object: { sha: string }
  }>(`/repos/${org}/${CONFIG_REPO}/git/ref/heads/${encodePathPart(branch)}`)

  const commit = await client.request<{
    tree: { sha: string }
  }>(`/repos/${org}/${CONFIG_REPO}/git/commits/${ref.object.sha}`)

  const tree = await client.request<GitHubTreeResponse>(
    `/repos/${org}/${CONFIG_REPO}/git/trees/${commit.tree.sha}?recursive=1`,
  )

  if (tree.truncated) {
    throw new Error(
      `The ${org}/${CONFIG_REPO} tree is too large to safely inspect for missing skeleton files.`,
    )
  }

  return new Map(
    tree.tree
      .filter((item) => item.type === "blob")
      .map((item) => [item.path, item.sha]),
  )
}

// The git blob SHA-1 GitHub reports for a file: sha1("blob <bytelen>\0" + body)
// over the UTF-8 bytes. Lets us compare a bundled skeleton file against the
// repo's tree entry by SHA, mirroring `git hash-object`. (See the CLI's
// gitBlobSHA in autograder_crud.go.)
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content)
  const header = new TextEncoder().encode(`blob ${body.length}\0`)
  const payload = new Uint8Array(header.length + body.length)
  payload.set(header)
  payload.set(body, header.length)
  const digest = await crypto.subtle.digest("SHA-1", payload)
  return bytesToHex(new Uint8Array(digest))
}

// A bundled skeleton file that needs writing, tagged with whether a file already
// exists at that path in the repo. `exists: false` is a create (always safe);
// `exists: true` is an overwrite of a drifted file (the GUI confirms these with
// the teacher first, mirroring the CLI's refresh prompt).
export type StaleSkeletonFile = SkeletonFile & { exists: boolean }

// Bounded retries for the skeleton commit's optimistic-rebase loop: re-diff
// against the freshly-read parent and re-PATCH the ref when a concurrent writer
// advances the tip during the (possibly long) overwrite-confirm pause.
const SKELETON_COMMIT_ATTEMPTS = 3

// A ref PATCH with force:false that loses a race returns 422 "Update is not a
// fast forward". Treat that (and only that) as retryable; everything else is a
// real error the caller should see. Exported so withGitConflictRetry treats a
// lost force:false race as retryable too (not just a 409) — the roster mutation
// family relies on that retry for concurrency safety.
export function isNonFastForward(err: unknown): boolean {
  if (!(err instanceof GitHubAPIError) || err.status !== 422) return false
  const message =
    err.message + " " + (typeof err.body === "string" ? err.body : "")
  return /fast forward|fast-forward/i.test(message)
}

// Skeleton files whose repo content is missing OR differs from the bundled
// version. Mirrors the CLI's diffSkeleton/refreshSkeleton: re-running setup
// picks up skeleton updates (new workflows, updated runner/scripts) instead of
// only filling in absent paths. Skeleton files aren't teacher-editable, so a
// drifted file is treated as stale; callers decide whether to overwrite.
export async function findStaleSkeletonFiles(
  client: GitHubClient,
  org: string,
): Promise<StaleSkeletonFile[]> {
  return (await findStaleSkeleton(client, org)).stale
}

// Like findStaleSkeletonFiles but also returns the config repo's resolved
// default branch, so the write path commits onto the same branch it diffed
// against. The repo read must precede the tree read — the tree read needs the
// branch name, which org policy can set to something other than `main`.
async function findStaleSkeleton(
  client: GitHubClient,
  org: string,
): Promise<{ stale: StaleSkeletonFile[]; branch: string }> {
  const defaultBranch = await getConfigRepoBranch(client, org)

  const existingBlobs = await listTargetRepoBlobs(client, org, defaultBranch)

  // From the bundled skeleton — no runtime fetch from the CLI repo.
  const bundled = buildSkeletonFiles(defaultBranch)
  const bundledShas = await Promise.all(
    bundled.map((file) => gitBlobSha(file.content)),
  )

  const stale: StaleSkeletonFile[] = []
  bundled.forEach((file, i) => {
    const existingSha = existingBlobs.get(file.path)
    if (existingSha === undefined) {
      stale.push({ ...file, exists: false })
    } else if (bundledShas[i] !== existingSha) {
      stale.push({ ...file, exists: true })
    }
  })
  return { stale, branch: defaultBranch }
}

// Commits missing skeleton files and refreshes drifted ones. Overwriting an
// existing (drifted) file resets it to the bundled version, so callers can gate
// that with confirmOverwrite: invoked with the existing paths about to be
// overwritten, resolving false leaves those files untouched while still creating
// any missing ones. Omitting the hook overwrites without asking (the first-time
// wizard, where nothing pre-exists).
export async function ensureSkeletonFiles(
  client: GitHubClient,
  org: string,
  confirmOverwrite?: (paths: string[]) => Promise<boolean>,
) {
  const { stale, branch: configBranch } = await findStaleSkeleton(client, org)

  if (stale.length === 0) {
    return { status: "complete" as const, created: [], skippedOverwrite: [] }
  }

  const overwritePaths = stale.filter((f) => f.exists).map((f) => f.path)
  let toWrite = stale
  let skippedOverwrite: string[] = []

  if (overwritePaths.length > 0 && confirmOverwrite) {
    const ok = await confirmOverwrite(overwritePaths)
    if (!ok) {
      // Declined: still create missing files, but leave drifted ones as-is.
      toWrite = stale.filter((f) => !f.exists)
      skippedOverwrite = overwritePaths
    }
  }

  if (toWrite.length === 0) {
    return {
      status: "complete" as const,
      created: [],
      skippedOverwrite,
      message:
        skippedOverwrite.length === 1
          ? "Left 1 customized skeleton file untouched."
          : `Left ${skippedOverwrite.length} customized skeleton files untouched.`,
    }
  }

  // Commit the stale files. The confirm modal can park this for an arbitrarily
  // long time, so the branch tip may have advanced (another tab/owner, any push)
  // by the time we write; updateRefForRepo uses force:false and rejects a
  // non-fast-forward rather than clobbering. On such a rejection we re-diff
  // against the new parent and retry, mirroring the CLI's refreshSkeleton
  // (init_skeleton.go): the retry sees the new parent and never re-commits an
  // already-current file.
  const writePaths = new Set(toWrite.map((f) => f.path))
  let changed = toWrite.map((f) => f.path)

  for (let attempt = 0; attempt < SKELETON_COMMIT_ATTEMPTS; attempt++) {
    // Attempt 0 reuses the diff we already computed; a retry re-diffs, where a
    // concurrent writer may have advanced the tip during the confirm pause (the
    // force:false PATCH's 422 below catches that race). The re-diff avoids
    // reverting that writer's changes and never re-commits an already-current
    // file; an empty re-diff is a clean no-op.
    const stillStale =
      attempt === 0
        ? toWrite
        : (await findStaleSkeletonFiles(client, org)).filter((f) =>
            writePaths.has(f.path),
          )
    if (stillStale.length === 0) {
      // A concurrent writer already brought our files up to date.
      changed = []
      break
    }
    changed = stillStale.map((f) => f.path)

    const branch = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, branch.object.sha)

    const tree = await createTreeRepo(client, {
      org,
      repo: CONFIG_REPO,
      base_tree: commit.tree.sha,
      tree: stillStale.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    })

    const newCommit = await createCommitRepo(client, {
      org,
      repo: CONFIG_REPO,
      message: prefixCommit("Bootstrap or refresh Classroom 50 skeleton"),
      tree: tree.sha,
      parents: [commit.sha],
    })

    try {
      await updateRefForRepo({
        client,
        owner: org,
        repo: CONFIG_REPO,
        branch: configBranch,
        commitSha: newCommit.sha,
      })
      break
    } catch (err) {
      // A non-fast-forward rejection means the tip moved between our read and
      // the PATCH; re-diff and retry. Any other error is real — rethrow it.
      if (!isNonFastForward(err) || attempt === SKELETON_COMMIT_ATTEMPTS - 1) {
        throw err
      }
    }
  }

  const updatedMsg =
    changed.length === 1
      ? "Updated 1 skeleton file to the latest version."
      : `Updated ${changed.length} skeleton files to the latest version.`
  const skippedMsg =
    skippedOverwrite.length > 0
      ? ` Left ${skippedOverwrite.length} customized file${
          skippedOverwrite.length === 1 ? "" : "s"
        } untouched.`
      : ""
  return {
    status: "complete" as const,
    created: changed,
    skippedOverwrite,
    message: `${updatedMsg}${skippedMsg}`,
  }
}

export type EnsurePagesResult = {
  status: "warning" | "complete"
  pagesEnabled: boolean
  pagesAlreadyEnabled: boolean
  visibilityPublic: boolean
  settingsUrl: string
  message: string
  pagesUrl: string
}

function expectedPagesUrl(org: string): string {
  return `https://${org}.github.io/${CONFIG_REPO}/`
}

function pagesSettingsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/settings/pages`
}

async function enableWorkflowPages(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<{
  enabled: boolean
  alreadyEnabled: boolean
}> {
  try {
    await client.request(`/repos/${owner}/${repo}/pages`, {
      method: "POST",
      body: {
        build_type: "workflow",
      },
    })

    return {
      enabled: true,
      alreadyEnabled: false,
    }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 409) {
      return {
        enabled: true,
        alreadyEnabled: true,
      }
    }

    throw new Error(
      `Could not enable GitHub Pages for ${owner}/${repo}: ${getErrorMessage(
        err,
      )}`,
      { cause: err },
    )
  }
}

async function setPagesPublic(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<{
  visibilityPublic: boolean
  warning?: string
}> {
  try {
    await client.request(`/repos/${owner}/${repo}/pages`, {
      method: "PUT",
      body: {
        public: true,
      },
    })

    return {
      visibilityPublic: true,
    }
  } catch (err) {
    return {
      visibilityPublic: false,
      warning: `Couldn't set Pages visibility to public for ${owner}/${repo}: ${getErrorMessage(
        err,
      )}. Toggle it manually at ${pagesSettingsUrl(
        owner,
        repo,
      )} → Visibility if students see 404s on the Pages URL.`,
    }
  }
}

export async function ensurePages(
  client: GitHubClient,
  org: string,
  repo = CONFIG_REPO,
): Promise<EnsurePagesResult> {
  const enableResult = await enableWorkflowPages(client, org, repo)
  const visibilityResult = await setPagesPublic(client, org, repo)
  const settingsUrl = pagesSettingsUrl(org, repo)

  // Trust the live read-back, not the write outcome: the writes are idempotent
  // and a re-run on an already-public site can 422 the visibility PUT while the
  // site is in fact correct. checkPages also keeps this in lockstep with the
  // audit.
  const verdict = await checkPages(client, org, repo)

  const base = {
    pagesEnabled: enableResult.enabled,
    pagesAlreadyEnabled: enableResult.alreadyEnabled,
    visibilityPublic: visibilityResult.visibilityPublic,
    settingsUrl,
    pagesUrl: expectedPagesUrl(org),
  }

  if (verdict.state === "enforced") {
    return {
      ...base,
      status: "complete",
      visibilityPublic: true,
      message: `${org}/${repo}: GitHub Pages builds from the workflow and the site is public.`,
    }
  }

  // Not enforced, or the read-back was unreadable: surface why, preferring the
  // write-time warning when we have one.
  const message =
    visibilityResult.warning ??
    (verdict.state === "unreadable"
      ? `${org}/${repo}: couldn't verify GitHub Pages (${verdict.detail ?? "read failed"}). Check it at ${settingsUrl} → Pages.`
      : `${org}/${repo}: GitHub Pages isn't fully configured (needs a workflow build and a public site). Set it at ${settingsUrl} → Pages.`)

  return {
    ...base,
    status: "warning",
    message,
  }
}

export type EnsureWorkflowPermissionsResult =
  | {
      status: "complete"
      repo: string
      defaultWorkflowPermissions: "read" | "write"
      managedByOrgPolicy: boolean
      message: string
    }
  | {
      status: "warning"
      repo: string
      defaultWorkflowPermissions: "read" | "write" | "unknown"
      managedByOrgPolicy: true
      message: string
    }

type WorkflowPermissionsResponse = {
  default_workflow_permissions: "read" | "write"
  can_approve_pull_request_reviews?: boolean
}

export async function setRepoWorkflowPermissions(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<void> {
  await client.request(`/repos/${owner}/${repo}/actions/permissions/workflow`, {
    method: "PUT",
    body: {
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: false,
    },
  })
}

export async function getRepoWorkflowPermissions(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<WorkflowPermissionsResponse> {
  return client.request<WorkflowPermissionsResponse>(
    `/repos/${owner}/${repo}/actions/permissions/workflow`,
  )
}

export async function ensureWorkflowPermissions(
  client: GitHubClient,
  owner: string,
  repo = CONFIG_REPO,
): Promise<EnsureWorkflowPermissionsResult> {
  try {
    await setRepoWorkflowPermissions(client, owner, repo)

    return {
      status: "complete",
      repo: `${owner}/${repo}`,
      defaultWorkflowPermissions: "write",
      managedByOrgPolicy: false,
      message: `${owner}/${repo}: workflow permissions set to write.`,
    }
  } catch {
    // The PUT failed — typically a 409 because workflow write is
    // org/enterprise-managed. That's benign (the skeleton workflows declare
    // their own permissions), so re-read and report the effective state instead
    // of failing setup.
    return reportOrgWorkflowPermissions(client, owner, repo)
  }
}

// Report the effective (org-managed) workflow-permission state when the repo PUT
// didn't apply. A read default is acceptable because the skeleton workflows
// declare workflow-level write where needed, so both "write" and "read" report
// complete; only an unreadable state warrants a warning.
async function reportOrgWorkflowPermissions(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<EnsureWorkflowPermissionsResult> {
  try {
    const permissions = await getRepoWorkflowPermissions(client, owner, repo)

    if (permissions.default_workflow_permissions === "write") {
      return {
        status: "complete",
        repo: `${owner}/${repo}`,
        defaultWorkflowPermissions: "write",
        managedByOrgPolicy: true,
        message: `${owner}/${repo}: workflow permissions are write, managed by organization policy.`,
      }
    }

    return {
      status: "complete",
      repo: `${owner}/${repo}`,
      defaultWorkflowPermissions: permissions.default_workflow_permissions,
      managedByOrgPolicy: true,
      message: `${owner}/${repo}: organization policy defaults workflows to read. This is okay — the Classroom 50 skeleton workflows declare workflow-level write where needed.`,
    }
  } catch {
    // Couldn't confirm the effective state — surface a warning to check rather
    // than a clean complete. Setup still proceeds (skeleton workflows
    // self-declare).
    return {
      status: "warning",
      repo: `${owner}/${repo}`,
      defaultWorkflowPermissions: "unknown",
      managedByOrgPolicy: true,
      message: `${owner}/${repo}: workflow permissions are managed by an organization policy and couldn't be read. Setup can continue because the Classroom 50 skeleton workflows declare their own permissions.`,
    }
  }
}

function actionsSettingsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/settings/actions`
}

export type EnsureReusableWorkflowAccessResult =
  | {
      status: "complete"
      repo: string
      accessLevel: "organization"
      message: string
      settingsUrl: string
    }
  | {
      status: "warning"
      repo: string
      accessLevel: "unknown"
      reason:
        | "permission_denied"
        | "policy_conflict"
        | "unexpected_status"
        | "unknown"
      message: string
      settingsUrl: string
    }

export async function ensureReusableWorkflowAccess(
  client: GitHubClient,
  owner: string,
  repo = CONFIG_REPO,
): Promise<EnsureReusableWorkflowAccessResult> {
  const settingsUrl = actionsSettingsUrl(owner, repo)

  try {
    await client.request(`/repos/${owner}/${repo}/actions/permissions/access`, {
      method: "PUT",
      body: {
        access_level: "organization",
      },
    })

    return {
      status: "complete",
      repo: `${owner}/${repo}`,
      accessLevel: "organization",
      settingsUrl,
      message: `${owner}/${repo}: reusable-workflow access enabled for the organization.`,
    }
  } catch (err) {
    const message = getErrorMessage(err)
    if (err instanceof GitHubAPIError) {
      if (err.status === 403) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          accessLevel: "unknown",
          reason: "permission_denied",
          settingsUrl,
          message: `${owner}/${repo}: couldn't enable reusable-workflow access for the organization. Student autograde workflows may fail with a 403 when resolving the reusable workflow. Retry with an org-admin token or toggle it manually at ${settingsUrl} → Access.`,
        }
      }

      if (err.status === 409) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          accessLevel: "unknown",
          reason: "policy_conflict",
          settingsUrl,
          message: `${owner}/${repo}: reusable-workflow access appears to be controlled by an organization or enterprise policy. Student autograde workflows may fail resolving the reusable workflow unless org-level access allows it. Review ${settingsUrl} → Access.`,
        }
      }
    }
    return {
      status: "warning",
      repo: `${owner}/${repo}`,
      accessLevel: "unknown",
      reason: "unknown",
      settingsUrl,
      message: `${owner}/${repo}: couldn't enable reusable-workflow access: ${message}. Student autograde workflows may fail resolving the reusable workflow. Review ${settingsUrl} → Access.`,
    }
  }
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value)
}

async function getDefaultBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<string> {
  const repoData = await client.request<GitHubRepo>(`/repos/${owner}/${repo}`)

  return repoData.default_branch
}

export async function putMinimalBranchProtection(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  await client.request(
    `/repos/${owner}/${repo}/branches/${encodePathPart(branch)}/protection`,
    {
      method: "PUT",
      body: {
        required_status_checks: null,
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      },
    },
  )
}

function branchSettingsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/settings/branches`
}

export type EnsureBranchProtectionResult =
  | {
      status: "complete"
      repo: string
      branch: string
      message: string
      settingsUrl: string
    }
  | {
      status: "warning"
      repo: string
      branch: string | null
      reason:
        "permission_denied" | "branch_not_found" | "unsupported" | "unexpected"
      message: string
      settingsUrl: string
    }

export async function ensureBranchProtection(
  client: GitHubClient,
  owner: string,
  repo = CONFIG_REPO,
  branch?: string,
): Promise<EnsureBranchProtectionResult> {
  const settingsUrl = branchSettingsUrl(owner, repo)

  let targetBranch: string | null = branch ?? null

  try {
    targetBranch ??= await getDefaultBranch(client, owner, repo)

    await putMinimalBranchProtection(client, owner, repo, targetBranch)

    return {
      status: "complete",
      repo: `${owner}/${repo}`,
      branch: targetBranch,
      settingsUrl,
      message: `${owner}/${repo}: branch protection applied to ${targetBranch}; force-pushes and deletions are disabled.`,
    }
  } catch (err) {
    const message = getErrorMessage(err)

    if (err instanceof GitHubAPIError) {
      if (err.status === 403) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          branch: targetBranch,
          reason: "permission_denied",
          settingsUrl,
          message: `${owner}/${repo}: branch protection could not be applied because the authenticated user lacks permission. Review branch protection manually at ${settingsUrl}.`,
        }
      }

      if (err.status === 404) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          branch: targetBranch,
          reason: "branch_not_found",
          settingsUrl,
          message: `${owner}/${repo}: branch protection could not be applied because the target branch was not found. The repository may still be initializing. Retry setup or review ${settingsUrl}.`,
        }
      }

      if (err.status === 422) {
        return {
          status: "warning",
          repo: `${owner}/${repo}`,
          branch: targetBranch,
          reason: "unsupported",
          settingsUrl,
          message: `${owner}/${repo}: GitHub rejected the branch protection request. This may be due to repository plan, ruleset, or policy constraints. Review ${settingsUrl}.`,
        }
      }
    }

    return {
      status: "warning",
      repo: `${owner}/${repo}`,
      branch: targetBranch,
      reason: "unexpected",
      settingsUrl,
      message: `${owner}/${repo}: branch protection could not be applied: ${message}. Review ${settingsUrl}.`,
    }
  }
}

type OrgActionsPermissions = {
  enabled_repositories: "all" | "none" | "selected"
  allowed_actions?: "all" | "local_only" | "selected"
  selected_actions_url?: string
}

export type EnsureOrgActionsEnabledResult =
  | {
      status: "complete"
      org: string
      enabledRepositories: "all"
      allowedActions: "all"
      message: string
      settingsUrl: string
    }
  | {
      status: "warning"
      org: string
      enabledRepositories: "all" | "none" | "selected" | "unknown"
      allowedActions: "all" | "local_only" | "selected" | "unknown"
      reason:
        | "permission_denied"
        | "enterprise_policy"
        | "validation_failed"
        | "readback_failed"
        | "autograding_paused"
        | "unknown"
      message: string
      settingsUrl: string
    }

async function getOrgActionsPermissions(
  client: GitHubClient,
  org: string,
): Promise<OrgActionsPermissions> {
  return client.request<OrgActionsPermissions>(
    `/orgs/${org}/actions/permissions`,
  )
}

async function setOrgActionsPermissions(
  client: GitHubClient,
  org: string,
): Promise<void> {
  await client.request(`/orgs/${org}/actions/permissions`, {
    method: "PUT",
    body: {
      enabled_repositories: "all",
      allowed_actions: "all",
    },
  })
}

export async function ensureOrgActionsEnabled(
  client: GitHubClient,
  org: string,
): Promise<EnsureOrgActionsEnabledResult> {
  const settingsUrl = githubOrgActionsSettingsUrl(org)

  // Don't clobber an intentional autograding pause. If the teacher paused
  // autograding (org Actions restricted to "selected", with the config repo
  // among the selected repos — see setOrgActionsMode), re-running setup must
  // NOT silently flip it back to "all" and resume student-repo spend. Leave it
  // and warn so the re-run board surfaces the paused state instead.
  let currentPerms: OrgActionsPermissions | null
  try {
    currentPerms = await getOrgActionsPermissions(client, org)
  } catch {
    // Couldn't read the current policy — fall through and attempt the normal
    // enable below (we have no evidence of a pause to preserve).
    currentPerms = null
  }

  if (currentPerms?.enabled_repositories === "selected") {
    // The org is restricted to selected repos. Determine whether it's OUR pause.
    // Fail CLOSED on a read error here: a transient failure of the inclusion
    // check must not fall through and force "all", which would resume
    // student-repo spend during a re-run while a pause is actually in effect.
    let includesConfigRepo: boolean
    try {
      includesConfigRepo = await orgActionsSelectionIncludesConfigRepo(
        client,
        org,
      )
    } catch {
      return {
        status: "warning",
        org,
        enabledRepositories: "selected",
        allowedActions: currentPerms.allowed_actions ?? "unknown",
        reason: "readback_failed",
        settingsUrl,
        message:
          `${org}: GitHub Actions is restricted to selected repositories, but we couldn't confirm whether autograding is paused. ` +
          `Left as-is so a transient read error doesn't resume student-repo Actions spend. Retry, or review ${settingsUrl}.`,
      }
    }
    if (includesConfigRepo) {
      return {
        status: "warning",
        org,
        enabledRepositories: "selected",
        allowedActions: currentPerms.allowed_actions ?? "unknown",
        reason: "autograding_paused",
        settingsUrl,
        message:
          `${org}: autograding is paused (GitHub Actions restricted to the ${CONFIG_REPO} config repo). ` +
          `Left as-is so re-running setup doesn't resume student-repo Actions spend. ` +
          `Resume from the GitHub Actions section in Org Settings, or at ${settingsUrl}.`,
      }
    }
    // "selected" but not our config repo: a teacher-authored allow-list. Fall
    // through to the normal enable (the pre-existing behavior).
  }

  try {
    await setOrgActionsPermissions(client, org)

    return {
      status: "complete",
      org,
      enabledRepositories: "all",
      allowedActions: "all",
      settingsUrl,
      message: `${org}: GitHub Actions enabled for all repositories.`,
    }
  } catch (err) {
    const message = getErrorMessage(err)

    let current: OrgActionsPermissions | null = null

    try {
      current = await getOrgActionsPermissions(client, org)
    } catch {
      // nothing for now, still want good warning info
    }

    const enabledRepositories = current?.enabled_repositories ?? "unknown"
    const allowedActions = current?.allowed_actions ?? "unknown"

    if (err instanceof GitHubAPIError) {
      if (err.status === 403) {
        return {
          status: "warning",
          org,
          enabledRepositories,
          allowedActions,
          reason: "permission_denied",
          settingsUrl,
          message:
            `${org}: couldn't enable GitHub Actions at the organization level. ` +
            `The authenticated user may lack org-owner/admin permissions, or an enterprise policy may block this change. ` +
            `Open ${settingsUrl} and set Actions permissions to allow repositories in this organization to run workflows.`,
        }
      }

      if (err.status === 409) {
        return {
          status: "warning",
          org,
          enabledRepositories,
          allowedActions,
          reason: "enterprise_policy",
          settingsUrl,
          message:
            `${org}: GitHub Actions permissions appear to be controlled by an organization or enterprise policy. ` +
            `Current setting: enabled_repositories="${enabledRepositories}", allowed_actions="${allowedActions}". ` +
            `Classroom50 workflows may not run until Actions are enabled. Review ${settingsUrl}.`,
        }
      }

      if (err.status === 422) {
        return {
          status: "warning",
          org,
          enabledRepositories,
          allowedActions,
          reason: "validation_failed",
          settingsUrl,
          message:
            `${org}: GitHub rejected the Actions permissions update. ` +
            `Current setting: enabled_repositories="${enabledRepositories}", allowed_actions="${allowedActions}". ` +
            `Review ${settingsUrl}. Original error: ${message}`,
        }
      }
    }

    return {
      status: "warning",
      org,
      enabledRepositories,
      allowedActions,
      reason: current ? "unknown" : "readback_failed",
      settingsUrl,
      message:
        `${org}: couldn't enable GitHub Actions. ` +
        `Current setting: enabled_repositories="${enabledRepositories}", allowed_actions="${allowedActions}". ` +
        `Review ${settingsUrl}. Original error: ${message}`,
    }
  }
}

// Whether autograding is paused: org Actions restricted to "selected" repos AND
// the config repo is among them. "active" means Actions run for all repos
// (autograding on). "disabled" means Actions are off for every repo
// (enabled_repositories="none") — distinct from our pause. "unknown" means the
// org policy couldn't be read.
export type OrgActionsMode = "active" | "paused" | "disabled" | "unknown"

// The autograding kill switch is a per-org, live-derived state: no stored flag.
// Paused == org Actions permission is enabled_repositories="selected" with the
// config repo selected, so every student repo's autograde shim is blocked while
// the config repo's own workflows (Pages, score collection, regrade) keep
// running. Resume == enabled_repositories="all".
type OrgSelectedRepositories = {
  total_count: number
  repositories: { id: number; name: string }[]
}

async function listOrgActionsSelectedRepositories(
  client: GitHubClient,
  org: string,
  page: number,
): Promise<OrgSelectedRepositories> {
  return client.request<OrgSelectedRepositories>(
    `/orgs/${org}/actions/permissions/repositories?per_page=100&page=${page}`,
  )
}

// True when the config repo is currently in the org's "selected" Actions
// allow-list — the marker that distinguishes our intentional pause from an
// unrelated teacher-set "selected" policy that happens to exclude it. Paginates
// to exhaustion: a teacher's own allow-list can exceed 100 repos, and reading
// only page 1 could misclassify a policy we didn't author (and then wrongly
// widen it to "all" via the setup guard).
async function orgActionsSelectionIncludesConfigRepo(
  client: GitHubClient,
  org: string,
): Promise<boolean> {
  let seen = 0
  for (let page = 1; ; page++) {
    const { total_count, repositories } =
      await listOrgActionsSelectedRepositories(client, org, page)
    if (repositories.some((r) => r.name === CONFIG_REPO)) return true
    seen += repositories.length
    if (repositories.length === 0 || seen >= total_count) return false
  }
}

// Read the live autograding mode from org Actions permissions.
export async function getOrgActionsMode(
  client: GitHubClient,
  org: string,
): Promise<OrgActionsMode> {
  try {
    const perms = await getOrgActionsPermissions(client, org)
    if (perms.enabled_repositories === "none") return "disabled"
    if (perms.enabled_repositories !== "selected") return "active"
    return (await orgActionsSelectionIncludesConfigRepo(client, org))
      ? "paused"
      : // "selected" but not our config repo: a teacher-set policy we didn't
        // author. Treat as active so we never claim a pause we can't honor.
        "active"
  } catch (err) {
    // Swallow to "unknown" — the UI's fail-safe (shows unknownNotice, disables
    // the toggle) and setOrgActionsMode re-reads and fail-closes on write. Log
    // the underlying error so a transient 5xx is diagnosable and not silently
    // conflated with a genuine permission/enterprise-policy lockout.
    logSetup.warn("couldn't read org Actions mode", { org, err })
    return "unknown"
  }
}

export type SetOrgActionsModeResult =
  | { status: "complete"; org: string; mode: OrgActionsMode; message: string }
  | {
      status: "warning"
      org: string
      reason:
        | "permission_denied"
        | "enterprise_policy"
        | "validation_failed"
        | "config_repo_missing"
        | "readback_failed"
        | "failed"
      settingsUrl: string
      message: string
    }

function setOrgActionsModeWarning(
  org: string,
  err: unknown,
): SetOrgActionsModeResult {
  const settingsUrl = githubOrgActionsSettingsUrl(org)
  const message = getErrorMessage(err)
  if (err instanceof GitHubAPIError) {
    if (err.status === 403)
      return {
        status: "warning",
        org,
        reason: "permission_denied",
        settingsUrl,
        message: `${org}: couldn't change GitHub Actions permissions — the token may lack org-owner rights. Review ${settingsUrl}.`,
      }
    if (err.status === 409)
      return {
        status: "warning",
        org,
        reason: "enterprise_policy",
        settingsUrl,
        message: `${org}: GitHub Actions permissions appear controlled by an org or enterprise policy. Review ${settingsUrl}.`,
      }
    if (err.status === 422)
      return {
        status: "warning",
        org,
        reason: "validation_failed",
        settingsUrl,
        message: `${org}: GitHub rejected the Actions permissions update (${message}). Review ${settingsUrl}.`,
      }
  }
  return {
    status: "warning",
    org,
    reason: "failed",
    settingsUrl,
    message: `${org}: couldn't change GitHub Actions permissions (${message}). Review ${settingsUrl}.`,
  }
}

// Pause or resume autograding org-wide by flipping the org Actions policy.
// Pausing restricts Actions to the config repo only (blocking every student
// repo's autograde shim); resuming re-enables Actions for all repos.
export async function setOrgActionsMode(
  client: GitHubClient,
  org: string,
  mode: "paused" | "active",
): Promise<SetOrgActionsModeResult> {
  const settingsUrl = githubOrgActionsSettingsUrl(org)

  if (mode === "active") {
    // Only resume from a pause WE authored. If the org is on a "selected"
    // policy that isn't ours (a teacher's own curated allow-list) — or already
    // "all" — forcing "all" here would widen the org's Actions posture beyond
    // what the owner set. getOrgActionsMode already reports those as "active",
    // so mirror that on the write side: no-op instead of clobbering.
    const current = await getOrgActionsMode(client, org)
    // An unreadable policy is NOT a successful no-op: surface it as a warning so
    // the UI doesn't announce success (green toast) while the toggle silently
    // stays put.
    if (current === "unknown") {
      return {
        status: "warning",
        org,
        reason: "readback_failed",
        settingsUrl,
        message: `${org}: couldn't read GitHub Actions permissions to resume — your token may lack owner rights, or an enterprise policy controls them. Review ${settingsUrl}.`,
      }
    }
    // Resume forces "all" from our pause OR from a fully-disabled org (both are
    // states where enabling all repos is the right move). A non-ours "selected"
    // (a teacher's curated allow-list) is left untouched — widening it to "all"
    // would clobber the owner's intent.
    if (current === "active") {
      return {
        status: "complete",
        org,
        mode: current,
        message: `${org}: autograding already on — left the organization's GitHub Actions policy unchanged.`,
      }
    }
    try {
      await setOrgActionsPermissions(client, org)
      return {
        status: "complete",
        org,
        mode: "active",
        message: `${org}: autograding resumed — GitHub Actions enabled for all repositories.`,
      }
    } catch (err) {
      return setOrgActionsModeWarning(org, err)
    }
  }

  // Pause: need the config repo's numeric id for the selected-repositories PUT.
  // getRepo tolerates a 404 (-> null -> config_repo_missing); a 403/5xx/network
  // error throws, so map it through the same warning shape rather than letting
  // it surface as a raw rejection.
  let repo: Awaited<ReturnType<typeof getRepo>>
  try {
    repo = await getRepo(client, org, CONFIG_REPO)
  } catch (err) {
    return setOrgActionsModeWarning(org, err)
  }
  if (!repo) {
    return {
      status: "warning",
      org,
      reason: "config_repo_missing",
      settingsUrl,
      message: `${org}: can't pause autograding — the ${CONFIG_REPO} config repo wasn't found. Run org setup first.`,
    }
  }

  try {
    // Switch the policy to "selected" first, then set the allow-list to just
    // the config repo. Doing it the other way (setting the list while still
    // "all") would 409. Send only enabled_repositories so we don't clobber a
    // teacher's existing allowed_actions (local_only/selected) — pausing is
    // about WHICH repos run Actions, not which actions are allowed.
    await client.request(`/orgs/${org}/actions/permissions`, {
      method: "PUT",
      body: { enabled_repositories: "selected" },
    })
    try {
      await client.request(`/orgs/${org}/actions/permissions/repositories`, {
        method: "PUT",
        body: { selected_repository_ids: [repo.id] },
      })
    } catch (listErr) {
      // The policy is now "selected" but the allow-list write failed, so even
      // the config repo may be blocked. Best-effort roll back to "all" so we
      // don't strand the org with Actions off; if the rollback also fails, warn
      // explicitly that the org may be in a partial state.
      try {
        await setOrgActionsPermissions(client, org)
      } catch {
        return {
          status: "warning",
          org,
          reason: "failed",
          settingsUrl,
          message:
            `${org}: pausing autograding half-applied — GitHub Actions is restricted to selected repositories but the ${CONFIG_REPO} config repo may not be allow-listed, so its workflows could be blocked. ` +
            `Fix this by hand at ${settingsUrl}.`,
        }
      }
      return setOrgActionsModeWarning(org, listErr)
    }
    // Read back the effective selection: both PUTs returning 2xx doesn't prove
    // the config repo actually landed in the allow-list (eventual consistency,
    // id drift). If it isn't there, its own workflows are blocked — surface it
    // instead of reporting a false success. Fail closed to match
    // ensureOrgActionsEnabled: if the verify read itself throws, warn rather
    // than claim a clean pause we couldn't confirm.
    let confirmed: boolean
    try {
      confirmed = await orgActionsSelectionIncludesConfigRepo(client, org)
    } catch {
      return {
        status: "warning",
        org,
        reason: "readback_failed",
        settingsUrl,
        message:
          `${org}: autograding paused, but we couldn't confirm the ${CONFIG_REPO} config repo is allow-listed (the verification read failed). ` +
          `If its workflows stop, check ${settingsUrl}.`,
      }
    }
    if (!confirmed) {
      return {
        status: "warning",
        org,
        reason: "failed",
        settingsUrl,
        message:
          `${org}: pausing autograding didn't take — GitHub Actions is restricted to selected repositories but the ${CONFIG_REPO} config repo isn't in the allow-list, so its workflows may be blocked. ` +
          `Check ${settingsUrl}.`,
      }
    }
    return {
      status: "complete",
      org,
      mode: "paused",
      message: `${org}: autograding paused — GitHub Actions restricted to the ${CONFIG_REPO} config repo.`,
    }
  } catch (err) {
    return setOrgActionsModeWarning(org, err)
  }
}

export type EnsureOrgActionsBudgetCapResult =
  | {
      status: "complete"
      org: string
      // budgetCreated is true only when this run POSTed the $0 cap (drives the
      // one-time "we created a budget for you" banner). "present" means a
      // conforming cap already existed.
      budgetCreated: boolean
      settingsUrl: string
      message: string
    }
  | {
      status: "warning"
      org: string
      reason:
        | "over_threshold"
        | "permission_denied"
        | "create_failed"
        | "readback_failed"
      settingsUrl: string
      message: string
    }

// Reconcile the org's $0 GitHub Actions spending cap. Create-only: POSTs the
// desired $0 hard-stop cap only when no conforming Actions budget exists; NEVER
// modifies or deletes a teacher-set budget (GitHub allows one budget per
// scope+SKU, and overriding the teacher's choice would surprise them — the
// audit surfaces the verdict instead). Best-effort: a missing budget scope or a
// permission error degrades to a warning rather than failing setup.
export async function ensureOrgActionsBudgetCap(
  client: GitHubClient,
  org: string,
): Promise<EnsureOrgActionsBudgetCapResult> {
  const settingsUrl = orgBudgetsUrl(org)

  let budgets: BudgetsListResponse
  try {
    budgets = await client.request<BudgetsListResponse>(orgBudgetsApiPath(org))
  } catch (err) {
    return {
      status: "warning",
      org,
      reason: "readback_failed",
      settingsUrl,
      message:
        `${org}: couldn't read org billing budgets (${getErrorMessage(err)}). ` +
        `Your token may lack Organization Administration: Read, or the plan may not expose budgets. ` +
        `Set a $0 GitHub Actions budget by hand at ${settingsUrl} to hard-stop paid Actions minutes.`,
    }
  }

  const verdict = classifyBudget(budgets.budgets ?? [])
  if (verdict.tier === "enforced" || verdict.tier === "ok") {
    return {
      status: "complete",
      org,
      budgetCreated: false,
      settingsUrl,
      message: `${org}: Actions budget cap already in place ($${verdict.amount}).`,
    }
  }
  if (verdict.tier === "warn") {
    return {
      status: "warning",
      org,
      reason: "over_threshold",
      settingsUrl,
      message:
        `${org}: an Actions budget over the recommended threshold ($${verdict.amount}) is set; leaving it untouched. ` +
        `Lower it to $0 at ${settingsUrl} to hard-stop paid Actions minutes.`,
    }
  }

  // Missing (or alert-only): create the $0 hard-stop cap.
  try {
    await client.request(orgBudgetsApiPath(org), {
      method: "POST",
      body: {
        budget_amount: 0,
        prevent_further_usage: true,
        budget_scope: BUDGET_SCOPE_ORG,
        budget_type: BUDGET_TYPE_PRODUCT_PRICING,
        budget_product_sku: BUDGET_PRODUCT_SKU_ACTIONS,
      },
    })
  } catch (err) {
    const permission = err instanceof GitHubAPIError && err.status === 403
    return {
      status: "warning",
      org,
      reason: permission ? "permission_denied" : "create_failed",
      settingsUrl,
      message: permission
        ? `${org}: couldn't create the $0 Actions budget cap — add Organization Administration: Read and write to your token, or create it by hand at ${settingsUrl}.`
        : `${org}: couldn't create the $0 Actions budget cap (${getErrorMessage(err)}); create it by hand at ${settingsUrl}.`,
    }
  }

  return {
    status: "complete",
    org,
    budgetCreated: true,
    settingsUrl,
    message: `${org}: created a $0 GitHub Actions budget cap (blocks paid Actions minutes).`,
  }
}

export type EnsureOrgCanCreatePullRequestsResult =
  | {
      status: "complete"
      org: string
      message: string
      settingsUrl: string
    }
  | {
      status: "warning"
      org: string
      reason: "permission_denied" | "policy_conflict" | "readback_failed"
      message: string
      settingsUrl: string
    }

type OrgWorkflowPermissions = {
  default_workflow_permissions: "read" | "write"
  can_approve_pull_request_reviews: boolean
}

// The opt-in Feedback PR, opened by each student repo's autograde workflow, is
// rejected unless the org-level "Allow GitHub Actions to create and approve pull
// requests" toggle is on (defaults off, settable only at the org level).
// Preserves default_workflow_permissions.
export async function ensureOrgCanCreatePullRequests(
  client: GitHubClient,
  org: string,
): Promise<EnsureOrgCanCreatePullRequestsResult> {
  const settingsUrl = githubOrgActionsSettingsUrl(org)
  const path = `/orgs/${org}/actions/permissions/workflow`

  let current: OrgWorkflowPermissions
  try {
    current = await client.request<OrgWorkflowPermissions>(path)
  } catch (err) {
    return {
      status: "warning",
      org,
      reason: "readback_failed",
      settingsUrl,
      message: `${org}: couldn't read organization workflow permissions (${getErrorMessage(
        err,
      )}); GitHub Actions may be blocked from opening Feedback PRs. Enable "Allow GitHub Actions to create and approve pull requests" at ${settingsUrl}.`,
    }
  }

  if (current.can_approve_pull_request_reviews) {
    return {
      status: "complete",
      org,
      settingsUrl,
      message: `${org}: GitHub Actions is already allowed to create pull requests (Feedback PRs can open).`,
    }
  }

  try {
    await client.request(path, {
      method: "PUT",
      body: {
        default_workflow_permissions: current.default_workflow_permissions,
        can_approve_pull_request_reviews: true,
      },
    })

    return {
      status: "complete",
      org,
      settingsUrl,
      message: `${org}: enabled GitHub Actions to create pull requests (required for opt-in Feedback PRs).`,
    }
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      (err.status === 403 || err.status === 409)
    ) {
      return {
        status: "warning",
        org,
        reason: err.status === 403 ? "permission_denied" : "policy_conflict",
        settingsUrl,
        message: `${org}: couldn't enable Actions-created pull requests (${getErrorMessage(
          err,
        )}); the opt-in Feedback PR won't open until an org admin turns on "Allow GitHub Actions to create and approve pull requests" at ${settingsUrl}.`,
      }
    }

    throw err
  }
}

export type InitStepId =
  | "orgDefaults"
  | "orgActions"
  | "orgBudget"
  | "orgPrCreation"
  | "configRepo"
  | "skeleton"
  | "branchProtection"
  | "workflowPermissions"
  | "reusableWorkflowAccess"
  | "pages"
  | "rulesets"

export type InitStepUpdate = {
  id: InitStepId
  status: InitStepStatus
  title?: string
  message?: string
  error?: string
  data?: unknown
}

function stepFailed(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    (result as { status: unknown }).status === "error"
  )
}

export async function initClassroom50({
  client,
  org,
  plan,
  onStepUpdate,
  confirmSkeletonOverwrite,
}: {
  client: GitHubClient
  org: string
  plan?: string
  onStepUpdate: (update: InitStepUpdate) => void
  // Invoked before drifted skeleton files are overwritten, with the paths at
  // risk. Resolving false skips the overwrite (missing files are still created)
  // — the GUI's "are you sure" prompt. Omitted on the first-time wizard, where
  // the repo is fresh and nothing pre-exists.
  confirmSkeletonOverwrite?: (paths: string[]) => Promise<boolean>
}) {
  const results: Partial<Record<InitStepId, unknown>> = {}

  logSetup.info("org setup: started", { org, plan })

  const buildResult = (status: "error" | "complete") => ({
    org,
    repo: CONFIG_REPO,
    ...results,
    status,
    pagesUrl: `https://${org}.github.io/${CONFIG_REPO}/`,
  })

  results.orgDefaults = await tryStep({
    id: "orgDefaults",
    onStepUpdate,
    fn: async () => {
      const result = await repairOrgDefaults(client, org, plan)
      // Forward the whole result (not just status/message) so the board can list
      // the specific unenforced settings, and warn on ANY unenforced field so it
      // matches the check page rather than `ok`'s critical-only verdict.
      const status =
        result.unenforced.length > 0 || result.transient
          ? ("warning" as const)
          : ("complete" as const)
      return {
        status,
        message: result.message,
        unenforced: result.unenforced,
        enterprisePinned: result.enterprisePinned,
      }
    },
    options: { warningCodes: [403, 422] },
  })

  results.orgActions = await tryStep({
    id: "orgActions",
    onStepUpdate,
    fn: () => ensureOrgActionsEnabled(client, org),
  })

  results.orgBudget = await tryStep({
    id: "orgBudget",
    onStepUpdate,
    fn: () => ensureOrgActionsBudgetCap(client, org),
  })

  results.orgPrCreation = await tryStep({
    id: "orgPrCreation",
    onStepUpdate,
    fn: () => ensureOrgCanCreatePullRequests(client, org),
  })

  results.configRepo = await tryStep({
    id: "configRepo",
    onStepUpdate,
    fn: () => ensureClassroom50Repo(client, org),
  })

  // configRepo is a hard prerequisite for every step below. If it errored,
  // continuing only cascades 404s and would report success on a
  // half-initialized org. Stop here.
  if (stepFailed(results.configRepo)) {
    logSetup.error("org setup: aborted (config repo step failed)", { org })
    return buildResult("error")
  }

  results.skeleton = await tryStep({
    id: "skeleton",
    onStepUpdate,
    fn: () => ensureSkeletonFiles(client, org, confirmSkeletonOverwrite),
  })

  // skeleton (workflows + scripts) — same hard-prerequisite gate.
  if (stepFailed(results.skeleton)) {
    logSetup.error("org setup: aborted (skeleton step failed)", { org })
    return buildResult("error")
  }

  results.pages = await tryStep({
    id: "pages",
    onStepUpdate,
    fn: () => ensurePages(client, org, CONFIG_REPO),
  })

  results.workflowPermissions = await tryStep({
    id: "workflowPermissions",
    onStepUpdate,
    fn: () => ensureWorkflowPermissions(client, org, CONFIG_REPO),
  })

  results.reusableWorkflowAccess = await tryStep({
    id: "reusableWorkflowAccess",
    onStepUpdate,
    fn: () => ensureReusableWorkflowAccess(client, org, CONFIG_REPO),
  })

  results.branchProtection = await tryStep({
    id: "branchProtection",
    onStepUpdate,
    // No branch: ensureBranchProtection resolves the config repo's actual
    // default branch, since org policy can seed it as `master`.
    fn: () => ensureBranchProtection(client, org, CONFIG_REPO),
  })

  results.rulesets = await tryStep({
    id: "rulesets",
    onStepUpdate,
    fn: () => repairRulesets(client, org),
  })

  logSetup.info("org setup: completed", { org })
  return buildResult("complete")
}
