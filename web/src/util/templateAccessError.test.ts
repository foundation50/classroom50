import { describe, expect, it } from "vitest"

import {
  TemplateAccessError,
  inOrgTemplateError,
  outOfOrgTemplateError,
} from "./templateAccessError"

describe("outOfOrgTemplateError", () => {
  it("appends GitHub's message when provided", () => {
    const err = outOfOrgTemplateError(
      "acme",
      "hw1",
      403,
      "IP allow list enabled",
    )

    expect(err).toBeInstanceOf(TemplateAccessError)
    expect(err.message).toContain("acme/hw1")
    expect(err.message).toContain("HTTP 403")
    expect(err.message).toContain('GitHub said: "IP allow list enabled".')
    expect(err.message).toContain("restricts third-party apps")
  })

  it("omits the GitHub-said detail when no message is provided", () => {
    const err = outOfOrgTemplateError("acme", "hw1", 404)

    expect(err.message).not.toContain("GitHub said:")
    expect(err.message).toContain("HTTP 404")
  })
})

describe("inOrgTemplateError", () => {
  it("appends GitHub's message when provided", () => {
    const err = inOrgTemplateError("cs50", "hw1", 403, "Must have admin rights")

    expect(err).toBeInstanceOf(TemplateAccessError)
    expect(err.message).toContain("cs50/hw1")
    expect(err.message).toContain("HTTP 403")
    expect(err.message).toContain('GitHub said: "Must have admin rights".')
    expect(err.message).toContain("re-run assignment setup")
  })

  it("omits the GitHub-said detail when no message is provided", () => {
    const err = inOrgTemplateError("cs50", "hw1", 403)

    expect(err.message).not.toContain("GitHub said:")
  })
})
