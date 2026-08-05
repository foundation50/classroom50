// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { Alert, Button, Card } from "@/components/ui"
import { renderAndAxe } from "./axe"
import { hasSingleH1 } from "@/util/a11yStructural"

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
