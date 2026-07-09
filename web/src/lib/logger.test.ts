// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { logger } from "./logger"
import { GitHubAPIError } from "@/hooks/github/errors"
import { clearActivity, readActivity } from "@/lib/activity/activityStore"

// Under Vitest import.meta.env.DEV === true, so the module's MIN_LEVEL is
// "debug" and every level prints — letting us assert the full range here.

type Spies = Record<
  "debug" | "info" | "warn" | "error",
  ReturnType<typeof vi.spyOn>
>

let spies: Spies

beforeEach(() => {
  spies = {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  clearActivity()
})

const firstArg = (spy: ReturnType<typeof vi.spyOn>): string =>
  String(spy.mock.calls[0]?.[0] ?? "")

describe("logger", () => {
  it("routes each level to the matching console method", () => {
    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")
    expect(spies.debug).toHaveBeenCalledTimes(1)
    expect(spies.info).toHaveBeenCalledTimes(1)
    expect(spies.warn).toHaveBeenCalledTimes(1)
    expect(spies.error).toHaveBeenCalledTimes(1)
  })

  it("prefixes an ISO timestamp and upper-case level", () => {
    logger.warn("something happened")
    const line = firstArg(spies.warn)
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN /)
    expect(line).toContain("something happened")
  })

  it("includes the scope in brackets when scoped", () => {
    logger.scope("mutations:students").error("boom")
    expect(firstArg(spies.error)).toContain("[mutations:students]")
  })

  it("nests scopes with a colon", () => {
    logger.scope("a").scope("b").info("hi")
    expect(firstArg(spies.info)).toContain("[a:b]")
  })

  it("tags a call-site frame pointing at the caller, not logger.ts", () => {
    logger.info("hi")
    const line = firstArg(spies.info)
    // A frame renders as "(file.tsx:line...)"; it must not point back at the
    // wrapper module itself.
    expect(line).not.toContain("logger.ts")
    expect(line).toMatch(/\(logger\.test\.ts:\d+/)
  })

  it("prints structured context as a trailing object (never inline)", () => {
    logger.warn("with ctx", { requestId: "ABCD:1", count: 3 })
    const [, ctx] = spies.warn.mock.calls[0] ?? []
    expect(ctx).toEqual({ requestId: "ABCD:1", count: 3 })
  })

  it("omits the trailing object when only control fields are passed", () => {
    logger.error("no rest", { record: false, org: "acme" })
    // org/record are consumed by the logger, not printed as context.
    expect(spies.error.mock.calls[0]?.length).toBe(1)
  })

  it("does not record into the Activity store by default", () => {
    logger.error("silent failure")
    expect(readActivity()).toHaveLength(0)
  })

  it("records into the Activity store when record:true, scope-qualified", () => {
    logger.scope("CreateClassroomPage").error("non-GitHub API error", {
      record: true,
      org: "acme",
    })
    const entries = readActivity()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("error")
    expect(entries[0].org).toBe("acme")
    expect(entries[0].label).toBe("[CreateClassroomPage] non-GitHub API error")
  })

  it("does not record debug/info even with record:true (store is error/action)", () => {
    logger.info("fyi", { record: true })
    logger.debug("trace", { record: true })
    expect(readActivity()).toHaveLength(0)
  })

  it("records a warn when record:true", () => {
    logger.warn("read-back failed", { record: true, org: "acme" })
    expect(readActivity()).toHaveLength(1)
  })
})

describe("logger privacy + record path", () => {
  it("never leaks a GitHubAPIError's body or ssoHeader passed as { err } context", () => {
    const err = new GitHubAPIError({
      status: 403,
      url: "https://api.github.com/orgs/acme/repos",
      message: "Forbidden",
      body: { message: "Forbidden", secret: "should-not-log" },
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: null,
      },
      ssoHeader:
        "required; url=https://github.com/orgs/acme/sso?authorization_request=leaky-token",
    })
    logger.error("request failed", { err })
    // The raw body and the SSO authorization_request token must not reach the
    // console sink through a stray raw-error context value.
    const serialized = JSON.stringify(spies.error.mock.calls)
    expect(serialized).not.toContain("should-not-log")
    expect(serialized).not.toContain("leaky-token")
    // The safe, allow-listed fields still come through so the line is useful.
    const [, ctx] = spies.error.mock.calls[0] ?? []
    expect(JSON.stringify(ctx)).toContain("403")
  })

  it("attributes a recorded entry's source to the caller, not logger.ts", () => {
    logger.scope("github:client").error("boom", { record: true })
    const [entry] = readActivity()
    expect(entry.source ?? "").not.toContain("logger.ts")
    expect(entry.source ?? "").toMatch(/logger\.test\.ts:\d+/)
  })

  it("collapses a burst of identical recorded warns into one Activity entry", () => {
    const log = logger.scope("github:client")
    for (let i = 0; i < 5; i++) {
      log.warn("session expired (401)", { record: true, org: "acme" })
    }
    // Same scope+message within the dedup window -> one entry, so a 401 burst
    // can't evict genuine errors from the ring.
    expect(readActivity()).toHaveLength(1)
  })
})
