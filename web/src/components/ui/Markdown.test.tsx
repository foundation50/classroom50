// @vitest-environment happy-dom
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import { act, render, screen, cleanup, waitFor } from "@testing-library/react"

import type { Markdown as MarkdownComponent } from "./Markdown"

// Observe the lazy chunk import itself: the DOM cannot tell the Suspense
// fallback from the real renderer on math-free text, so "did KaTeX load" has
// to be measured here. `failMathChunk` simulates a stale chunk hash after a
// deploy. React caches a lazy import per module instance, so every test gets
// a fresh Markdown module.
let mathChunkLoaded = false
let failMathChunk = false
let Markdown: typeof MarkdownComponent
beforeEach(async () => {
  mathChunkLoaded = false
  failMathChunk = false
  vi.resetModules()
  vi.doMock("./MarkdownMath", async (importOriginal) => {
    mathChunkLoaded = true
    if (failMathChunk) {
      throw new Error("Failed to fetch dynamically imported module")
    }
    return importOriginal()
  })
  ;({ Markdown } = await import("./Markdown"))
})
afterEach(cleanup)

const flushImports = () => act(async () => {})

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

  it("renders a literal dollar inside math, in both of GitHub's forms", async () => {
    const { container } = render(
      <Markdown
        content={"Backtick $`\\text{$}`$ and plain $\\sqrt{\\$4}$ forms"}
      />,
    )
    await waitFor(() =>
      expect(container.querySelectorAll(".katex")).toHaveLength(2),
    )
    expect(container.querySelector(".katex-error")).toBeNull()
    expect(container.querySelector(".katex-display")).toBeNull()
    // Nothing of either expression leaked out as prose: only the text nodes
    // that are direct children of the paragraph count, not KaTeX's output.
    const prose = Array.from(container.querySelectorAll("p"))
      .flatMap((p) => Array.from(p.childNodes))
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("")
    expect(prose).toBe("Backtick  and plain  forms")
  })

  it("copies indented code blocks through without adding escapes", () => {
    const { container } = render(
      <Markdown content={"Run:\n\n    echo $5 and $10\n    ls $HOME"} />,
    )
    expect(container.querySelector("pre")?.textContent).toBe(
      "echo $5 and $10\nls $HOME\n",
    )
  })

  it("keeps a dollar inside an autolink URL", () => {
    render(<Markdown content="see <https://example.com/?a=$5&b=6>" />)
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://example.com/?a=$5&b=6",
    )
  })

  it("caps glyph size and macro expansion for pathological input", async () => {
    const { container } = render(
      <Markdown
        content={String.raw`$\rule{5000em}{1em}$ and $\def\x{\x\x}\x$`}
      />,
    )
    await waitFor(() =>
      expect(container.querySelector(".katex-error")).not.toBeNull(),
    )
    // maxSize clamps the 5000em rule to 500em; without it KaTeX emits 5000em.
    const rule = container.querySelector<HTMLElement>(".rule")
    expect(rule?.style.borderRightWidth).toBe("500em")
    // maxExpand turns the infinite \def loop into an error chip.
    expect(container.querySelector(".katex-error")?.textContent).toContain(
      "\\def",
    )
  })

  it("renders footnotes as in-page links with a hidden, labelled heading", async () => {
    const { container } = render(
      <Markdown content={"text[^1]\n\n[^1]: the note"} />,
    )
    const ref = container.querySelector("sup a")
    expect(ref?.getAttribute("href")).toBe("#user-content-fn-1")
    expect(ref?.getAttribute("id")).toBe("user-content-fnref-1")
    expect(ref?.getAttribute("aria-describedby")).toBe("footnote-label")
    expect(ref?.getAttribute("target")).toBeNull()

    const heading = container.querySelector("h2")
    expect(heading?.id).toBe("footnote-label")
    expect(heading?.className).toContain("sr-only")
    expect(heading?.textContent).toBe("components.markdown.footnotes")

    const back = container.querySelector('a[href="#user-content-fnref-1"]')
    expect(back).not.toBeNull()
    expect(back?.getAttribute("aria-label")).toBe(
      "components.markdown.backToReference",
    )
    await flushImports()
    expect(mathChunkLoaded).toBe(false)
  })

  it("does not load the math renderer for text without math", async () => {
    const { container } = render(
      <Markdown
        content={
          "Just **bold** words, `echo $HOME`, and\n\n```sh\necho $5\n```"
        }
      />,
    )
    expect(container.querySelector("strong")?.textContent).toBe("bold")
    await flushImports()
    expect(mathChunkLoaded).toBe(false)
    expect(container.querySelector(".katex")).toBeNull()
  })

  it("loads the math renderer once the text has math", async () => {
    const { container } = render(<Markdown content="so $x^2$ is math" />)
    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    )
    expect(mathChunkLoaded).toBe(true)
  })

  it("falls back to the plain renderer when the math chunk fails to load", async () => {
    failMathChunk = true
    const { container } = render(<Markdown content="so $x^2$ is math" />)
    await flushImports()
    expect(mathChunkLoaded).toBe(true)
    expect(container.querySelector(".katex")).toBeNull()
    // The source stays readable as a code chip instead of an error page.
    expect(container.querySelector("code")?.textContent).toBe("x^2")
    expect(container.textContent).toContain("is math")
  })
})
