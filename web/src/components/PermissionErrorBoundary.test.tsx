// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { GitHubAPIError } from "@/github-core/errors"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})
// The friendly message renders a RouterButton (createLink) that needs a router
// context; stub just that primitive to a plain anchor so the boundary renders
// without a RouterProvider. Spread the barrel so Alert et al. stay real.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>()
  return {
    ...actual,
    RouterButton: ({ children }: { children: React.ReactNode }) => (
      <a>{children}</a>
    ),
  }
})

import { PermissionErrorBoundary } from "./PermissionErrorBoundary"

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "x",
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

const Boom = ({ error }: { error: unknown }) => {
  throw error
}

afterEach(cleanup)

describe("PermissionErrorBoundary", () => {
  it("renders the friendly message on a 403 from a role-gated read", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <PermissionErrorBoundary>
        <Boom error={apiError(403)} />
      </PermissionErrorBoundary>,
    )
    expect(screen.getByText("permissionDenied.title")).toBeTruthy()
    expect(screen.getByText("permissionDenied.message")).toBeTruthy()
    spy.mockRestore()
  })

  it("renders the friendly message on a 404 (role changed mid-session)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <PermissionErrorBoundary>
        <Boom error={apiError(404)} />
      </PermissionErrorBoundary>,
    )
    expect(screen.getByText("permissionDenied.title")).toBeTruthy()
    spy.mockRestore()
  })

  it("re-throws a non-permission error (unrelated errors still bubble)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() =>
      render(
        <PermissionErrorBoundary>
          <Boom error={new Error("kaboom")} />
        </PermissionErrorBoundary>,
      ),
    ).toThrow(/kaboom/)
    spy.mockRestore()
  })

  it("re-throws a non-403/404 GitHubAPIError (e.g. 500)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() =>
      render(
        <PermissionErrorBoundary>
          <Boom error={apiError(500)} />
        </PermissionErrorBoundary>,
      ),
    ).toThrow()
    spy.mockRestore()
  })

  it("renders children when nothing throws", () => {
    render(
      <PermissionErrorBoundary>
        <div data-testid="child" />
      </PermissionErrorBoundary>,
    )
    expect(screen.getByTestId("child")).toBeTruthy()
  })
})
