// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

import { Button } from "@/components/ui"
import { renderAndAxe } from "./axe"

afterEach(cleanup)

// Proves the harness both passes clean markup AND actually catches a violation —
// a matcher that silently passed everything would make every `automated` verdict
// worthless.
describe("renderAndAxe", () => {
  it("reports zero violations for an accessible primitive", async () => {
    const { results } = await renderAndAxe(<Button>Save</Button>)
    expect(results).toHaveNoViolations()
  })

  it("catches a real violation (an informative image with no alt)", async () => {
    // eslint-disable-next-line jsx-a11y/alt-text -- deliberate violation fixture
    const { results } = await renderAndAxe(<img src="/x.png" />)
    expect(results.violations.length).toBeGreaterThan(0)
    expect(results.violations.map((v) => v.id)).toContain("image-alt")
  })
})
