import { describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import {
  classifyServiceTokenExpiry,
  getCollectScoresRunAfterId,
  getLastCollectScoresRun,
  getRunAnnotations,
  getServiceTokenStatus,
  latestSubmitReleaseAndCount,
  latestSubmitReleaseWithAssets,
} from "./releaseRunReads"
import type { GitHubClient } from "../client"
import type { GitHubRelease } from "../types"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: noRateLimit,
  })

const clientThrowing = (err: unknown): GitHubClient =>
  ({ request: vi.fn().mockRejectedValue(err) }) as unknown as GitHubClient

// getServiceTokenStatus resolves only DEFINITIVE verdicts (404 -> missing,
// 403 -> unknown/permission_denied) and rethrows everything else. Resolving a
// transient error to "unknown" would let an invalidation refetch overwrite the
// optimistically-seeded "present" (useSaveServiceToken) and bounce the setup
// wizard off its derived finish stage (#310).
describe("getServiceTokenStatus", () => {
  it("resolves 'missing' on a 404", async () => {
    const status = await getServiceTokenStatus(
      clientThrowing(apiError(404)),
      "org",
    )
    expect(status.status).toBe("missing")
  })

  it("resolves 'unknown' (permission_denied) on a 403", async () => {
    const status = await getServiceTokenStatus(
      clientThrowing(apiError(403)),
      "org",
    )
    expect(status.status).toBe("unknown")
    expect(status.status === "unknown" && status.reason).toBe(
      "permission_denied",
    )
  })

  it("rethrows a transient 5xx instead of resolving 'unknown'", async () => {
    await expect(
      getServiceTokenStatus(clientThrowing(apiError(503)), "org"),
    ).rejects.toThrow()
  })

  it("rethrows a network/timeout error instead of resolving 'unknown'", async () => {
    await expect(
      getServiceTokenStatus(
        clientThrowing(new TypeError("Failed to fetch")),
        "org",
      ),
    ).rejects.toThrow()
  })

  it("resolves 'present' with the expiry and name from the variables, and tolerates missing variables", async () => {
    // Secret resolves; the two variable reads (expiry, name) resolve their
    // values. Order of the two variable reads isn't guaranteed (Promise.all), so
    // resolve by URL rather than call order.
    const withVars = {
      request: vi.fn((path: string) => {
        if (path.includes("/actions/secrets/")) {
          return Promise.resolve({
            name: "CLASSROOM50_SERVICE_TOKEN",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          })
        }
        if (path.endsWith("CLASSROOM50_SERVICE_TOKEN_EXPIRES_AT")) {
          return Promise.resolve({
            name: "CLASSROOM50_SERVICE_TOKEN_EXPIRES_AT",
            value: "2026-10-01T00:00:00Z",
          })
        }
        return Promise.resolve({
          name: "CLASSROOM50_SERVICE_TOKEN_NAME",
          value: "classroom50-token-42-ab12",
        })
      }),
    } as unknown as GitHubClient
    const present = await getServiceTokenStatus(withVars, "org")
    expect(present.status).toBe("present")
    expect(present.status === "present" && present.expiresAt).toBe(
      "2026-10-01T00:00:00Z",
    )
    expect(present.status === "present" && present.tokenName).toBe(
      "classroom50-token-42-ab12",
    )

    // A 404 on both variables must not void the present verdict.
    const noVars = {
      request: vi.fn((path: string) => {
        if (path.includes("/actions/secrets/")) {
          return Promise.resolve({
            name: "CLASSROOM50_SERVICE_TOKEN",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          })
        }
        return Promise.reject(apiError(404))
      }),
    } as unknown as GitHubClient
    const stillPresent = await getServiceTokenStatus(noVars, "org")
    expect(stillPresent.status).toBe("present")
    expect(stillPresent.status === "present" && stillPresent.expiresAt).toBe(
      undefined,
    )
    expect(stillPresent.status === "present" && stillPresent.tokenName).toBe(
      undefined,
    )
  })
})

describe("classifyServiceTokenExpiry", () => {
  const now = Date.parse("2026-07-01T00:00:00Z")
  const days = (n: number) => n * 24 * 60 * 60 * 1000

  it("returns 'unknown' with no/invalid expiry", () => {
    expect(classifyServiceTokenExpiry(undefined, now)).toBe("unknown")
    expect(classifyServiceTokenExpiry("not-a-date", now)).toBe("unknown")
  })

  it("returns 'expired' at or past the instant", () => {
    expect(classifyServiceTokenExpiry(new Date(now).toISOString(), now)).toBe(
      "expired",
    )
    expect(
      classifyServiceTokenExpiry(new Date(now - days(1)).toISOString(), now),
    ).toBe("expired")
  })

  it("returns 'expiringSoon' inside the warn window and 'ok' beyond it", () => {
    expect(
      classifyServiceTokenExpiry(new Date(now + days(10)).toISOString(), now),
    ).toBe("expiringSoon")
    // Boundary: exactly the 14-day default warn window is still "soon".
    expect(
      classifyServiceTokenExpiry(new Date(now + days(14)).toISOString(), now),
    ).toBe("expiringSoon")
    expect(
      classifyServiceTokenExpiry(new Date(now + days(30)).toISOString(), now),
    ).toBe("ok")
  })
})

const clientReturning = (releases: GitHubRelease[]): GitHubClient =>
  ({ request: vi.fn().mockResolvedValue(releases) }) as unknown as GitHubClient

const release = (
  tag: string,
  when: string,
  extra: Partial<GitHubRelease> = {},
): GitHubRelease => ({
  id: 1,
  tag_name: tag,
  name: tag,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  created_at: when,
  published_at: when,
  ...extra,
})

describe("latestSubmitReleaseWithAssets", () => {
  it("returns the newest submit/* release among several", async () => {
    const client = clientReturning([
      release("submit/2026-01-01T00:00:00Z-aaaa", "2026-01-01T00:00:00Z"),
      release("submit/2026-03-01T00:00:00Z-cccc", "2026-03-01T00:00:00Z"),
      release("submit/2026-02-01T00:00:00Z-bbbb", "2026-02-01T00:00:00Z"),
    ])
    const latest = await latestSubmitReleaseWithAssets(client, "o", "r")
    expect(latest?.tag_name).toBe("submit/2026-03-01T00:00:00Z-cccc")
  })

  it("ignores non-submit/* tags", async () => {
    const client = clientReturning([
      release("v1.0.0", "2026-05-01T00:00:00Z"),
      release("submit/2026-01-01T00:00:00Z-aaaa", "2026-01-01T00:00:00Z"),
    ])
    const latest = await latestSubmitReleaseWithAssets(client, "o", "r")
    expect(latest?.tag_name).toBe("submit/2026-01-01T00:00:00Z-aaaa")
  })

  it("returns null when there are no submit/* releases", async () => {
    const client = clientReturning([release("v1.0.0", "2026-05-01T00:00:00Z")])
    expect(await latestSubmitReleaseWithAssets(client, "o", "r")).toBeNull()
  })

  it("returns null on a 404 (repo not accepted)", async () => {
    const client = clientThrowing(apiError(404))
    expect(await latestSubmitReleaseWithAssets(client, "o", "r")).toBeNull()
  })

  it("rethrows a non-404 error (e.g., 403) rather than hiding it as no-submission", async () => {
    await expect(
      latestSubmitReleaseWithAssets(clientThrowing(apiError(403)), "o", "r"),
    ).rejects.toThrow()
  })

  it("carries the release's assets through for the caller", async () => {
    const client = clientReturning([
      release("submit/2026-01-01T00:00:00Z-aaaa", "2026-01-01T00:00:00Z", {
        assets: [
          {
            id: 9,
            name: "result.json",
            browser_download_url: "https://github.com/o/r/releases/download/x",
          },
        ],
      }),
    ])
    const latest = await latestSubmitReleaseWithAssets(client, "o", "r")
    expect(latest?.assets?.[0]?.name).toBe("result.json")
  })
})

describe("latestSubmitReleaseAndCount", () => {
  it("returns the newest submit/* release and the submit-release count", async () => {
    const client = clientReturning([
      release("submit/2026-01-01T00:00:00Z-aaaa", "2026-01-01T00:00:00Z"),
      release("submit/2026-03-01T00:00:00Z-cccc", "2026-03-01T00:00:00Z"),
      release("submit/2026-02-01T00:00:00Z-bbbb", "2026-02-01T00:00:00Z"),
    ])
    const { latest, count } = await latestSubmitReleaseAndCount(
      client,
      "o",
      "r",
    )
    expect(latest?.tag_name).toBe("submit/2026-03-01T00:00:00Z-cccc")
    expect(count).toBe(3)
  })

  it("counts only submit/* releases, ignoring other tags", async () => {
    const client = clientReturning([
      release("v1.0.0", "2026-05-01T00:00:00Z"),
      release("submit/2026-01-01T00:00:00Z-aaaa", "2026-01-01T00:00:00Z"),
      release("nightly", "2026-04-01T00:00:00Z"),
    ])
    const { latest, count } = await latestSubmitReleaseAndCount(
      client,
      "o",
      "r",
    )
    expect(latest?.tag_name).toBe("submit/2026-01-01T00:00:00Z-aaaa")
    expect(count).toBe(1)
  })

  it("resolves { latest: null, count: 0 } on a 404 (repo not accepted)", async () => {
    const client = clientThrowing(apiError(404))
    expect(await latestSubmitReleaseAndCount(client, "o", "r")).toEqual({
      latest: null,
      count: 0,
    })
  })

  it("rethrows a non-404 error rather than hiding it as no-submission", async () => {
    await expect(
      latestSubmitReleaseAndCount(clientThrowing(apiError(403)), "o", "r"),
    ).rejects.toThrow()
  })
})

// A paging-aware client mock for the workflow-runs endpoint: serves per_page
// slices of `allRuns` (newest-first) keyed by the request's `page` param.
const runsClient = (allRuns: { id: number }[]) => {
  const request = vi.fn().mockImplementation((url: string) => {
    const params = new URL(`https://api.github.com${url}`).searchParams
    const perPage = Number(params.get("per_page") ?? "1")
    const page = Number(params.get("page") ?? "1")
    const start = (page - 1) * perPage
    return Promise.resolve({
      workflow_runs: allRuns.slice(start, start + perPage),
    })
  })
  return { client: { request } as unknown as GitHubClient, request }
}

describe("getCollectScoresRunAfterId", () => {
  it("binds to the oldest run newer than the baseline", async () => {
    const { client } = runsClient([{ id: 30 }, { id: 20 }, { id: 10 }])
    const run = await getCollectScoresRunAfterId(client, "acme", 10)
    expect(run?.id).toBe(20)
  })

  it("returns null while our run has not registered yet", async () => {
    const { client } = runsClient([{ id: 10 }])
    expect(await getCollectScoresRunAfterId(client, "acme", 10)).toBeNull()
  })

  it("pages past the first page when many dispatches piled up", async () => {
    // 35 runs newer than the baseline (ids 45..11 newest-first) push our own
    // run (id 11) off a single 30-run page; the reader must keep paging until
    // it sees the baseline, not bind to a later dispatch on page 1.
    const newer = Array.from({ length: 35 }, (_, i) => ({ id: 45 - i }))
    const { client, request } = runsClient([...newer, { id: 10 }])
    const run = await getCollectScoresRunAfterId(client, "acme", 10)
    expect(run?.id).toBe(11)
    expect(request.mock.calls.length).toBeGreaterThan(1)
  })
})

describe("getLastCollectScoresRun", () => {
  it("asks for the last SUCCESSFUL run, so a failed collection never reads as fresh", async () => {
    const { client, request } = runsClient([{ id: 5 }])
    const run = await getLastCollectScoresRun(client, "acme")
    expect(run?.id).toBe(5)
    const url = String(request.mock.calls[0][0])
    expect(url).toContain("status=success")
  })
})

// A run's workflow-command annotations (`::error::` etc.) hang off each job's
// check run, so the read is the jobs list followed by one annotations call per
// job. The probe-token verdict is delivered this way.
describe("getRunAnnotations", () => {
  const clientWith = (
    jobs: { id: number }[],
    annotations: Record<
      number,
      { annotation_level: string; message: string | null }[]
    >,
  ) => {
    const request = vi.fn((url: string) => {
      if (url.includes("/actions/runs/77/jobs")) {
        return Promise.resolve({ jobs })
      }
      const m = /check-runs\/(\d+)\/annotations/.exec(url)
      if (m) return Promise.resolve(annotations[Number(m[1])] ?? [])
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    return { client: { request } as unknown as GitHubClient, request }
  }

  it("flattens every job's annotations in job order and normalizes the level", async () => {
    const { client, request } = clientWith([{ id: 1 }, { id: 2 }], {
      1: [{ annotation_level: "notice", message: "probe PASSED" }],
      2: [
        { annotation_level: "failure", message: "  probe FAILED: 2 checks  " },
        { annotation_level: "warning", message: "slow" },
        { annotation_level: "weird", message: "?" },
      ],
    })

    const out = await getRunAnnotations(client, "acme", 77)

    expect(out).toEqual([
      { level: "notice", message: "probe PASSED" },
      { level: "failure", message: "probe FAILED: 2 checks" },
      { level: "warning", message: "slow" },
      { level: "notice", message: "?" },
    ])
    expect(String(request.mock.calls[0][0])).toContain(
      "/repos/acme/classroom50/actions/runs/77/jobs",
    )
  })

  it("drops annotations with no message and returns [] for a silent run", async () => {
    const { client } = clientWith([{ id: 1 }], {
      1: [
        { annotation_level: "failure", message: null },
        { annotation_level: "failure", message: "   " },
      ],
    })
    expect(await getRunAnnotations(client, "acme", 77)).toEqual([])

    const { client: noJobs } = clientWith([], {})
    expect(await getRunAnnotations(noJobs, "acme", 77)).toEqual([])
  })
})
