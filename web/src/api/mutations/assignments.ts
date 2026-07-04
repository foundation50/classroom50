import type { GitHubClient } from "@/hooks/github/client"
import type { Assignment } from "@/types/classroom"
import {
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  PASS_THRESHOLD_MAX,
  PASS_THRESHOLD_MIN,
  assertAssignmentMode,
} from "@/types/classroom"
import { getBranchRef, getClassroomJson, getCommit } from "../github/queries"
import { getUser } from "@/hooks/github/queries"
import { GitHubAPIError } from "@/hooks/github/errors"

import type { AssignmentTestDraft } from "@/util/assignmentTests"
import { draftToTest, makeSetupTest } from "@/util/assignmentTests"
import { buildDueFields } from "@/util/formatDate"
import { studentRepoName } from "@/util/studentRepo"
import { classroomPagesSegment } from "@/util/secret"
import { prefixCommit } from "@/util/commit"
import { parseRunnerLabels } from "@/util/runners"
import { parseAllowedFiles, validateAllowedFiles } from "@/util/allowedFiles"
import {
  addRepositoryToTeam,
  createCommitForAssignment,
  createGitCommit,
  createGitTree,
  createTreeForAssignment,
  getErrorMessage,
  updateRef,
  updateRefForRepo,
} from "@/hooks/github/mutations"
import {
  fetchAssignmentFromPages,
  fetchTextWithFriendlyErrors,
  getAssignmentsFile,
  type AssignmentsFile,
} from "../queries/assignments"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "./classrooms"
import type { GitHubRepo } from "@/hooks/github/types"
import {
  getBranchRefRepo,
  getCommitByRepo,
  getRepo,
  withFreshRepoRetry,
} from "@/hooks/github/queries"
import { getAuthenticatedUser } from "../queries/users"
import { acceptAndVerifyOrgMembership } from "./users"
import {
  TemplateAccessError,
  inOrgTemplateError,
  outOfOrgTemplateError,
} from "@/util/templateAccessError"
import { githubOrgOAuthPolicyUrl } from "@/auth/constants"

// The accept commit's subject. Written by both this GUI and the CLI's
// `gh student accept`; kept byte-identical (via prefixCommit) per the
// synchronized-release rule. The subject carries NO contract — the runner
// resolves the trusted Feedback-PR baseline by the commit that introduced
// the `.classroom50.yaml` marker (runner.py: ACCEPT_MARKER_PATH), not by
// matching this string — so it can be reworded freely as long as both
// accept clients stay in lockstep.
const ACCEPT_COMMIT_SUBJECT = prefixCommit(
  "Initialize .classroom50.yaml and autograde workflow (gh student accept)",
)

// A student-facing accept failure. The accept page renders `error.message`
// verbatim, so this keeps a raw GitHub "Not Found" from reaching a student.
class AcceptStepError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "AcceptStepError"
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

// Ordered phases of the accept flow, surfaced as a progress checklist in the
// GUI.
export type AcceptStepId =
  | "account"
  | "membership"
  | "assignment"
  | "autograder"
  | "repo"
  | "access"
  | "setup"

export type AcceptStepStatus = "pending" | "running" | "complete" | "error"

type AcceptStepUpdate = {
  id: AcceptStepId
  status: AcceptStepStatus
  // The label shown for the step; on resolution it can override the default
  // (e.g. "Repository already exists").
  message?: string
  error?: string
}

type OnAcceptStepUpdate = (update: AcceptStepUpdate) => void

// Run one accept step, emitting progress around it. Its core job is to
// translate a raw GitHubAPIError into a student-facing, actionable message
// (`actions`) so a bare "Not Found" never reaches the student; already-friendly
// errors pass through untouched.
async function withAcceptStep<T>(
  params: {
    id: AcceptStepId
    label: string
    actions: string
    onStepUpdate?: OnAcceptStepUpdate
    doneMessage?: string
  },
  fn: () => Promise<T>,
): Promise<T> {
  const { id, label, actions, onStepUpdate, doneMessage } = params

  onStepUpdate?.({ id, status: "running", message: label })

  try {
    const result = await fn()
    onStepUpdate?.({ id, status: "complete", message: doneMessage ?? label })
    return result
  } catch (err) {
    const fail = (message: string, cause?: unknown): never => {
      onStepUpdate?.({ id, status: "error", error: message })
      throw new AcceptStepError(message, cause)
    }

    if (err instanceof TemplateAccessError || err instanceof AcceptStepError) {
      onStepUpdate?.({ id, status: "error", error: err.message })
      throw err
    }
    if (err instanceof GitHubAPIError) {
      console.error(`Accept step "${label}" failed:`, err)

      if (err.isRateLimited) {
        fail(
          `${label} hit GitHub's rate limit. Wait a minute, then try accepting again.`,
          err,
        )
      }
      if (err.isUnauthorized) {
        fail(
          `${label} failed because your GitHub session expired (HTTP 401). Sign out and sign back in, then accept again.`,
          err,
        )
      }
      fail(`${label} failed (HTTP ${err.status}). ${actions}`, err)
    }
    // Unexpected non-GitHub error (network/parse/etc.): surface it on the step
    // so the checklist row leaves "running" instead of spinning forever.
    onStepUpdate?.({
      id,
      status: "error",
      error: err instanceof Error ? err.message : "Unexpected error",
    })
    throw err
  }
}

// Parse a `--template` ref — `<owner>/<repo>[@<branch>]` or a bare `<repo>`
// (owner defaults to the org). Mirrors the CLI's parseTemplateRef so the GUI
// accepts the same inputs and writes the same template block.
type ParsedTemplate = { owner: string; repo: string; branch?: string }
function parseTemplateRef(raw: string, defaultOwner: string): ParsedTemplate {
  const trimmed = raw.trim()
  if (!trimmed) {
    // Callers gate on a non-empty ref (the template is optional), so this is
    // an internal invariant, not user input.
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
  // (e.g. a commitless template). resolveTemplate rejects this too.
  | { kind: "no-branch"; owner: string; repo: string }
  | { kind: "private-out-of-org"; owner: string; repo: string }
  // Read denied (HTTP 403): the owning org likely restricts third-party apps.
  | { kind: "restricted"; owner: string; repo: string; policyUrl: string }
  // GitHub rate limit hit; the check is inconclusive and should be retried.
  | { kind: "rate-limited"; owner: string; repo: string }
  // Verification couldn't complete (network or unexpected error).
  | { kind: "unknown"; owner: string; repo: string }
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
    // getRepo is 404-tolerant (returns null). A rate-limit also surfaces as 403,
    // so check it before treating a 403 as an org restriction.
    repo = await getRepo(client, parsed.owner, parsed.repo)
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isRateLimited) {
      return { kind: "rate-limited", owner: parsed.owner, repo: parsed.repo }
    }
    if (err instanceof GitHubAPIError && err.isForbidden) {
      return {
        kind: "restricted",
        owner: parsed.owner,
        repo: parsed.repo,
        policyUrl: githubOrgOAuthPolicyUrl(parsed.owner),
      }
    }
    return { kind: "unknown", owner: parsed.owner, repo: parsed.repo }
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
// read grant.
async function resolveTemplate(
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

  return {
    template: { owner: parsed.owner, repo: parsed.repo, branch },
    needsTeamGrant: Boolean(repo.private && inOrg),
  }
}

// True when a parsed ref still points at the assignment's stored template, so
// an edit can reuse the stored block instead of re-resolving live. Owner/repo
// are case-insensitive (per GitHub); an omitted @branch means "keep the
// stored branch". Edit only.
function templateRefUnchanged(
  parsed: ParsedTemplate,
  existing: Assignment["template"] | undefined,
): boolean {
  if (!existing) return false
  const sameOwner = parsed.owner.toLowerCase() === existing.owner.toLowerCase()
  const sameRepo = parsed.repo.toLowerCase() === existing.repo.toLowerCase()
  const sameBranch = !parsed.branch || parsed.branch === existing.branch
  return sameOwner && sameRepo && sameBranch
}

// 404 -> false, 200 -> true, else throws. Wraps repoContentsPathExists for
// the config repo (classroom50).
async function contentsPathExists(
  client: GitHubClient,
  org: string,
  path: string,
): Promise<boolean> {
  return repoContentsPathExists(client, org, "classroom50", path)
}

// Check whether a path exists in an arbitrary repo. 404 -> false, 200 -> true.
async function repoContentsPathExists(
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

export async function editAssignment(
  client: GitHubClient,
  input: CreateAssignmentInput,
): Promise<CreateAssignmentResult> {
  const { org, classroom, slug } = input

  // The archive guard is independent of the org ref read, so run them
  // concurrently — Promise.all rejects on the first rejection, so an archived
  // classroom still fails closed before any write.
  const [, ref] = await Promise.all([
    assertClassroomNotArchived(client, org, classroom),
    getBranchRef(client, org),
  ])
  const commit = await getCommit(client, org, ref.object.sha)

  const assignmentsFilePath = `${classroom}/assignments.json`
  const currentAssignments = await getAssignmentsFile(client, {
    org,
    path: assignmentsFilePath,
    ref: ref.object.sha,
  })

  const targetAssignment = currentAssignments.assignments.find(
    (a) => a.slug === slug,
  )
  if (!targetAssignment) {
    throw new Error(`Existing assignment matching ${slug} was not found.`)
  }

  // Normalize the edit the same way as create so it never leaves stray
  // non-schema keys the CLI rejects. Pass the stored template so an unchanged
  // ref is reused without a live lookup (non-template edits save even if the
  // template moved).
  const { entry: editedAssignment, needsTeamGrant } =
    await buildAssignmentEntry(client, input, targetAssignment.template)

  // The form rebuilds only the fields it manages; carry forward the rest
  // (e.g. `migrated_from`, unknown future keys) so an edit doesn't drop them.
  const preservedEntry = preserveUnmanagedAssignmentKeys(
    targetAssignment,
    editedAssignment,
  )

  const nextAssignments = {
    ...currentAssignments,
    assignments: [
      ...currentAssignments.assignments.filter((a) => a.slug !== slug),
      preservedEntry,
    ],
  }

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: assignmentsFilePath,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(nextAssignments, null, 2) + "\n",
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(`Edit assignment: ${input.classroom}/${slug}`),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })
  const updatedRef = await updateRef(client, input.org, newCommit.sha)

  // Grant the (possibly changed) in-org private template a team read — a
  // non-fatal warning, never thrown (the edit already committed). needsTeamGrant
  // implies a resolved template, so the guard just narrows the type.
  let templateGrantWarning: string | undefined
  if (needsTeamGrant && preservedEntry.template) {
    templateGrantWarning = await tryGrantTeamTemplateRead(
      client,
      input.org,
      input.classroom,
      input.slug,
      preservedEntry.template,
    )
  }

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    templateGrantWarning,
  }
}

// Same pre-write probes gh-teacher runs before writing declarative
// tests (see the "For other clients" section of the Autograders wiki).
async function ensureDeclarativeTestsWritable(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
) {
  const materializeScript = ".github/scripts/materialize_tests.py"
  if (!(await contentsPathExists(client, org, materializeScript))) {
    throw new Error(
      `${org}/classroom50 is missing ${materializeScript}, so autograding tests would never run. ` +
        "Re-initialize the organization (or run `gh teacher init`) to update the config repo, then retry.",
    )
  }

  const autograderPath = `${classroom}/autograders/${slug}/autograder.py`
  if (await contentsPathExists(client, org, autograderPath)) {
    throw new Error(
      `Assignment "${slug}" already has a custom autograder at ${autograderPath}. ` +
        "Autograding tests and a hand-written autograder.py are mutually exclusive — remove one before adding the other.",
    )
  }
}

export type CreateAssignmentResult = CreateClassroomResult & {
  // Set when the assignment saved but the follow-up team read grant on a
  // private in-org template failed — a non-fatal warning the UI surfaces
  // (students can't accept until fixed). Mirrors teamDeleteWarning.
  templateGrantWarning?: string
}

// Assemble the normalized classroom50/assignments/v1 entry from form input,
// resolving the template the way the CLI does. Shared by create and edit so
// both write the same schema-valid shape and apply the team grant.
//
// `existingTemplate` (edit only): an unchanged ref (same owner/repo, branch
// unchanged or omitted) reuses the stored block WITHOUT a live lookup, so an
// unrelated-field edit still saves when the template was deleted/un-templated/
// made private-out-of-org. A changed ref is always re-resolved.
async function buildAssignmentEntry(
  client: GitHubClient,
  input: CreateAssignmentInput,
  existingTemplate?: Assignment["template"],
): Promise<{ entry: Assignment; needsTeamGrant: boolean }> {
  const userTests = input.tests.map(draftToTest)

  // A setup command is written as a leading 0-point `run` test named "setup"
  // — the CLI-blessed pre-grading idiom (no runtime.setup field exists; the
  // runner runs tests in order, non-zero exit fails the step). See
  // makeSetupTest/isSetupTest.
  const setupCommand = input.setup_command?.trim()
  const tests = setupCommand
    ? [makeSetupTest(setupCommand), ...userTests]
    : userTests

  if (tests.length > 0) {
    await ensureDeclarativeTestsWritable(
      client,
      input.org,
      input.classroom,
      input.slug,
    )
  }

  // Resolve the template like the CLI (parse, confirm template, default branch,
  // reject out-of-org private), reusing an unchanged stored ref on edit. The
  // template is OPTIONAL (mirrors `--template`): a blank field means a
  // template-less assignment, so skip parse/resolve/grant entirely.
  let template: Assignment["template"] | undefined
  let needsTeamGrant = false
  if (input.template_repo.trim()) {
    const parsedTemplate = parseTemplateRef(input.template_repo, input.org)
    const resolved = templateRefUnchanged(parsedTemplate, existingTemplate)
      ? { template: existingTemplate!, needsTeamGrant: false }
      : await resolveTemplate(client, input.org, parsedTemplate)
    template = resolved.template
    needsTeamGrant = resolved.needsTeamGrant
  }

  // Must match classroom50/assignments/v1 exactly — the CLI rejects unknown
  // fields, so a stray key breaks `gh teacher` for the whole classroom.
  // Optional fields are omitted (not written empty), as the CLI writes them.
  const entry: Assignment = {
    slug: input.slug,
    name: input.name,
    mode: assertAssignmentMode(input.mode),
    autograder: "default",
    // Mirrors the CLI's `--feedback-pr` default of true.
    feedback_pr: input.feedback_pr ?? true,
  }
  // Omit the template block entirely for a template-less assignment, matching
  // how the CLI writes a nil TemplateRef.
  if (template) {
    entry.template = template
  }
  if (input.description.trim()) {
    entry.description = input.description.trim()
  }
  if (input.due_date.trim()) {
    const { due, due_meta } = buildDueFields(input.due_date.trim())
    entry.due = due
    if (due_meta) {
      entry.due_meta = due_meta
    }
  }
  if (input.mode === "group") {
    // A group size outside [GROUP_SIZE_MIN, GROUP_SIZE_MAX] (or non-integer)
    // produces an assignments.json the CLI refuses to parse; enforce the schema
    // bounds here, not just in the form.
    if (
      !Number.isInteger(input.max_group_size) ||
      input.max_group_size < GROUP_SIZE_MIN ||
      input.max_group_size > GROUP_SIZE_MAX
    ) {
      throw new Error(
        `max_group_size: group assignments require a whole number between ${GROUP_SIZE_MIN} and ${GROUP_SIZE_MAX} (got ${input.max_group_size}).`,
      )
    }
    entry.max_group_size = input.max_group_size
  }

  // Runtime overrides (Advanced Settings); omit the block when unset.
  // runs-on: write a string for one label, an array for many (both valid).
  const runnerLabels = parseRunnerLabels(input.runs_on ?? "")
  const containerImage = input.container_image?.trim()
  const containerUser = input.container_user?.trim()
  const runtime: NonNullable<Assignment["runtime"]> = {}
  if (runnerLabels.length === 1) {
    runtime["runs-on"] = runnerLabels[0]
  } else if (runnerLabels.length > 1) {
    runtime["runs-on"] = runnerLabels
  }
  if (containerImage) {
    runtime.container = { image: containerImage }
    if (containerUser) {
      runtime.container.user = containerUser
    }
  }
  if (Object.keys(runtime).length > 0) {
    entry.runtime = runtime
  }

  // allowed_files: parse the textarea, re-validate, omit when empty.
  const allowedFiles = parseAllowedFiles(input.allowed_files ?? "")
  if (allowedFiles.length > 0) {
    const allowedFilesError = validateAllowedFiles(allowedFiles)
    if (allowedFilesError) {
      throw new Error(`allowed_files: ${allowedFilesError}`)
    }
    entry.allowed_files = allowedFiles
  }

  if (tests.length > 0) {
    entry.tests = tests
  }

  // pass_threshold: opt-in integer percentage [0,100]. Absent (undefined) means
  // the teacher didn't enable a passing threshold, so the field is omitted
  // entirely — absent = "no passing concept" everywhere downstream. Validate
  // the bounds so a bad value can't produce a file the CLI refuses to parse.
  if (input.pass_threshold !== undefined) {
    const threshold = input.pass_threshold
    if (
      !Number.isInteger(threshold) ||
      threshold < PASS_THRESHOLD_MIN ||
      threshold > PASS_THRESHOLD_MAX
    ) {
      throw new Error(
        `pass_threshold: must be a whole number between ${PASS_THRESHOLD_MIN} and ${PASS_THRESHOLD_MAX} (got ${threshold}).`,
      )
    }
    entry.pass_threshold = threshold
  }

  return { entry, needsTeamGrant }
}

// Grant the classroom team read on an in-org private template so rostered
// students can generate from it (mirrors the CLI's assignment add). The slug
// comes from classroom.json (authoritative). A genuinely teamless classroom
// (404, or a read with no team block) gets "recreate the classroom" advice; a
// transient read failure must NOT — that could push a teacher to destroy a
// healthy classroom — so it gets a retry message instead.
async function grantTeamTemplateRead(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
  template: NonNullable<Assignment["template"]>,
) {
  let teamSlug: string | undefined
  try {
    const classroomJson = await getClassroomJson(client, { org, classroom })
    teamSlug = classroomJson.team?.slug
  } catch (err) {
    // 404 = no classroom.json (pre-feature) is a genuine "no team"; fall
    // through. Anything else is transient and must not be misread as "no team".
    if (!(err instanceof GitHubAPIError && err.isNotFound)) {
      throw new Error(
        `Assignment "${slug}" was saved, but checking classroom "${classroom}" for its team failed (${getErrorMessage(err)}). The classroom team read on the private template ${template.owner}/${template.repo} could not be granted — retry the save; if it keeps failing, grant the team read on ${template.owner}/${template.repo} directly in GitHub (Settings -> Collaborators and teams).`,
        { cause: err },
      )
    }
    teamSlug = undefined
  }

  if (!teamSlug) {
    throw new Error(
      `Assignment "${slug}" was saved, but classroom "${classroom}" has no team to grant read on the private template ${template.owner}/${template.repo}. Recreate the classroom so the team exists, then students can accept.`,
    )
  }

  await addRepositoryToTeam(client, {
    org,
    teamSlug,
    owner: template.owner,
    repo: template.repo,
    permission: "pull",
  })
}

// Grant the template read but never throw: the commit has already landed, so
// a grant failure can't be reported as a failed save. Returns an actionable
// warning on failure (the assignment works except for student accept against
// the private template), or undefined on success. Mirrors teamDeleteWarning.
async function tryGrantTeamTemplateRead(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
  template: NonNullable<Assignment["template"]>,
): Promise<string | undefined> {
  try {
    await grantTeamTemplateRead(client, org, classroom, slug, template)
    return undefined
  } catch (err) {
    // Log the raw error so a dev-time bug isn't fully hidden behind the
    // user-facing warning string.
    console.error("grantTeamTemplateRead failed (assignment saved):", err)
    const detail = getErrorMessage(err)
    return (
      `Assignment "${slug}" was saved, but granting the classroom team read on ` +
      `the private template ${template.owner}/${template.repo} failed (${detail}). ` +
      `Students can't accept it until the classroom50-${classroom} team is granted ` +
      `read on that repo — grant the team read on ${template.owner}/${template.repo} ` +
      `directly in GitHub (Settings -> Collaborators and teams), then students can accept.`
    )
  }
}

// Refuse a write into an archived classroom (active: false). The UI hides the
// New-assignment / reuse / edit affordances, but the write path is the
// authoritative guard — a stale tab, a direct API call, or a CLI/agent must not
// be able to mutate an archived classroom. Reads classroom.json fresh and fails
// closed before any commit. A genuinely teamless/legacy classroom (no `active`)
// reads as active, so this never blocks normal use.
export async function createAssignment(
  client: GitHubClient,
  input: CreateAssignmentInput,
): Promise<CreateAssignmentResult> {
  // The archive guard, the assignment-entry build, and the org ref read are
  // independent, so run them concurrently — Promise.all rejects on the first
  // rejection, so an archived classroom still fails closed before any write.
  const [, { entry: assignmentBody, needsTeamGrant }, ref] = await Promise.all([
    assertClassroomNotArchived(client, input.org, input.classroom),
    buildAssignmentEntry(client, input),
    getBranchRef(client, input.org),
  ])

  const commit = await getCommit(client, input.org, ref.object.sha)

  const assignmentsFilePath = `${input.classroom}/assignments.json`
  const currentAssignments = await getAssignmentsFile(client, {
    org: input.org,
    path: assignmentsFilePath,
    ref: ref.object.sha,
  })

  if (
    currentAssignments.assignments.some(
      (assignment) => assignment.slug === assignmentBody.slug,
    )
  ) {
    throw new Error(`Assignment already exists: ${assignmentBody.slug}`)
  }

  const nextAssignments: AssignmentsFile = {
    ...currentAssignments,
    assignments: [...currentAssignments.assignments, assignmentBody],
  }

  const tree = await createGitTree(client, {
    ...input,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: assignmentsFilePath,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(nextAssignments, null, 2) + "\n",
      },
    ],
  })
  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(
      `Create assignment: ${input.classroom}/${assignmentBody.slug}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })
  const updatedRef = await updateRef(client, input.org, newCommit.sha)

  let templateGrantWarning: string | undefined
  if (needsTeamGrant && assignmentBody.template) {
    templateGrantWarning = await tryGrantTeamTemplateRead(
      client,
      input.org,
      input.classroom,
      input.slug,
      assignmentBody.template,
    )
  }

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    templateGrantWarning,
  }
}

const extractTemplate = (template: string) => {
  if (!/\//.test(template)) return template
  return template.split("/")?.[1] ?? template
}
export async function createAssignmentRepo(params: {
  client: GitHubClient
  templateOwner?: string
  templateRepo?: string
  owner: string
  name: string
  fallbackBranch: string
}): Promise<AcceptRepoCreationResult> {
  const { client, templateOwner, templateRepo, owner, name, fallbackBranch } =
    params

  const cleanTemplateRepo = templateRepo
    ? extractTemplate(templateRepo)
    : undefined

  if (templateOwner && cleanTemplateRepo) {
    try {
      const repo = await client.request<GitHubRepo>(
        `/repos/${templateOwner}/${cleanTemplateRepo}/generate`,
        {
          method: "POST",
          body: {
            owner,
            name,
            private: true,
            include_all_branches: false,
          },
        },
      )

      return {
        kind: "generated",
        repo,
      }
    } catch (err) {
      if (!(err instanceof GitHubAPIError)) {
        throw err
      }

      if (err.status === 422) {
        const existing = await client.request<GitHubRepo>(
          `/repos/${owner}/${name}`,
        )

        return {
          kind: "already-accepted",
          repo: existing,
        }
      }

      // Don't fall back to an empty repo — it looks "accepted" but has no
      // template content and can't be regenerated. A rate-limit also surfaces
      // as 403, so rethrow it before treating 403/404 as a template problem.
      if (err.isRateLimited) {
        throw err
      }
      if (err.isForbidden || err.isNotFound) {
        const inOrg = templateOwner.toLowerCase() === owner.toLowerCase()
        throw inOrg
          ? inOrgTemplateError(templateOwner, cleanTemplateRepo, err.status)
          : outOfOrgTemplateError(templateOwner, cleanTemplateRepo, err.status)
      }

      // Any other status is a real failure too — don't mask it with an empty
      // repo.
      throw err
    }
  }

  // No template specified — create an empty starter repo. auto_init seeds the
  // README/initial commit; the metadata + shim land in the downstream tree
  // commit (see provisionAcceptedRepo), together in one commit.
  return await createEmptyAssignmentRepo({
    client,
    owner,
    name,
    branch: fallbackBranch,
  })
}

type AcceptRepoCreationResult =
  | {
      kind: "generated"
      repo: GitHubRepo
    }
  | {
      kind: "already-accepted"
      repo: GitHubRepo
    }
  | {
      kind: "fallback-empty"
      repo: GitHubRepo
      branch: string
    }
async function createEmptyAssignmentRepo(params: {
  client: GitHubClient
  owner: string
  name: string
  branch: string
}): Promise<AcceptRepoCreationResult> {
  const { client, owner, name, branch } = params
  let repo: GitHubRepo

  try {
    // metadata + workflow must land in ONE commit so the accept marker and the
    // autograde workflow share the runner's Feedback-PR baseline. auto_init
    // gives us the initial commit to build that single tree commit on; we used
    // to commit .classroom50.yaml alone first, splitting them and skewing the
    // baseline.
    repo = await client.request<GitHubRepo>(`/orgs/${owner}/repos`, {
      method: "POST",
      body: {
        name,
        private: true,
        auto_init: true,
      },
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      const existing = await client.request<GitHubRepo>(
        `/repos/${owner}/${name}`,
      )

      return {
        kind: "already-accepted",
        repo: existing,
      }
    }

    throw err
  }

  // Commit onto the repo's real default branch (GitHub picks it for an
  // auto_init repo); fall back to the requested branch, then "main".
  const targetBranch = repo.default_branch || branch || "main"

  return {
    kind: "fallback-empty",
    repo: {
      ...repo,
      default_branch: targetBranch,
    },
    branch: targetBranch,
  }
}

export type CreateAssignmentInput = {
  name: string
  description: string
  template_repo: string
  due_date: string
  mode: string
  slug: string
  classroom: string
  org: string
  max_group_size: number
  feedback_pr?: boolean
  runs_on?: string
  container_image?: string
  container_user?: string
  setup_command?: string
  allowed_files?: string
  pass_threshold?: number
  tests: AssignmentTestDraft[]
}
export async function createAssignmentWithConflictRetry(
  client: GitHubClient,
  input: CreateAssignmentInput,
) {
  return withGitConflictRetry(() => createAssignment(client, input))
}

export type CopyAssignmentInput = {
  org: string
  // A resolved, schema-valid record from the source classroom's
  // assignments.json — copied verbatim, not re-derived from form input.
  source: Assignment
  // Sibling classroom under classroom50/. In-org only for v1: a private template
  // can only be team-granted within its own org.
  targetClassroom: string
  // Default to the source slug/name; the slug must be unique in the target.
  targetSlug?: string
  targetName?: string
}

// First slug not in `taken`, suffixing `-2`, `-3`, … A base ending in `-<n>`
// continues from n+1 ("hw1-2" -> "hw1-3", not "hw1-2-2"). Case-insensitive, to
// match GitHub repo naming and the server-side check. Pure; prefills the reuse
// modals — the write path re-checks authoritatively.
export function nextAvailableSlug(
  base: string,
  taken: Iterable<string>,
): string {
  const takenSet = new Set(Array.from(taken, (s) => s.trim().toLowerCase()))
  const isFree = (candidate: string) => !takenSet.has(candidate.toLowerCase())

  if (isFree(base)) return base

  // Split off a trailing "-<n>" so we increment it rather than append again.
  const match = /^(.*?)-(\d+)$/.exec(base)
  const stem = match ? match[1] : base
  let n = match ? Number(match[2]) + 1 : 2

  // Bounded defensively; a classroom never has thousands of same-stem slugs.
  for (let i = 0; i < 10000; i++) {
    const candidate = `${stem}-${n}`
    if (isFree(candidate)) return candidate
    n++
  }
  // Unreachable in practice, but never silently return a taken slug.
  return `${stem}-${Date.now()}`
}

// Build the target classroom's record, overriding slug/name. Pure: deep-copies
// (no shared mutable structure) and drops undefined keys to stay omitempty-clean
// — the CLI rejects unknown/`null` fields.
export function buildReusedEntry(
  source: Assignment,
  overrides: { slug: string; name: string },
): Assignment {
  const slug = overrides.slug.trim()
  const name = overrides.name.trim()
  if (!slug) {
    throw new Error("A slug is required for the copied assignment.")
  }

  const entry: Assignment = {
    // Spread the whole source so a field this client doesn't model yet rides
    // through — deliberate. assignments.json is a strict cross-binary contract
    // that evolves by one binary adding a field before the others; preserving
    // unknown keys is the "tolerate AND preserve" rule from
    // evolving-strict-cross-binary-schemas.md (an allowlist would drop them).
    // Known nested objects/arrays are re-cloned below so nothing is shared.
    ...source,
    slug,
    name,
    template: source.template ? { ...source.template } : undefined,
    due_meta: source.due_meta ? { ...source.due_meta } : undefined,
    runtime: source.runtime
      ? {
          ...source.runtime,
          container: source.runtime.container
            ? { ...source.runtime.container }
            : undefined,
        }
      : undefined,
    allowed_files: source.allowed_files ? [...source.allowed_files] : undefined,
    tests: source.tests ? source.tests.map((t) => ({ ...t })) : undefined,
  }
  if (!entry.template) delete entry.template
  if (!entry.due_meta) delete entry.due_meta
  if (entry.runtime && !entry.runtime.container) delete entry.runtime.container
  if (!entry.runtime) delete entry.runtime
  if (!entry.allowed_files) delete entry.allowed_files
  if (!entry.tests) delete entry.tests

  return entry
}

// Ownership of every Assignment entry-level key on the edit path. Typed as a
// total Record<keyof Assignment, ...>, so adding a field to the Assignment type
// fails to compile here until it is classified — closing the silent-desync trap
// where a new managed field omitted from the set lets an edit that clears it get
// re-populated from the stale existing entry. "managed": buildAssignmentEntry
// rebuilds it from input, so an edit clearing it must win. "unmanaged": the form
// never touches it; preserve it verbatim on a read-modify-write (mirrors the
// CLI's AssignmentEntry.Extra).
const ASSIGNMENT_KEY_OWNERSHIP: Record<
  keyof Assignment,
  "managed" | "unmanaged"
> = {
  slug: "managed",
  name: "managed",
  description: "managed",
  template: "managed",
  due: "managed",
  due_meta: "managed",
  mode: "managed",
  autograder: "managed",
  max_group_size: "managed",
  feedback_pr: "managed",
  runtime: "managed",
  allowed_files: "managed",
  pass_threshold: "managed",
  tests: "managed",
  // Written only by the CLI's `migrate`; the form never manages it, so it must
  // ride through a GUI edit untouched.
  migrated_from: "unmanaged",
}

// Keys the edit form fully owns, derived from the ownership map above so it can
// never drift from the Assignment type.
const EDIT_MANAGED_ASSIGNMENT_KEYS = new Set<string>(
  Object.entries(ASSIGNMENT_KEY_OWNERSHIP)
    .filter(([, ownership]) => ownership === "managed")
    .map(([key]) => key),
)

// Copy forward entry-level keys the edit form doesn't manage (e.g.
// `migrated_from`, unknown future keys) onto the rebuilt edit, without
// overwriting managed keys. Mirrors the CLI's AssignmentEntry.Extra round-trip.
export function preserveUnmanagedAssignmentKeys(
  existing: Assignment,
  edited: Assignment,
): Assignment {
  const merged: Record<string, unknown> = { ...edited }
  for (const [key, value] of Object.entries(
    existing as Record<string, unknown>,
  )) {
    if (EDIT_MANAGED_ASSIGNMENT_KEYS.has(key)) continue
    if (value === undefined) continue
    merged[key] = value
  }
  return merged as Assignment
}
// grant — the same write + grant as createAssignment, minus form resolution.
// Cross-org reuse is out of scope for v1.
export async function copyAssignmentToClassroom(
  client: GitHubClient,
  input: CopyAssignmentInput,
): Promise<CreateAssignmentResult> {
  const { org, source, targetClassroom } = input

  const entry = buildReusedEntry(source, {
    slug: input.targetSlug ?? source.slug,
    name: input.targetName ?? source.name,
  })

  // The archive guard (refuse reuse into an archived target), the template
  // re-check, and the org ref read are all independent, so run them
  // concurrently — one fewer serial round-trip per conflict-retry attempt.
  // Promise.all rejects on the first rejection, so an archived classroom or a
  // bad template still throws before any write — no commit.
  const [, repo, ref] = await Promise.all([
    assertClassroomNotArchived(client, org, targetClassroom),
    entry.template
      ? getRepo(client, entry.template.owner, entry.template.repo)
      : Promise.resolve(null),
    getBranchRef(client, org),
  ])

  // Re-check the template live (mirrors create): public/missing -> no grant;
  // private in-org -> needs grant; private out-of-org -> refuse.
  let needsTeamGrant = false
  if (entry.template) {
    // getRepo returns null on 404 (deleted/renamed/invisible) — fail closed
    // before any write, like resolveTemplate, so we never commit a record
    // pointing at a template students can't generate from.
    if (!repo) {
      throw new Error(
        `Template "${entry.template.owner}/${entry.template.repo}" is not visible to your account — it may have been deleted, renamed, or made private outside ${org}. Restore or update the source assignment's template, then reuse.`,
      )
    }
    if (repo.private) {
      const inOrg = entry.template.owner.toLowerCase() === org.toLowerCase()
      if (!inOrg) {
        throw new Error(
          `Template "${entry.template.owner}/${entry.template.repo}" is private and outside ${org} — students in "${targetClassroom}" couldn't be granted access. Copy the template into ${org} and reference the copy, or make it public, then reuse.`,
        )
      }
      needsTeamGrant = true
    }
  }

  const commit = await getCommit(client, org, ref.object.sha)

  const assignmentsFilePath = `${targetClassroom}/assignments.json`
  const currentAssignments = await getAssignmentsFile(client, {
    org,
    path: assignmentsFilePath,
    ref: ref.object.sha,
  })

  // Case-insensitive — slugs are GitHub repo path segments, matching the
  // modals' optimistic check, so a mixed-case programmatic slug can't slip past.
  const entrySlugLower = entry.slug.toLowerCase()
  if (
    currentAssignments.assignments.some(
      (a) => a.slug.toLowerCase() === entrySlugLower,
    )
  ) {
    throw new Error(
      `Assignment "${entry.slug}" already exists in classroom "${targetClassroom}" — choose a different slug.`,
    )
  }

  const nextAssignments: AssignmentsFile = {
    ...currentAssignments,
    assignments: [...currentAssignments.assignments, entry],
  }

  const tree = await createGitTree(client, {
    org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: assignmentsFilePath,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(nextAssignments, null, 2) + "\n",
      },
    ],
  })
  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(
      `Reuse assignment: ${source.slug} -> ${targetClassroom}/${entry.slug}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })
  const updatedRef = await updateRef(client, org, newCommit.sha)

  let templateGrantWarning: string | undefined
  if (needsTeamGrant && entry.template) {
    templateGrantWarning = await tryGrantTeamTemplateRead(
      client,
      org,
      targetClassroom,
      entry.slug,
      entry.template,
    )
  }

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    templateGrantWarning,
  }
}

export async function copyAssignmentWithConflictRetry(
  client: GitHubClient,
  input: CopyAssignmentInput,
) {
  return withGitConflictRetry(() => copyAssignmentToClassroom(client, input))
}

// editAssignment writes to the same classroom50 main branch as createAssignment
// and the roster commits, so a concurrent write 409s non-fast-forward. It
// re-reads the ref + assignments.json each call, so it's safe to retry — mirror
// the create path.
export async function editAssignmentWithConflictRetry(
  client: GitHubClient,
  input: CreateAssignmentInput,
) {
  return withGitConflictRetry(() => editAssignment(client, input))
}

export function createClassroom50Yaml(params: {
  classroom: string
  assignment: string
  // `id` is the immutable numeric GitHub user id, recorded so the
  // repo<->student binding survives a username rename.
  ownerUsername: string
  ownerId?: number | null
  acceptedAt?: string
  // Optional capability-URL secret copied from the classroom's classroom.json
  // at accept. Written only for a protected classroom; when present, submit
  // and the autograde runner build the `<classroom>/<secret>/...` Pages path.
  secret?: string
  // Lets `gh student submit` re-fetch instructor files; omitted when template-less.
  sourceOwner?: string
  sourceOwnerId?: number | null
  sourceRepo?: string
  sourceBranch?: string
}) {
  const {
    classroom,
    assignment,
    ownerUsername,
    ownerId,
    acceptedAt,
    secret,
    sourceOwner,
    sourceOwnerId,
    sourceRepo,
    sourceBranch,
  } = params

  // id is a number (or null) — never quote it as a string.
  const idValue = (id: number | null | undefined) =>
    typeof id === "number" ? String(id) : "null"

  const lines = [
    `schema: "classroom50/repo-config/v1"`,
    `classroom: ${JSON.stringify(classroom)}`,
    `assignment: ${JSON.stringify(assignment)}`,
  ]

  // Emit the secret right after the identity fields (matching the CLI's
  // field order) and only when present, mirroring the CLI's `omitempty`.
  if (secret) {
    lines.push(`secret: ${JSON.stringify(secret)}`)
  }

  lines.push(
    `owner:`,
    `  username: ${JSON.stringify(ownerUsername)}`,
    `  id: ${idValue(ownerId)}`,
  )

  if (acceptedAt) {
    lines.push(`  accepted_at: ${JSON.stringify(acceptedAt)}`)
  }

  if (sourceOwner && sourceRepo) {
    lines.push(
      `source:`,
      `  owner: ${JSON.stringify(sourceOwner)}`,
      `  owner_id: ${idValue(sourceOwnerId)}`,
      `  repo: ${JSON.stringify(sourceRepo)}`,
      `  branch: ${JSON.stringify(sourceBranch ?? "main")}`,
    )
  }
  lines.push(``)
  return lines.join("\n")
}

export type DeleteAssignmentInput = {
  org: string
  classroom: string
  assignment: string
}
export async function deleteAssignment(
  client: GitHubClient,
  input: DeleteAssignmentInput,
) {
  const { org, classroom, assignment: slug } = input

  // Refuse a delete into an archived classroom (write-path guard); run the
  // check concurrently with the ref read.
  const [, ref] = await Promise.all([
    assertClassroomNotArchived(client, org, classroom),
    getBranchRef(client, org),
  ])
  const commit = await getCommit(client, org, ref.object.sha)

  const assignmentsFilePath = `${classroom}/assignments.json`
  const currentAssignments = await getAssignmentsFile(client, {
    org,
    path: assignmentsFilePath,
    ref: ref.object.sha,
  })

  // find the assignment if it exists already
  const targetAssignment = currentAssignments.assignments.find(
    (a) => a.slug === slug,
  )

  if (!targetAssignment) {
    throw new Error(`Existing assignment matching ${slug} was not found.`)
  }

  // expand all but the targeted assignment to filter it out
  const nextAssignments = {
    ...currentAssignments,
    assignments: [
      ...currentAssignments.assignments.filter((a) => a.slug !== slug),
    ],
  }

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: assignmentsFilePath,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(nextAssignments, null, 2) + "\n",
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(`Edit assignment: ${input.classroom}/${slug}`),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })
  const updatedRef = await updateRef(client, input.org, newCommit.sha)

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
  }
}

// Grant the student `admin` (not `maintain`) on their own repo. Intentional and
// CLI-aligned: only an admin can manage collaborators for the
// founder-driven group-invite flow (`gh student invite`).
async function addAdminCollaborator(params: {
  client: GitHubClient
  owner: string
  repo: string
  username: string
}) {
  const { client, owner, repo, username } = params

  await client.request(`/repos/${owner}/${repo}/collaborators/${username}`, {
    method: "PUT",
    body: {
      permission: "admin",
    },
  })
}

async function patchRepoSurface(
  client: GitHubClient,
  owner: string,
  repo: string,
) {
  await client.request<GitHubRepo>(`/repos/${owner}/${repo}`, {
    method: "PATCH",
    body: {
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    },
  })
}

function pagesAutograderUrl(params: {
  org: string
  classroom: string
  name: string
  secret?: string
}) {
  const { org, classroom, name, secret } = params
  const segment = classroomPagesSegment(classroom, secret)
  return `https://${org}.github.io/classroom50/${segment}/autograders/${name}.yaml`
}

function defaultAutograderWorkflow(org: string) {
  return `name: Autograde

on:
  push:
    branches: [main]
    tags: ["submit/*"]

jobs:
  grade:
    uses: "${org}/classroom50/.github/workflows/autograde-runner.yaml@main"
    permissions:
      contents: write
      statuses: write
      # Lets the runner open the opt-in Feedback PR. A reusable
      # workflow's token is the intersection with the caller's grants, so
      # this must mirror autograde-runner.yaml's permissions.
      pull-requests: write
`
}

export async function resolveAutograderWorkflow(params: {
  org: string
  classroom: string
  autograder?: string
  secret?: string
}): Promise<string> {
  const { org, classroom, autograder, secret } = params
  if (!autograder || autograder === "default") {
    return defaultAutograderWorkflow(org)
  }

  const workflow = await fetchTextWithFriendlyErrors(
    pagesAutograderUrl({ org, classroom, name: autograder, secret }),
    `autograder ${autograder}`,
  )

  if (!workflow.includes("jobs:")) {
    throw new Error(
      `Autograder ${autograder} may be malformed YAML. Ask your instructor to check the file in the config repo.`,
    )
  }

  return workflow
}

// Synthetic "repo still seeding" error for a 200 read with a blank SHA, so
// withFreshRepoRetry retries instead of letting the blank SHA flow into a Tree
// write that would 404 on an empty base_tree.
function freshRepoNotReadyError(owner: string, repo: string) {
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

// Land .classroom50.yaml + the autograde workflow as one Tree commit, riding out
// GitHub's git-data lag after POST .../generate (reads 404, the first write 409s
// "Git Repository is empty"). The whole read→build→commit→update sequence runs
// inside withFreshRepoRetry, re-reading the ref + parent commit each attempt and
// requiring non-empty SHAs before writing. Safe because the student's
// just-accepted repo has no concurrent writers.
async function commitAcceptFilesWithFreshRepoRetry(params: {
  client: GitHubClient
  owner: string
  repo: string
  branch: string
  metadataYaml: string
  autogradeYaml: string
}) {
  const { client, owner, repo, branch, metadataYaml, autogradeYaml } = params

  await withFreshRepoRetry(async () => {
    const ref = await getBranchRefRepo(client, owner, repo, branch)
    const parentSha = ref.object.sha
    const currentCommit = await getCommitByRepo(client, owner, repo, parentSha)
    const baseTreeSha = currentCommit.tree?.sha

    if (!parentSha || !baseTreeSha) {
      throw freshRepoNotReadyError(owner, repo)
    }

    const tree = await createTreeForAssignment({
      client,
      owner,
      repo,
      baseTreeSha,
      metadataYaml,
      autogradeYaml,
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
      branch,
      commitSha: commit.sha,
    })
  })
}

type AcceptAssignmentResult = {
  status: "created" | "already-accepted"
  repo: GitHubRepo
  cloneCommand: string
}

// Provision a just-created (or partially-provisioned) student repo: patch its
// surface, grant the student admin, and land the .classroom50.yaml + autograde
// shim through GitHub's post-generate lag. Every step is idempotent, so it's
// safe to re-run when healing a repo whose earlier accept failed mid-flow.
async function provisionAcceptedRepo(params: {
  client: GitHubClient
  org: string
  repo: GitHubRepo
  username: string
  branch: string
  metadataYaml: string
  autogradeYaml: string
  onStepUpdate?: OnAcceptStepUpdate
}) {
  const {
    client,
    org,
    repo,
    username,
    branch,
    metadataYaml,
    autogradeYaml,
    onStepUpdate,
  } = params

  await withAcceptStep(
    {
      id: "access",
      label: "Granting you access to your repository",
      actions: `Your repository ${org}/${repo.name} was created, but adding you (${username}) as a collaborator failed. This usually means your GitHub username changed or you left ${org}. Confirm you're a member of ${org}, then use "Re-run setup".`,
      doneMessage: "Granted you access to your repository",
      onStepUpdate,
    },
    async () => {
      await patchRepoSurface(client, org, repo.name)
      await addAdminCollaborator({
        client,
        owner: org,
        repo: repo.name,
        username,
      })
    },
  )

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
      }),
  )
}
export async function acceptAssignment(params: {
  client: GitHubClient
  org: string
  classroom: string
  assignmentSlug: string
  // Capability-URL access key from the accept link (?k=). Selects the
  // <classroom>/<secret>/ Pages path for a protected classroom and is
  // written into .classroom50.yaml so submit + the runner can rebuild the
  // URLs. Undefined for an unprotected classroom (plain path). Not read
  // from classroom.json — students can't access the private config repo.
  secret?: string
  onStepUpdate?: OnAcceptStepUpdate
}): Promise<AcceptAssignmentResult> {
  const { client, org, classroom, assignmentSlug, secret, onStepUpdate } =
    params

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
  // student is now an ACTIVE member before we attempt repo creation (a pending
  // invitee can't create their repo). Verifying here means a SAML-SSO-gated 403
  // surfaces as an actionable step failure right away (with the SSO/HTTP status
  // in the message) instead of a confusing downstream repo/access failure.
  await withAcceptStep(
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

  // Best-effort: resolve the template owner's immutable id (org or user). Never
  // fail accept over this — a missing id is recorded as null.
  let sourceOwnerId: number | null = null
  if (sourceOwner) {
    try {
      sourceOwnerId = (await getUser(client, sourceOwner)).id
    } catch {
      sourceOwnerId = null
    }
  }

  const autogradeYaml = await withAcceptStep(
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
      }),
  )

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
      }),
  )

  if (created.kind === "already-accepted") {
    // The repo exists, but a prior accept may have failed AFTER creating it but
    // BEFORE committing the metadata/workflow (seeding lag, transient 5xx),
    // leaving a repo that looks accepted but never autogrades. Heal it: a repo
    // is only "genuinely accepted" when BOTH the metadata and the autograde
    // workflow landed (they're written in one commit, so a missing workflow
    // means the prior accept failed mid-flow). If either is missing, re-run the
    // idempotent provisioning.
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
      // Genuinely already accepted — mark the remaining steps complete so the
      // checklist doesn't look stuck.
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

    // Half-finished prior accept — re-provision to repair it.
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
      branch: created.repo.default_branch || sourceBranch,
      metadataYaml,
      autogradeYaml,
      onStepUpdate,
    })

    return {
      status: "already-accepted",
      repo: created.repo,
      cloneCommand: `git clone ${created.repo.ssh_url}`,
    }
  }

  const repo = created.repo

  const targetBranch =
    created.kind === "fallback-empty"
      ? created.branch
      : repo.default_branch || sourceBranch

  await provisionAcceptedRepo({
    client,
    org,
    repo,
    username,
    branch: targetBranch,
    metadataYaml,
    autogradeYaml,
    onStepUpdate,
  })

  return {
    status: "created",
    repo,
    cloneCommand: `git clone ${repo.ssh_url}`,
  }
}
