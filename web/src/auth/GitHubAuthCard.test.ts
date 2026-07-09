import { describe, expect, it } from "vitest"

import { resolveLoginAlert } from "./GitHubAuthCard"

// Precedence for the sign-in form alert (#187): offline must win over a stale
// error or the involuntary-expiry notice, because when offline the user never
// signed out — showing "session expired" or a proxy error would misexplain it.
describe("resolveLoginAlert", () => {
  it("shows nothing when online with no error and no expiry", () => {
    expect(
      resolveLoginAlert({ isOnline: true, error: null, sessionExpired: false }),
    ).toBeNull()
  })

  it("shows the offline alert when offline, even with a stale error present", () => {
    expect(
      resolveLoginAlert({
        isOnline: false,
        error: "Network error reaching the proxy",
        sessionExpired: false,
      }),
    ).toBe("offline")
  })

  it("shows the offline alert when offline, even with a session-expired notice", () => {
    expect(
      resolveLoginAlert({
        isOnline: false,
        error: null,
        sessionExpired: true,
      }),
    ).toBe("offline")
  })

  it("shows the error alert when online with a live sign-in error", () => {
    expect(
      resolveLoginAlert({
        isOnline: true,
        error: "That token was rejected by GitHub (401).",
        sessionExpired: false,
      }),
    ).toBe("error")
  })

  it("prefers the error alert over the expiry notice when both are set online", () => {
    expect(
      resolveLoginAlert({
        isOnline: true,
        error: "Something went wrong",
        sessionExpired: true,
      }),
    ).toBe("error")
  })

  it("shows the expiry notice when online with no error but the session expired", () => {
    expect(
      resolveLoginAlert({
        isOnline: true,
        error: null,
        sessionExpired: true,
      }),
    ).toBe("expired")
  })
})
