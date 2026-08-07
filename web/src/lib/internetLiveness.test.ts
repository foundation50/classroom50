import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { checkInternetLiveness } from "./internetLiveness"

// A resolved fetch (even an opaque no-cors response) means the round-trip
// succeeded; a rejected one means that endpoint was unreachable.
const reachable = (): Response => ({}) as unknown as Response
const unreachable = () => Promise.reject(new TypeError("Failed to fetch"))

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("checkInternetLiveness", () => {
  it("reports online when every probe resolves", async () => {
    fetchMock.mockResolvedValue(reachable())
    expect(await checkInternetLiveness()).toBe(true)
  })

  it("reports online when only one endpoint is reachable", async () => {
    fetchMock
      .mockImplementationOnce(unreachable)
      .mockResolvedValueOnce(reachable())
      .mockImplementationOnce(unreachable)
    expect(await checkInternetLiveness()).toBe(true)
  })

  it("reports offline only when every endpoint is unreachable", async () => {
    fetchMock.mockImplementation(unreachable)
    expect(await checkInternetLiveness()).toBe(false)
  })

  it("reports offline when every probe times out", async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(
        new DOMException("The operation timed out", "TimeoutError"),
      ),
    )
    expect(await checkInternetLiveness()).toBe(false)
  })

  it("probes multiple independent endpoints, none of them GitHub", async () => {
    fetchMock.mockResolvedValue(reachable())
    await checkInternetLiveness()
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.length).toBeGreaterThan(1)
    expect(urls.some((url) => url.includes("cloudflare"))).toBe(true)
    expect(urls.every((url) => !url.includes("github"))).toBe(true)
  })

  it("passes an abort signal and a no-store cache policy to every probe", async () => {
    fetchMock.mockResolvedValue(reachable())
    await checkInternetLiveness()
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit
      expect(init.cache).toBe("no-store")
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })
})
