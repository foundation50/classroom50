import { describe, expect, it } from "vitest"

import { DEFAULT_GITHUB_SCOPE, ELEVATED_GITHUB_SCOPE } from "./constants"
import { REQUIRED_SCOPES, expandScopes, missingScopes } from "./scopes"

describe("expandScopes", () => {
  it("expands repo to its sub-scopes", () => {
    const have = expandScopes("repo")
    expect(have.has("repo")).toBe(true)
    expect(have.has("repo:status")).toBe(true)
    expect(have.has("public_repo")).toBe(true)
  })

  it("expands admin:org down to read:org", () => {
    const have = expandScopes("admin:org")
    expect(have.has("write:org")).toBe(true)
    expect(have.has("read:org")).toBe(true)
  })

  it("expands user down to read:user", () => {
    expect(expandScopes("user").has("read:user")).toBe(true)
  })

  it("accepts comma- and space-delimited input alike", () => {
    expect(expandScopes("repo, workflow")).toEqual(
      expandScopes("repo workflow"),
    )
  })

  it("keeps unknown scopes as themselves without throwing", () => {
    const have = expandScopes("gist")
    expect(have.has("gist")).toBe(true)
  })
})

describe("missingScopes", () => {
  it("reports nothing missing for the exact required string", () => {
    expect(missingScopes(DEFAULT_GITHUB_SCOPE)).toEqual([])
  })

  it("treats admin:org as covering read:org (implication, not literal match)", () => {
    // read:user repo workflow admin:org — read:org omitted but implied by
    // admin:org.
    const granted = "read:user repo workflow admin:org"
    expect(missingScopes(granted)).toEqual([])
  })

  it("treats a broad real-world grant as fully satisfying", () => {
    // GitHub commonly returns broader top-level scopes; user covers read:user.
    const granted = "user repo workflow admin:org"
    expect(missingScopes(granted)).toEqual([])
  })

  it("does not require delete_repo (it is elevated-only, not a base scope)", () => {
    // A least-privilege base grant must never trip the scope-warning banner
    // just because delete_repo is absent (#655).
    const granted = "read:user read:org repo workflow admin:org"
    expect(missingScopes(granted)).toEqual([])
    expect(REQUIRED_SCOPES).not.toContain("delete_repo")
  })

  it("flags an actually-absent required scope", () => {
    // workflow dropped from the grant.
    const granted = "read:user read:org repo admin:org"
    expect(missingScopes(granted)).toEqual(["workflow"])
  })

  it("reports every required scope for an empty grant", () => {
    expect(missingScopes("")).toEqual(REQUIRED_SCOPES)
  })

  // Drift guard: a captured X-OAuth-Scopes header for a token authorized with
  // DEFAULT_GITHUB_SCOPE (comma-delimited, possibly with implied entries). If
  // GitHub's expansion drifts from SCOPE_IMPLICATIONS such that a required scope
  // no longer resolves, this diff goes non-empty and the test fails — catching a
  // source of spurious production banners.
  it("diffs a captured DEFAULT_GITHUB_SCOPE header to zero missing", () => {
    const capturedHeader =
      "read:org, read:user, repo, workflow, admin:org, write:org"
    expect(missingScopes(capturedHeader)).toEqual([])
  })
})

describe("expandScopes against the elevated contract", () => {
  it("does not see delete_repo in the base scope string", () => {
    expect(expandScopes(DEFAULT_GITHUB_SCOPE).has("delete_repo")).toBe(false)
  })

  it("sees delete_repo in the elevated scope string", () => {
    expect(expandScopes(ELEVATED_GITHUB_SCOPE).has("delete_repo")).toBe(true)
  })

  it("never implies delete_repo from a broader scope", () => {
    // `repo` must not satisfy the deletion gate by implication.
    expect(expandScopes("repo admin:org").has("delete_repo")).toBe(false)
  })
})
