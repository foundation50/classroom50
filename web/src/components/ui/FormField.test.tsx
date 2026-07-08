// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { FormField } from "./FormField"

afterEach(cleanup)

// FormField is the one field wrapper unifying the label + error + helper markup,
// so these lock the a11y wiring: label->control association, required marker,
// error (role=alert) with aria-describedby, and helper text swap.
describe("FormField", () => {
  it("links the label to the control via the generated id", () => {
    render(
      <FormField label="Name">
        {({ id }) => <input id={id} aria-label="Name" />}
      </FormField>,
    )
    const input = screen.getByLabelText("Name")
    const label = screen.getByText("Name")
    expect(label.getAttribute("for")).toBe(input.id)
    expect(input.id).toBeTruthy()
  })

  it("uses the provided htmlFor id", () => {
    render(
      <FormField label="Slug" htmlFor="slug">
        {({ id }) => <input id={id} aria-label="Slug" />}
      </FormField>,
    )
    expect(screen.getByLabelText("Slug").id).toBe("slug")
  })

  it("renders the required marker", () => {
    render(
      <FormField label="Name" required>
        {({ id }) => <input id={id} aria-label="Name" />}
      </FormField>,
    )
    expect(screen.getByText("*")).toBeDefined()
  })

  it("shows an error with role=alert and wires aria-describedby + invalid", () => {
    render(
      <FormField label="Name" htmlFor="n" error="Required">
        {({ describedById, invalid }) => (
          <input
            id="n"
            aria-label="Name"
            aria-describedby={describedById}
            aria-invalid={invalid}
          />
        )}
      </FormField>,
    )
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toBe("Required")
    const input = screen.getByLabelText("Name")
    expect(input.getAttribute("aria-describedby")).toBe(alert.id)
    expect(input.getAttribute("aria-invalid")).toBe("true")
  })

  it("shows helper text (not an alert) when there is no error", () => {
    render(
      <FormField label="Name" htmlFor="n" hint="Use lowercase">
        {({ describedById }) => (
          <input id="n" aria-label="Name" aria-describedby={describedById} />
        )}
      </FormField>,
    )
    expect(screen.queryByRole("alert")).toBeNull()
    const hint = screen.getByText("Use lowercase")
    expect(screen.getByLabelText("Name").getAttribute("aria-describedby")).toBe(
      hint.id,
    )
  })
})
