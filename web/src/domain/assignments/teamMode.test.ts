import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"
import { editAssignment } from "./createEdit"
import { acceptAssignment } from "./accept"
import { assertAssignmentModeCoherent, founderPermission } from "./permissions"
import { groupTeamName } from "@/util/teamSlug"
import { groupRepoName } from "@/util/studentRepo"
import { marshalGroupDescription } from "@/util/groupTeam"
import { localizedMessageOf } from "@/types/localizedMessage"

const ORG = "cs50"
const CLASSROOM = "cs50"
const SLUG = "hw1"

// The accept flow reads the published manifest through
// fetchAssignmentFromPages; stub it so no network fetch runs. The hoisted box
// lets each test choose the entry the stub serves.
const mocked = vi.hoisted(() => ({ assignment: undefined as unknown }))
vi.mock("../queries/assignments", async (importOriginal) => {
  const mod = await importOriginal<object>()
  return {
    ...mod,
    fetchAssignmentFromPages: vi.fn(async () => mocked.assignment),
  }
})

function apiError(status: number, message: string): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "test",
    message,
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

describe("founderPermission (team mode)", () => {
  it("defaults to push", () => {
    expect(founderPermission("team")).toBe("push")
  })

  it("honors a below-admin student_permission", () => {
    expect(founderPermission("team", "maintain")).toBe("maintain")
    expect(founderPermission("team", "pull")).toBe("pull")
  })

  it("clamps admin DOWN to the push default (access flows through the team)", () => {
    expect(founderPermission("team", "admin")).toBe("push")
  })
})

describe("assertAssignmentModeCoherent (team mode)", () => {
  it("accepts a group-shaped team entry", () => {
    expect(() => assertAssignmentModeCoherent(SLUG, "team", 3)).not.toThrow()
  })

  it("still rejects a group-shaped individual entry", () => {
    expect(() => assertAssignmentModeCoherent(SLUG, "individual", 3)).toThrow()
  })
})

describe("buildAssignmentEntry team mode (via editAssignment round trip)", () => {
  const existingEntry: Assignment = {
    slug: SLUG,
    name: "Homework 1",
    mode: "team",
    autograder: "default",
    feedback_pr: true,
    max_group_size: 3,
    team_formation: "teacher",
  }

  // Route-table client covering exactly the endpoints editAssignment hits on
  // the template-less path — mirrors the makeClient in assignments.test.ts.
  function makeClient(entry: Assignment = existingEntry): {
    client: GitHubClient
    committedContent: () => string
  } {
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [entry],
    }
    const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")
    let committedContent = ""

    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      if (method === "GET" && url.includes("/git/ref/heads/main")) {
        return { object: { sha: "refsha" } }
      }
      if (method === "GET" && url.includes("/git/commits/refsha")) {
        return { tree: { sha: "basetree" } }
      }
      if (
        method === "GET" &&
        url.includes(`/contents/${CLASSROOM}/assignments.json`)
      ) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(JSON.stringify(assignmentsFile)),
        }
      }
      if (method === "POST" && url.endsWith("/git/trees")) {
        const body = (init as { body?: { tree: { content: string }[] } }).body
        committedContent = body!.tree[0].content
        return { sha: "newtree" }
      }
      if (method === "POST" && url.endsWith("/git/commits")) {
        return { sha: "newcommit" }
      }
      if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
        return { object: { sha: "newcommit" } }
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    // classroom.json read (archive guard): 404 -> treated as active.
    const requestRaw = vi.fn(async () => {
      throw apiError(404, "Not Found")
    })

    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      committedContent: () => committedContent,
    }
  }

  function editInput(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      name: "Homework 1",
      description: "",
      template_repo: "",
      due_date: "",
      mode: "team",
      max_group_size: 3,
      team_formation: "teacher",
      release_assets: "",
      tests: [],
      ...overrides,
    } as unknown as Parameters<typeof editAssignment>[1]
  }

  function writtenEntry(content: string): Assignment {
    const written = JSON.parse(content) as { assignments: Assignment[] }
    return written.assignments.find((a) => a.slug === SLUG)!
  }

  it("writes mode, max_group_size, and team_formation", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(client, editInput({ team_formation: "student" }))
    const entry = writtenEntry(committedContent())
    expect(entry.mode).toBe("team")
    expect(entry.max_group_size).toBe(3)
    expect(entry.team_formation).toBe("student")
  })

  it("rejects a team entry without a formation", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(client, editInput({ team_formation: undefined })),
    ).rejects.toThrow(/team_formation/)
  })

  it("rejects an off-enum formation", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(client, editInput({ team_formation: "anarchy" })),
    ).rejects.toThrow(/team_formation/)
  })

  it("enforces the group-size bounds for team mode", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(client, editInput({ max_group_size: 1 })),
    ).rejects.toThrow(/max_group_size/)
  })

  it("clamps student_permission admin down to the (omitted) push default", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(client, editInput({ student_permission: "admin" }))
    // Admin must never land on a team entry; the clamp resolves to push, the
    // team default, which is omitted on the wire.
    expect(writtenEntry(committedContent()).student_permission).toBeUndefined()
  })

  it("writes a non-admin, non-default student_permission verbatim", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(client, editInput({ student_permission: "maintain" }))
    expect(writtenEntry(committedContent()).student_permission).toBe("maintain")
  })

  it("omits team_formation for a non-team mode", async () => {
    const individual: Assignment = {
      slug: SLUG,
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      feedback_pr: true,
    }
    const { client, committedContent } = makeClient(individual)
    await editAssignment(
      client,
      editInput({ mode: "individual", max_group_size: 0 }),
    )
    expect("team_formation" in writtenEntry(committedContent())).toBe(false)
  })
})

describe("acceptAssignment team mode", () => {
  const ASSIGNMENT_ENTRY: Assignment = {
    slug: SLUG,
    name: "Homework 1",
    mode: "team",
    autograder: "default",
    feedback_pr: false,
    max_group_size: 3,
    team_formation: "teacher",
  }

  // The accept flow reads the mocked manifest (see the vi.mock at module top).

  // Route-table client for the team accept path: identity + membership, the
  // viewer's teams, the config-repo branch read, the (already existing) repo
  // create 422, the provisioning probes, and the access writes.
  function makeClient(opts: { myTeams: unknown[]; repoExists: boolean }) {
    const repoName = groupRepoName(CLASSROOM, SLUG, 2)
    const requests: string[] = []
    const request = vi.fn(
      async (
        url: string,
        init?: { method?: string; body?: Record<string, unknown> },
      ) => {
        const method = init?.method ?? "GET"
        requests.push(`${method} ${url}`)
        if (method === "GET" && url === "/user") {
          return { login: "alice", id: 7 }
        }
        if (url === `/user/memberships/orgs/${ORG}`) {
          // PATCH (accept invite) and GET (verify) share the shape. role
          // admin = org owner, which bypasses the enrollment team probes.
          return { state: "active", role: "admin" }
        }
        if (method === "GET" && url.startsWith("/user/teams")) {
          return opts.myTeams
        }
        if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
          return { default_branch: "main" }
        }
        if (method === "POST" && url === `/orgs/${ORG}/repos`) {
          if (opts.repoExists) {
            throw apiError(422, "name already exists on this account")
          }
          throw new Error("unexpected fresh create in this test")
        }
        if (method === "GET" && url === `/repos/${ORG}/${repoName}`) {
          return {
            name: repoName,
            full_name: `${ORG}/${repoName}`,
            default_branch: "main",
            html_url: `https://github.com/${ORG}/${repoName}`,
            ssh_url: `git@github.com:${ORG}/${repoName}.git`,
          }
        }
        if (
          method === "GET" &&
          url.includes(`/repos/${ORG}/${repoName}/contents/`)
        ) {
          // Marker + workflow both present: the healthy already-accepted path.
          return { type: "file" }
        }
        if (method === "PUT" && url.includes("/teams/")) {
          return undefined
        }
        if (method === "PUT" && url.includes("/collaborators/")) {
          return undefined
        }
        throw new Error(`unexpected request: ${method} ${url}`)
      },
    )
    return { client: { request } as unknown as GitHubClient, requests }
  }

  it("short-circuits to already-accepted on the team's existing repo (no second repo)", async () => {
    mocked.assignment = ASSIGNMENT_ENTRY
    const slug = await groupTeamName(CLASSROOM, SLUG, 2)
    const myTeam = {
      slug,
      id: 42,
      description: marshalGroupDescription({
        classroom: CLASSROOM,
        assignment: SLUG,
      }),
      organization: { login: ORG, id: 1 },
    }
    const { client, requests } = makeClient({
      myTeams: [myTeam],
      repoExists: true,
    })

    const result = await acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
    })

    expect(result.status).toBe("already-accepted")
    expect(result.repo.name).toBe(groupRepoName(CLASSROOM, SLUG, 2))
    // Exactly one repo create attempt (the 422 probe) — never a second repo.
    expect(
      requests.filter((r) => r === `POST /orgs/${ORG}/repos`),
    ).toHaveLength(1)
    // The team attachment (authoritative link) was re-asserted, and the
    // founder grant carries the team default push, never admin.
    expect(
      requests.some((r) =>
        r.startsWith(
          `PUT /orgs/${ORG}/teams/${slug}/repos/${ORG}/${result.repo.name}`,
        ),
      ),
    ).toBe(true)
  })

  it("blocks a student on no team (teacher formation) with the teacher-assigns message", async () => {
    mocked.assignment = { ...ASSIGNMENT_ENTRY, team_formation: "teacher" }
    const { client } = makeClient({ myTeams: [], repoExists: true })
    await expect(
      acceptAssignment({
        client,
        org: ORG,
        classroom: CLASSROOM,
        assignmentSlug: SLUG,
      }),
    ).rejects.toSatisfy(
      (err) =>
        localizedMessageOf(err)?.key === "accept.errors.teamTeacherAssigns",
    )
  })

  it("blocks a student on no team (student formation) with the create-a-group message", async () => {
    mocked.assignment = { ...ASSIGNMENT_ENTRY, team_formation: "student" }
    const { client } = makeClient({ myTeams: [], repoExists: true })
    await expect(
      acceptAssignment({
        client,
        org: ORG,
        classroom: CLASSROOM,
        assignmentSlug: SLUG,
      }),
    ).rejects.toSatisfy(
      (err) => localizedMessageOf(err)?.key === "accept.errors.teamRequired",
    )
  })
})
