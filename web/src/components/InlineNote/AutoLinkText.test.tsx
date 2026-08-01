// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { AutoLinkText } from "./index"

afterEach(() => {
  cleanup()
})

describe("AutoLinkText", () => {
  it("renders a bare URL as an anchor with the URL as href", () => {
    render(
      <AutoLinkText text="See https://docs.github.com/articles/x for help" />,
    )
    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toBe("https://docs.github.com/articles/x")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noreferrer")
  })

  it("keeps surrounding text as-is", () => {
    const { container } = render(
      <AutoLinkText text="before https://example.com after" />,
    )
    expect(container.textContent).toBe("before https://example.com after")
  })

  it("trims a trailing sentence period out of the href but keeps it visible", () => {
    const { container } = render(
      <AutoLinkText text="Visit https://github.com/foo/bar/. Thanks." />,
    )
    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toBe("https://github.com/foo/bar/")
    expect(link.textContent).toBe("https://github.com/foo/bar/")
    // The period stays in the rendered text, just outside the link.
    expect(container.textContent).toContain("bar/. Thanks.")
  })

  it("renders plain text with no URL and no anchor", () => {
    render(<AutoLinkText text="no links here" />)
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("links a URL at the very start of the text", () => {
    const { container } = render(
      <AutoLinkText text="https://example.com is the docs" />,
    )
    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toBe("https://example.com")
    expect(container.textContent).toBe("https://example.com is the docs")
  })

  it("links every URL when several appear in one string", () => {
    render(
      <AutoLinkText text="see https://a.example.com and https://b.example.com now" />,
    )
    const links = screen.getAllByRole("link")
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ])
  })

  it("links GitHub's OAuth-restriction message docs URL", () => {
    render(
      <AutoLinkText text="the `acme` organization has enabled OAuth App access restrictions. visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/" />,
    )
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://docs.github.com/articles/restricting-access-to-your-organization-s-data/",
    )
  })
})
