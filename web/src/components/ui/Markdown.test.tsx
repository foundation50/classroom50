// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"

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
    expect(container.querySelector("code")?.className).toContain(
      "bg-base-300/50",
    )
  })

  it("renders GitHub Flavored Markdown: tables, strikethrough, task lists", () => {
    const { container } = render(
      <Markdown
        content={
          "| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~\n\n- [x] done\n- [ ] todo"
        }
      />,
    )
    expect(container.querySelector("table")).not.toBeNull()
    expect(container.querySelector("del")?.textContent).toBe("old")
    const boxes = container.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]",
    )
    expect(boxes).toHaveLength(2)
    expect(boxes[0].checked).toBe(true)
    expect(boxes[0].disabled).toBe(true)
  })

  it("renders $$ display and $ inline math with KaTeX (MathML + HTML)", async () => {
    const { container } = render(
      <Markdown
        content={String.raw`Mid $c=\frac{a+b}{2}$ then

$$
S(a,b)=\frac{b-a}{6}\left[f(a)+4f(c)+f(b)\right].
$$`}
      />,
    )
    await waitFor(() =>
      expect(container.querySelector(".katex-display")).not.toBeNull(),
    )
    expect(container.querySelectorAll(".katex")).toHaveLength(2)
    expect(container.querySelector("math")).not.toBeNull()
    expect(
      container.querySelector(".katex-html")?.getAttribute("aria-hidden"),
    ).toBe("true")
    expect(container.querySelector(".katex-error")).toBeNull()
  })

  it("renders a ```math fence as display math", async () => {
    const { container } = render(
      <Markdown content={"```math\n\\frac{a}{b}\n```"} />,
    )
    await waitFor(() =>
      expect(container.querySelector(".katex-display")).not.toBeNull(),
    )
  })

  it("keeps dollar amounts as prose, matching GitHub", async () => {
    const { container } = render(
      <Markdown content={"Costs $5 and $10 each, so $x^2$ is math"} />,
    )
    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    )
    expect(container.querySelectorAll(".katex")).toHaveLength(1)
    expect(container.textContent).toContain("Costs $5 and $10 each")
  })

  it("never turns a math macro into a link or an element", async () => {
    const { container } = render(
      <Markdown
        content={String.raw`$\href{javascript:alert(1)}{x}$ and $\includegraphics{x.png}$`}
      />,
    )
    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    )
    expect(container.querySelector("a")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
  })

  it("shows the source instead of crashing on invalid LaTeX", async () => {
    const { container } = render(<Markdown content={String.raw`$\frac{$`} />)
    await waitFor(() =>
      expect(container.querySelector(".katex-error")).not.toBeNull(),
    )
    expect(container.textContent).toContain("\\frac{")
  })

  it("does not load the math renderer for plain text", () => {
    const { container } = render(<Markdown content="Just **bold** words" />)
    expect(container.querySelector("strong")?.textContent).toBe("bold")
    expect(container.querySelector(".katex")).toBeNull()
  })
})
