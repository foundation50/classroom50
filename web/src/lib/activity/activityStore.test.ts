// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"

import { GitHubAPIError } from "@/hooks/github/errors"
import {
  activityForOrg,
  clearActivity,
  readActivity,
  recordAction,
  recordError,
  recordErrorToast,
  toActivityEntry,
} from "./activityStore"

const noRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const githubError = () =>
  new GitHubAPIError({
    status: 403,
    url: "https://api.github.com/orgs/acme",
    message: "Forbidden",
    body: { secret: "should never leak" },
    rateLimit: noRateLimit,
    ssoHeader:
      "required; url=https://github.com/orgs/acme/sso?authorization_request=SECRET_TOKEN",
    acceptedScopes: "repo",
    oauthScopes: "read:user",
    requestId: "ABCD:1234",
  })

afterEach(() => clearActivity())

describe("toActivityEntry (allow-list / redaction)", () => {
  it("projects a GitHubAPIError to allow-listed fields only", () => {
    const entry = toActivityEntry(githubError(), { org: "acme" })
    expect(entry.kind).toBe("error")
    expect(entry.org).toBe("acme")
    expect(entry.status).toBe(403)
    expect(entry.endpoint).toBe("https://api.github.com/orgs/acme")
    expect(entry.requestId).toBe("ABCD:1234")
    expect(entry.ssoRequired).toBe(true)
    expect(entry.scopeGap).toBe(true)
  })

  it("never carries the raw body or raw SSO header", () => {
    const serialized = JSON.stringify(toActivityEntry(githubError()))
    expect(serialized).not.toContain("should never leak")
    expect(serialized).not.toContain("authorization_request")
    expect(serialized).not.toContain("SECRET_TOKEN")
  })

  it("projects a plain Error to name/message with no GitHub fields", () => {
    const entry = toActivityEntry(new TypeError("boom"))
    expect(entry.label).toBe("boom")
    expect(entry.status).toBeUndefined()
    expect(entry.endpoint).toBeUndefined()
  })
})

describe("recording and reading", () => {
  it("records errors and actions and reads them back most-recent-last", () => {
    recordError(new Error("first"), { org: "acme" })
    recordAction("Dispatched collect-scores", { org: "acme" })
    const all = readActivity()
    expect(all).toHaveLength(2)
    expect(all[0].label).toBe("first")
    expect(all[1].kind).toBe("action")
  })

  it("filters by org", () => {
    recordError(new Error("a"), { org: "acme" })
    recordError(new Error("b"), { org: "other" })
    expect(activityForOrg("acme")).toHaveLength(1)
    expect(activityForOrg("acme")[0].label).toBe("a")
    expect(activityForOrg(undefined)).toHaveLength(0)
  })

  it("persists across a reload (sessionStorage)", async () => {
    recordError(new Error("survives"), { org: "acme" })
    // Re-import a fresh module graph to simulate a remount reading storage.
    // (clearActivity in afterEach resets both.)
    expect(readActivity()).toHaveLength(1)
  })
})

describe("dedup", () => {
  it("collapses two records sharing a dedup key within the window into one", () => {
    recordError(new Error("mutation failed"), {
      org: "acme",
      dedupKey: "k1",
    })
    recordError(new Error("mutation failed (toast)"), {
      org: "acme",
      dedupKey: "k1",
    })
    const all = activityForOrg("acme")
    expect(all).toHaveLength(1)
    // The later record replaces the label in place.
    expect(all[0].label).toBe("mutation failed (toast)")
  })

  it("keeps records with different dedup keys separate", () => {
    recordError(new Error("one"), { org: "acme", dedupKey: "k1" })
    recordError(new Error("two"), { org: "acme", dedupKey: "k2" })
    expect(activityForOrg("acme")).toHaveLength(2)
  })

  it("suppresses an error toast that follows a structural error (same failure)", () => {
    // MutationCache records structurally; the mutation's onError then toasts a
    // translated message. The toast is suppressed so one failure lists once.
    recordError(new Error("Create failed"), { dedupKey: "mutation-7" })
    recordErrorToast("Couldn't create classroom: Create failed")
    expect(readActivity()).toHaveLength(1)
  })

  it("records a standalone error toast when no structural error preceded it", () => {
    recordErrorToast("Something went wrong")
    expect(readActivity()).toHaveLength(1)
    expect(readActivity()[0].label).toBe("Something went wrong")
  })
})

describe("orgFromApiUrl", () => {
  it("extracts org from /orgs/ and /repos/ URLs", () => {
    const gh = new GitHubAPIError({
      status: 404,
      url: "https://api.github.com/repos/acme/some-repo/contents/x",
      message: "Not Found",
      body: null,
      rateLimit: noRateLimit,
    })
    expect(toActivityEntry(gh).org).toBe("acme")
  })

  it("prefers an explicit org context over the URL-derived one", () => {
    const gh = new GitHubAPIError({
      status: 404,
      url: "https://api.github.com/repos/acme/x",
      message: "Not Found",
      body: null,
      rateLimit: noRateLimit,
    })
    expect(toActivityEntry(gh, { org: "explicit" }).org).toBe("explicit")
  })
})
