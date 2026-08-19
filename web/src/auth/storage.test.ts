// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"

import { GITHUB_AUTH_STORAGE } from "./constants"
import {
  clearGithubToken,
  getStoredAuthMethod,
  persistGithubToken,
} from "./storage"

// happy-dom doesn't back window.localStorage here, so install a minimal
// in-memory store — the same shape the hiddenOrgsStore / useTheme tests use.
function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size
      },
    },
    configurable: true,
  })
}

beforeEach(installLocalStorage)

// How a session signed in decides the remedy for a missing destructive scope:
// an OAuth session can be re-authed in-app, a PAT has to be replaced on GitHub
// (#655). Getting "unknown" wrong in either direction misroutes the user, so the
// read is deliberately strict.
describe("getStoredAuthMethod", () => {
  it("round-trips a persisted method", () => {
    persistGithubToken("gho_x", "repo", "oauth")
    expect(getStoredAuthMethod()).toBe("oauth")

    persistGithubToken("ghp_x", "repo", "pat")
    expect(getStoredAuthMethod()).toBe("pat")
  })

  it("reports unknown for a session stored before the method was tracked", () => {
    // The upgrade path: an existing signed-in user has a token and scopes but no
    // method key. This must read as unknown rather than defaulting to a method.
    window.localStorage.setItem(GITHUB_AUTH_STORAGE.TOKEN, "gho_x")
    window.localStorage.setItem(GITHUB_AUTH_STORAGE.SCOPE_GRANTED, "repo")
    expect(getStoredAuthMethod()).toBeNull()
  })

  it("rejects a value it doesn't recognize", () => {
    // localStorage is user-writable, so an arbitrary string must never be
    // trusted as a method.
    window.localStorage.setItem(GITHUB_AUTH_STORAGE.AUTH_METHOD, "oauth-ish")
    expect(getStoredAuthMethod()).toBeNull()
  })

  it("clears a stale method when a later sign-in doesn't know its own", () => {
    // Otherwise a PAT session could inherit the previous OAuth session's method
    // and be offered an elevation that can't help it.
    persistGithubToken("gho_x", "repo", "oauth")
    persistGithubToken("ghp_x", "repo")
    expect(getStoredAuthMethod()).toBeNull()
  })

  it("forgets the method on sign-out", () => {
    persistGithubToken("ghp_x", "repo", "pat")
    clearGithubToken()
    expect(getStoredAuthMethod()).toBeNull()
    expect(window.localStorage.getItem(GITHUB_AUTH_STORAGE.TOKEN)).toBeNull()
  })
})
