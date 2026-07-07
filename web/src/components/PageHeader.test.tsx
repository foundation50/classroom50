// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import PageHeader, { OrgLink } from "./PageHeader"

afterEach(cleanup)

describe("PageHeader", () => {
  it("renders the title and omits subtitle/action when not passed", () => {
    render(<PageHeader title="Members" />)
    expect(screen.getByRole("heading", { name: "Members" })).toBeDefined()
  })

  it("renders subtitle and action nodes when passed", () => {
    render(
      <PageHeader
        title="Settings"
        subtitle={<span>manage the org</span>}
        action={<button type="button">Do it</button>}
      />,
    )
    expect(screen.getByText("manage the org")).toBeDefined()
    expect(screen.getByRole("button", { name: "Do it" })).toBeDefined()
  })

  it("shows a skeleton instead of the title while loading", () => {
    const { container } = render(<PageHeader title="Late" loading />)
    expect(screen.queryByRole("heading")).toBeNull()
    expect(container.querySelector(".skeleton")).not.toBeNull()
  })
})

describe("OrgLink", () => {
  it("renders a github link when org is set", () => {
    render(<OrgLink org="acme" href="https://gh/acme" title="Open acme" />)
    const link = screen.getByRole("link", { name: "acme" })
    expect(link.getAttribute("href")).toBe("https://gh/acme")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noreferrer")
    expect(link.getAttribute("title")).toBe("Open acme")
  })

  it("renders plain text (no link) when org is undefined", () => {
    render(<OrgLink org={undefined} href="https://gh/x" title="x" />)
    expect(screen.queryByRole("link")).toBeNull()
  })
})
