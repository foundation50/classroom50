// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { createElement, type PropsWithChildren } from "react"

// useMissingScopes reads the login scope from useGithubAuth and the live
// observed scope from the provider's ObservedContext. A fine-grained session
// has an empty login scope and a null observed header — both must fail open so
// the ScopeWarningBanner never nags a token whose scopes can't be introspected.

const authState = { tokenScope: "" as string }
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => authState,
}))

import { GitHubProvider, useMissingScopes, useHasDeleteRepoScope } from "./GitHubProvider"

function wrapper(token: string | null) {
  return ({ children }: PropsWithChildren) =>
    createElement(GitHubProvider, { token }, children)
}

describe("useMissingScopes (fail-open backstop)", () => {
  it("returns [] for a fine-grained session (empty login scope, no observation)", () => {
    authState.tokenScope = ""
    const { result } = renderHook(() => useMissingScopes(), {
      wrapper: wrapper("github_pat_xxx"),
    })
    expect(result.current).toEqual([])
  })

  it("still reports missing scopes for an under-scoped classic session", () => {
    authState.tokenScope = "repo"
    const { result } = renderHook(() => useMissingScopes(), {
      wrapper: wrapper("ghp_xxx"),
    })
    // A real classic grant that's missing scopes must still surface them.
    expect(result.current.length).toBeGreaterThan(0)
  })
})

describe("useHasDeleteRepoScope (gate for elevated teardown)", () => {
  it("returns true when the login scope carries delete_repo", () => {
    authState.tokenScope = "read:user read:org repo workflow admin:org delete_repo"
    const { result } = renderHook(() => useHasDeleteRepoScope(), {
      wrapper: wrapper("ghp_xxx"),
    })
    expect(result.current).toBe(true)
  })

  it("returns false for a positively-scoped classic token without delete_repo", () => {
    authState.tokenScope = "read:user read:org repo workflow admin:org"
    const { result } = renderHook(() => useHasDeleteRepoScope(), {
      wrapper: wrapper("ghp_xxx"),
    })
    expect(result.current).toBe(false)
  })

  it("fails open (true) for a fine-grained session with no introspectable scopes", () => {
    // A fine-grained PAT can delete via Administration: write but reports no
    // X-OAuth-Scopes header, so we must not nag it with an OAuth-only prompt.
    authState.tokenScope = ""
    const { result } = renderHook(() => useHasDeleteRepoScope(), {
      wrapper: wrapper("github_pat_xxx"),
    })
    expect(result.current).toBe(true)
  })
})
