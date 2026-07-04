import { describe, expect, it, vi } from "vitest"
import {
  acceptAndVerifyOrgMembership,
  acceptPendingOrgInvite,
  acceptPendingOrgInviteOrThrow,
  NotActiveMemberError,
} from "./users"
import { GitHubAPIError } from "@/hooks/github/errors"
import type { GitHubClient } from "@/hooks/github/client"

// acceptAndVerifyOrgMembership is the single verified-accept path: PATCH the
// membership to "active", re-read it, and assert active. These tests pin the
// risk-bearing branches — the happy accept+verify, the eventual-consistency lag
// (PATCH ok but re-read still "pending" -> NotActiveMemberError), and a PATCH
// failure (SSO 403) propagating the raw GitHubAPIError — plus the best-effort
// wrapper's never-throws contract that both onboarding and ClassesPage rely on.

const ssoError = () =>
  new GitHubAPIError({
    status: 403,
    url: "/user/memberships/orgs/acme",
    message: "sso",
    body: { message: "sso" },
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
    ssoHeader:
      "required; url=https://github.com/orgs/acme/sso?authorization_request=x",
  })

// A path-routing fake client. `patch` controls the PATCH result (resolve or
// throw); `read` controls the GET re-read membership state.
const makeClient = (opts: { patch?: () => unknown; read?: () => unknown }) => {
  const request = vi
    .fn()
    .mockImplementation((path: string, options?: { method?: string }) => {
      const method = options?.method ?? "GET"
      if (path === "/user/memberships/orgs/acme" && method === "PATCH") {
        return Promise.resolve(opts.patch ? opts.patch() : { state: "active" })
      }
      if (path === "/user/memberships/orgs/acme" && method === "GET") {
        return Promise.resolve(
          opts.read ? opts.read() : { state: "active", role: "member" },
        )
      }
      throw new Error(`unexpected request: ${method} ${path}`)
    })
  return { request } as unknown as GitHubClient
}

describe("acceptAndVerifyOrgMembership", () => {
  it("returns the active membership when PATCH succeeds and the re-read is active", async () => {
    const client = makeClient({
      read: () => ({ state: "active", role: "member" }),
    })
    const membership = await acceptAndVerifyOrgMembership(client, "acme")
    expect(membership.state).toBe("active")
  })

  it("throws NotActiveMemberError when the re-read is still pending (GitHub lag)", async () => {
    const client = makeClient({
      read: () => ({ state: "pending", role: "member" }),
    })
    await expect(
      acceptAndVerifyOrgMembership(client, "acme"),
    ).rejects.toBeInstanceOf(NotActiveMemberError)
  })

  it("carries the observed state on NotActiveMemberError so the UI can explain the lag", async () => {
    const client = makeClient({
      read: () => ({ state: "pending", role: "member" }),
    })
    await expect(
      acceptAndVerifyOrgMembership(client, "acme"),
    ).rejects.toMatchObject({ org: "acme", state: "pending" })
  })

  it("propagates the raw GitHubAPIError when the PATCH is SSO-gated (403)", async () => {
    const err = ssoError()
    const client = makeClient({
      patch: () => {
        throw err
      },
    })
    await expect(acceptAndVerifyOrgMembership(client, "acme")).rejects.toBe(err)
  })
})

describe("acceptPendingOrgInvite (best-effort wrapper)", () => {
  it("returns {ok:true} when the PATCH succeeds", async () => {
    const client = makeClient({})
    await expect(acceptPendingOrgInvite(client, "acme")).resolves.toEqual({
      ok: true,
    })
  })

  it("swallows a PATCH failure and returns {ok:false} (never throws)", async () => {
    const client = makeClient({
      patch: () => {
        throw ssoError()
      },
    })
    await expect(acceptPendingOrgInvite(client, "acme")).resolves.toEqual({
      ok: false,
    })
  })
})

describe("acceptPendingOrgInviteOrThrow", () => {
  it("throws the raw error (unlike the best-effort wrapper)", async () => {
    const err = ssoError()
    const client = makeClient({
      patch: () => {
        throw err
      },
    })
    await expect(acceptPendingOrgInviteOrThrow(client, "acme")).rejects.toBe(
      err,
    )
  })
})
