// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { GitHubAPIError } from "@/hooks/github/errors"

// Mock the membership read so the provider's resolution is driven by fixture
// data rather than a live query.
const membershipMock = vi.fn()
vi.mock("@/hooks/useGetOwnOrgMembership", () => ({
  default: (org: string | undefined) => membershipMock(org),
}))

import { OrgRoleProvider, useOrgRole } from "./OrgRoleProvider"

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/user/memberships/orgs/acme",
    message: `boom ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })

const Probe = () => {
  const { orgRole } = useOrgRole()
  return <div data-testid="role">{orgRole}</div>
}

const renderWithMembership = (
  membership: Partial<{
    isSuccess: boolean
    data: { role?: string; state?: string }
    error: unknown
  }>,
) => {
  membershipMock.mockReturnValue({
    isSuccess: false,
    data: undefined,
    error: null,
    ...membership,
  })
  render(
    <OrgRoleProvider org="acme">
      <Probe />
    </OrgRoleProvider>,
  )
  return screen.getByTestId("role").textContent
}

afterEach(() => {
  cleanup()
  membershipMock.mockReset()
})

describe("OrgRoleProvider", () => {
  it("owner for an active admin", () => {
    expect(
      renderWithMembership({
        isSuccess: true,
        data: { role: "admin", state: "active" },
      }),
    ).toBe("owner")
  })

  it("member for a definitive non-admin", () => {
    expect(
      renderWithMembership({
        isSuccess: true,
        data: { role: "member", state: "active" },
      }),
    ).toBe("member")
  })

  it("member on a definitive 403/404", () => {
    expect(renderWithMembership({ error: apiError(404) })).toBe("member")
    cleanup()
    expect(renderWithMembership({ error: apiError(403) })).toBe("member")
  })

  it("unresolved while loading / on a transient error (fail-closed)", () => {
    expect(renderWithMembership({})).toBe("unresolved")
    cleanup()
    expect(renderWithMembership({ error: apiError(500) })).toBe("unresolved")
  })
})

describe("useOrgRole off-route default", () => {
  it("returns unresolved when no provider is mounted (fail-closed)", () => {
    render(<Probe />)
    expect(screen.getByTestId("role").textContent).toBe("unresolved")
  })
})
