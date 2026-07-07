// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { EmptyState, NoSearchResults } from "./index"

afterEach(cleanup)

// EmptyState is the single dashed-card implementation every empty state now
// renders through, so these lock the slot contract: title is always present,
// body/action wrappers appear only when passed, and className fully overrides
// the default shell.
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

  it("replaces the default shell class when className is provided", () => {
    const { container } = render(
      <EmptyState title="Custom" className="my-shell" />,
    )
    const root = container.firstElementChild
    expect(root?.className).toBe("my-shell")
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
