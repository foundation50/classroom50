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

import { GitHubProvider, useMissingScopes } from "./GitHubProvider"

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
