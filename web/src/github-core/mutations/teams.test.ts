// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import {
  grantTeamConfigRepoAccess,
  grantStaffTeamsConfigRepoAccess,
} from "./teams"
import type { GitHubClient } from "@/github-core/client"

// grantTeamConfigRepoAccess routes each staff role to its config-repo
// permission (teacher/hta write, ta read) via an unconditional PUT — so a TA
// team that currently holds `push` is downgraded to `pull` on re-affirm (the
// TA read-only demotion, R3). A role with no config-repo permission is a no-op.
describe("grantTeamConfigRepoAccess", () => {
  const makeClient = () => {
    const request = vi.fn().mockResolvedValue({})
    return { client: { request } as unknown as GitHubClient, request }
  }

  it("grants push for teacher and hta", async () => {
    for (const role of ["teacher", "hta"] as const) {
      const { client, request } = makeClient()
      await grantTeamConfigRepoAccess(client, "acme", `slug-${role}`, role)
      expect(request).toHaveBeenCalledTimes(1)
      const [, options] = request.mock.calls[0]
      expect(options).toMatchObject({
        method: "PUT",
        body: { permission: "push" },
      })
    }
  })

  it("grants pull (read-only) for ta — the demotion", async () => {
    const { client, request } = makeClient()
    await grantTeamConfigRepoAccess(client, "acme", "slug-ta", "ta")
    expect(request).toHaveBeenCalledTimes(1)
    const [, options] = request.mock.calls[0]
    expect(options).toMatchObject({
      method: "PUT",
      body: { permission: "pull" },
    })
  })

  it("is a no-op for a role with no config-repo permission", async () => {
    const { client, request } = makeClient()
    // A student is not a staff role, so use a cast to
    // exercise the guard for an unmapped value.
    await grantTeamConfigRepoAccess(
      client,
      "acme",
      "slug-student",
      "student" as never,
    )
    expect(request).not.toHaveBeenCalled()
  })
})

// grantStaffTeamsConfigRepoAccess grants each recorded staff team its role's
// config-repo permission (teacher/hta push, ta pull). Split from
// ensureStaffTeams so callers sequence it AFTER the creator drop (granting a
// team repo access before removing a member emails that member). Skips absent
// slugs. The web grantTeamConfigRepoAccess PUTs unconditionally.
describe("grantStaffTeamsConfigRepoAccess", () => {
  it("PUTs each role's permission for every recorded staff team", async () => {
    const request = vi.fn().mockResolvedValue({})
    const client = { request } as unknown as GitHubClient
    await grantStaffTeamsConfigRepoAccess(client, "acme", {
      teacher: { id: 1, slug: "classroom50-cs101-teacher" },
      hta: { id: 2, slug: "classroom50-cs101-hta" },
      ta: { id: 3, slug: "classroom50-cs101-ta" },
    })
    // teacher -> push, hta -> push, ta -> pull; one PUT each.
    expect(request).toHaveBeenCalledTimes(3)
    const bodies = request.mock.calls.map(
      ([, o]) => (o as { body?: unknown }).body,
    )
    expect(bodies).toEqual([
      { permission: "push" },
      { permission: "push" },
      { permission: "pull" },
    ])
  })

  it("skips a role whose team ref is absent", async () => {
    const request = vi.fn().mockResolvedValue({})
    const client = { request } as unknown as GitHubClient
    await grantStaffTeamsConfigRepoAccess(client, "acme", {
      teacher: { id: 1, slug: "classroom50-cs101-teacher" },
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0] as string).toContain(
      "classroom50-cs101-teacher",
    )
  })
})
