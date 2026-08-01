import type { GitHubClient } from "@/github-core/client"
import type { Assignment } from "@/types/classroom"
import { getRepo } from "@/github-core/repoReads"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { GitHubAPIError } from "@/github-core/errors"
import { isDefiniteOutageError } from "@/lib/githubHealth/githubHealthStore"
import type { GitHubRepo } from "@/github-core/types"
import { githubOrgOAuthPolicyUrl } from "@/auth/constants"
import { TemplateAccessError } from "@/util/templateAccessError"
import {
  describeLocalizedMessage,
  localizedMessageOf,
  type LocalizedMessage,
} from "@/types/localizedMessage"
import { prefixCommit } from "@/util/commit"
import { logger } from "@/lib/logger"

export const log = logger.scope("mutations:assignments")

// Kept byte-identical with the CLI's `gh student accept` (via prefixCommit) per
// the synchronized-release rule. Carries no contract — the runner keys the
// Feedback-PR baseline off the `.classroom50.yaml` marker commit, not this
// string — so it's freely rewordable as long as both accept clients match.
export const ACCEPT_COMMIT_SUBJECT = prefixCommit(
  "Initialize .classroom50.yaml and autograde workflow (gh student accept)",
)

// Student-facing accept failure: `localized` names the message the accept page
// renders, so a raw GitHub "Not Found" never reaches a student. `Error.message`
// keeps a diagnostic form for logs and outage classification (which unwraps
// `.cause`), but the view renders `localized`, never this.
export class AcceptStepError extends Error {
  localized: LocalizedMessage

  constructor(localized: LocalizedMessage, cause?: unknown) {
    super(describeLocalizedMessage(localized))
    this.name = "AcceptStepError"
    this.localized = localized
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

// Ordered accept-flow phases, shown as a progress checklist in the GUI.
// "feedback" (issue #228) never resolves error — see openFeedbackPrStep.
export type AcceptStepId =
  | "account"
  | "membership"
  | "assignment"
  | "autograder"
  | "repo"
  | "access"
  | "setup"
  | "feedback"

export type AcceptStepStatus = "pending" | "running" | "complete" | "error"

export type AcceptStepUpdate = {
  id: AcceptStepId
  status: AcceptStepStatus
  // Step label; on resolution can override the default (e.g., "Repository
  // already exists").
  message?: LocalizedMessage
  error?: LocalizedMessage
}

export type OnAcceptStepUpdate = (update: AcceptStepUpdate) => void

// Run one accept step, emitting progress around it. Translates a raw
// GitHubAPIError into a student-facing, actionable message (`actions`) so a
// bare "Not Found" never reaches the student; already-friendly errors pass
// through untouched. Every message is a `{ key, params }` descriptor — this
// layer names messages, the accept page renders them.
export async function withAcceptStep<T>(
  params: {
    id: AcceptStepId
    label: LocalizedMessage
    actions: LocalizedMessage
    onStepUpdate?: OnAcceptStepUpdate
    doneMessage?: LocalizedMessage
  },
  fn: () => Promise<T>,
): Promise<T> {
  const { id, label, actions, onStepUpdate, doneMessage } = params

  log.info(`accept step: ${id} started`, { step: id })
  onStepUpdate?.({ id, status: "running", message: label })

  try {
    const result = await fn()
    log.info(`accept step: ${id} complete`, { step: id })
    onStepUpdate?.({ id, status: "complete", message: doneMessage ?? label })
    return result
  } catch (err) {
    const fail = (message: LocalizedMessage, cause?: unknown): never => {
      onStepUpdate?.({ id, status: "error", error: message })
      throw new AcceptStepError(message, cause)
    }

    if (err instanceof TemplateAccessError || err instanceof AcceptStepError) {
      log.warn("accept step failed (typed)", { step: id })
      // TemplateAccessError carries a shorter form for the checklist row, which
      // sits beside six others and can't absorb a paragraph.
      onStepUpdate?.({
        id,
        status: "error",
        error:
          err instanceof TemplateAccessError
            ? err.localizedStep
            : err.localized,
      })
      throw err
    }
    if (err instanceof GitHubAPIError) {
      log.error("accept step failed", { step: id, err })

      if (err.isRateLimited) {
        fail({ key: "accept.stepErrors.rateLimited", params: { label } }, err)
      }
      if (err.isUnauthorized) {
        fail({ key: "accept.stepErrors.unauthorized", params: { label } }, err)
      }
      fail(
        {
          key: "accept.stepErrors.generic",
          params: { label, status: err.status, actions },
        },
        err,
      )
    }
    // Unexpected non-GitHub error (network/parse/etc.): surface it so the
    // checklist row leaves "running" instead of spinning forever. A thrown error
    // that already names its own message keeps it — the Pages readers do, and an
    // unpublished assignment or malformed autograder is actionable advice a
    // generic "safe to retry" line would throw away. Rethrown unwrapped so the
    // outage classifier still sees the original error, not a wrapper.
    log.error("accept step failed (unexpected)", { step: id, err })
    onStepUpdate?.({
      id,
      status: "error",
      error: localizedMessageOf(err) ?? {
        key: "accept.stepErrors.unexpected",
        params: { label },
      },
    })
    throw err
  }
}

// Parse a `--template` ref — `<owner>/<repo>[@<branch>]` or bare `<repo>`
// (owner defaults to the org). Mirrors the CLI's parseTemplateRef so the GUI
// accepts the same inputs and writes the same template block.
export type ParsedTemplate = { owner: string; repo: string; branch?: string }
export function parseTemplateRef(
  raw: string,
  defaultOwner: string,
): ParsedTemplate {
  const trimmed = raw.trim()
  if (!trimmed) {
    // Callers gate on a non-empty ref (template is optional), so this is an
    // internal invariant, not user input.
    throw new Error("Template ref is empty.")
  }

  const [ownerRepo, branch, ...extraAt] = trimmed.split("@")
  if (extraAt.length > 0) {
    throw new Error(
      `Invalid template "${raw}": branch contains '@' (expected owner/repo[@branch]).`,
    )
  }
  // A branch given as `@<whitespace>` is empty after trimming.
  const trimmedBranch = branch?.trim()
  if (trimmed.includes("@") && !trimmedBranch) {
    throw new Error(`Invalid template "${raw}": branch is empty after '@'.`)
  }

  const parts = ownerRepo.split("/").map((part) => part.trim())
  if (parts.length === 1 && parts[0]) {
    // Bare repo name → owner defaults to the org (the form's hint).
    return {
      owner: defaultOwner,
      repo: parts[0],
      branch: trimmedBranch || undefined,
    }
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid template "${raw}": expected owner/repo[@branch].`)
  }
  return {
    owner: parts[0],
    repo: parts[1],
    branch: trimmedBranch || undefined,
  }
}

// Advisory pre-flight verdict for a template ref: mirrors resolveTemplate's
// checks but returns a verdict instead of throwing. Uses the teacher's OAuth
// token — the same one students use at accept time.
export type TemplateAccessVerification =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "not-visible"; owner: string; repo: string }
  | { kind: "not-template"; owner: string; repo: string }
  // No usable branch: no @branch given and the repo has no default branch
  // (e.g., a commitless template). resolveTemplate rejects this too.
  | { kind: "no-branch"; owner: string; repo: string }
  | { kind: "private-out-of-org"; owner: string; repo: string }
  // Read denied (HTTP 403): org restricts third-party apps, the per-user
  // OAuth-App grant was never authorized, or the token's scopes are stale.
  // `message`/`httpStatus` carry GitHub's actual error so the note shows the
  // real cause. `scopeGap` is true when GitHub reported required scopes
  // (X-Accepted-OAuth-Scopes) the token appears to lack.
  | {
      kind: "restricted"
      owner: string
      repo: string
      policyUrl: string
      message: string
      httpStatus: number
      scopeGap: boolean
    }
  // Rate limit hit; the check is inconclusive and should be retried. `outage` is
  // true when the failure that produced this verdict is a positively-identified
  // GitHub outage (5xx / network), so the note can add the githubstatus.com hint
  // even if the global suspicion flag was cleared by this query resolving.
  | { kind: "rate-limited"; owner: string; repo: string; outage: boolean }
  // Verification couldn't complete (network or unexpected error). `outage` as
  // above — set when the underlying failure was a positively-identified outage.
  | { kind: "unknown"; owner: string; repo: string; outage: boolean }
  | {
      kind: "ok"
      owner: string
      repo: string
      branch: string
      visibility: "public" | "private"
      inOrg: boolean
    }
  // Reachable third-party org template (neither the classroom org nor the
  // teacher's account). The org's app restriction only bites at generate time,
  // so accept may still fail.
  | {
      kind: "ok-verify"
      owner: string
      repo: string
      branch: string
      visibility: "public" | "private"
      policyUrl: string
    }
  // A private fork used as a template. `generate` copies the fork's tree but can
  // fail (403/404) when the fork's upstream parent is private and inaccessible
  // to the OAuth token. `parentInOrg` splits the cases: an in-org parent
  // (usually fine, advisory) vs. a cross-org private parent (likely to fail —
  // strongly discouraged). `parent` names the upstream when GitHub reported it.
  | {
      kind: "private-fork"
      owner: string
      repo: string
      branch: string
      parent?: string
      parentInOrg: boolean
    }

// Classify a repo as a risky private fork for template use. `generate` copies
// the fork's tree but can be blocked (403/404) when GitHub can't reach the
// fork's private upstream parent — common when the parent lives in another org.
// True only for a private fork whose parent is private or of unknown
// visibility (a public parent or non-fork/non-private repo generates fine).
// `parentInOrg` splits the risky cases: an in-org private parent (reachable,
// usually fine) vs. a cross-org or unknown parent (likely to fail). An
// absent/malformed parent fails closed to cross-org (`parentInOrg: false`).
// Single source of truth for verifyTemplateAccess, resolveTemplate, and
// copyAssignmentToClassroom.
export function classifyPrivateFork(
  repo: GitHubRepo,
  org: string,
): { isRiskyPrivateFork: boolean; parent?: string; parentInOrg: boolean } {
  if (!(repo.fork && repo.private && repo.parent?.private !== false)) {
    return { isRiskyPrivateFork: false, parentInOrg: false }
  }
  const parentOwner = repo.parent?.full_name?.split("/")[0]
  const parentInOrg =
    parentOwner !== undefined && parentOwner.toLowerCase() === org.toLowerCase()
  return {
    isRiskyPrivateFork: true,
    parent: repo.parent?.full_name,
    parentInOrg,
  }
}

export async function verifyTemplateAccess(
  client: GitHubClient,
  org: string,
  raw: string,
  viewerLogin?: string,
): Promise<TemplateAccessVerification> {
  if (!raw.trim()) return { kind: "empty" }

  let parsed: ParsedTemplate
  try {
    parsed = parseTemplateRef(raw, org)
  } catch (err) {
    return {
      kind: "invalid",
      message: err instanceof Error ? err.message : "Invalid template ref.",
    }
  }

  let repo: GitHubRepo | null
  try {
    // getRepo is 404-tolerant (returns null). A rate-limit also surfaces as
    // 403, so check it before treating a 403 as an org restriction.
    repo = await getRepo(client, parsed.owner, parsed.repo)
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isRateLimited) {
      // A rate limit is the user's own state, never an outage.
      return {
        kind: "rate-limited",
        owner: parsed.owner,
        repo: parsed.repo,
        outage: false,
      }
    }
    if (err instanceof GitHubAPIError && err.isForbidden) {
      return {
        kind: "restricted",
        owner: parsed.owner,
        repo: parsed.repo,
        policyUrl: githubOrgOAuthPolicyUrl(parsed.owner),
        message: err.message,
        httpStatus: err.status,
        // A true scope gap is granted scopes failing to satisfy the endpoint's
        // required scopes — not the mere presence of the header, which GitHub
        // sends on most 403s (else an org restriction would be mislabeled a
        // scope problem). See GitHubAPIError.isScopeGap.
        scopeGap: err.isScopeGap,
      }
    }
    // The verify query resolves-successfully with this verdict, which clears the
    // global outage suspicion — so carry the outage signal on the verdict itself
    // (a 5xx / network failure here) rather than relying on the suspicion flag.
    return {
      kind: "unknown",
      owner: parsed.owner,
      repo: parsed.repo,
      outage: isDefiniteOutageError(err),
    }
  }

  if (!repo) {
    return { kind: "not-visible", owner: parsed.owner, repo: parsed.repo }
  }
  if (!repo.is_template) {
    return { kind: "not-template", owner: parsed.owner, repo: parsed.repo }
  }

  const inOrg = parsed.owner.toLowerCase() === org.toLowerCase()
  if (repo.private && !inOrg) {
    return {
      kind: "private-out-of-org",
      owner: parsed.owner,
      repo: parsed.repo,
    }
  }

  const branch = parsed.branch || repo.default_branch
  if (!branch) {
    return { kind: "no-branch", owner: parsed.owner, repo: parsed.repo }
  }
  const visibility = repo.private ? "private" : "public"

  // Third-party org (not the classroom org, not the teacher's account):
  // readable, but generate may still be blocked by app restrictions.
  const isOwnAccount =
    viewerLogin !== undefined &&
    parsed.owner.toLowerCase() === viewerLogin.toLowerCase()
  if (!inOrg && !isOwnAccount) {
    return {
      kind: "ok-verify",
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      visibility,
      policyUrl: githubOrgOAuthPolicyUrl(parsed.owner),
    }
  }

  // A private fork whose upstream parent is private: `generate` copies the
  // fork's tree but can be blocked (403/404) when GitHub can't reach the private
  // parent — common cross-org. Warn before create so the teacher isn't
  // surprised at accept. A public parent generates fine, so only warn when the
  // parent is private (or unknown).
  const fork = classifyPrivateFork(repo, org)
  if (fork.isRiskyPrivateFork) {
    return {
      kind: "private-fork",
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      parent: fork.parent,
      parentInOrg: fork.parentInOrg,
    }
  }

  return {
    kind: "ok",
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
    visibility,
    inOrg,
  }
}

// Resolve a template ref against GitHub, mirroring the CLI: must be a template
// repo, an omitted @branch falls back to its default, and an out-of-org private
// template is rejected (students could never be granted access). Returns the
// resolved block plus whether it's an in-org private template needing a team
// read grant. Exported for tests.
export async function resolveTemplate(
  client: GitHubClient,
  org: string,
  parsed: ParsedTemplate,
): Promise<{ template: Assignment["template"]; needsTeamGrant: boolean }> {
  // getRepo is 404-tolerant (returns null), so a missing/invisible template
  // surfaces as null.
  const repo = await getRepo(client, parsed.owner, parsed.repo)
  if (!repo) {
    throw new Error(
      `Template "${parsed.owner}/${parsed.repo}" is not visible to your account — make it public, or copy it into ${org} and reference the copy.`,
    )
  }

  if (!repo.is_template) {
    throw new Error(
      `"${parsed.owner}/${parsed.repo}" is not a template repository — toggle Settings → "Template repository" on the repo, then retry.`,
    )
  }

  const branch = parsed.branch || repo.default_branch
  if (!branch) {
    throw new Error(
      `Template "${parsed.owner}/${parsed.repo}" has no default branch — specify one as ${parsed.owner}/${parsed.repo}@<branch>.`,
    )
  }

  const inOrg = parsed.owner.toLowerCase() === org.toLowerCase()
  if (repo.private && !inOrg) {
    throw new Error(
      `Template "${parsed.owner}/${parsed.repo}" is private and outside ${org} — students can't be granted access, so accept would fail. Copy it into ${org} and reference the copy, or make the template public.`,
    )
  }

  // A cross-org private fork is NOT blocked: `generate` copies the fork's own
  // objects and does not need access to the private upstream (verified against
  // GitHub — a student with no parent-org access still generates successfully).
  // The one real failure is the parent org's OAuth-App-access restriction
  // gating our token, which no create-time check can pre-empt. The pre-flight
  // `private-fork` verdict warns about it; accept surfaces it with an
  // actionable, parent-org-named error (see forkParentRestrictedError).

  return {
    template: { owner: parsed.owner, repo: parsed.repo, branch },
    needsTeamGrant: Boolean(repo.private && inOrg),
  }
}

// True when a parsed ref still points at the assignment's stored template, so
// an edit can reuse the stored block instead of re-resolving live. Owner/repo
// case-insensitive (per GitHub); an omitted @branch means "keep the stored
// branch". Edit only.
export function templateRefUnchanged(
  parsed: ParsedTemplate,
  existing: Assignment["template"] | undefined,
): boolean {
  if (!existing) return false
  const sameOwner = parsed.owner.toLowerCase() === existing.owner.toLowerCase()
  const sameRepo = parsed.repo.toLowerCase() === existing.repo.toLowerCase()
  const sameBranch = !parsed.branch || parsed.branch === existing.branch
  return sameOwner && sameRepo && sameBranch
}

// 404 -> false, 200 -> true, else throws. Wraps repoContentsPathExists for the
// config repo (classroom50).
export async function contentsPathExists(
  client: GitHubClient,
  org: string,
  path: string,
): Promise<boolean> {
  return repoContentsPathExists(client, org, CONFIG_REPO, path)
}

// Check whether a path exists in an arbitrary repo. 404 -> false, 200 -> true.
export async function repoContentsPathExists(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
): Promise<boolean> {
  try {
    await client.request(
      `/repos/${owner}/${repo}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    )
    return true
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return false
    }
    throw err
  }
}

// The config repo's default branch, for the default shim's reusable-workflow
// `uses:` ref. On a read failure, fall back to `fallbackBranch` (the assignment
// repo's own branch) rather than a hardcoded `main` — a wrong `@main` ref would
// 404 the runner and silently skip grading on a master-default org. A 404
// (getRepo returns null) or empty value falls back to `main`.
export async function resolveConfigRepoDefaultBranch(
  client: GitHubClient,
  org: string,
  fallbackBranch: string,
): Promise<string> {
  try {
    const repo = await getRepo(client, org, CONFIG_REPO)
    return repo?.default_branch || DEFAULT_BRANCH
  } catch {
    return fallbackBranch
  }
}

// Synthetic "repo still seeding" error for a 200 read with a blank SHA, so
// withFreshRepoRetry retries instead of letting the blank SHA flow into a Tree
// write that would 404 on an empty base_tree.
export function freshRepoNotReadyError(owner: string, repo: string) {
  return new GitHubAPIError({
    status: 409,
    url: `/repos/${owner}/${repo}/git/commits`,
    message: "Git Repository is empty.",
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })
}
