// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { InlineMessage } from "./InlineMessage"

afterEach(cleanup)

describe("InlineMessage", () => {
  it("renders the warning tone with the text-safe token, not the on-fill token", () => {
    render(<InlineMessage tone="warning">not a template</InlineMessage>)
    const el = screen.getByText("not a template").closest("p")!
    expect(el.className).toContain("text-warning")
    expect(el.className).not.toContain("warning-content")
    expect(el.querySelector("svg")).toBeTruthy()
  })

  it("defaults to the neutral tone and appends className last", () => {
    render(<InlineMessage className="mt-2">note</InlineMessage>)
    const el = screen.getByText("note").closest("p")!
    expect(el.className).toContain("text-base-content/70")
    expect(el.className.endsWith("mt-2")).toBe(true)
  })
})
