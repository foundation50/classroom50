import { describe, expect, it } from "vitest"

import { resolveLocalizedMessage } from "@/types/localizedMessage"
import { GitHubAPIError } from "@/github-core/errors"
import en from "@/locales/en.json"

import {
  TemplateAccessError,
  inOrgTemplateError,
  isOrgRepoCreationDenied,
  orgRepoCreationDeniedError,
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
  // The error crosses layers that read `.message` (the logger,
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

// The destination-org refusal (#413): GitHub refuses the repo create because the
// org doesn't let its members create repositories. There is no structured signal
// for it, so the predicate matches the one observed message and guards against
// the other 403 causes, each of which has a different remedy.
describe("isOrgRepoCreationDenied", () => {
  const forbidden = (
    message: string,
    over: Partial<{
      status: number
      remaining: number | null
      retryAfter: number | null
      ssoHeader: string | null
      acceptedScopes: string | null
      oauthScopes: string | null
    }> = {},
  ) =>
    new GitHubAPIError({
      status: over.status ?? 403,
      url: "/orgs/cs50/repos",
      message,
      body: null,
      rateLimit: {
        limit: null,
        remaining: over.remaining ?? null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: over.retryAfter ?? null,
      },
      ssoHeader: over.ssoHeader ?? null,
      acceptedScopes: over.acceptedScopes ?? null,
      oauthScopes: over.oauthScopes ?? null,
    })

  const OBSERVED =
    "You need admin access to the organization before adding a repository to it."

  it("is true for the observed GitHub message", () => {
    expect(isOrgRepoCreationDenied(forbidden(OBSERVED))).toBe(true)
  })

  it("matches case-insensitively", () => {
    expect(
      isOrgRepoCreationDenied(
        forbidden("You need ADMIN ACCESS TO THE ORGANIZATION first."),
      ),
    ).toBe(true)
  })

  it("is false for a rate-limited 403", () => {
    expect(isOrgRepoCreationDenied(forbidden(OBSERVED, { remaining: 0 }))).toBe(
      false,
    )
    expect(
      isOrgRepoCreationDenied(forbidden(OBSERVED, { retryAfter: 60 })),
    ).toBe(false)
  })

  it("is false for an SSO-required 403", () => {
    expect(
      isOrgRepoCreationDenied(
        forbidden(OBSERVED, {
          ssoHeader: "required; url=https://github.com/orgs/cs50/sso",
        }),
      ),
    ).toBe(false)
  })

  it("is false for a scope-gap 403", () => {
    expect(
      isOrgRepoCreationDenied(
        forbidden(OBSERVED, {
          acceptedScopes: "admin:org",
          oauthScopes: "repo, read:user",
        }),
      ),
    ).toBe(false)
  })

  it("is false for a 403 with an unrelated message", () => {
    expect(
      isOrgRepoCreationDenied(
        forbidden("Resource protected by organization SAML enforcement."),
      ),
    ).toBe(false)
  })

  it("is false for a 404 (a destination refusal is always a 403)", () => {
    expect(isOrgRepoCreationDenied(forbidden(OBSERVED, { status: 404 }))).toBe(
      false,
    )
  })
})

describe("orgRepoCreationDeniedError", () => {
  it("names the destination org, not the template, and its own key", () => {
    const err = orgRepoCreationDeniedError("cs50", 403, "You need admin access")

    expect(err).toBeInstanceOf(TemplateAccessError)
    expect(err.localized.key).toBe(
      "accept.templateErrors.orgRepoCreationDenied",
    )
    expect(err.localized.key).not.toBe("accept.templateErrors.inOrg")
    expect(err.localized.params).toMatchObject({ org: "cs50", status: 403 })
  })

  it("carries a short, distinct step message for the checklist row", () => {
    const err = orgRepoCreationDeniedError("cs50", 403)

    expect(err.localizedStep.key).toBe(
      "accept.templateErrors.orgRepoCreationDeniedStep",
    )
    expect(err.localizedStep).not.toBe(err.localized)
    // The seven-row checklist can't absorb the full remedy paragraph.
    expect(resolveLocalizedMessage(t, err.localizedStep).length).toBeLessThan(
      resolveLocalizedMessage(t, err.localized).length,
    )
  })

  it("nests GitHub's own words, and omits the clause when absent", () => {
    expect(
      orgRepoCreationDeniedError("cs50", 403, "You need admin access").localized
        .params?.detail,
    ).toEqual({
      key: "accept.templateErrors.githubSaid",
      params: { message: "You need admin access" },
    })
    expect(
      orgRepoCreationDeniedError("cs50", 403).localized.params?.detail,
    ).toBe("")
  })

  it("resolves to copy that hedges, names both controls, and drops the wrong remedy", () => {
    const rendered = resolveLocalizedMessage(
      t,
      orgRepoCreationDeniedError("cs50", 403).localized,
    )

    // R2: the cause is inferred from message text, so the copy must not assert it.
    expect(rendered).toContain("may not allow")
    // R3: ask for private creation only, so the remedy can't widen the org into
    // allowing public student repos.
    expect(rendered).toContain("private (not public)")
    // R4: the remedy can itself no-op on an enterprise-pinned org.
    expect(rendered).toContain("enterprise")
    // R1: the remedy #413 reports as useless must be gone.
    expect(rendered).not.toContain("re-run assignment setup")
    expect(rendered).toContain("cs50")
  })
})
