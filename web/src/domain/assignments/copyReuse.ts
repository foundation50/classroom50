import type { GitHubClient } from "@/github-core/client"
import type { Assignment } from "@/types/classroom"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { prefixCommit } from "@/util/commit"
import {
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { getRepo } from "@/github-core/repoReads"
import {
  getAssignmentsFile,
  type AssignmentsFile,
} from "../queries/assignments"
import { withGitConflictRetry, assertClassroomNotArchived } from "../classrooms"
import {
  log,
  classifyPrivateFork,
  crossOrgPrivateForkError,
} from "./accessPrimitives"
import { resolveTemplateGrant, type CreateAssignmentResult } from "./createEdit"

export type CopyAssignmentInput = {
  org: string
  // A resolved, schema-valid record from the source classroom's
  // assignments.json — copied verbatim, not re-derived from form input.
  source: Assignment
  // Sibling classroom under classroom50/. In-org only for v1: a private
  // template can only be team-granted within its own org.
  targetClassroom: string
  // Default to the source slug/name; the slug must be unique in the target.
  targetSlug?: string
  targetName?: string
  // See CreateAssignmentInput.canGrantTemplateAccess — same owner-only grant gate.
  canGrantTemplateAccess?: boolean
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
    // that evolves by one binary adding a field before the others; "tolerate
    // AND preserve" (evolving-strict-cross-binary-schemas.md; an allowlist would
    // drop them). Known nested objects/arrays are re-cloned below so nothing is
    // shared.
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
          apt: source.runtime.apt ? [...source.runtime.apt] : undefined,
        }
      : undefined,
    allowed_files: source.allowed_files ? [...source.allowed_files] : undefined,
    tests: source.tests ? source.tests.map((t) => ({ ...t })) : undefined,
  }
  if (!entry.template) delete entry.template
  if (!entry.due_meta) delete entry.due_meta
  if (entry.runtime && !entry.runtime.container) delete entry.runtime.container
  // apt can't coexist with a container (the image owns its packages — the CLI
  // rejects the pair), so a container source self-heals by dropping apt on
  // reuse, matching the edit path rather than laundering an invalid combo.
  if (entry.runtime?.container) delete entry.runtime.apt
  if (entry.runtime && !entry.runtime.apt) delete entry.runtime.apt
  if (!entry.runtime) delete entry.runtime
  if (!entry.allowed_files) delete entry.allowed_files
  if (!entry.tests) delete entry.tests

  return entry
}

// grant — the same write + grant as createAssignment, minus form resolution.
// Cross-org reuse is out of scope for v1.
export async function copyAssignmentToClassroom(
  client: GitHubClient,
  input: CopyAssignmentInput,
): Promise<CreateAssignmentResult> {
  const { org, source, targetClassroom } = input

  log.info("copy assignment: started", {
    org,
    targetClassroom,
    sourceSlug: source.slug,
  })

  const entry = buildReusedEntry(source, {
    slug: input.targetSlug ?? source.slug,
    name: input.targetName ?? source.name,
  })

  // The archive guard, template re-check, and org ref read are independent, so
  // run them concurrently — one fewer serial round-trip per retry attempt.
  // Promise.all rejects on the first rejection, so an archived classroom or bad
  // template throws before any write.
  const [, repo, configBranch] = await Promise.all([
    assertClassroomNotArchived(client, org, targetClassroom),
    entry.template
      ? getRepo(client, entry.template.owner, entry.template.repo)
      : Promise.resolve(null),
    getConfigRepoBranch(client, org),
  ])
  const ref = await getBranchRef(client, org, configBranch)

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
    // Same cross-org private-fork guard as resolveTemplate (create/edit): a
    // private fork whose private upstream lives in another org can't be reached
    // by generate, so accept would fail. Enforce here so reuse can't smuggle in
    // a template create/edit would reject.
    const fork = classifyPrivateFork(repo, org)
    if (fork.isRiskyPrivateFork && !fork.parentInOrg) {
      throw crossOrgPrivateForkError(
        entry.template.owner,
        entry.template.repo,
        org,
        fork.parent,
      )
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
  const updatedRef = await updateRef(client, org, newCommit.sha, configBranch)

  let templateGrantWarning: string | undefined
  if (needsTeamGrant && entry.template) {
    templateGrantWarning = await resolveTemplateGrant(
      client,
      org,
      targetClassroom,
      entry.slug,
      entry.template,
      input.canGrantTemplateAccess,
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
