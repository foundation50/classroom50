import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number, over: Partial<GitHubRateLimit> = {}) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: { ...noRateLimit, ...over },
  })

// The status probe is mocked per-test so the threshold/recovery logic is tested
// without a real fetch; probe-mapping is asserted via its resolved value.
const fetchIndicatorMock = vi.fn()
vi.mock("./githubStatusApi", () => ({
  fetchGitHubStatusIndicator: () => fetchIndicatorMock(),
}))

import {
  __resetGitHubHealthForTest,
  getGitHubHealthSnapshot,
  isDefiniteOutageError,
  recordGitHubFailure,
  recordGitHubSuccess,
} from "./githubHealthStore"

beforeEach(() => {
  __resetGitHubHealthForTest()
  fetchIndicatorMock.mockReset()
  fetchIndicatorMock.mockResolvedValue(null)
})

afterEach(() => {
  __resetGitHubHealthForTest()
})

describe("isDefiniteOutageError", () => {
  class Wrapper extends Error {
    constructor(cause?: unknown) {
      super("wrapped")
      if (cause !== undefined) this.cause = cause
    }
  }

  it("is true for a 5xx GitHubAPIError, unwrapping `.cause`", () => {
    expect(isDefiniteOutageError(apiError(500))).toBe(true)
    expect(isDefiniteOutageError(apiError(503))).toBe(true)
    expect(isDefiniteOutageError(new Wrapper(apiError(502)))).toBe(true)
  })

  it("is true for a network-failure TypeError across browser engines, unwrapping `.cause`", () => {
    expect(isDefiniteOutageError(new TypeError("Failed to fetch"))).toBe(true)
    expect(
      isDefiniteOutageError(
        new TypeError("NetworkError when attempting to fetch resource"),
      ),
    ).toBe(true)
    expect(isDefiniteOutageError(new TypeError("Load failed"))).toBe(true)
    expect(
      isDefiniteOutageError(new Wrapper(new TypeError("Failed to fetch"))),
    ).toBe(true)
  })

  it("is true for a non-abort timeout DOMException", () => {
    expect(
      isDefiniteOutageError(new DOMException("timed out", "TimeoutError")),
    ).toBe(true)
  })

  it("is false for a non-network TypeError (an ordinary local app bug)", () => {
    // A property-access-on-undefined bug throws TypeError too; it must never
    // read as a GitHub outage (that would mislabel the failure and hide it).
    expect(
      isDefiniteOutageError(
        new TypeError("Cannot read properties of undefined (reading 'x')"),
      ),
    ).toBe(false)
  })

  it("is false for definitive 4xx, rate limit, abort — even wrapped", () => {
    expect(isDefiniteOutageError(apiError(401))).toBe(false)
    expect(isDefiniteOutageError(apiError(403))).toBe(false)
    expect(isDefiniteOutageError(apiError(404))).toBe(false)
    expect(isDefiniteOutageError(apiError(429))).toBe(false)
    expect(isDefiniteOutageError(apiError(403, { retryAfter: 60 }))).toBe(false)
    expect(isDefiniteOutageError(apiError(403, { remaining: 0 }))).toBe(false)
    expect(
      isDefiniteOutageError(new DOMException("aborted", "AbortError")),
    ).toBe(false)
    expect(isDefiniteOutageError(new Wrapper(apiError(404)))).toBe(false)
    expect(isDefiniteOutageError(new Wrapper(apiError(429)))).toBe(false)
  })

  it("is false for a plain/unknown error with no outage cause (no false positive)", () => {
    // A TemplateAccessError-like plain Error must never read as an outage.
    expect(isDefiniteOutageError(new Error("ask your instructor"))).toBe(false)
    expect(isDefiniteOutageError(new Wrapper())).toBe(false)
    expect(isDefiniteOutageError("string")).toBe(false)
    expect(isDefiniteOutageError(undefined)).toBe(false)
    expect(isDefiniteOutageError(null)).toBe(false)
  })
})

describe("suspicion threshold", () => {
  it("stays healthy below the 3-failure threshold", () => {
    recordGitHubFailure(apiError(500), 1000)
    recordGitHubFailure(apiError(500), 1100)
    expect(getGitHubHealthSnapshot().suspected).toBe(false)
  })

  it("suspects an outage at 3 outage-shaped failures within the window", () => {
    recordGitHubFailure(apiError(500), 1000)
    recordGitHubFailure(new TypeError("Failed to fetch"), 1100)
    recordGitHubFailure(apiError(503), 1200)
    expect(getGitHubHealthSnapshot().suspected).toBe(true)
  })

  it("does not count failures that fell outside the 30s window", () => {
    recordGitHubFailure(apiError(500), 1000)
    recordGitHubFailure(apiError(500), 2000)
    // 40s later: the first two are evicted, so this is only the 1st in-window.
    recordGitHubFailure(apiError(500), 42000)
    expect(getGitHubHealthSnapshot().suspected).toBe(false)
  })

  it("ignores non-outage errors entirely (a burst of 404s never suspects)", () => {
    recordGitHubFailure(apiError(404), 1000)
    recordGitHubFailure(apiError(404), 1100)
    recordGitHubFailure(apiError(404), 1200)
    recordGitHubFailure(apiError(429), 1300)
    expect(getGitHubHealthSnapshot().suspected).toBe(false)
  })

  it("ignores local app errors so unrelated non-GitHub throws never trip the banner", () => {
    // These reach React Query's global onError (which feeds recordGitHubFailure
    // unfiltered), but none is a positively-identified outage, so 3+ in-window
    // must NOT suspect — a local bug is not "GitHub is down".
    recordGitHubFailure(new Error("something local broke"), 1000)
    recordGitHubFailure(
      new TypeError("Cannot read properties of undefined"),
      1100,
    )
    recordGitHubFailure("rejected with a string", 1200)
    recordGitHubFailure(new Error("another local failure"), 1300)
    expect(getGitHubHealthSnapshot().suspected).toBe(false)
  })
})

describe("recovery", () => {
  it("clears suspicion on the next successful response", () => {
    recordGitHubFailure(apiError(500), 1000)
    recordGitHubFailure(apiError(500), 1100)
    recordGitHubFailure(apiError(500), 1200)
    expect(getGitHubHealthSnapshot().suspected).toBe(true)

    recordGitHubSuccess()
    expect(getGitHubHealthSnapshot().suspected).toBe(false)
  })

  it("resets the failure window on success so it takes a fresh 3 to re-suspect", () => {
    recordGitHubFailure(apiError(500), 1000)
    recordGitHubFailure(apiError(500), 1100)
    recordGitHubSuccess()
    // Two fresh failures — still below threshold because success cleared the prior two.
    recordGitHubFailure(apiError(500), 1200)
    recordGitHubFailure(apiError(500), 1300)
    expect(getGitHubHealthSnapshot().suspected).toBe(false)
  })
})

describe("status probe enrichment", () => {
  // The probe fires as a floating promise inside recordGitHubFailure; flush the
  // microtask queue so its setState lands before asserting.
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const trip = (base = 1000) => {
    recordGitHubFailure(apiError(500), base)
    recordGitHubFailure(apiError(500), base + 100)
    recordGitHubFailure(apiError(500), base + 200)
  }

  it("enriches with the githubstatus.com description when the indicator is not 'none'", async () => {
    fetchIndicatorMock.mockResolvedValue({
      indicator: "major",
      description: "Major Service Outage",
    })
    trip()
    await flush()
    const snap = getGitHubHealthSnapshot()
    expect(snap.suspected).toBe(true)
    expect(snap.statusIndicator).toBe("major")
    expect(snap.statusDescription).toBe("Major Service Outage")
  })

  it("stays suspected with no description when the probe reports 'none' (local-only issue)", async () => {
    fetchIndicatorMock.mockResolvedValue({
      indicator: "none",
      description: "All Systems Operational",
    })
    trip()
    await flush()
    const snap = getGitHubHealthSnapshot()
    expect(snap.suspected).toBe(true)
    expect(snap.statusDescription).toBeNull()
  })

  it("re-probes on a fresh episode after recovery (probe cache is re-armed on success)", async () => {
    fetchIndicatorMock.mockResolvedValue({
      indicator: "major",
      description: "Major Service Outage",
    })
    trip(1000)
    await flush()
    expect(getGitHubHealthSnapshot().statusIndicator).toBe("major")
    expect(fetchIndicatorMock).toHaveBeenCalledTimes(1)

    recordGitHubSuccess()
    expect(getGitHubHealthSnapshot().suspected).toBe(false)

    // A distinct outage 5s later (well within PROBE_CACHE_MS) must still probe.
    trip(6000)
    await flush()
    expect(getGitHubHealthSnapshot().statusIndicator).toBe("major")
    expect(fetchIndicatorMock).toHaveBeenCalledTimes(2)
  })

  it("a fresh episode still probes when a prior episode's probe is still in flight", async () => {
    // Episode A's probe never resolves (slow network) — its in-flight flag must
    // not starve episode B of its own guaranteed first probe after recovery.
    let resolveA: (v: unknown) => void = () => {}
    fetchIndicatorMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveA = res
      }),
    )
    trip(1000)
    await flush()
    expect(fetchIndicatorMock).toHaveBeenCalledTimes(1)

    recordGitHubSuccess()

    fetchIndicatorMock.mockResolvedValueOnce({
      indicator: "major",
      description: "Major Service Outage",
    })
    trip(6000)
    await flush()
    // Episode B probed despite A still pending, and got its own result.
    expect(fetchIndicatorMock).toHaveBeenCalledTimes(2)
    expect(getGitHubHealthSnapshot().statusIndicator).toBe("major")

    // A resolving late must not overwrite episode B.
    resolveA({ indicator: "minor", description: "Stale Episode A" })
    await flush()
    expect(getGitHubHealthSnapshot().statusDescription).toBe(
      "Major Service Outage",
    )
  })

  it("a stale probe resolving into a new episode does not write its result onto it", async () => {
    let resolveA: (v: unknown) => void = () => {}
    fetchIndicatorMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveA = res
      }),
    )
    trip(1000)
    await flush()

    recordGitHubSuccess()
    // Episode B trips and its own probe reports healthy-but-generic (null).
    fetchIndicatorMock.mockResolvedValueOnce(null)
    trip(6000)
    await flush()
    expect(getGitHubHealthSnapshot().suspected).toBe(true)
    expect(getGitHubHealthSnapshot().statusDescription).toBeNull()

    // Episode A's stale probe resolves with an indicator; the epoch guard must
    // discard it rather than enrich episode B with episode A's description.
    resolveA({ indicator: "critical", description: "Stale Episode A" })
    await flush()
    expect(getGitHubHealthSnapshot().statusDescription).toBeNull()
    expect(getGitHubHealthSnapshot().statusIndicator).toBeNull()
  })
})
