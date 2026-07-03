import { describe, expect, it } from "vitest"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"

// Regression guard for #71: a query-bearing returnTo (e.g. the ?k= accept key)
// must survive navigation. navigate({ to: returnTo }) folds "?k=..." into the
// pathname; history.push preserves it. Pins the behavior useGithubAuth and the
// /login guard rely on.
function buildTestRouter() {
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" })
  const acceptRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/org/cls/assignments/a1/accept",
    validateSearch: (search: Record<string, unknown>): { k?: string } => ({
      k: typeof search.k === "string" ? search.k : undefined,
    }),
  })
  const routeTree = rootRoute.addChildren([indexRoute, acceptRoute])
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
}

describe("returnTo navigation (query preservation)", () => {
  it("preserves the query string when pushing a deep link via history.push", async () => {
    const router = buildTestRouter()
    await router.load()

    router.history.push("/org/cls/assignments/a1/accept?k=SECRET")
    await router.load()

    expect(router.state.location.pathname).toBe(
      "/org/cls/assignments/a1/accept",
    )
    expect(router.state.location.search).toEqual({ k: "SECRET" })
  })

  it("documents that navigate({ to }) would fold the query into the pathname", () => {
    const router = buildTestRouter()

    const built = router.buildLocation({
      // Cast: the point of this test is passing a raw path+query string, which
      // is not a literal member of the typed route union.
      to: "/org/cls/assignments/a1/accept?k=SECRET" as never,
    })

    // The regression this suite guards against: the query is NOT parsed out.
    expect(built.pathname).toBe("/org/cls/assignments/a1/accept?k=SECRET")
    expect(built.search).toEqual({})
  })
})
