import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { fetchGitHubStatusIndicator } from "./githubStatusApi"

// The parser is otherwise only reached through a wholesale mock in the store
// tests, so exercise its guard branches directly against a stubbed fetch.
const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as Response

const notOkResponse = (status: number): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
  }) as unknown as Response

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchGitHubStatusIndicator", () => {
  it("maps a well-formed summary to {indicator, description}", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        status: { indicator: "major", description: "Major Service Outage" },
      }),
    )
    expect(await fetchGitHubStatusIndicator()).toEqual({
      indicator: "major",
      description: "Major Service Outage",
    })
  })

  it("returns null for an unknown indicator value", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ status: { indicator: "catastrophic", description: "x" } }),
    )
    expect(await fetchGitHubStatusIndicator()).toBeNull()
  })

  it("returns null when status is missing or not an object", async () => {
    fetchMock.mockResolvedValue(okResponse({ nope: true }))
    expect(await fetchGitHubStatusIndicator()).toBeNull()
    fetchMock.mockResolvedValue(okResponse({ status: "degraded" }))
    expect(await fetchGitHubStatusIndicator()).toBeNull()
  })

  it("returns null on a non-ok response", async () => {
    fetchMock.mockResolvedValue(notOkResponse(503))
    expect(await fetchGitHubStatusIndicator()).toBeNull()
  })

  it("defaults description to '' when it is absent or non-string", async () => {
    fetchMock.mockResolvedValue(okResponse({ status: { indicator: "minor" } }))
    expect(await fetchGitHubStatusIndicator()).toEqual({
      indicator: "minor",
      description: "",
    })
    fetchMock.mockResolvedValue(
      okResponse({ status: { indicator: "none", description: 42 } }),
    )
    expect(await fetchGitHubStatusIndicator()).toEqual({
      indicator: "none",
      description: "",
    })
  })

  it("returns null on a thrown/timeout fetch or malformed JSON", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    expect(await fetchGitHubStatusIndicator()).toBeNull()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json")
      },
    } as unknown as Response)
    expect(await fetchGitHubStatusIndicator()).toBeNull()
  })
})
