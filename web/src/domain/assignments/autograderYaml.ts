import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { classroomPagesSegment } from "@/util/secret"
import { safeShimTagPatterns } from "@/util/submissionTags"
import { fetchTextWithFriendlyErrors } from "../queries/assignments"
import {
  attemptedPagesUrls,
  CUSTOM_HOST_TIMEOUT_MS,
} from "@/github-core/queries"
import { localizedError } from "@/types/localizedMessage"
import type { SubmissionMode } from "@/types/classroom"

export function createClassroom50Yaml(params: {
  classroom: string
  assignment: string
  // `id` is the immutable numeric GitHub user id, recorded so the repo<->student
  // binding survives a username rename.
  ownerUsername: string
  ownerId?: number | null
  acceptedAt?: string
  // Optional capability-URL secret copied from the classroom's classroom.json
  // at accept. Written only for a protected classroom; when present, submit and
  // the autograde runner build the `<classroom>/<secret>/...` Pages path.
  secret?: string
  // Lets `gh student submit` re-fetch teacher files; omitted when template-less.
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

  // Emit the secret right after the identity fields (matching the CLI's field
  // order) and only when present, mirroring the CLI's `omitempty`.
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

// The URL(s) a teacher-authored autograder fetch attempts: custom Pages base
// first when set, github.io fallback — same order and dedupe as the
// assignments-manifest read (attemptedPagesUrls owns the recipe).
function pagesAutograderUrls(params: {
  org: string
  classroom: string
  name: string
  secret?: string
  pagesBaseUrl?: string
}): string[] {
  const { org, classroom, name, secret, pagesBaseUrl } = params
  const segment = classroomPagesSegment(classroom, secret)
  return attemptedPagesUrls(
    org,
    `${segment}/autograders/${name}.yaml`,
    pagesBaseUrl,
  )
}

// The shim's on.push.tags flow sequence: the teacher's milestone patterns (if
// any) UNION the always-on canonical submit/* namespace. No patterns ->
// `"submit/*"` alone, byte-identical to the pre-submission_tags shim.
// Byte-format mirror of Go contract.ShimTagsList — keep identical. FAIL
// CLOSED: this renders a workflow file into a student repo from the
// PUBLISHED (hand-editable) manifest, so unsafe patterns drop the whole
// milestone set rather than trusting write-time validation
// (safeShimTagPatterns has the full rationale).
function shimTagsList(submissionTags?: string[]): string {
  return [...safeShimTagPatterns(submissionTags), "submit/*"]
    .map((p) => `"${p}"`)
    .join(", ")
}

export function defaultAutograderWorkflow(
  org: string,
  branch: string,
  configBranch: string,
  submissionMode?: SubmissionMode,
  submissionTags?: string[],
) {
  // Tag mode drops ONLY the branches: line, so the shim fires exclusively on
  // submission-tag pushes (the submit flows create the tag; a hand-pushed
  // submit/* tag works too). Every other value — undefined, an explicit
  // "every-push", anything unvalidated — renders the identical bytes as
  // before submission_mode existed. Milestone submission_tags widen the tags
  // line to their union with submit/* and are orthogonal to the mode.
  // Mirrors the CLI's renderEmbeddedShim.
  const tagsLine = `    tags: [${shimTagsList(submissionTags)}]`
  const pushTriggers =
    submissionMode === "tag"
      ? tagsLine
      : `    branches: ["${branch}"]
${tagsLine}`
  return `name: Autograde

on:
  push:
${pushTriggers}

jobs:
  grade:
    uses: "${org}/${CONFIG_REPO}/.github/workflows/autograde-runner.yaml@${configBranch}"
    permissions:
      contents: write
      statuses: write
      # Lets the runner open the opt-in Feedback PR. A reusable
      # workflow's token is the intersection with the caller's grants, so
      # this must mirror autograde-runner.yaml's permissions.
      pull-requests: write
`
}

// Whether an autograder name uses the built-in default shim (templated by
// branch here) vs a teacher-authored one fetched from Pages (branch-agnostic).
export function isDefaultAutograder(autograder?: string): boolean {
  return !autograder || autograder === "default"
}

export async function resolveAutograderWorkflow(params: {
  org: string
  classroom: string
  autograder?: string
  secret?: string
  // Custom Pages base URL for an org off the github.io default; the
  // teacher-authored autograder is fetched from it first, like the manifest.
  pagesBaseUrl?: string
  // The assignment repo's default branch (the shim's push trigger) and the
  // config repo's default branch (the reusable-workflow ref). Only used for the
  // built-in default shim; teacher-authored autograders are branch-agnostic.
  branch?: string
  configBranch?: string
  // The assignment's submission_mode; "tag" drops the branch-push trigger.
  // Only applies to the default shim — teacher-authored autograders own their
  // triggers and are never rewritten.
  submissionMode?: SubmissionMode
  // The assignment's milestone submission_tags; rendered into the tags
  // trigger as their union with submit/*. Default-shim only, like the mode.
  submissionTags?: string[]
}): Promise<string> {
  const {
    org,
    classroom,
    autograder,
    secret,
    pagesBaseUrl,
    branch,
    configBranch,
    submissionMode,
    submissionTags,
  } = params
  if (isDefaultAutograder(autograder)) {
    return defaultAutograderWorkflow(
      org,
      branch || DEFAULT_BRANCH,
      configBranch || DEFAULT_BRANCH,
      submissionMode,
      submissionTags,
    )
  }
  // Narrowed: isDefaultAutograder returns true for undefined/"default", so a
  // non-default autograder name is a non-empty string here.
  const autograderName = autograder as string
  const label = {
    key: "pagesErrors.autograderLabel",
    params: { autograderName },
  }

  const urls = pagesAutograderUrls({
    org,
    classroom,
    name: autograderName,
    secret,
    pagesBaseUrl,
  })

  // Custom-domain-first with github.io fallback, mirroring
  // fetchPagesAssignments. Only the (bounded) custom attempt may be a
  // non-final URL; the last attempt's error is the one surfaced.
  let workflow: string | undefined
  let lastErr: unknown
  for (const [i, url] of urls.entries()) {
    const isFallbackable = i < urls.length - 1
    try {
      workflow = await fetchTextWithFriendlyErrors(
        url,
        label,
        isFallbackable ? { timeoutMs: CUSTOM_HOST_TIMEOUT_MS } : undefined,
      )
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (workflow === undefined) {
    throw lastErr
  }

  if (!workflow.includes("jobs:")) {
    throw localizedError({
      key: "pagesErrors.autograderMalformed",
      params: { autograderName },
    })
  }

  return workflow
}
