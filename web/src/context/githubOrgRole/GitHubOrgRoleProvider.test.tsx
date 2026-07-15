// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { GitHubAPIError } from "@/github-core/errors"

// Mock the membership read so the provider's resolution is driven by fixture
// data rather than a live query.
const membershipMock = vi.fn()
vi.mock("@/hooks/useGetOwnOrgMembership", () => ({
  default: (org: string | undefined) => membershipMock(org),
}))

import {
  GitHubOrgRoleProvider,
  useGitHubOrgRole,
} from "./GitHubOrgRoleProvider"

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
  const { githubOrgRole, isError } = useGitHubOrgRole()
  return (
    <div>
      <div data-testid="role">{githubOrgRole}</div>
      <div data-testid="error">{String(isError)}</div>
    </div>
  )
}

const renderWithMembership = (
  membership: Partial<{
    isSuccess: boolean
    isError: boolean
    data: { role?: string; state?: string }
    error: unknown
    refetch: () => void
  }>,
) => {
  membershipMock.mockReturnValue({
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
    refetch: () => {},
    ...membership,
  })
  render(
    <GitHubOrgRoleProvider org="acme">
      <Probe />
    </GitHubOrgRoleProvider>,
  )
  return screen.getByTestId("role").textContent
}

afterEach(() => {
  cleanup()
  membershipMock.mockReset()
})

describe("GitHubOrgRoleProvider", () => {
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

  it("non-member on a definitive 403/404", () => {
    expect(renderWithMembership({ error: apiError(404) })).toBe("non-member")
    cleanup()
    expect(renderWithMembership({ error: apiError(403) })).toBe("non-member")
  })

  it("unresolved while loading / on a transient error (fail-closed)", () => {
    expect(renderWithMembership({})).toBe("unresolved")
    cleanup()
    expect(renderWithMembership({ error: apiError(500) })).toBe("unresolved")
  })

  it("isError only when a settled transient error leaves the role unresolved", () => {
    // Settled transient error, role still unresolved -> the owner gate shows a
    // retry surface rather than an indefinite spinner.
    renderWithMembership({ isError: true, error: apiError(500) })
    expect(screen.getByTestId("role").textContent).toBe("unresolved")
    expect(screen.getByTestId("error").textContent).toBe("true")
    cleanup()
    // A definitive 403 resolves to `non-member` (roleResolved), so it is NOT an
    // error strand even though the query technically errored.
    renderWithMembership({ isError: true, error: apiError(403) })
    expect(screen.getByTestId("role").textContent).toBe("non-member")
    expect(screen.getByTestId("error").textContent).toBe("false")
  })
})

describe("useGitHubOrgRole off-route default", () => {
  it("returns unresolved when no provider is mounted (fail-closed)", () => {
    render(<Probe />)
    expect(screen.getByTestId("role").textContent).toBe("unresolved")
    expect(screen.getByTestId("error").textContent).toBe("false")
  })
})
