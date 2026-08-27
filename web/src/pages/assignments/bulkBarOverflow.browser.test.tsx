import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"

import { setupBrowserA11y } from "@/test/browserA11y"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock("@/hooks/mutations/useBulkAssignmentActions", () => ({
  useBulkSetAssignmentLock: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBulkDeleteAssignments: () => ({ mutateAsync: vi.fn(), isPending: false }),
  // Imported by the reuse modal, which the bar only mounts once opened.
  useBulkReuseAssignments: () => ({
    running: false,
    processed: 0,
    total: 0,
    outcomes: [],
    run: vi.fn(),
  }),
}))

import { AssignmentsBulkBar } from "./AssignmentsBulkBar"
import type { Assignment } from "@/types/classroom"

setupBrowserA11y()

const selected = [{ slug: "hw1", name: "Homework 1" }] as Assignment[]

// The bar lives in a `<td colSpan>` inside a table that scrolls horizontally
// once its columns outgrow the window. Measured in Chromium before the sticky
// pins existed: at a 1200-1300px scrollport the right-aligned actions sat
// past the visible edge, so the selection announced a count with every button
// unreachable. happy-dom cannot see this — it does not lay out.
describe("bulk bar inside a horizontally scrolling table", () => {
  it("keeps the count and the actions inside the scrollport", async () => {
    const { container } = render(
      <div className="overflow-x-auto" style={{ width: "600px" }}>
        <table className="table" style={{ width: "1800px" }}>
          <thead>
            <tr>
              <th className="w-0">
                <span className="sr-only">select</span>
              </th>
              <td colSpan={7}>
                <AssignmentsBulkBar
                  org="acme"
                  classroom="cs50"
                  selected={selected}
                  onClearSelection={() => {}}
                />
              </td>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>row</td>
              <td colSpan={7} style={{ width: "1800px" }}>
                wide
              </td>
            </tr>
          </tbody>
        </table>
      </div>,
    )

    const frame = container.querySelector<HTMLElement>(".overflow-x-auto")!
    expect(frame.scrollWidth).toBeGreaterThan(frame.clientWidth)

    const inFrame = (el: Element) => {
      const f = frame.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return r.left >= f.left - 1 && r.right <= f.right + 1
    }
    // Found by role and content, never by the utility classes that implement
    // the pinning — otherwise a rename would fail the test while the layout
    // stayed correct, and the measurement below would never run.
    const count = [...container.querySelectorAll("span")].find((el) =>
      el.textContent?.startsWith("assignments.bulk.selectedCount"),
    )!
    const lock = container.querySelector<HTMLElement>(
      '[aria-label="assignments.bulk.lock"]',
    )!
    const actions = lock.parentElement!

    // Scrolled hard right — the far end of the table, where the un-pinned
    // version left the buttons behind.
    frame.scrollLeft = frame.scrollWidth
    await new Promise((r) => requestAnimationFrame(() => r(null)))

    expect(inFrame(count)).toBe(true)
    expect(inFrame(actions)).toBe(true)
    expect(actions.querySelectorAll("button").length).toBeGreaterThan(0)
  })
})
