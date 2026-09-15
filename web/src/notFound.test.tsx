// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

// Real i18n rather than relying on a transitive import: the translated copy is
// what these assertions check.
import "@/i18n"
import { routeTree } from "./routeTree.gen"
import type { RouterContext } from "./types/router"

afterEach(cleanup)

// Uses the generated tree so the check covers the real root route, not a stub.
const renderAt = (path: string) => {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: {
      auth: { user: null, status: "unauthenticated" },
    } satisfies RouterContext,
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe("root notFoundComponent", () => {
  it("renders the shared not-found page with a way back", async () => {
    renderAt("/no/such/page")
    const heading = await screen.findByRole("heading", {
      name: "Page not found",
    })
    expect(document.title).toBe("Page not found · Classroom 50")
    expect(document.activeElement).toBe(heading)
    expect(
      screen
        .getByRole("link", { name: "Go to dashboard" })
        .getAttribute("href"),
    ).toBe("/")
  })

  it("no longer registers the shell-less /classes and /assignments routes", () => {
    // Those two paths now resolve like any other `/$org` URL instead of
    // rendering a page without the authed shell.
    const paths = (
      (routeTree.children ?? []) as unknown as { fullPath: string }[]
    ).map((route) => route.fullPath)
    expect(paths).toContain("/login")
    expect(paths).not.toContain("/classes")
    expect(paths).not.toContain("/assignments")
  })

  it.each(["/classes", "/assignments"])(
    "%s falls through to the authed guard",
    async (path) => {
      const router = renderAt(path)
      await waitFor(() => expect(router.state.location.pathname).toBe("/login"))
      expect(router.state.location.search).toEqual({ redirect: path })
    },
  )
})
