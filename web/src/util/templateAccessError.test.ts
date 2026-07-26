import { describe, expect, it } from "vitest"

import { resolveLocalizedMessage } from "@/types/localizedMessage"
import en from "@/locales/en.json"

import {
  TemplateAccessError,
  inOrgTemplateError,
  outOfOrgTemplateError,
} from "./templateAccessError"

// Resolve a { key, params } descriptor against the real en.json so a test can
// assert the copy a student actually sees without the factories assembling it.
const t = (key: string, params?: Record<string, string | number>): string => {
  const template = key
    .split(".")
    .reduce<unknown>(
      (node, segment) => (node as Record<string, unknown>)?.[segment],
      en,
    )
  if (typeof template !== "string")
    throw new Error(`missing en.json key: ${key}`)
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(params?.[name] ?? ""),
  )
}

describe("outOfOrgTemplateError", () => {
  it("names the out-of-org key and nests GitHub's message", () => {
    const err = outOfOrgTemplateError(
      "acme",
      "hw1",
      403,
      "IP allow list enabled",
    )

    expect(err).toBeInstanceOf(TemplateAccessError)
    expect(err.localized).toEqual({
      key: "accept.templateErrors.outOfOrg",
      params: {
        owner: "acme",
        repo: "hw1",
        status: 403,
        detail: {
          key: "accept.templateErrors.githubSaid",
          params: { message: "IP allow list enabled" },
        },
      },
    })

    const rendered = resolveLocalizedMessage(t, err.localized)
    expect(rendered).toContain("acme/hw1")
    expect(rendered).toContain("HTTP 403")
    expect(rendered).toContain('GitHub said: "IP allow list enabled".')
    expect(rendered).toContain("restricts third-party apps")
  })

  it("omits the GitHub-said detail when no message is provided", () => {
    const err = outOfOrgTemplateError("acme", "hw1", 404)

    expect(err.localized.params?.detail).toBe("")
    const rendered = resolveLocalizedMessage(t, err.localized)
    expect(rendered).not.toContain("GitHub said:")
    expect(rendered).toContain("HTTP 404")
  })
})

describe("inOrgTemplateError", () => {
  it("names the in-org key and nests GitHub's message", () => {
    const err = inOrgTemplateError("cs50", "hw1", 403, "Must have admin rights")

    expect(err).toBeInstanceOf(TemplateAccessError)
    expect(err.localized.key).toBe("accept.templateErrors.inOrg")

    const rendered = resolveLocalizedMessage(t, err.localized)
    expect(rendered).toContain("cs50/hw1")
    expect(rendered).toContain("HTTP 403")
    expect(rendered).toContain('GitHub said: "Must have admin rights".')
    expect(rendered).toContain("re-run assignment setup")
  })

  it("omits the GitHub-said detail when no message is provided", () => {
    const err = inOrgTemplateError("cs50", "hw1", 403)

    expect(resolveLocalizedMessage(t, err.localized)).not.toContain(
      "GitHub said:",
    )
  })
})

describe("TemplateAccessError", () => {
  // The error is thrown across layers that read `.message` (the logger,
  // githubHealthStore) — keeping it populated means nothing loses the signal
  // when the view stops rendering it.
  it("keeps a diagnostic Error.message naming the key", () => {
    const err = inOrgTemplateError("cs50", "hw1", 403)
    expect(err.message).toContain("accept.templateErrors.inOrg")
  })

  it("defaults localizedStep to the full message when none is given", () => {
    const err = inOrgTemplateError("cs50", "hw1", 403)
    expect(err.localizedStep).toBe(err.localized)
  })
})
