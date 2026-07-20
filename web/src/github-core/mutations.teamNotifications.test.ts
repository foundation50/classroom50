import { describe, expect, it, vi } from "vitest"

import { ensureClassroomTeam, ensureClassroomRoleTeam } from "./mutations"
import { GitHubAPIError } from "./errors"
import type { GitHubClient } from "./client"
import type { GitHubRequestOptions } from "./client"

// Pins the team-level notification policy (#335): student teams create with
// notifications_disabled (assignment-repo churn would spam the class), staff
// teams with notifications_enabled (so @mentions reach TAs/teachers). tsc keeps
// the arg well-typed but cannot catch a wrong literal — these do.

type Call = { path: string; options?: GitHubRequestOptions }

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "x",
    message: "err",
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

// A fake client recording every request. `adoptGet` (when set) is returned for
// the adopt GET and forces the POST to 422 so the adopt path runs.
function makeClient(adoptGet?: Record<string, unknown>) {
  const calls: Call[] = []
  const request = vi.fn(
    async (path: string, options?: GitHubRequestOptions): Promise<unknown> => {
      calls.push({ path, options })
      const method = options?.method ?? "GET"
      if (path.endsWith("/teams") && method === "POST") {
        if (adoptGet) throw apiError(422)
        return { id: 1, slug: "created" }
      }
      if (method === "GET") return adoptGet
      if (method === "PATCH") return undefined
      return undefined
    },
  )
  const client = { request } as unknown as GitHubClient
  const posts = () => calls.filter((c) => c.path.endsWith("/teams"))
  const patches = () => calls.filter((c) => c.options?.method === "PATCH")
  return { client, calls, posts, patches }
}

describe("ensureClassroomTeam / ensureClassroomRoleTeam create notification_setting", () => {
  it("creates the student team with notifications_disabled", async () => {
    const { client, posts } = makeClient()
    await ensureClassroomTeam(client, "o", "cs101")
    const body = posts()[0]?.options?.body as {
      notification_setting?: string
    }
    expect(body.notification_setting).toBe("notifications_disabled")
  })

  it("creates staff teams with notifications_enabled (teacher and ta)", async () => {
    for (const role of ["teacher", "ta"] as const) {
      const { client, posts } = makeClient()
      await ensureClassroomRoleTeam(client, "o", "cs101", role)
      const body = posts()[0]?.options?.body as {
        notification_setting?: string
      }
      expect(body.notification_setting).toBe("notifications_enabled")
    }
  })
})

describe("adoptSecretTeamByName notification_setting reconcile", () => {
  it("PATCHes notification_setting when the existing value drifts", async () => {
    const { client, patches } = makeClient({
      id: 7,
      slug: "classroom50-cs101-teacher",
      privacy: "secret",
      notification_setting: "notifications_disabled",
    })
    await ensureClassroomRoleTeam(client, "o", "cs101", "teacher")
    const body = patches()[0]?.options?.body as {
      notification_setting?: string
    }
    expect(patches()).toHaveLength(1)
    expect(body.notification_setting).toBe("notifications_enabled")
  })

  it("does not PATCH when notification_setting already matches", async () => {
    const { client, patches } = makeClient({
      id: 7,
      slug: "classroom50-cs101",
      privacy: "secret",
      notification_setting: "notifications_disabled",
    })
    await ensureClassroomTeam(client, "o", "cs101")
    expect(patches()).toHaveLength(0)
  })

  it("does not PATCH when GitHub omits notification_setting from the GET (unknown, not drifted)", async () => {
    // GitHub returns notification_setting only to org members; an absent value
    // must read as unknown, not as drift — otherwise every reconcile PATCHes.
    const { client, patches } = makeClient({
      id: 7,
      slug: "classroom50-cs101-teacher",
      privacy: "secret",
    })
    await ensureClassroomRoleTeam(client, "o", "cs101", "teacher")
    expect(patches()).toHaveLength(0)
  })
})
