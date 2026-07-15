import type { GitHubClient } from "../client"
import {
  getBranchRef,
  getClassroomJson,
  getCommit,
  getConfigRepoBranch,
} from "../configRepoReads"
import { isClassroomArchived } from "@/types/classroom"
import { prefixCommit } from "@/util/commit"
import {
  createBlob,
  createTreeFromEntries,
  createCommit,
  updateRef,
} from "./gitObjects"

export type UpdateClassroomMetadataInput = {
  org: string
  slug: string
  name: string
  term: string
}

export type Classroom = {
  name: string
  short_name: string
  slug: string
  schema: string
  term: string
}
export type UpdateClassroomMetadataResult = {
  previousCommitSha: string
  baseTreeSha: string
  newTreeSha: string
  newCommitSha: string
  updatedRef: unknown
  classroom: Classroom
}
export type EditClassroomInput = {
  org: string
  slug: string
  // name/term are written only when provided — a pure archive/unarchive toggle
  // omits them so editClassroom's `...current` spread preserves the persisted
  // values (no stale-cache overwrite, no lost-update of a concurrent rename).
  term?: string
  name?: string
  // Archive lifecycle: false = archive, true = unarchive. Omitted leaves the
  // current value (or its absence) intact. See isClassroomArchived.
  active?: boolean
}

export type EditClassroomResult = Awaited<ReturnType<typeof editClassroom>>

// Merge an edit onto the current classroom.json record. Pure (no I/O):
// - spreads `...current` first so unknown/future fields a sibling binary wrote
//   ride through verbatim (the strict CLI round-trips this file);
// - writes name/term/active ONLY when provided, so a pure archive toggle
//   preserves the persisted name/term. `active` is a meaningful boolean (false =
//   archived), so unarchive writes `true` rather than deleting the key.
export function buildClassroomUpdate(
  current: Record<string, unknown>,
  fields: {
    name?: string
    term?: string
    active?: boolean
  },
): Record<string, unknown> {
  const { name, term, active } = fields
  return {
    ...current,
    ...(name !== undefined ? { name } : {}),
    ...(term !== undefined ? { term } : {}),
    ...(active !== undefined ? { active } : {}),
  }
}

export async function editClassroom(
  client: GitHubClient,
  input: EditClassroomInput,
) {
  const { org, slug, term, name, active } = input

  // Org policy can seed the config repo on a non-`main` branch, so both the ref
  // read and the write must target the real branch.
  const configBranch = await getConfigRepoBranch(client, org)

  const ref = await getBranchRef(client, org, configBranch)

  const commit = await getCommit(client, org, ref.object.sha)

  const current = await getClassroomJson(client, {
    org,
    classroom: slug,
    ref: ref.object.sha,
  })

  if (current.short_name !== slug) {
    throw new Error(
      `classroom.json slug mismatch: expected ${current.short_name}, got ${slug}`,
    )
  }

  // Archived classrooms are read-only — refuse a settings edit (name / term),
  // but let a lifecycle toggle through since unarchiving re-enables editing.
  // Gate on whether a settings field is actually present rather than on
  // `active === undefined`, so a payload bundling a settings change with
  // `active: false` (a stale tab, direct API call, or CLI/agent) can't slip an
  // edit past the guard by re-asserting the archived state.
  const editsSettings = name !== undefined || term !== undefined
  if (editsSettings && active !== true && isClassroomArchived(current)) {
    throw new Error(
      `Classroom "${slug}" is archived — settings are read-only. Unarchive it first to make changes.`,
    )
  }

  const next = buildClassroomUpdate(current, {
    name,
    term,
    active,
  })

  const blob = await createBlob(client, {
    org,
    content: JSON.stringify(next, null, 2) + "\n",
  })

  const tree = await createTreeFromEntries(client, {
    org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: `${slug}/classroom.json`,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      },
    ],
  })

  const newCommit = await createCommit(client, {
    org,
    message: prefixCommit(`Update classroom ${slug}`),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
    classroom: slug,
  })

  const updatedRef = await updateRef(client, org, newCommit.sha, configBranch)

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    classroom: next,
  }
}
