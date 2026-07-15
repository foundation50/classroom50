import { describe, expect, it, vi } from "vitest"
import {
  pagesAssignmentUrl,
  classroomsIndexUrl,
  configCommitsQuery,
  csvFileQuery,
  getClassroom50OrgSummary,
  getOrgFailedInvitationsForTeam,
  listAllOrgMembers,
  listOrgAdmins,
  listOrgTeams,
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

  it("rethrows a non-403/404 error (e.g. 500) rather than degrading silently", async () => {
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

  it("rethrows a non-404 error (e.g. 403/500) rather than degrading silently", async () => {
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

describe("getOrgFailedInvitationsForTeam (team-scoped failed invites, #236)", () => {
  const failedListUrl = "/orgs/acme/failed_invitations?per_page=100&page=1"
  // A client whose request routes by URL: the org-wide failed list, then each
  // invite's invitation_teams_url returns that invite's team set.
  const clientReturning = (
    failed: unknown[],
    teamsByUrl: Record<string, Array<{ slug: string }>>,
  ) =>
    ({
      request: vi.fn((url: string) => {
        if (url === failedListUrl) return Promise.resolve(failed)
        if (url in teamsByUrl) return Promise.resolve(teamsByUrl[url])
        return Promise.resolve([])
      }),
    }) as unknown as GitHubClient

  it("keeps only failed invites whose team set includes the classroom slug", async () => {
    const failed = [
      {
        id: 1,
        login: "onteam",
        email: null,
        role: "direct_member",
        team_count: 1,
        invitation_teams_url: "https://api.github.com/invites/1/teams",
      },
      {
        id: 2,
        login: "otherclass",
        email: null,
        role: "direct_member",
        team_count: 1,
        invitation_teams_url: "https://api.github.com/invites/2/teams",
      },
    ]
    const client = clientReturning(failed, {
      "https://api.github.com/invites/1/teams": [{ slug: "classroom50-cs101" }],
      "https://api.github.com/invites/2/teams": [{ slug: "classroom50-cs201" }],
    })
    const result = await getOrgFailedInvitationsForTeam(
      client,
      "acme",
      "classroom50-cs101",
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 1, login: "onteam" })
  })

  it("drops team-less invites (team_count 0) without fetching their teams", async () => {
    const failed = [
      {
        id: 3,
        login: "orgonly",
        email: null,
        role: "direct_member",
        team_count: 0,
        invitation_teams_url: "https://api.github.com/invites/3/teams",
      },
    ]
    const request = vi.fn((url: string) =>
      url === failedListUrl ? Promise.resolve(failed) : Promise.resolve([]),
    )
    const client = { request } as unknown as GitHubClient
    const result = await getOrgFailedInvitationsForTeam(
      client,
      "acme",
      "classroom50-cs101",
    )
    expect(result).toEqual([])
    // No per-invite teams fetch for a team-less invite.
    expect(
      request.mock.calls.some(([url]) => String(url).includes("/teams")),
    ).toBe(false)
  })

  it("drops an invite whose per-invite teams read fails (never leaks unattributable)", async () => {
    const failed = [
      {
        id: 4,
        login: "unreadable",
        email: null,
        role: "direct_member",
        team_count: 1,
        invitation_teams_url: "https://api.github.com/invites/4/teams",
      },
    ]
    const request = vi.fn((url: string) => {
      if (url === failedListUrl) return Promise.resolve(failed)
      return Promise.reject(new Error("boom"))
    })
    const client = { request } as unknown as GitHubClient
    const result = await getOrgFailedInvitationsForTeam(
      client,
      "acme",
      "classroom50-cs101",
    )
    expect(result).toEqual([])
  })

  it("drops a team_count>0 invite with no invitation_teams_url (no fetch)", async () => {
    const failed = [
      {
        id: 5,
        login: "noteamsurl",
        email: null,
        role: "direct_member",
        team_count: 1,
        invitation_teams_url: null,
      },
    ]
    const request = vi.fn((url: string) =>
      url === failedListUrl ? Promise.resolve(failed) : Promise.resolve([]),
    )
    const client = { request } as unknown as GitHubClient
    const result = await getOrgFailedInvitationsForTeam(
      client,
      "acme",
      "classroom50-cs101",
    )
    expect(result).toEqual([])
    expect(
      request.mock.calls.some(([url]) => String(url).includes("/teams")),
    ).toBe(false)
  })

  it("keeps an invite on MULTIPLE teams including the classroom, case-insensitively", async () => {
    // A real classroom invite carries the classroom team plus possibly others;
    // GitHub may echo the slug with different casing.
    const failed = [
      {
        id: 6,
        login: "multi",
        email: null,
        role: "direct_member",
        team_count: 2,
        invitation_teams_url: "https://api.github.com/invites/6/teams",
      },
    ]
    const client = clientReturning(failed, {
      "https://api.github.com/invites/6/teams": [
        { slug: "some-other-team" },
        { slug: "Classroom50-CS101" },
      ],
    })
    const result = await getOrgFailedInvitationsForTeam(
      client,
      "acme",
      "classroom50-cs101",
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 6, login: "multi" })
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

  it("rethrows a non-404 (e.g. 403/5xx) so it surfaces as an error", async () => {
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

describe("csvFileQuery — roster.csv read with legacy students.csv fallback", () => {
  const HEADER = "username,first_name,last_name,email,section,github_id\n"

  const run = <T>(client: GitHubClient, path: string, fallbackPath?: string) =>
    (
      csvFileQuery<T>(
        client,
        "acme",
        "classroom50",
        path,
        undefined,
        fallbackPath,
      ).queryFn as (ctx: { signal?: AbortSignal }) => Promise<T[]>
    )({})

  it("reads roster.csv when present (no fallback attempt)", async () => {
    const requestRaw = vi
      .fn()
      .mockResolvedValue(HEADER + "alice,Alice,A,alice@x.edu,,42\n")
    const rows = await run<Record<string, string>>(
      { requestRaw } as unknown as GitHubClient,
      "cs101/roster.csv",
      "cs101/students.csv",
    )
    expect(rows.map((r) => r.username)).toEqual(["alice"])
    expect(requestRaw).toHaveBeenCalledTimes(1)
    expect(requestRaw.mock.calls[0][0]).toContain("cs101/roster.csv")
  })

  it("falls back to legacy students.csv when roster.csv 404s", async () => {
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("roster.csv")) return Promise.reject(apiError(404))
      return Promise.resolve(HEADER + "bob,Bob,B,bob@x.edu,,43\n")
    })
    const rows = await run<Record<string, string>>(
      { requestRaw } as unknown as GitHubClient,
      "cs101/roster.csv",
      "cs101/students.csv",
    )
    expect(rows.map((r) => r.username)).toEqual(["bob"])
    expect(requestRaw).toHaveBeenCalledTimes(2)
    expect(requestRaw.mock.calls[1][0]).toContain("cs101/students.csv")
  })

  it("does not fall back on a non-404 error", async () => {
    const requestRaw = vi.fn().mockRejectedValue(apiError(403))
    await expect(
      run(
        { requestRaw } as unknown as GitHubClient,
        "cs101/roster.csv",
        "cs101/students.csv",
      ),
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
