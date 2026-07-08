import { afterEach, describe, expect, it } from "vitest"

import {
  clearObservedContext,
  observeOrg,
  observeResponse,
  readObservedContext,
} from "./observed"

afterEach(() => clearObservedContext())

describe("observed context", () => {
  it("starts empty", () => {
    expect(readObservedContext()).toEqual({
      scopes: null,
      status: null,
      org: null,
    })
  })

  it("records the most recent response signal", () => {
    observeResponse({ status: 200, scopes: "repo, read:org" })
    observeResponse({ status: 403, scopes: "repo" })

    const ctx = readObservedContext()
    expect(ctx.status).toBe(403)
    expect(ctx.scopes).toBe("repo")
  })

  it("preserves a null scopes signal (fine-grained PAT — unknown, not empty)", () => {
    observeResponse({ status: 200, scopes: null })
    expect(readObservedContext().scopes).toBeNull()
  })

  it("records and clears the current org independently of the response signal", () => {
    observeResponse({ status: 200, scopes: "repo" })
    observeOrg("acme")
    expect(readObservedContext().org).toBe("acme")

    observeOrg(null)
    expect(readObservedContext().org).toBeNull()
    // Clearing the org must not wipe the response signal.
    expect(readObservedContext().status).toBe(200)
  })

  it("returns a copy so callers cannot mutate the store", () => {
    observeResponse({ status: 200, scopes: "repo" })
    const ctx = readObservedContext()
    ctx.status = 999

    expect(readObservedContext().status).toBe(200)
  })
})
