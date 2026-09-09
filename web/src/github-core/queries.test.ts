import { describe, expect, it, vi } from "vitest"
import {
  pagesAssignmentUrl,
  classroomsIndexUrl,
  configCommitsQuery,
  csvFileQuery,
  getClassroom50OrgSummary,
  getOrgFailedInvitations,
  listAllOrgMembers,
  listOrgAdmins,
  listOrgTeams,
  listRepoTeams,
  listTeamInvitations,
  releasesQuery,
  verifyClassroom50ConfigRepo,
} from "./queries"
import { GitHubAPIError } from "./errors"
import type { GitHubClient } from "./client"
import type { GitHubOrgMembership, GitHubUser, GitHubRelease } from "./types"
import { CONFIG_REPO_MARKER_REL, ORG_GITHUB_DIR } from "@/skeleton/skeleton"

describe("pagesAssignmentUrl", () => {
  it("builds the plain classroom path when no secret is set", () => {
    expect(pagesAssignmentUrl("acme", "cs50")).toBe(
      "https://acme.github.io/classroom50/cs50/assignments.json",
    )
  })

  it("treats an empty/undefined secret as the plain path", () => {
    expect(pagesAssignmentUrl("acme", "cs50", "")).toBe(
      "https://acme.github.io/classroom50/cs50/assignments.json",
    )
    expect(pagesAssignmentUrl("acme", "cs50", undefined)).toBe(
      "https://acme.github.io/classroom50/cs50/assignments.json",
    )
  })

  it("inserts the capability-URL secret segment when present", () => {
    expect(pagesAssignmentUrl("acme", "cs50", "a1b2c3d4")).toBe(
      "https://acme.github.io/classroom50/cs50/a1b2c3d4/assignments.json",
    )
  })
})

describe("classroomsIndexUrl", () => {
  it("never carries a classroom or secret segment (public index)", () => {
    expect(classroomsIndexUrl("acme")).toBe(
      "https://acme.github.io/classroom50/classrooms-index.json",
    )
  })
})

describe("listAllOrgMembers (#76 — pages to completion)", () => {
  const member = (id: number): GitHubUser =>
    ({ id, login: `u${id}` }) as GitHubUser

  const makeClient = (pages: GitHubUser[][]) => {
    const requested: string[] = []
    const request = vi.fn().mockImplementation((path: string) => {
      requested.push(path)
      const match = path.match(/[?&]page=(\d+)/)
      const page = match ? Number(match[1]) : 1
      return Promise.resolve(pages[page - 1] ?? [])
    })
    const client = { request } as unknown as GitHubClient
    return { client, requested }
  }

  it("returns a single short page in one request", async () => {
    const { client, requested } = makeClient([[member(1), member(2)]])
    const all = await listAllOrgMembers(client, "acme")
    expect(all.map((m) => m.id)).toEqual([1, 2])
    expect(requested).toHaveLength(1)
  })

  it("pages until a short page, concatenating results", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => member(i + 1))
    const shortPage = [member(101)]
    const { client, requested } = makeClient([fullPage, shortPage])
    const all = await listAllOrgMembers(client, "acme")
    expect(all).toHaveLength(101)
    expect(requested).toHaveLength(2)
  })

  it("returns an empty array for an empty org in one request", async () => {
    const { client, requested } = makeClient([[]])
    const all = await listAllOrgMembers(client, "acme")
    expect(all).toEqual([])
    expect(requested).toHaveLength(1)
  })

  it("stops at the page cap if a server keeps returning full pages", async () => {
    // A misbehaving server that ignores `page` and always returns 100 items
    // must not loop unbounded; paginateAll caps at 100 pages.
    const request = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 100 }, (_, i) => member(i + 1)))
    const client = { request } as unknown as GitHubClient
    const all = await listAllOrgMembers(client, "acme")
    expect(request).toHaveBeenCalledTimes(100)
    expect(all).toHaveLength(100 * 100)
  })
})

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
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

describe("listOrgAdmins (role=admin fallback)", () => {
  const rejectingClient = (status: number) =>
    ({
      request: vi.fn().mockRejectedValue(apiError(status)),
    }) as unknown as GitHubClient

  it("returns [] on 403 (can't read the role-filtered member list)", async () => {
    await expect(listOrgAdmins(rejectingClient(403), "acme")).resolves.toEqual(
      [],
    )
  })

  it("returns [] on 404", async () => {
    await expect(listOrgAdmins(rejectingClient(404), "acme")).resolves.toEqual(
      [],
    )
  })

  it("rethrows a non-403/404 error (e.g., 500) rather than degrading silently", async () => {
    await expect(listOrgAdmins(rejectingClient(500), "acme")).rejects.toThrow(
      GitHubAPIError,
    )
  })

  it("returns the admins on success", async () => {
    const client = {
      request: vi.fn().mockResolvedValue([{ id: 1, login: "owner" }]),
    } as unknown as GitHubClient
    const admins = await listOrgAdmins(client, "acme")
    expect(admins.map((m) => m.login)).toEqual(["owner"])
  })
})

describe("listOrgTeams (org teams fallback)", () => {
  const rejectingClient = (status: number) =>
    ({
      request: vi.fn().mockRejectedValue(apiError(status)),
    }) as unknown as GitHubClient

  it("returns [] on 404 (no access — degrades to CSV-only display)", async () => {
    await expect(listOrgTeams(rejectingClient(404), "acme")).resolves.toEqual(
      [],
    )
  })

  it("rethrows a non-404 error (e.g., 403/500) rather than degrading silently", async () => {
    await expect(listOrgTeams(rejectingClient(403), "acme")).rejects.toThrow(
      GitHubAPIError,
    )
    await expect(listOrgTeams(rejectingClient(500), "acme")).rejects.toThrow(
      GitHubAPIError,
    )
  })

  it("returns the teams on success", async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValue([{ id: 7, slug: "classroom50-cs101" }]),
    } as unknown as GitHubClient
    const teams = await listOrgTeams(client, "acme")
    expect(teams.map((tm) => tm.slug)).toEqual(["classroom50-cs101"])
  })
})

describe("listRepoTeams (repo teams, 404 -> [])", () => {
  it("returns [] on 404 (repo gone/invisible — degrades to 'no teams listed')", async () => {
    const client = {
      request: vi.fn().mockRejectedValue(apiError(404)),
    } as unknown as GitHubClient
    await expect(listRepoTeams(client, "acme", "tmpl")).resolves.toEqual([])
  })

  it("rethrows a non-404 error rather than degrading silently", async () => {
    const client = {
      request: vi.fn().mockRejectedValue(apiError(500)),
    } as unknown as GitHubClient
    await expect(listRepoTeams(client, "acme", "tmpl")).rejects.toThrow(
      GitHubAPIError,
    )
  })

  it("returns the repo's teams with their permission on success", async () => {
    const client = {
      request: vi.fn().mockResolvedValue([
        { id: 7, slug: "classroom50-cs101", permission: "pull" },
        { id: 9, slug: "classroom50-cs101-ta", permission: "pull" },
      ]),
    } as unknown as GitHubClient
    const teams = await listRepoTeams(client, "acme", "tmpl")
    expect(teams.map((tm) => tm.slug)).toEqual([
      "classroom50-cs101",
      "classroom50-cs101-ta",
    ])
  })
})

describe("listTeamInvitations (team-scoped pending, role attribution)", () => {
  const apiError = (status: number) =>
    new GitHubAPIError({
      status,
      url: "https://api.github.com/orgs/acme/teams/classroom50-cs101-ta/invitations",
      message: status === 404 ? "Not Found" : `boom ${status}`,
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

  const rejectingClient = (status: number) =>
    ({
      request: vi.fn().mockRejectedValue(apiError(status)),
    }) as unknown as GitHubClient

  it("returns [] on 404 (team not created yet)", async () => {
    await expect(
      listTeamInvitations(rejectingClient(404), "acme", "classroom50-cs101-ta"),
    ).resolves.toEqual([])
  })

  it("rethrows 403 (owner-only) so callers can hide pending", async () => {
    await expect(
      listTeamInvitations(rejectingClient(403), "acme", "classroom50-cs101-ta"),
    ).rejects.toThrow(GitHubAPIError)
  })

  it("paginates and preserves an email-only invite (login null)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      login: `u${i + 1}`,
      email: null,
      role: "direct_member",
    }))
    const page2 = [
      { id: 101, login: null, email: "invitee@x.edu", role: "direct_member" },
    ]
    const request = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
    const client = { request } as unknown as GitHubClient
    const invites = await listTeamInvitations(
      client,
      "acme",
      "classroom50-cs101-ta",
    )
    expect(invites).toHaveLength(101)
    expect(invites[100]).toMatchObject({ login: null, email: "invitee@x.edu" })
  })
})

describe("getOrgFailedInvitations (org-wide; attribution happens in the roster)", () => {
  // A failed invite's invitation_teams_url 404s on GitHub (verified live), so
  // the read must NOT try to resolve teams: one paginated list, nothing else.
  it("pages the org-wide failed list and never fetches per-invite teams", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      login: null,
      email: `s${i}@x.edu`,
      role: "direct_member",
      failed_at: "2026-09-07T00:41:28Z",
      failed_reason:
        "Invitation expired. User did not accept this invite for 7 days",
      team_count: 1,
      invitation_teams_url: `https://api.github.com/invites/${i + 1}/teams`,
    }))
    const page2 = [{ ...page1[0]!, id: 101, email: "last@x.edu" }]
    const request = vi.fn((url: string) => {
      if (url === "/orgs/acme/failed_invitations?per_page=100&page=1")
        return Promise.resolve(page1)
      if (url === "/orgs/acme/failed_invitations?per_page=100&page=2")
        return Promise.resolve(page2)
      return Promise.reject(new Error(`unexpected request ${url}`))
    })
    const client = { request } as unknown as GitHubClient

    const result = await getOrgFailedInvitations(client, "acme")

    expect(result).toHaveLength(101)
    expect(result[100]).toMatchObject({ id: 101, email: "last@x.edu" })
    expect(
      request.mock.calls.some(([url]) => String(url).includes("/teams")),
    ).toBe(false)
  })
})

describe("releasesQuery", () => {
  const apiError = (status: number) =>
    new GitHubAPIError({
      status,
      url: "https://api.github.com/repos/acme/cs50-a1-bob/releases",
      message: status === 404 ? "Not Found" : `boom ${status}`,
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

  const run = (client: GitHubClient) =>
    // The query is enabled only with owner+repo; invoke the queryFn directly.
    (
      releasesQuery(client, "acme", "cs50-a1-bob").queryFn as (ctx: {
        signal?: AbortSignal
      }) => Promise<GitHubRelease[]>
    )({})

  it("returns [] when the repo is missing (404) — no submission, not an error", async () => {
    const request = vi.fn().mockRejectedValue(apiError(404))
    const releases = await run({ request } as unknown as GitHubClient)
    expect(releases).toEqual([])
  })

  it("rethrows a non-404 (e.g., 403/5xx) so it surfaces as an error", async () => {
    const request = vi.fn().mockRejectedValue(apiError(403))
    await expect(run({ request } as unknown as GitHubClient)).rejects.toThrow()
  })

  it("keeps only submit/* tags, newest first", async () => {
    const rel = (tag: string, when: string): GitHubRelease =>
      ({
        id: tag.length,
        tag_name: tag,
        name: tag,
        published_at: when,
        created_at: when,
      }) as GitHubRelease
    const request = vi.fn().mockResolvedValue([
      rel("submit/1", "2026-01-01T00:00:00Z"),
      rel("v1.0", "2026-02-01T00:00:00Z"), // non-submission tag, filtered out
      rel("submit/2", "2026-03-01T00:00:00Z"),
    ])
    const releases = await run({ request } as unknown as GitHubClient)
    expect(releases.map((r) => r.tag_name)).toEqual(["submit/2", "submit/1"])
  })
})

describe("configCommitsQuery", () => {
  const apiError = (status: number) =>
    new GitHubAPIError({
      status,
      url: "https://api.github.com/repos/acme/classroom50/commits",
      message: status === 404 ? "Not Found" : `boom ${status}`,
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

  const run = (client: GitHubClient, perPage = 30) =>
    (
      configCommitsQuery(client, "acme", perPage).queryFn as (ctx: {
        signal?: AbortSignal
      }) => Promise<unknown>
    )({})

  it("returns [] when the config repo is missing (404) — uninitialized org", async () => {
    const request = vi.fn().mockRejectedValue(apiError(404))
    await expect(run({ request } as unknown as GitHubClient)).resolves.toEqual(
      [],
    )
  })

  it("rethrows a non-404 so it surfaces as an error", async () => {
    const request = vi.fn().mockRejectedValue(apiError(403))
    await expect(run({ request } as unknown as GitHubClient)).rejects.toThrow()
  })

  it("requests the commits endpoint with the perPage window", async () => {
    const request = vi.fn().mockResolvedValue([])
    await run({ request } as unknown as GitHubClient, 60)
    expect(request).toHaveBeenCalledWith(
      "/repos/acme/classroom50/commits?per_page=60",
      expect.objectContaining({ method: "GET" }),
    )
  })
})

const MARKER_PATH = `/contents/${ORG_GITHUB_DIR}/${CONFIG_REPO_MARKER_REL}`

describe("csvFileQuery — roster.csv read", () => {
  const HEADER = "username,first_name,last_name,email,section,github_id\n"

  const run = <T>(client: GitHubClient, path: string) =>
    (
      csvFileQuery<T>(client, "acme", "classroom50", path).queryFn as (ctx: {
        signal?: AbortSignal
      }) => Promise<T[]>
    )({})

  it("reads roster.csv when present", async () => {
    const requestRaw = vi
      .fn()
      .mockResolvedValue(HEADER + "alice,Alice,A,alice@x.edu,,42\n")
    const rows = await run<Record<string, string>>(
      { requestRaw } as unknown as GitHubClient,
      "cs101/roster.csv",
    )
    expect(rows.map((r) => r.username)).toEqual(["alice"])
    expect(requestRaw).toHaveBeenCalledTimes(1)
    expect(requestRaw.mock.calls[0][0]).toContain("cs101/roster.csv")
  })

  it("rethrows a 404 (no fallback)", async () => {
    const requestRaw = vi.fn().mockRejectedValue(apiError(404))
    await expect(
      run({ requestRaw } as unknown as GitHubClient, "cs101/roster.csv"),
    ).rejects.toThrow(GitHubAPIError)
    expect(requestRaw).toHaveBeenCalledTimes(1)
  })

  it("rethrows a non-404 error", async () => {
    const requestRaw = vi.fn().mockRejectedValue(apiError(403))
    await expect(
      run({ requestRaw } as unknown as GitHubClient, "cs101/roster.csv"),
    ).rejects.toThrow(GitHubAPIError)
    expect(requestRaw).toHaveBeenCalledTimes(1)
  })
})

describe("verifyClassroom50ConfigRepo (name-collision guard)", () => {
  it("returns true when the config-repo marker resolves", async () => {
    const client = { request: vi.fn().mockResolvedValue({ type: "file" }) }
    await expect(verifyClassroom50ConfigRepo(client, "acme")).resolves.toBe(
      true,
    )
    expect(client.request).toHaveBeenCalledWith(
      `/repos/acme/classroom50${MARKER_PATH}`,
    )
  })

  it("returns false on a 404 (repo exists but isn't a config repo)", async () => {
    const client = { request: vi.fn().mockRejectedValue(apiError(404)) }
    await expect(verifyClassroom50ConfigRepo(client, "acme")).resolves.toBe(
      false,
    )
  })

  it("fails open (true) on a non-404 error so a blip never hides a real org", async () => {
    const client = { request: vi.fn().mockRejectedValue(apiError(403)) }
    await expect(verifyClassroom50ConfigRepo(client, "acme")).resolves.toBe(
      true,
    )
  })
})

describe("getClassroom50OrgSummary (verifies config repo before 'ready')", () => {
  const membership = (
    role: "admin" | "member",
    state: "active" | "pending" = "active",
  ): GitHubOrgMembership =>
    ({
      state,
      role,
      organization: {
        login: "acme",
        id: 1,
        avatar_url: "",
        html_url: "https://github.com/acme",
      },
    }) as unknown as GitHubOrgMembership

  it("is 'ready' when the repo exists AND carries the config marker", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ id: 1 }),
    } as unknown as GitHubClient
    const summary = await getClassroom50OrgSummary(client, membership("admin"))
    expect(summary.classroom50.status).toBe("ready")
    expect(summary.classroom50.canAccessRepo).toBe(true)
  })

  it("is 'not_classroom50' when a readable repo lacks the config marker (name collision)", async () => {
    const client = {
      request: vi.fn().mockImplementation((path: string) => {
        if (path.includes("/contents/")) return Promise.reject(apiError(404))
        return Promise.resolve({ id: 1 })
      }),
    } as unknown as GitHubClient
    const summary = await getClassroom50OrgSummary(client, membership("admin"))
    expect(summary.classroom50.status).toBe("not_classroom50")
  })

  it("stays 'ready' when the marker probe fails open on a non-404 (readable repo, blip on the marker read)", async () => {
    const client = {
      request: vi.fn().mockImplementation((path: string) => {
        if (path.includes("/contents/")) return Promise.reject(apiError(403))
        return Promise.resolve({ id: 1 })
      }),
    } as unknown as GitHubClient
    const summary = await getClassroom50OrgSummary(client, membership("admin"))
    expect(summary.classroom50.status).toBe("ready")
    expect(summary.classroom50.canAccessRepo).toBe(true)
  })

  it("is 'needs_setup' for an admin when the repo itself 404s", async () => {
    const client = {
      request: vi.fn().mockRejectedValue(apiError(404)),
    } as unknown as GitHubClient
    const summary = await getClassroom50OrgSummary(client, membership("admin"))
    expect(summary.classroom50.status).toBe("needs_setup")
  })

  // Pins the active-state half of the owner test: only isOwnerGitHubOrgRole
  // (bare admin) routes through the shared helper; the `state === "active"`
  // premise stays inline, so a pending admin must NOT be treated as an owner.
  it("denies canInitialize to a pending admin (active-state premise, not just role)", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ id: 1 }),
    } as unknown as GitHubClient
    const summary = await getClassroom50OrgSummary(
      client,
      membership("admin", "pending"),
    )
    // Repo is readable+marked, so status is 'ready' regardless of role, but the
    // pending state must still gate initialization off.
    expect(summary.classroom50.status).toBe("ready")
    expect(summary.classroom50.canInitialize).toBe(false)
  })
})
