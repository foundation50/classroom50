// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

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
}

describe("root notFoundComponent", () => {
  it("renders the translated not-found page with a way home", async () => {
    renderAt("/no/such/page")
    await screen.findByRole("heading", { name: "Page not found" })
    expect(
      screen.getByRole("link", { name: "Go to home" }).getAttribute("href"),
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
})
