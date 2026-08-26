// The web half of the one-shot assignment slug rename (#691): offered solely
// to remediate an assignment whose composed `<classroom>-<slug>-<username>`
// repo name can exceed GitHub's 100-character limit. Mirrors the CLI's
// `gh teacher assignment rename` (cli/gh-teacher/internal/assignmentcmd/
// rename.go) phase for phase: one atomic config commit (slug + renamed_from +
// lock, scores.json bucket re-key, autograders/<old>/ move), then a
// marker-verified serial fan-out renaming each student repo, then the lock
// restore — held while any repo failed, because an accept mid-heal would mint
// a fresh repo at a straggler's NEW name and permanently 422 its rename.
// Idempotent: a re-run resumes from state and heals stragglers.
import { parseDocument, isMap, isScalar } from "yaml"

import type { GitHubClient } from "@/github-core/client"
import type { Assignment } from "@/types/classroom"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import {
  getAssignmentsFile,
  type AssignmentsFile,
} from "../queries/assignments"
import {
  createGitCommit,
  createGitTree,
  createCommitRepo,
  createTreeRepo,
  updateRef,
  updateRefForRepo,
  renameRepo,
  getRepoTreeRecursive,
  type GitTreeEntry,
  type GitTreeFileMode,
} from "@/github-core/mutations"
import {
  getOrgRepos,
  getRawFile,
  getRepoFileAtRef,
  getBranchRefRepo,
  getCommitByRepo,
} from "@/github-core/queries"
import { GitHubAPIError, tolerateGitHubError } from "@/github-core/errors"
import { getErrorMessage } from "@/github-core/errorMessage"
import { withGitConflictRetry, assertClassroomNotArchived } from "../classrooms"
import { prefixCommit } from "@/util/commit"
import { CONFIG_REPO } from "@/util/configRepo"
import { composedRepoNameFits } from "@/util/repoNameBudget"
import { studentRepoName } from "@/util/studentRepo"
import { isValidShortName } from "@/util/shortName"
import {
  localizedError,
  type LocalizedMessage,
  type LocalizedParam,
} from "@/types/localizedMessage"
import { log } from "./accessPrimitives"

// The `<classroom>-<slug>-` repo-name prefix every student repo of an
// assignment shares. Routed through studentRepoName (the cross-binary naming
// formula) so it can't drift; mirrors the CLI's contract.AssignmentRepoPrefix.
export function assignmentRepoPrefix(classroom: string, slug: string): string {
  return studentRepoName(classroom, slug, "")
}

// The rename remediation is offered only while BOTH hold: the composed repo
// name can overflow, and the assignment has never been renamed (one-shot —
// renaming again would sever the redirects reserved by the first rename).
export function isRenameEligible(
  classroom: string,
  assignment: Assignment,
): boolean {
  return (
    !composedRepoNameFits(classroom, assignment.slug).fits &&
    !assignment.renamed_from
  )
}

// A prior rename left stragglers: the config already carries renamed_from and
// the fan-out lock is still held. The UI offers "finish rename" (resume) here.
export function needsRenameFinish(assignment: Assignment): boolean {
  return Boolean(assignment.renamed_from) && Boolean(assignment.locked)
}

export type RepoRenameOutcome =
  // Marker rewritten (or already current) and repo renamed.
  | "renamed"
  // Repo already at the new name (a prior run's rename landed); only the
  // marker needed rewriting.
  | "markerHealed"
  // Name and marker already consistent — an idempotent re-run over completed
  // work.
  | "current"
  // The prefix matched but the marker names a different assignment (a sibling
  // slug sharing the prefix) — not ours, untouched.
  | "skippedForeign"
  // No readable marker, so ownership can't be verified; left untouched.
  | "skippedNoMarker"
  // Transient or permission failure — a re-run retries it.
  | "failed"

export type RepoRenameResult = {
  repo: string
  newName: string
  outcome: RepoRenameOutcome
  // Set for skipped/failed rows; resolved with t() at the view layer.
  reason?: LocalizedMessage
  // A secondary-rate-limit failure: the fan-out stops issuing writes and
  // defers the remaining repos (a "finish rename" re-run heals them).
  rateLimited?: boolean
}

export type RenameProgress = { processed: number; total: number; repo: string }

export type RenameAssignmentInput = {
  org: string
  classroom: string
  oldSlug: string
  newSlug: string
}

export type RenameAssignmentSummary = {
  // "fresh" landed the config commit this run; "resume" found it already
  // landed (a prior run died mid-fan-out, or a deliberate healing re-run).
  mode: "fresh" | "resume"
  results: RepoRenameResult[]
  failed: number
  // True when this run released the fan-out lock (fresh, previously unlocked,
  // every repo landed). With stragglers the assignment STAYS locked.
  lockReleased: boolean
  // The lock release was due but its commit failed (non-fatal): the UI
  // surfaces "unlock manually" instead of failing an otherwise-complete run.
  lockRestoreFailed: boolean
  // On resume the pre-rename lock state is unknowable, so it is left alone
  // and the UI notes that an unlock may be due once everything landed.
  prevLocked: boolean
}

// Rewrite the marker's top-level `assignment` scalar from oldSlug to newSlug
// via a comment-preserving YAML round-trip (the `yaml` document model keeps
// key order, comments, and the scalar's quote style). Returns:
//   { changed: true, content }   — rewritten
//   { changed: false }           — already carries newSlug
//   { changed: false, foreignSlug } — the marker belongs to a DIFFERENT
//                                     assignment (sibling prefix over-match)
// Throws for an unparseable document or a missing `assignment` key.
export function rewriteMarkerAssignment(
  raw: string,
  oldSlug: string,
  newSlug: string,
): { changed: boolean; content?: string; foreignSlug?: string } {
  const doc = parseDocument(raw, { schema: "core", prettyErrors: true })
  if (doc.errors.length > 0) {
    throw new Error(doc.errors.map((e) => e.message).join("\n"))
  }
  if (!isMap(doc.contents)) {
    throw new Error("top level is not a mapping")
  }
  const node = doc.get("assignment", true)
  if (!isScalar(node) || typeof node.value !== "string") {
    throw new Error('no "assignment" key')
  }
  if (node.value === newSlug) {
    return { changed: false }
  }
  if (node.value !== oldSlug) {
    return { changed: false, foreignSlug: node.value }
  }
  // Mutate the scalar in place so its existing style (double-quoted at accept
  // time) survives the round-trip.
  node.value = newSlug
  return { changed: true, content: doc.toString() }
}

// Move assignments[oldSlug] to assignments[newSlug] in a parsed scores.json,
// preserving bucket position and any unknown top-level keys. Returns null when
// there is nothing to move (no old bucket — nothing was ever collected).
// An existing new bucket is an error (the preflight uniqueness check makes it
// unreachable short of a race). Mirrors the CLI's rekeyScoresBucket.
export function rekeyScoresBucket(
  raw: string,
  oldSlug: string,
  newSlug: string,
): string | null {
  const top = JSON.parse(raw) as Record<string, unknown>
  const buckets = top.assignments
  if (
    typeof buckets !== "object" ||
    buckets === null ||
    Array.isArray(buckets)
  ) {
    throw renameError("assignments.rename.error.scoresMalformed")
  }
  const map = buckets as Record<string, unknown>
  if (!(oldSlug in map)) return null
  if (newSlug in map) {
    // Reachable outside a race: a DELETED assignment's bucket survives in
    // scores.json, so its slug can collide with the rename target. Keyed so
    // the modal shows a translated, actionable message.
    throw renameError("assignments.rename.error.scoresBucketExists", {
      slug: newSlug,
    })
  }
  top.assignments = Object.fromEntries(
    Object.entries(map).map(([key, value]) => [
      key === oldSlug ? newSlug : key,
      value,
    ]),
  )
  return JSON.stringify(top, null, 2) + "\n"
}

// Full literal keys at every call site (never assembled), so the i18n audit
// can see each one is used.
const renameError = (key: string, params?: Record<string, LocalizedParam>) =>
  localizedError({ key, params })

const reason = (
  key: string,
  params?: Record<string, LocalizedParam>,
): LocalizedMessage => ({ key, params })

const fold = (s: string) => s.toLowerCase()

// One atomic config commit: assignments.json (slug + renamed_from + locked),
// the scores.json bucket re-key, and the autograders/<old>/ directory move.
// Atomic on purpose — a partial config state (renamed slug but orphaned
// bucket) would silently hide grades. The build re-reads everything per
// attempt so a conflict retry observes the latest parent, and re-asserts the
// preflight invariants so a concurrent write loses cleanly, never half-applies.
async function commitRenameConfig(
  client: GitHubClient,
  input: RenameAssignmentInput,
  branch: string,
): Promise<void> {
  const { org, classroom, oldSlug, newSlug } = input
  const assignmentsPath = `${classroom}/assignments.json`
  const scoresPath = `${classroom}/scores.json`

  await withGitConflictRetry(async () => {
    const ref = await getBranchRef(client, org, branch)
    // The three parent-pinned reads are independent — fetch them together.
    // The scores read tolerates 404 (no file — nothing was ever collected).
    const [commit, file, scoresRaw] = await Promise.all([
      getCommit(client, org, ref.object.sha),
      getAssignmentsFile(client, {
        org,
        path: assignmentsPath,
        ref: ref.object.sha,
      }),
      tolerateGitHubError(
        () =>
          getRawFile(client, { org, path: scoresPath, ref: ref.object.sha }),
        null,
      ),
    ])

    const target = file.assignments.find((a) => a.slug === oldSlug)
    if (!target) {
      throw renameError("assignments.rename.error.notFound", {
        slug: oldSlug,
        classroom,
      })
    }
    if (target.renamed_from) {
      throw renameError("assignments.rename.error.alreadyRenamed", {
        slug: oldSlug,
        from: target.renamed_from,
      })
    }
    if (file.assignments.some((a) => fold(a.slug) === fold(newSlug))) {
      throw renameError("assignments.rename.error.slugTaken", {
        slug: newSlug,
        classroom,
      })
    }
    const reserving = file.assignments.find(
      (a) => a.renamed_from && fold(a.renamed_from) === fold(newSlug),
    )
    if (reserving) {
      throw renameError("assignments.rename.error.slugReserved", {
        slug: newSlug,
        current: reserving.slug,
      })
    }

    // Map in place so the entry keeps its position in the array: a rename
    // shouldn't reorder the manifest (see replaceAssignmentEntry).
    // Lock for the fan-out window: an accept mid-rename would mint a fresh
    // empty repo at the NEW name and 422 the real repo's rename.
    const nextAssignments: AssignmentsFile = {
      ...file,
      assignments: file.assignments.map((a) =>
        a.slug === oldSlug
          ? { ...a, slug: newSlug, renamed_from: oldSlug, locked: true }
          : a,
      ),
    }

    const tree: GitTreeEntry[] = [
      {
        path: assignmentsPath,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(nextAssignments, null, 2) + "\n",
      },
    ]

    // scores.json bucket re-key (skipped when the file or the old bucket is
    // absent).
    if (scoresRaw !== null) {
      const rekeyed = rekeyScoresBucket(scoresRaw, oldSlug, newSlug)
      if (rekeyed !== null) {
        tree.push({
          path: scoresPath,
          mode: "100644",
          type: "blob",
          content: rekeyed,
        })
      }
    }

    // Move a hand-authored autograders/<old>/ directory by blob SHA (no
    // content round-trip), or the runner's bundle URL for the new slug 404s
    // and grading silently falls back.
    const oldDir = `${classroom}/autograders/${oldSlug}/`
    const newDir = `${classroom}/autograders/${newSlug}/`
    const { tree: fullTree, truncated } = await getRepoTreeRecursive({
      client,
      owner: org,
      repo: CONFIG_REPO,
      treeSha: commit.tree.sha,
    })
    if (truncated) {
      // A truncated listing would move a PARTIAL directory — refuse.
      throw renameError("assignments.rename.error.treeTruncated")
    }
    for (const entry of fullTree) {
      if (entry.type !== "blob" || !entry.path.startsWith(oldDir)) continue
      tree.push({
        path: newDir + entry.path.slice(oldDir.length),
        mode: entry.mode as GitTreeFileMode,
        type: "blob",
        sha: entry.sha,
      })
      tree.push({ path: entry.path, mode: "100644", type: "blob", sha: null })
    }

    const newTree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree,
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `Rename assignment ${oldSlug} to ${newSlug}: ${classroom}`,
      ),
      tree_sha: newTree.sha,
      parents: [ref.object.sha],
    })
    await updateRef(client, org, newCommit.sha, branch)
  })
}

// Flip the renamed entry's locked flag (the post-fan-out restore). Deliberately
// NOT setAssignmentLock: the rename lock is a bare flag for the fan-out window
// and must not touch template team access. No-op when already in state.
async function setRenamedEntryLocked(
  client: GitHubClient,
  input: RenameAssignmentInput,
  branch: string,
  locked: boolean,
): Promise<void> {
  const { org, classroom, newSlug } = input
  const assignmentsPath = `${classroom}/assignments.json`

  await withGitConflictRetry(async () => {
    const ref = await getBranchRef(client, org, branch)
    const commit = await getCommit(client, org, ref.object.sha)
    const file = await getAssignmentsFile(client, {
      org,
      path: assignmentsPath,
      ref: ref.object.sha,
    })
    const target = file.assignments.find((a) => a.slug === newSlug)
    if (!target) {
      throw renameError("assignments.rename.error.notFound", {
        slug: newSlug,
        classroom,
      })
    }
    if (Boolean(target.locked) === locked) return

    const nextAssignments: AssignmentsFile = {
      ...file,
      assignments: file.assignments.map((a) => {
        if (a.slug !== newSlug) return a
        const entry: Assignment = { ...a, locked }
        // Collapse to the wire's absent-is-false shape (matches the CLI's
        // omitempty), so unlocking drops the key.
        if (!locked) delete entry.locked
        return entry
      }),
    }
    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: [
        {
          path: assignmentsPath,
          mode: "100644",
          type: "blob",
          content: JSON.stringify(nextAssignments, null, 2) + "\n",
        },
      ],
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `Restore lock state of ${newSlug} after rename: ${classroom}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    await updateRef(client, org, newCommit.sha, branch)
  })
}

// Handle a single candidate repo: verify ownership via the marker, rewrite the
// marker's `assignment` field ([skip ci]), then PATCH the repo name. `healing`
// marks a repo already at the new name (resume path), so only the marker is
// checked/rewritten. Ownership is marker-gated because the prefix can
// over-match a sibling slug — a proper sibling repo carries a marker naming
// ITS slug and is skipped untouched.
//
// Marker before rename, on purpose: the config already carries the new slug,
// so a marker pointing at it grades correctly even while the repo still has
// its old name; the reverse order leaves a window where the runner hard-fails
// the manifest lookup.
async function renameOneRepo(params: {
  client: GitHubClient
  org: string
  repo: string
  newName: string
  branch: string
  oldSlug: string
  newSlug: string
  healing: boolean
}): Promise<RepoRenameResult> {
  const { client, org, repo, newName, branch, oldSlug, newSlug, healing } =
    params
  const result: RepoRenameResult = { repo, newName, outcome: "failed" }

  // The marker rewrite reads at the same head the commit is built on, inside
  // the conflict retry, so a concurrent student push loses cleanly and the
  // build re-observes the new head. The closure returns its classification so
  // a retried attempt can't leak a stale one.
  type MarkerStep =
    | { kind: "skip"; outcome: RepoRenameOutcome; reason: LocalizedMessage }
    | { kind: "done"; rewroteMarker: boolean }
  let step: MarkerStep
  try {
    step = await withGitConflictRetry(async (): Promise<MarkerStep> => {
      const headRef = await getBranchRefRepo(client, org, repo, branch)
      const headSha = headRef.object.sha
      const raw = await getRepoFileAtRef(client, {
        owner: org,
        repo,
        path: ".classroom50.yaml",
        ref: headSha,
      })
      if (raw === null) {
        return {
          kind: "skip",
          outcome: "skippedNoMarker",
          reason: reason("assignments.rename.reason.noMarker"),
        }
      }
      let rewrite
      try {
        rewrite = rewriteMarkerAssignment(raw, oldSlug, newSlug)
      } catch (err) {
        return {
          kind: "skip",
          outcome: "skippedNoMarker",
          reason: reason("assignments.rename.reason.unparseableMarker", {
            message: getErrorMessage(err),
          }),
        }
      }
      if (rewrite.foreignSlug) {
        return {
          kind: "skip",
          outcome: "skippedForeign",
          reason: reason("assignments.rename.reason.foreignMarker", {
            slug: rewrite.foreignSlug,
          }),
        }
      }
      if (!rewrite.changed) {
        return { kind: "done", rewroteMarker: false }
      }

      const headCommit = await getCommitByRepo(client, org, repo, headSha)
      const tree = await createTreeRepo(client, {
        base_tree: headCommit.tree.sha,
        org,
        repo,
        tree: [
          {
            path: ".classroom50.yaml",
            mode: "100644",
            type: "blob",
            content: rewrite.content ?? "",
          },
        ],
      })
      // [skip ci]: the marker touch must not burn an autograde run on every
      // student repo.
      const commit = await createCommitRepo(client, {
        org,
        repo,
        parents: [headSha],
        tree: tree.sha,
        message:
          prefixCommit(`Update assignment slug to ${newSlug} (rename)`) +
          "\n\n[skip ci]",
      })
      await updateRefForRepo({
        client,
        owner: org,
        repo,
        branch,
        commitSha: commit.sha,
      })
      return { kind: "done", rewroteMarker: true }
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      // The org listing said it exists; a 404 now means it was deleted (or
      // renamed) concurrently — a re-run re-classifies.
      result.reason = reason("assignments.rename.reason.repoGone")
      return result
    }
    if (err instanceof GitHubAPIError && err.isRateLimited) {
      result.reason = reason("assignments.rename.reason.rateLimited")
      result.rateLimited = true
      return result
    }
    result.reason = reason("assignments.rename.reason.markerRewriteFailed", {
      message: getErrorMessage(err),
    })
    return result
  }
  if (step.kind === "skip") {
    result.outcome = step.outcome
    result.reason = step.reason
    return result
  }

  if (healing) {
    // Name already current: a rewrite means a prior run's rename landed but
    // its marker didn't; neither means fully completed work.
    result.outcome = step.rewroteMarker ? "markerHealed" : "current"
    return result
  }

  try {
    await renameRepo(client, { owner: org, repo, newName })
  } catch (err) {
    // isRateLimited before isForbidden: a secondary rate limit is a 403 too,
    // and "needs admin" advice for a throttle would send the teacher down the
    // wrong recovery path.
    if (err instanceof GitHubAPIError && err.isRateLimited) {
      result.reason = reason("assignments.rename.reason.rateLimited")
      result.rateLimited = true
    } else if (err instanceof GitHubAPIError && err.isForbidden) {
      result.reason = reason("assignments.rename.reason.renameForbidden", {
        newName,
      })
    } else if (err instanceof GitHubAPIError && err.status === 422) {
      result.reason = reason("assignments.rename.reason.renameConflict", {
        newName,
        org,
      })
    } else {
      result.reason = reason("assignments.rename.reason.renameFailed", {
        message: getErrorMessage(err),
      })
    }
    return result
  }
  result.outcome = "renamed"
  return result
}

// Orchestrate preflight -> config commit -> per-repo fan-out -> lock restore.
// Config lands FIRST so a run that dies mid-fan-out is resumable purely from
// state: the manifest already records the rename, and a re-run classifies each
// repo by its current name and marker. The fan-out is serial on purpose —
// GitHub's secondary-rate-limit budget makes a concurrent repo-rename fan-out
// a liability. Per-repo failures never abort the batch; they are returned as
// classified results for the UI to report with fixes.
export async function renameAssignment(
  client: GitHubClient,
  input: RenameAssignmentInput,
  opts?: { onProgress?: (progress: RenameProgress) => void },
): Promise<RenameAssignmentSummary> {
  const { org, classroom, oldSlug, newSlug } = input
  log.info("rename assignment: started", { org, classroom, oldSlug, newSlug })

  if (!isValidShortName(newSlug)) {
    throw renameError("assignments.rename.error.invalidSlug", { slug: newSlug })
  }
  if (fold(oldSlug) === fold(newSlug)) {
    throw renameError("assignments.rename.error.sameSlug")
  }
  if (!composedRepoNameFits(classroom, newSlug).fits) {
    throw renameError("assignments.rename.error.overBudget", {
      slug: newSlug,
      classroom,
    })
  }

  // Start the whole-org pagination (the longest read in the flow) before the
  // config-repo preflight reads — it has no dependency on them. A deliberate
  // FRESH read rather than the modal's react-query cache: enumeration decides
  // which repos get renamed, so it must not act on a stale list. The no-op
  // catch keeps a preflight throw from surfacing an unhandled rejection; the
  // real error resurfaces at the await below.
  const orgReposPromise = getOrgRepos(client, org)
  orgReposPromise.catch(() => {})

  const [, branch] = await Promise.all([
    assertClassroomNotArchived(client, org, classroom),
    getConfigRepoBranch(client, org),
  ])

  // Preflight against the current manifest: fresh rename vs resume (the
  // config commit already landed — a prior run died mid-fan-out, or this is a
  // deliberate re-run to heal stragglers). The commit build re-asserts the
  // fresh-path invariants against its own parent, so this classification can
  // race without half-applying.
  const preFile = await getAssignmentsFile(client, {
    org,
    path: `${classroom}/assignments.json`,
    ref: branch,
  })
  let mode: "fresh" | "resume"
  let prevLocked = false
  const oldEntry = preFile.assignments.find((a) => a.slug === oldSlug)
  const newEntry = preFile.assignments.find((a) => a.slug === newSlug)
  if (oldEntry) {
    if (oldEntry.renamed_from) {
      throw renameError("assignments.rename.error.alreadyRenamed", {
        slug: oldSlug,
        from: oldEntry.renamed_from,
      })
    }
    if (composedRepoNameFits(classroom, oldSlug).fits) {
      throw renameError("assignments.rename.error.fitsBudget", {
        slug: oldSlug,
      })
    }
    if (newEntry) {
      throw renameError("assignments.rename.error.slugTaken", {
        slug: newSlug,
        classroom,
      })
    }
    const reserving = preFile.assignments.find(
      (a) => a.renamed_from && fold(a.renamed_from) === fold(newSlug),
    )
    if (reserving) {
      throw renameError("assignments.rename.error.slugReserved", {
        slug: newSlug,
        current: reserving.slug,
      })
    }
    prevLocked = Boolean(oldEntry.locked)
    mode = "fresh"
  } else if (newEntry && fold(newEntry.renamed_from ?? "") === fold(oldSlug)) {
    mode = "resume"
  } else {
    throw renameError("assignments.rename.error.notFound", {
      slug: oldSlug,
      classroom,
    })
  }

  // Enumerate candidate repos by prefix over the org list (roster-free, so
  // dropped students' repos are covered). Prefix over-match against a sibling
  // slug is possible ("hw" also prefixes "hw-extra" repos), so the fan-out
  // verifies OWNERSHIP per repo via the marker before touching it.
  const orgRepos = await orgReposPromise
  if (orgRepos === null) {
    throw renameError("assignments.rename.error.repoListFailed", { org })
  }
  const oldPrefix = assignmentRepoPrefix(classroom, oldSlug)
  const newPrefix = assignmentRepoPrefix(classroom, newSlug)
  const toRename: { repo: string; branch: string }[] = []
  const toHeal: { repo: string; branch: string }[] = []
  for (const repo of orgRepos) {
    if (repo.name.startsWith(oldPrefix)) {
      toRename.push({ repo: repo.name, branch: repo.default_branch })
    } else if (mode === "resume" && repo.name.startsWith(newPrefix)) {
      // A prior run may have renamed the repo but died before the marker
      // rewrite landed; classified per repo in the fan-out.
      toHeal.push({ repo: repo.name, branch: repo.default_branch })
    }
  }

  if (mode === "fresh") {
    await commitRenameConfig(client, input, branch)
  }

  const total = toRename.length + toHeal.length
  const results: RepoRenameResult[] = []
  // Once one repo hits a secondary rate limit, keep issuing writes and the
  // throttle only deepens — defer every remaining repo instead (the
  // bulk-modal convention); the idempotent "finish rename" re-run heals them.
  let rateLimitHit = false
  const report = (repo: string) =>
    opts?.onProgress?.({ processed: results.length, total, repo })
  const processOne = async (
    repo: string,
    repoBranch: string,
    newName: string,
    healing: boolean,
  ) => {
    report(repo)
    if (rateLimitHit) {
      results.push({
        repo,
        newName,
        outcome: "failed",
        reason: reason("assignments.rename.reason.rateLimitedDeferred"),
        rateLimited: true,
      })
      return
    }
    const result = await renameOneRepo({
      client,
      org,
      repo,
      newName,
      branch: repoBranch,
      oldSlug,
      newSlug,
      healing,
    })
    if (result.rateLimited) rateLimitHit = true
    results.push(result)
  }
  for (const { repo, branch: repoBranch } of toRename) {
    await processOne(
      repo,
      repoBranch,
      newPrefix + repo.slice(oldPrefix.length),
      false,
    )
  }
  for (const { repo, branch: repoBranch } of toHeal) {
    await processOne(repo, repoBranch, repo, true)
  }
  const failed = results.filter((r) => r.outcome === "failed").length

  // Release the lock only when THIS run set it (fresh path, previously
  // unlocked) AND every repo landed: with stragglers still at their old
  // names, an unlocked assignment lets a student accept into a fresh repo at
  // the NEW name, permanently 422-ing the straggler's rename. The lock holds
  // until a re-run heals them. On resume the pre-rename lock state is
  // unknowable, so it is left alone with a note rather than guessed.
  let lockReleased = false
  let lockRestoreFailed = false
  if (mode === "fresh" && !prevLocked && failed === 0) {
    try {
      await setRenamedEntryLocked(client, input, branch, false)
      lockReleased = true
    } catch (err) {
      log.error("rename assignment: lock restore failed", { err })
      lockRestoreFailed = true
    }
  }

  log.info("rename assignment: finished", { mode, total, failed })
  return { mode, results, failed, lockReleased, lockRestoreFailed, prevLocked }
}
