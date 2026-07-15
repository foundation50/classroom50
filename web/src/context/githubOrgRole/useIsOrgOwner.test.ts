// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

const orgRoleMock = vi.fn()
vi.mock("@/context/githubOrgRole/GitHubOrgRoleProvider", () => ({
  useGitHubOrgRole: () => orgRoleMock(),
}))

import { useIsOrgOwner } from "./useIsOrgOwner"

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
