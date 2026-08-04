import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import type { RouterContext } from "./types/router"

export const router = createRouter({
  routeTree,
  // "/" in local dev; set via --base flag in the GitHub Pages build
  basepath: import.meta.env.BASE_URL,
  // Preload a route's component code on hover/touch intent so the code-split
  // chunk is ready by click. Data still loads via each page's useQuery hooks
  // (this app has no route loaders by design), so this warms code, not data —
  // the React-Query-backed top progress bar covers the data-fetch phase.
  defaultPreload: "intent",
  context: {
    auth: {
      user: null,
      status: "loading",
    },
  } satisfies RouterContext,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

export default router
