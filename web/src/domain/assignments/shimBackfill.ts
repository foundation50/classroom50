// Add the default autograde shim to a student repo accepted while the
// assignment had the built-in autograder off (no_autograder). Accept writes the
// shim only when the autograder is on, so flipping the setting later leaves the
// already-accepted repos with no workflow and nothing ever grades them. This is
// the web twin of `gh teacher assignment enable-autograder`'s per-repo loop.
//
// A no_autograder accept writes no `.classroom50.yaml` either, and the runner
// refuses a repo without one, so a missing marker lands in the same commit,
// rebuilt teacher-side from the assignment entry (see buildBackfillMarker).
//
// A repo that already carries a default shim is reported present and never
// rewritten: the submission-mode retrofit (submissionTrigger.ts) owns
// reconciling its trigger. Any other file at the reserved path is reported
// unrecognized and left alone, since calling it present would hide that
// nothing grades. Custom (teacher-authored) autograders are gated out by the
// callers, as they are for the retrofit.
import type { GitHubClient } from "@/github-core/client"
import { readRepoHead } from "@/github-core/mutations"
import { getRepoFileAtRef, getUser } from "@/github-core/queries"
import { SHIM_BACKFILL_COMMIT_MESSAGE } from "@/util/commit"
import type { SubmissionMode } from "@/types/classroom"
import { log } from "./accessPrimitives"
import {
  createClassroom50Yaml,
  defaultAutograderWorkflow,
} from "./autograderYaml"
import { ACCEPT_MARKER_PATH } from "@/util/yaml"
import {
  commitShimFiles,
  isDefaultShim,
  readShimAtHead,
  resolveStudentRepoBranch,
  AUTOGRADE_SHIM_PATH,
} from "./submissionTrigger"

export type ShimBackfillOutcome =
  | { status: "added" }
  // The default shim was already there; only the missing marker was written.
  | { status: "markerAdded" }
  | { status: "present" }
  | { status: "unrecognized"; reason: string }
  | { status: "notAccepted" }
  | { status: "missingWorkflowScope" }

// What a missing `.classroom50.yaml` is rebuilt from. `owner` is the repo's
// student login (the repo-name owner segment; the backfill is individual-only).
export type BackfillMarker = {
  classroom: string
  assignment: string
  owner: string
  // The classroom's capability-URL secret, when protected.
  secret?: string
  // ownerId is the template owner's numeric id when the caller already
  // resolved it (a bulk run does so once); undefined means look it up here.
  template?: {
    owner: string
    repo: string
    branch?: string
    ownerId?: number | null
  }
}

// The assignment-level half of BackfillMarker, threaded from the page that
// holds the entry and the classroom secret down to each row.
export type BackfillMarkerSource = Pick<BackfillMarker, "secret" | "template">

// A source whose template owner id is resolved once, for a fan-out that would
// otherwise repeat the same GET /users read for every repo in the roster.
export async function resolveBackfillMarkerSource(
  client: GitHubClient,
  source: BackfillMarkerSource,
): Promise<BackfillMarkerSource> {
  if (!source.template || source.template.ownerId !== undefined) return source
  return {
    ...source,
    template: {
      ...source.template,
      ownerId: await lookupUserId(client, source.template.owner),
    },
  }
}

export async function addAutogradeShim(params: {
  client: GitHubClient
  org: string
  repo: string
  // The config repo's default branch: the reusable-workflow ref the shim
  // points at. The caller resolves it once, and fails closed rather than
  // guessing, because an existing shim is never rewritten.
  configBranch: string
  submissionMode: SubmissionMode
  submissionTags?: string[]
  marker: BackfillMarker
}): Promise<ShimBackfillOutcome> {
  const {
    client,
    org,
    repo,
    configBranch,
    submissionMode,
    submissionTags,
    marker,
  } = params

  const branch = await resolveStudentRepoBranch(client, org, repo)
  if (!branch) return { status: "notAccepted" }
  const head = await readRepoHead(client, { owner: org, repo }, branch)

  const current = await readShimAtHead(client, org, repo, head.headSha)
  const shimPresent = current !== null
  if (shimPresent && !isDefaultShim(current)) {
    return {
      status: "unrecognized",
      reason:
        "a workflow already exists at the shim path but is not the default autograde shim",
    }
  }

  const files: { path: string; content: string }[] = []
  if (!shimPresent) {
    files.push({
      path: AUTOGRADE_SHIM_PATH,
      content: defaultAutograderWorkflow(
        org,
        branch,
        configBranch,
        submissionMode,
        submissionTags,
      ),
    })
  }
  const hasMarker =
    (await getRepoFileAtRef(client, {
      owner: org,
      repo,
      path: ACCEPT_MARKER_PATH,
      ref: head.headSha,
    })) !== null
  if (!hasMarker) {
    // Written under SHIM_BACKFILL_COMMIT_MESSAGE so every reader keeps the root
    // baseline (see baselineSource): a heal re-accept, the only other way to get
    // a marker, would move it. Shim-but-no-marker repos need it just the same.
    files.push({
      path: ACCEPT_MARKER_PATH,
      content: await buildBackfillMarker(client, marker),
    })
  }
  if (files.length === 0) return { status: "present" }

  const committed = await commitShimFiles(
    client,
    org,
    repo,
    head,
    files,
    SHIM_BACKFILL_COMMIT_MESSAGE,
  )
  if (committed === "missingWorkflowScope") {
    return { status: "missingWorkflowScope" }
  }
  return { status: shimPresent ? "markerAdded" : "added" }
}

// The marker accept would have written, minus accepted_at (this is not the
// accept). The numeric ids are best-effort lookups, null when unresolved, the
// same rule accept applies.
async function buildBackfillMarker(
  client: GitHubClient,
  marker: BackfillMarker,
): Promise<string> {
  const [ownerId, sourceOwnerId] = await Promise.all([
    lookupUserId(client, marker.owner),
    marker.template
      ? marker.template.ownerId !== undefined
        ? marker.template.ownerId
        : lookupUserId(client, marker.template.owner)
      : null,
  ])
  return createClassroom50Yaml({
    classroom: marker.classroom,
    assignment: marker.assignment,
    ownerUsername: marker.owner,
    ownerId,
    secret: marker.secret,
    sourceOwner: marker.template?.owner,
    sourceOwnerId,
    sourceRepo: marker.template?.repo,
    sourceBranch: marker.template?.branch,
  })
}

async function lookupUserId(
  client: GitHubClient,
  login: string,
): Promise<number | null> {
  try {
    return (await getUser(client, login)).id
  } catch (err) {
    log.debug("shim backfill: user id lookup failed (non-fatal)", {
      login,
      err,
    })
    return null
  }
}
