// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"
import { createElement, type PropsWithChildren } from "react"

// useMissingScopes reads the login scope from useGithubAuth and the live
// observed scope from the provider's ObservedContext. A fine-grained session
// has an empty login scope and a null observed header — both must fail open so
// the ScopeWarningBanner never nags a token whose scopes can't be introspected.

const authState = { tokenScope: "" as string }
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => authState,
}))

import {
  GitHubProvider,
  useMissingScopes,
  useHasDeleteRepoScope,
  useDeleteRepoScopeState,
} from "./GitHubProvider"

function wrapper(token: string | null) {
  return ({ children }: PropsWithChildren) =>
    createElement(GitHubProvider, { token }, children)
}

// The gate drives an irreversible action, so never let a scope string leak from
// one case into the next.
beforeEach(() => {
  authState.tokenScope = ""
})

afterEach(cleanup)

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

describe("useDeleteRepoScopeState (honest three-way signal)", () => {
  const state = (tokenScope: string, token = "ghp_xxx") => {
    authState.tokenScope = tokenScope
    return renderHook(() => useDeleteRepoScopeState(), {
      wrapper: wrapper(token),
    }).result.current
  }

  it("reports granted when the scope is present", () => {
    expect(
      state("read:user read:org repo workflow admin:org delete_repo"),
    ).toBe("granted")
  })

  it("reports missing when a readable grant lacks it", () => {
    expect(state("read:user read:org repo workflow admin:org")).toBe("missing")
  })

  it("reports unknown when no scopes are introspectable", () => {
    // A fine-grained PAT sends no X-OAuth-Scopes header; claiming either answer
    // would be a lie, and "granted" is the dangerous one to display.
    expect(state("", "github_pat_xxx")).toBe("unknown")
  })
})

describe("useHasDeleteRepoScope (gate: fails open)", () => {
  it("allows the action when the scope is present", () => {
    authState.tokenScope = "repo delete_repo"
    const { result } = renderHook(() => useHasDeleteRepoScope(), {
      wrapper: wrapper("ghp_xxx"),
    })
    expect(result.current).toBe(true)
  })

  it("blocks the action only when the grant readably lacks it", () => {
    authState.tokenScope = "read:user read:org repo workflow admin:org"
    const { result } = renderHook(() => useHasDeleteRepoScope(), {
      wrapper: wrapper("ghp_xxx"),
    })
    expect(result.current).toBe(false)
  })

  it("fails open on unknown so GitHub stays the authority", () => {
    authState.tokenScope = ""
    const { result } = renderHook(() => useHasDeleteRepoScope(), {
      wrapper: wrapper("github_pat_xxx"),
    })
    expect(result.current).toBe(true)
  })
})
