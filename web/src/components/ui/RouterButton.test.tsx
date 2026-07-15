// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"

import { RouterButton } from "./RouterButton"

afterEach(cleanup)

// `to` is typed against the app's generated route tree (module augmentation),
// but this suite renders an isolated in-memory tree, so relax the path type to
// a plain string for the ad-hoc `/target` route. Behavior is unaffected.
const TestButton = RouterButton as (props: {
  to: string
  variant?: "primary"
  size?: "sm"
  className?: string
  children?: React.ReactNode
}) => React.ReactElement

// RouterButton is createLink(Button): a router <Link> that wears the Button
// recipe. These lock that it renders an <a> with the resolved href and the
// same variant/size mapping Button uses, so the ~ handful of Link-as-button
// sites converge on one primitive instead of hand-written `<Link class="btn">`.
function renderInRouter(node: React.ReactNode) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{node}</>,
  })
  const targetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/target",
    component: () => <div>target</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, targetRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router} />)
}

describe("RouterButton", () => {
  it("renders an anchor with the resolved href", async () => {
    renderInRouter(<TestButton to="/target">Go</TestButton>)
    const link = await screen.findByRole("link", { name: "Go" })
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("href")).toBe("/target")
  })

  it("wears the Button recipe (variant + size map to daisyUI modifiers)", async () => {
    renderInRouter(
      <TestButton to="/target" variant="primary" size="sm">
        Styled
      </TestButton>,
    )
    const cls = (await screen.findByRole("link", { name: "Styled" })).className
    expect(cls).toContain("btn")
    expect(cls).toContain("btn-primary")
    expect(cls).toContain("btn-sm")
  })

  it("keeps the className escape hatch for layout utilities", async () => {
    renderInRouter(
      <TestButton to="/target" className="w-full">
        Wide
      </TestButton>,
    )
    expect(
      (await screen.findByRole("link", { name: "Wide" })).className,
    ).toContain("w-full")
  })
})
