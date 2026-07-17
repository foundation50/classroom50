import { describe, expect, it, vi } from "vitest"

import { migrateInstructorTeamToTeacher } from "./mutations"
import type { GitHubClient } from "./client"

// Drives migrateInstructorTeamToTeacher end to end over a fake config repo:
// the classroom.json contents read (requestRaw), team create/adopt, config-repo
// grant, member list + membership PUTs, the team-delete verify+DELETE, and the
// git-data commit sequence (ref -> commit -> blob -> tree -> commit -> patch).
function makeClient(opts: {
  classroomJson: Record<string, unknown>
  instructorMembers?: { login: string; id: number }[]
}) {
  const committed: { content: Record<string, unknown> | null } = {
    content: null,
  }
  const teamsCreated: string[] = []
  const membershipPUT: string[] = []
  const teamDeleted: string[] = []
  let blobContent = ""

  const requestRaw = vi.fn(async (path: string): Promise<string> => {
    if (path.includes("/contents/") && path.includes("classroom.json")) {
      // Reflect a committed patch on subsequent reads (the RMW re-read).
      return JSON.stringify(committed.content ?? opts.classroomJson)
    }
    throw new Error(`unexpected requestRaw: ${path}`)
  })

  const request = vi.fn(
    async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET"
      // Config-repo default branch.
      if (/\/repos\/[^/]+\/classroom50$/.test(path))
        return { default_branch: "main" }
      // Branch ref / commit for the RMW.
      if (path.includes("/git/ref/heads/"))
        return { object: { sha: "base-sha" } }
      if (path.includes("/git/commits/base-sha"))
        return { tree: { sha: "base-tree" } }
      // Create team (POST /orgs/o/teams) -> slug == name.
      if (method === "POST" && /\/orgs\/[^/]+\/teams$/.test(path)) {
        const name = (init?.body as { name?: string })?.name ?? "team"
        teamsCreated.push(name)
        return { id: teamsCreated.length + 300, slug: name }
      }
      // Repo-grant probe (no access) + PUT.
      if (
        path.includes("/repos/") &&
        path.includes("/orgs/") &&
        method === "GET"
      )
        throw notFound()
      if (
        path.includes("/repos/") &&
        path.includes("/orgs/") &&
        method === "PUT"
      )
        return undefined
      // Member list.
      if (path.includes("/members") && method === "GET")
        return opts.instructorMembers ?? []
      // Membership PUT (copy members).
      if (path.includes("/memberships/") && method === "PUT") {
        membershipPUT.push(path)
        return { state: "active" }
      }
      // Team-delete verify (live id) + DELETE.
      if (
        method === "GET" &&
        /\/orgs\/[^/]+\/teams\/[^/]+$/.test(path) &&
        path.endsWith("-instructor")
      )
        return { id: 2 }
      if (method === "DELETE" && /\/orgs\/[^/]+\/teams\//.test(path)) {
        teamDeleted.push(path)
        return undefined
      }
      // Git-data commit sequence.
      if (method === "POST" && path.endsWith("/git/blobs")) {
        blobContent = (init?.body as { content?: string })?.content ?? ""
        return { sha: "blob-sha" }
      }
      if (method === "POST" && path.endsWith("/git/trees"))
        return { sha: "tree-sha" }
      if (method === "POST" && path.endsWith("/git/commits"))
        return { sha: "new-commit" }
      if (method === "PATCH" && path.includes("/git/refs/heads/")) {
        // Reflect the committed classroom.json for the next read.
        if (blobContent) committed.content = JSON.parse(blobContent)
        return { object: { sha: "new-commit" } }
      }
      return undefined
    },
  )

  const client = { request, requestRaw } as unknown as GitHubClient
  return { client, committed, teamsCreated, membershipPUT, teamDeleted }
}

function notFound() {
  // Minimal shape GitHubAPIError-tolerant callers 404-branch on.
  return Object.assign(new Error("404"), {
    name: "GitHubAPIError",
    status: 404,
    isNotFound: true,
  })
}

const CLASSROOM_BASE = {
  schema: "classroom50/classroom/v1",
  name: "CS 101",
  short_name: "cs101",
  term: "2026",
  org: "o",
}

describe("migrateInstructorTeamToTeacher", () => {
  it("phase-create: legacy instructor team, no teacher -> creates teacher, copies members, records teams.teacher, does NOT delete", async () => {
    const { client, committed, teamsCreated, membershipPUT, teamDeleted } =
      makeClient({
        classroomJson: {
          ...CLASSROOM_BASE,
          teams: {
            instructor: { id: 2, slug: "classroom50-cs101-instructor" },
            ta: { id: 3, slug: "classroom50-cs101-ta" },
          },
        },
        instructorMembers: [
          { login: "alice", id: 1 },
          { login: "bob", id: 2 },
        ],
      })

    const result = await migrateInstructorTeamToTeacher(client, "o", "cs101")

    expect(result).toEqual({
      changed: true,
      phase: "create",
      teacherSlug: "classroom50-cs101-teacher",
    })
    expect(teamsCreated).toEqual(["classroom50-cs101-teacher"])
    for (const login of ["alice", "bob"]) {
      expect(
        membershipPUT.some((p) =>
          p.includes(`classroom50-cs101-teacher/memberships/${login}`),
        ),
      ).toBe(true)
    }
    // Two-phase safety: the instructor team is left intact on the create touch.
    expect(teamDeleted).toEqual([])
    // teams.teacher recorded; instructor ref preserved for the second touch.
    const teams = committed.content?.teams as Record<string, unknown>
    expect(teams.teacher).toEqual({
      id: 301,
      slug: "classroom50-cs101-teacher",
    })
    expect(teams.instructor).toBeTruthy()
  })

  it("phase-delete: both teams recorded -> deletes the legacy instructor team and drops its ref", async () => {
    const { client, committed, teamsCreated, teamDeleted } = makeClient({
      classroomJson: {
        ...CLASSROOM_BASE,
        teams: {
          teacher: { id: 9, slug: "classroom50-cs101-teacher" },
          instructor: { id: 2, slug: "classroom50-cs101-instructor" },
          ta: { id: 3, slug: "classroom50-cs101-ta" },
        },
      },
    })

    const result = await migrateInstructorTeamToTeacher(client, "o", "cs101")

    expect(result).toEqual({
      changed: true,
      phase: "delete",
      teacherSlug: "classroom50-cs101-teacher",
    })
    expect(teamsCreated).toEqual([])
    expect(
      teamDeleted.some((p) => p.endsWith("classroom50-cs101-instructor")),
    ).toBe(true)
    const teams = committed.content?.teams as Record<string, unknown>
    expect(teams.instructor).toBeUndefined()
    expect(teams.teacher).toBeTruthy()
  })

  it("phase-delete adopted-same-slug: teacher ref adopted the instructor team -> drops the ref WITHOUT deleting the live team", async () => {
    const { client, committed, teamsCreated, teamDeleted } = makeClient({
      classroomJson: {
        ...CLASSROOM_BASE,
        teams: {
          // teacher and instructor both point at the one adopted team.
          teacher: { id: 2, slug: "classroom50-cs101-instructor" },
          instructor: { id: 2, slug: "classroom50-cs101-instructor" },
          ta: { id: 3, slug: "classroom50-cs101-ta" },
        },
      },
    })

    const result = await migrateInstructorTeamToTeacher(client, "o", "cs101")

    expect(result).toEqual({
      changed: true,
      phase: "delete",
      teacherSlug: "classroom50-cs101-instructor",
    })
    expect(teamsCreated).toEqual([])
    // Deleting would remove the live teacher team — the shared-slug guard must skip it.
    expect(teamDeleted).toEqual([])
    const teams = committed.content?.teams as Record<string, unknown>
    expect(teams.instructor).toBeUndefined()
    expect(teams.teacher).toEqual({
      id: 2,
      slug: "classroom50-cs101-instructor",
    })
  })

  it("no-op: a fully-migrated classroom (teacher only) makes no change", async () => {
    const { client, teamsCreated, teamDeleted, membershipPUT } = makeClient({
      classroomJson: {
        ...CLASSROOM_BASE,
        teams: {
          teacher: { id: 9, slug: "classroom50-cs101-teacher" },
          ta: { id: 3, slug: "classroom50-cs101-ta" },
        },
      },
    })

    const result = await migrateInstructorTeamToTeacher(client, "o", "cs101")

    expect(result).toEqual({ changed: false })
    expect(teamsCreated).toEqual([])
    expect(teamDeleted).toEqual([])
    expect(membershipPUT).toEqual([])
  })

  it("no-op: a classroom with no teams block makes no change", async () => {
    const { client, teamsCreated, teamDeleted } = makeClient({
      classroomJson: { ...CLASSROOM_BASE },
    })

    const result = await migrateInstructorTeamToTeacher(client, "o", "cs101")

    expect(result).toEqual({ changed: false })
    expect(teamsCreated).toEqual([])
    expect(teamDeleted).toEqual([])
  })
})
