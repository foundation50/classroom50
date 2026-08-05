// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Alert, Button, Card, FormField } from "@/components/ui"
import {
  NotificationProvider,
  useToast,
  type ToastTone,
} from "@/context/notifications/NotificationProvider"
import { renderAndAxe } from "./axe"
import { documentHasLang, hasSingleH1 } from "@/util/a11yStructural"
import { applyDocumentDirection } from "@/i18n/direction"

// The toast dismiss button reads its accessible name from an i18n key; stub
// useTranslation so the key resolves to itself (mirrors NotificationProvider.test).
vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

afterEach(cleanup)

// Render-based structural checks that back the `automated` VPAT verdicts. These
// assert DOM-observable facts (roles, names, heading structure, ARIA validity)
// on representative accessible primitives. happy-dom has no layout engine, so
// pixel reflow and computed focus rings are NOT asserted here — those criteria
// stay Not Evaluated (see the plan's Open Questions), and the VPAT remarks state
// exactly what was and wasn't machine-checked.

describe("structural a11y — headings", () => {
  it("a well-formed section renders exactly one h1 (2.4.6 / 1.3.1)", () => {
    const { container } = render(
      <div>
        <h1>Accessibility</h1>
        <h2>Color contrast</h2>
        <h2>Conformance report</h2>
      </div>,
    )
    const levels = Array.from(
      container.querySelectorAll("h1,h2,h3,h4,h5,h6"),
    ).map((h) => Number(h.tagName[1]))
    expect(hasSingleH1(levels)).toBe(true)
  })
})

describe("structural a11y — axe-clean primitives (4.1.2 Name, Role, Value)", () => {
  it("Button exposes an accessible name and valid role", async () => {
    const { results } = await renderAndAxe(<Button>Download report</Button>)
    expect(results).toHaveNoViolations()
  })

  it("Alert content carries valid roles/ARIA", async () => {
    const { results } = await renderAndAxe(
      <Alert tone="info">Heads up: this is informational.</Alert>,
    )
    expect(results).toHaveNoViolations()
  })

  it("a Card with a labelled control is violation-free", async () => {
    const { results } = await renderAndAxe(
      <Card>
        <Card.Body>
          <Button aria-label="Open details">i</Button>
        </Card.Body>
      </Card>,
    )
    expect(results).toHaveNoViolations()
  })
})

// The runtime half of the 3.1.1 (Language of Page) binding: the static <html
// lang> in index.html is checked in vpatAutomated.test.ts; this proves the
// i18n layer keeps document.documentElement.lang in sync, so the criterion's
// remark ("...updates it to match the active language at runtime") is fully
// backed by a check and can't silently drift (adversarial finding #1).
describe("structural a11y — 3.1.1 runtime <html lang> sync", () => {
  it("applyDocumentDirection sets a non-empty lang on <html>", () => {
    applyDocumentDirection("en")
    expect(documentHasLang(document.documentElement.lang)).toBe(true)
    expect(document.documentElement.lang).toBe("en")

    applyDocumentDirection("ar-EG")
    expect(documentHasLang(document.documentElement.lang)).toBe(true)
    expect(document.documentElement.lang).toBe("ar-EG")
  })
})

// A minimal consumer that fires one toast of the given tone on click, so the
// check exercises the shipped NotificationProvider path (not private internals).
function FireToast({ tone }: { tone: ToastTone }) {
  const { notify } = useToast()
  return (
    <button onClick={() => notify({ tone, message: "Status." })}>fire</button>
  )
}

// 4.1.3 Status Messages: the toast viewport is a live region — role="alert" with
// aria-live tone-mapped (assertive for errors, polite otherwise), so assistive
// tech announces a status change without moving focus. Structure only (KTD3): no
// timing or visibility is asserted.
describe("structural a11y — 4.1.3 status-message live region", () => {
  it("an error toast is an assertive alert", async () => {
    render(
      <NotificationProvider>
        <FireToast tone="error" />
      </NotificationProvider>,
    )
    await userEvent.click(screen.getByText("fire"))
    const alert = screen.getByRole("alert")
    expect(alert.getAttribute("aria-live")).toBe("assertive")
  })

  it.each(["info", "success", "warning"] as const)(
    "a %s toast is a polite alert",
    async (tone) => {
      render(
        <NotificationProvider>
          <FireToast tone={tone} />
        </NotificationProvider>,
      )
      await userEvent.click(screen.getByText("fire"))
      const alert = screen.getByRole("alert")
      expect(alert.getAttribute("aria-live")).toBe("polite")
    },
  )

  it("keeps an accessible name on the dismiss control", async () => {
    render(
      <NotificationProvider>
        <FireToast tone="info" />
      </NotificationProvider>,
    )
    await userEvent.click(screen.getByText("fire"))
    // common.dismissNotification resolves to itself under the mock above.
    expect(
      screen.getByRole("button", { name: "common.dismissNotification" }),
    ).toBeTruthy()
  })
})

// 3.3.2 Labels or Instructions: FormField programmatically associates its label
// with the control and surfaces required/help affordances.
describe("structural a11y — 3.3.2 form-field label association", () => {
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

  it("uses a provided htmlFor id", () => {
    render(
      <FormField label="Slug" htmlFor="slug">
        {({ id }) => <input id={id} aria-label="Slug" />}
      </FormField>,
    )
    expect(screen.getByLabelText("Slug").id).toBe("slug")
  })

  it("exposes the help affordance's text as its accessible name", () => {
    render(
      <FormField label="Name" help="Your full display name">
        {({ id }) => <input id={id} aria-label="Name" />}
      </FormField>,
    )
    expect(
      screen.getByRole("button", { name: "Your full display name" }),
    ).toBeTruthy()
  })
})

// 3.3.1 Error Identification: an invalid field renders role="alert" error text,
// links it to the control via aria-describedby, and marks the control invalid;
// the non-error branch points aria-describedby at the hint instead.
describe("structural a11y — 3.3.1 form-field error identification", () => {
  it("wires role=alert error text to the control and marks it invalid", () => {
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
    expect(alert.id).toBe("n-error")
    const input = screen.getByLabelText("Name")
    expect(input.getAttribute("aria-describedby")).toBe(alert.id)
    expect(input.getAttribute("aria-invalid")).toBe("true")
  })

  it("points aria-describedby at the hint when there is no error", () => {
    render(
      <FormField label="Name" htmlFor="n" hint="Use lowercase">
        {({ describedById }) => (
          <input id="n" aria-label="Name" aria-describedby={describedById} />
        )}
      </FormField>,
    )
    expect(screen.queryByRole("alert")).toBeNull()
    const hint = screen.getByText("Use lowercase")
    expect(hint.id).toBe("n-hint")
    expect(screen.getByLabelText("Name").getAttribute("aria-describedby")).toBe(
      hint.id,
    )
  })
})
