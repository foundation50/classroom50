// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Read-only GitHub Classroom REST reads
// via the standard GitHubClient (same bearer token as every other call — no
// worker proxy, no new OAuth scope). Mirrors the CLI's migrate_source.go.

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { paginateAll } from "@/github-core/paginate"
import type {
  ClassroomAssignmentDetail,
  ClassroomAssignmentListItem,
  ClassroomDetail,
  ClassroomListItem,
  ClassroomWithOrg,
} from "./types"

// digits-only --source is a classroom id; anything else is an org login.
const ALL_DIGITS = /^\d+$/

// `GET /classrooms` — every classroom the token can administer.
export function listClassrooms(
  client: GitHubClient,
): Promise<ClassroomListItem[]> {
  return paginateAll<ClassroomListItem>(
    client,
    (page) => `/classrooms?per_page=100&page=${page}`,
  )
}

// `GET /classrooms/{id}` — detail including the `organization` block. A 404
// means the token can't administer that classroom.
export async function getClassroom(
  client: GitHubClient,
  id: number,
): Promise<ClassroomDetail> {
  try {
    return await client.request<ClassroomDetail>(`/classrooms/${id}`)
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      throw new GitHubClassroomAccessError(id)
    }
    throw err
  }
}

// `GET /classrooms/{id}/assignments` — assignment listing (no starter repo).
export function listClassroomAssignments(
  client: GitHubClient,
  classroomId: number,
): Promise<ClassroomAssignmentListItem[]> {
  return paginateAll<ClassroomAssignmentListItem>(
    client,
    (page) => `/classrooms/${classroomId}/assignments?per_page=100&page=${page}`,
  )
}

// `GET /assignments/{id}` — assignment detail incl. starter_code_repository.
export async function getClassroomAssignment(
  client: GitHubClient,
  assignmentId: number,
): Promise<ClassroomAssignmentDetail> {
  try {
    return await client.request<ClassroomAssignmentDetail>(
      `/assignments/${assignmentId}`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      throw new Error(
        `Assignment ${assignmentId} is not accessible — you must administer its GitHub Classroom.`,
      )
    }
    throw err
  }
}

// List the classrooms the viewer can administer, each resolved to its org login
// (needs a per-row detail fetch since the listing omits `organization`).
// Archived rows are dropped unless includeArchived. A per-row access loss is
// skipped rather than failing the whole list.
export async function listClassroomsWithOrg(
  client: GitHubClient,
  options: { includeArchived?: boolean } = {},
): Promise<ClassroomWithOrg[]> {
  const listing = await listClassrooms(client)
  const out: ClassroomWithOrg[] = []
  for (const row of listing) {
    if (row.archived && !options.includeArchived) continue
    try {
      const detail = await getClassroom(client, row.id)
      out.push({ ...row, orgLogin: detail.organization.login })
    } catch {
      // Stale listing row or mid-loop access loss: skip, don't fail the list.
    }
  }
  return out
}

// Fetch every assignment's detail for a classroom, in listing order (so output
// is deterministic).
export async function fetchAssignmentsForClassroom(
  client: GitHubClient,
  classroomId: number,
): Promise<ClassroomAssignmentDetail[]> {
  const listing = await listClassroomAssignments(client, classroomId)
  const out: ClassroomAssignmentDetail[] = []
  for (const row of listing) {
    out.push(await getClassroomAssignment(client, row.id))
  }
  return out
}

// Resolve a --source value (numeric id or org login) to a single classroom.
// Digits -> direct lookup. Org login -> list + filter by organization.login
// (case-insensitive); zero or multiple matches is an actionable error.
export async function resolveSource(
  client: GitHubClient,
  source: string,
  options: { includeArchived?: boolean } = {},
): Promise<ClassroomDetail> {
  const trimmed = source.trim()
  if (!trimmed) {
    throw new Error(
      "Source must not be empty — pass a numeric classroom id or an org login.",
    )
  }

  if (ALL_DIGITS.test(trimmed)) {
    return getClassroom(client, Number(trimmed))
  }

  const listing = await listClassrooms(client)
  if (listing.length === 0) {
    throw new Error(
      "No classrooms are accessible to your account — confirm you administer a GitHub Classroom.",
    )
  }

  const want = trimmed.toLowerCase()
  const matches: ClassroomDetail[] = []
  for (const row of listing) {
    if (row.archived && !options.includeArchived) continue
    try {
      const detail = await getClassroom(client, row.id)
      if (detail.organization.login.toLowerCase() === want) {
        matches.push(detail)
      }
    } catch {
      // Skip a row we lost access to mid-resolution.
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `No classroom found in org "${trimmed}"${
        options.includeArchived ? "" : " (archived classrooms are hidden)"
      } — confirm you administer one there.`,
    )
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => `${m.id} (${m.name})`).join(", ")
    throw new Error(
      `Multiple classrooms found in org "${trimmed}" — pick one by id: ${ids}.`,
    )
  }
  return matches[0]
}

// A source classroom the viewer cannot administer (GitHub Classroom 404).
export class GitHubClassroomAccessError extends Error {
  classroomId: number
  constructor(classroomId: number) {
    super(
      `Classroom ${classroomId} is not accessible to your account — you must be a GitHub Classroom admin for it.`,
    )
    this.name = "GitHubClassroomAccessError"
    this.classroomId = classroomId
  }
}
