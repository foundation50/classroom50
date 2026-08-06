import { afterEach, describe, expect, it, vi } from "vitest"

import { isAuthedPath } from "./authedPath"

// App gates the session-end /login redirect on isAuthedPath: the public auth
// screens ("/login", "/auth", "/auth/") and the public accessibility report
// ("/accessibility") are exempt; everything else — the app home "/" included —
// is authed and must bounce when the session ends.
// (BASE_PATH is "" under the test env's default BASE_URL of "/".)
describe("isAuthedPath", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("treats the public auth screens as NOT authed", () => {
    expect(isAuthedPath("/login")).toBe(false)
    expect(isAuthedPath("/auth")).toBe(false)
    expect(isAuthedPath("/auth/")).toBe(false)
  })

  it("treats the public accessibility report as NOT authed", () => {
    expect(isAuthedPath("/accessibility")).toBe(false)
    expect(isAuthedPath("/accessibility/")).toBe(false)
  })

  it("treats the app home '/' as authed (must bounce on session end)", () => {
    expect(isAuthedPath("/")).toBe(true)
  })

  it("treats org and deep sub-routes as authed", () => {
    expect(isAuthedPath("/acme")).toBe(true)
    expect(isAuthedPath("/acme/cls/assignments/a1")).toBe(true)
    expect(isAuthedPath("/auth/callback")).toBe(true)
  })

  // GitHub Pages serves the app under a subpath, so production strips BASE_PATH
  // before comparing. BASE_PATH is a module-load const, so exercise the non-root
  // base by re-importing with a stubbed BASE_URL.
  it("exempts the public routes under a non-root BASE_PATH", async () => {
    vi.stubEnv("BASE_URL", "/classroom50/")
    vi.resetModules()
    const { isAuthedPath: scoped } = await import("./authedPath")
    expect(scoped("/classroom50/accessibility")).toBe(false)
    expect(scoped("/classroom50/accessibility/")).toBe(false)
    expect(scoped("/classroom50/login")).toBe(false)
    expect(scoped("/classroom50/")).toBe(true)
    expect(scoped("/classroom50/acme")).toBe(true)
  })
})
