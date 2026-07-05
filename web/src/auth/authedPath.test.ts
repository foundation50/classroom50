import { describe, expect, it } from "vitest"

import { isAuthedPath } from "./authedPath"

// App gates the session-end /login redirect on isAuthedPath: only the public
// auth screens ("/login", "/auth", "/auth/") are exempt; everything else — the
// app home "/" included — is authed and must bounce when the session ends.
// (BASE_PATH is "" under the test env's default BASE_URL of "/".)
describe("isAuthedPath", () => {
  it("treats the public auth screens as NOT authed", () => {
    expect(isAuthedPath("/login")).toBe(false)
    expect(isAuthedPath("/auth")).toBe(false)
    expect(isAuthedPath("/auth/")).toBe(false)
  })

  it("treats the app home '/' as authed (must bounce on session end)", () => {
    expect(isAuthedPath("/")).toBe(true)
  })

  it("treats org and deep sub-routes as authed", () => {
    expect(isAuthedPath("/acme")).toBe(true)
    expect(isAuthedPath("/acme/cls/assignments/a1")).toBe(true)
    expect(isAuthedPath("/auth/callback")).toBe(true)
  })
})
