// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts down.
import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import {
  fetchAssignmentsForClassroom,
  getClassroom,
  GitHubClassroomAccessError,
  listClassroomsWithOrg,
  resolveSource,
} from "./classroomApi"

const emptyRateLimit = {
  limit: null,
  remaining: null,
  reset: null,
  used: null,
  resource: null,
  retryAfter: null,
}

const notFound = (url: string) =>
  new GitHubAPIError({
    status: 404,
    url,
    message: "Not Found",
    body: null,
    rateLimit: emptyRateLimit,
  })

function clientFrom(
  handler: (url: string) => unknown | Promise<unknown>,
): GitHubClient {
  const request = vi.fn(async (url: string) => handler(url))
  return { request } as unknown as GitHubClient
}

describe("getClassroom", () => {
  it("returns detail with the organization block", async () => {
    const client = clientFrom((url) => {
      if (url === "/classrooms/42")
        return {
          id: 42,
          name: "CS",
          archived: false,
          url: "u",
          organization: { id: 1, login: "acme" },
        }
      throw notFound(url)
    })
    const detail = await getClassroom(client, 42)
    expect(detail.organization.login).toBe("acme")
  })

  it("maps a 404 to an actionable access error", async () => {
    const client = clientFrom((url) => {
      throw notFound(url)
    })
    await expect(getClassroom(client, 7)).rejects.toBeInstanceOf(
      GitHubClassroomAccessError,
    )
  })
})

describe("getClassroomAssignment (deadline nullability)", () => {
  it("preserves a null deadline as null", async () => {
    const client = clientFrom((url) => {
      if (url === "/assignments/5")
        return {
          id: 5,
          public_repo: true,
          title: "HW",
          type: "individual",
          invite_link: "l",
          slug: "hw",
          deadline: null,
          max_teams: null,
          starter_code_repository: null,
        }
      throw notFound(url)
    })
    const [detail] = await fetchAssignmentsForClassroom(
      clientFrom((url) => {
        if (url.startsWith("/classrooms/9/assignments"))
          return [{ id: 5, title: "HW", slug: "hw", type: "individual" }]
        if (url === "/assignments/5")
          return {
            id: 5,
            public_repo: true,
            title: "HW",
            type: "individual",
            invite_link: "l",
            slug: "hw",
            deadline: null,
            max_teams: null,
            starter_code_repository: null,
          }
        throw notFound(url)
      }),
      9,
    )
    expect(detail.deadline).toBeNull()
    // keep the single-fetch client referenced
    void client
  })
})

describe("fetchAssignmentsForClassroom", () => {
  it("resolves each listed assignment's detail in order", async () => {
    const client = clientFrom((url) => {
      if (url.startsWith("/classrooms/1/assignments"))
        return [
          { id: 10, title: "A", slug: "a", type: "individual" },
          { id: 11, title: "B", slug: "b", type: "group" },
        ]
      if (url === "/assignments/10")
        return {
          id: 10,
          slug: "a",
          title: "A",
          type: "individual",
          deadline: null,
          max_teams: null,
          starter_code_repository: null,
          invite_link: "",
          public_repo: true,
        }
      if (url === "/assignments/11")
        return {
          id: 11,
          slug: "b",
          title: "B",
          type: "group",
          deadline: null,
          max_teams: 3,
          starter_code_repository: null,
          invite_link: "",
          public_repo: true,
        }
      throw notFound(url)
    })
    const details = await fetchAssignmentsForClassroom(client, 1)
    expect(details.map((d) => d.slug)).toEqual(["a", "b"])
  })
})

describe("resolveSource", () => {
  it("resolves a numeric id directly", async () => {
    const client = clientFrom((url) => {
      if (url === "/classrooms/99")
        return {
          id: 99,
          name: "N",
          archived: false,
          url: "u",
          organization: { id: 1, login: "acme" },
        }
      throw notFound(url)
    })
    const detail = await resolveSource(client, "99")
    expect(detail.id).toBe(99)
  })

  it("resolves a unique org-login match", async () => {
    const client = clientFrom((url) => {
      if (url.startsWith("/classrooms?"))
        return [{ id: 1, name: "One", archived: false, url: "u" }]
      if (url === "/classrooms/1")
        return {
          id: 1,
          name: "One",
          archived: false,
          url: "u",
          organization: { id: 1, login: "acme" },
        }
      throw notFound(url)
    })
    const detail = await resolveSource(client, "ACME")
    expect(detail.id).toBe(1)
  })

  it("errors with the candidate ids on multiple org matches", async () => {
    const client = clientFrom((url) => {
      if (url.startsWith("/classrooms?"))
        return [
          { id: 1, name: "One", archived: false, url: "u" },
          { id: 2, name: "Two", archived: false, url: "u" },
        ]
      if (url === "/classrooms/1")
        return {
          id: 1,
          name: "One",
          archived: false,
          url: "u",
          organization: { login: "acme" },
        }
      if (url === "/classrooms/2")
        return {
          id: 2,
          name: "Two",
          archived: false,
          url: "u",
          organization: { login: "acme" },
        }
      throw notFound(url)
    })
    await expect(resolveSource(client, "acme")).rejects.toThrow(
      /1 \(One\).*2 \(Two\)/s,
    )
  })

  it("errors when no classroom matches the org", async () => {
    const client = clientFrom((url) => {
      if (url.startsWith("/classrooms?"))
        return [{ id: 1, name: "One", archived: false, url: "u" }]
      if (url === "/classrooms/1")
        return {
          id: 1,
          name: "One",
          archived: false,
          url: "u",
          organization: { login: "other" },
        }
      throw notFound(url)
    })
    await expect(resolveSource(client, "acme")).rejects.toThrow(
      /No classroom found/,
    )
  })
})

describe("listClassroomsWithOrg", () => {
  it("drops archived rows by default and resolves the org login", async () => {
    const client = clientFrom((url) => {
      if (url.startsWith("/classrooms?"))
        return [
          { id: 1, name: "Live", archived: false, url: "u" },
          { id: 2, name: "Old", archived: true, url: "u" },
        ]
      if (url === "/classrooms/1")
        return {
          id: 1,
          name: "Live",
          archived: false,
          url: "u",
          organization: { login: "acme" },
        }
      throw notFound(url)
    })
    const rows = await listClassroomsWithOrg(client)
    expect(rows).toEqual([
      { id: 1, name: "Live", archived: false, url: "u", orgLogin: "acme" },
    ])
  })
})
