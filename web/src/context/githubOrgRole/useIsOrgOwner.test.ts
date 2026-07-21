// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

const orgRoleMock = vi.fn()
vi.mock("@/context/githubOrgRole/GitHubOrgRoleProvider", () => ({
  useGitHubOrgRole: () => orgRoleMock(),
}))

import { useIsOrgOwner, useCanAttemptTemplateGrant } from "./useIsOrgOwner"

const retry = vi.fn()

const withOrgRole = (
  value: Partial<{
    githubOrgRole: string
    isError: boolean
    retry: () => void
  }>,
) => {
  orgRoleMock.mockReturnValue({
    githubOrgRole: "unresolved",
    isError: false,
    retry,
    ...value,
  })
  return renderHook(() => useIsOrgOwner()).result.current
}

afterEach(() => {
  orgRoleMock.mockReset()
  retry.mockReset()
})

describe("useIsOrgOwner", () => {
  it("owner => isOwner, not pending, not error", () => {
    expect(withOrgRole({ githubOrgRole: "owner" })).toEqual({
      isOwner: true,
      isPending: false,
      isError: false,
      retry,
    })
  })

  it("member => not owner, not pending", () => {
    const r = withOrgRole({ githubOrgRole: "member" })
    expect(r.isOwner).toBe(false)
    expect(r.isPending).toBe(false)
  })

  it("unresolved (in flight) => pending, not owner, not error", () => {
    expect(withOrgRole({ githubOrgRole: "unresolved" })).toEqual({
      isOwner: false,
      isPending: true,
      isError: false,
      retry,
    })
  })

  it("unresolved + isError (settled) => error surface, not pending, retry passthrough", () => {
    const r = withOrgRole({ githubOrgRole: "unresolved", isError: true })
    expect(r.isOwner).toBe(false)
    expect(r.isPending).toBe(false)
    expect(r.isError).toBe(true)
    expect(r.retry).toBe(retry)
  })
})

const attemptWithOrgRole = (
  value: Partial<{ githubOrgRole: string; isError: boolean }>,
) => {
  orgRoleMock.mockReturnValue({
    githubOrgRole: "unresolved",
    isError: false,
    retry,
    ...value,
  })
  return renderHook(() => useCanAttemptTemplateGrant()).result.current
}

describe("useCanAttemptTemplateGrant", () => {
  it("owner => attempt the grant", () => {
    expect(attemptWithOrgRole({ githubOrgRole: "owner" })).toBe(true)
  })

  // The fix for the org-role-pending race: a not-yet-confirmed role must NOT be
  // treated as a confirmed non-owner, or a real owner mid-load skips the
  // student-team grant and sees the misleading owner-required warning.
  it("unresolved (in flight) => attempt (real owner mustn't be demoted)", () => {
    expect(attemptWithOrgRole({ githubOrgRole: "unresolved" })).toBe(true)
  })

  it("unresolved + settled error => attempt (grant path fails soft, never throws)", () => {
    expect(
      attemptWithOrgRole({ githubOrgRole: "unresolved", isError: true }),
    ).toBe(true)
  })

  it("confirmed member => do not attempt (owner-required warning is accurate)", () => {
    expect(attemptWithOrgRole({ githubOrgRole: "member" })).toBe(false)
  })

  it("confirmed non-member => do not attempt", () => {
    expect(attemptWithOrgRole({ githubOrgRole: "non-member" })).toBe(false)
  })
})
