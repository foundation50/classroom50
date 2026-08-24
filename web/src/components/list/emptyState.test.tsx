// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { EmptyState, NoSearchResults } from "./index"

afterEach(cleanup)

// EmptyState is the single Blankslate implementation every empty state now
// renders through, so these lock the slot contract: title/body/action/icon
// wrappers appear only when passed, className merges onto the variant shell,
// and the bare variant drops the dashed card.
describe("EmptyState", () => {
  it("renders the title and omits body/action when not passed", () => {
    render(<EmptyState title="Nothing here" />)
    expect(screen.getByRole("heading", { name: "Nothing here" })).toBeDefined()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("renders body and action when passed", () => {
    render(
      <EmptyState
        title="Empty"
        body="Add something to get started"
        action={<button type="button">Do it</button>}
      />,
    )
    expect(screen.getByText("Add something to get started")).toBeDefined()
    expect(screen.getByRole("button", { name: "Do it" })).toBeDefined()
  })

  it("merges className onto the card shell", () => {
    const { container } = render(<EmptyState title="Custom" className="mt-4" />)
    const root = container.firstElementChild
    expect(root?.className).toContain("mt-4")
    expect(root?.className).toContain("border-dashed")
  })

  it("drops the card shell in the bare variant", () => {
    const { container } = render(<EmptyState title="Bare" variant="bare" />)
    expect(container.firstElementChild?.className).not.toContain(
      "border-dashed",
    )
  })

  it("renders the icon in the standard muted circle, hidden from AT", () => {
    const Probe = (props: { className?: string }) => (
      <svg data-testid="probe" {...props} />
    )
    render(<EmptyState title="With icon" icon={Probe} />)
    const icon = screen.getByTestId("probe")
    expect(icon.getAttribute("aria-hidden")).toBe("true")
    expect(icon.parentElement?.className).toContain("rounded-full")
  })

  it("supports a body-only empty state without a heading", () => {
    render(<EmptyState body="Nothing matched" />)
    expect(screen.queryByRole("heading")).toBeNull()
    expect(screen.getByText("Nothing matched")).toBeDefined()
  })
})

describe("NoSearchResults", () => {
  it("renders the labels and fires onClear when the clear button is clicked", async () => {
    const onClear = vi.fn()
    render(
      <NoSearchResults
        title="No results"
        body="Nothing matched your search"
        clearLabel="Clear search"
        onClear={onClear}
      />,
    )
    expect(screen.getByRole("heading", { name: "No results" })).toBeDefined()
    expect(screen.getByText("Nothing matched your search")).toBeDefined()
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
