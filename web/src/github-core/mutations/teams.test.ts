// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { grantTeamConfigRepoAccess } from "./teams"
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
    // A student is not a staff role; instructor maps to push, so use a cast to
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
