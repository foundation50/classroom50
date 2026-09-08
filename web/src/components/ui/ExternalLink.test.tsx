// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { ExternalLink } from "./ExternalLink"

afterEach(cleanup)

// ExternalLink is the one off-site text-link recipe, so these lock the
// target/rel pair, the three variants, the gap default, and the glyph toggle.
describe("ExternalLink", () => {
  it("opens in a new tab with the referrer withheld, as a daisyUI link", () => {
    render(<ExternalLink href="https://example.org">Docs</ExternalLink>)
    const a = screen.getByRole("link", { name: "Docs" })
    expect(a.getAttribute("href")).toBe("https://example.org")
    expect(a.getAttribute("target")).toBe("_blank")
    expect(a.getAttribute("rel")).toBe("noreferrer")
    expect(a.className).toContain("link")
    expect(a.className).toContain("inline-flex")
    expect(a.className).toContain("gap-1")
    expect(a.querySelector("svg")).not.toBeNull()
  })

  it("drops the glyph on request", () => {
    render(
      <ExternalLink href="https://example.org" icon={false}>
        Docs
      </ExternalLink>,
    )
    expect(screen.getByRole("link").querySelector("svg")).toBeNull()
  })

  it("muted and plain variants leave the daisyUI link class off", () => {
    render(
      <>
        <ExternalLink href="https://a.test" variant="muted">
          A
        </ExternalLink>
        <ExternalLink href="https://b.test" variant="plain">
          B
        </ExternalLink>
      </>,
    )
    const muted = screen.getByRole("link", { name: "A" })
    const plain = screen.getByRole("link", { name: "B" })
    expect(muted.className.split(" ")).not.toContain("link")
    expect(muted.className).toContain("hover:text-primary")
    expect(plain.className.split(" ")).not.toContain("link")
    expect(plain.className).toContain("inline-flex")
  })

  // cx can't merge Tailwind classes, so a caller's gap must replace, not join,
  // the default.
  it("yields the gap to a caller that sets one", () => {
    render(
      <ExternalLink href="https://example.org" className="gap-1.5">
        Docs
      </ExternalLink>,
    )
    const classes = screen.getByRole("link").className.split(" ")
    expect(classes).toContain("gap-1.5")
    expect(classes).not.toContain("gap-1")
  })

  // A note's follow-up link sits on its own line under the message; the
  // caller says so with `flex`, and the primitive must not fight it.
  it("yields inline-flex to a caller that sets flex", () => {
    render(
      <ExternalLink href="https://example.org" className="mt-1 flex">
        Docs
      </ExternalLink>,
    )
    const classes = screen.getByRole("link").className.split(" ")
    expect(classes).toContain("flex")
    expect(classes).not.toContain("inline-flex")
  })
})
