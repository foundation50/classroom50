import { describe, expect, it } from "vitest"

import {
  describeLocalizedMessage,
  localizedMessageOf,
  resolveLocalizedMessage,
  type TranslateFn,
} from "./localizedMessage"

// Stand-in for i18next: renders the key with {{param}} substitution so a test
// can tell a resolved sentence from a leaked raw key.
const t: TranslateFn = (key, params) => {
  const body = `[${key}]`
  if (!params) return body
  const rendered = Object.entries(params)
    .map(([name, value]) => `${name}:${String(value)}`)
    .join("|")
  return `${body}{${rendered}}`
}

describe("resolveLocalizedMessage", () => {
  it("resolves a bare key", () => {
    expect(resolveLocalizedMessage(t, { key: "a.b" })).toBe("[a.b]")
  })

  it("passes scalar params through", () => {
    expect(
      resolveLocalizedMessage(t, {
        key: "a.b",
        params: { org: "cs50", status: 403 },
      }),
    ).toBe("[a.b]{org:cs50|status:403}")
  })

  it("resolves a nested message param before the parent key", () => {
    expect(
      resolveLocalizedMessage(t, {
        key: "parent",
        params: {
          detail: { key: "child", params: { message: "denied" } },
        },
      }),
    ).toBe("[parent]{detail:[child]{message:denied}}")
  })
})

describe("localizedMessageOf", () => {
  it("returns the carried message", () => {
    const err = Object.assign(new Error("diagnostic"), {
      localized: { key: "a.b" },
    })
    expect(localizedMessageOf(err)).toEqual({ key: "a.b" })
  })

  it("returns undefined for a plain error, a non-object, and a malformed carrier", () => {
    expect(localizedMessageOf(new Error("plain"))).toBeUndefined()
    expect(localizedMessageOf("nope")).toBeUndefined()
    expect(localizedMessageOf(null)).toBeUndefined()
    expect(
      localizedMessageOf(
        Object.assign(new Error("x"), { localized: { key: 1 } }),
      ),
    ).toBeUndefined()
  })
})

describe("describeLocalizedMessage", () => {
  it("keeps the key and its params readable for logs", () => {
    expect(
      describeLocalizedMessage({
        key: "accept.templateErrors.orgRepoCreationDenied",
        params: { org: "cs50", status: 403 },
      }),
    ).toBe("accept.templateErrors.orgRepoCreationDenied (org=cs50, status=403)")
  })

  it("flattens a nested message", () => {
    expect(
      describeLocalizedMessage({
        key: "parent",
        params: { detail: { key: "child" } },
      }),
    ).toBe("parent (detail=child)")
  })
})
