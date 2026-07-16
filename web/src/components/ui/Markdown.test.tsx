// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Markdown } from "./Markdown"

afterEach(cleanup)

describe("Markdown", () => {
  it("drops embedded raw HTML instead of rendering it (no rehype-raw)", () => {
    const { container } = render(
      <Markdown
        content={`<img src=x onerror="alert(1)"> <script>alert(1)</script> plain`}
      />,
    )
    // Raw HTML is converted to inert text, never real elements: no <img>/<script>
    // node exists and nothing carries the onerror handler as a live attribute.
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("[onerror]")).toBeNull()
    expect(container.textContent).toContain("plain")
  })

  it("renders an http(s) link in a new tab with rel=noreferrer", () => {
    render(<Markdown content="[go](https://example.com)" />)
    const link = screen.getByRole("link", { name: "go" })
    expect(link.getAttribute("href")).toBe("https://example.com")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noreferrer")
  })

  it("degrades an unsafe link scheme to inert text, not an anchor", () => {
    render(<Markdown content="[x](javascript:alert(1))" />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("x").tagName).toBe("SPAN")
  })

  it("does not leak react-markdown's node prop onto the anchor DOM element", () => {
    const { container } = render(
      <Markdown content="[go](https://example.com)" />,
    )
    const link = container.querySelector("a")
    expect(link).not.toBeNull()
    expect(link?.getAttribute("node")).toBeNull()
  })

  it("maps markdown structure to the styled elements", () => {
    const { container } = render(
      <Markdown content={"# Title\n\n- one\n\n`code`"} />,
    )
    expect(container.querySelector("h1")?.className).toContain("text-xl")
    expect(container.querySelector("ul")?.className).toContain("list-disc")
    expect(container.querySelector("code")?.className).toContain("bg-base-200")
  })
})
