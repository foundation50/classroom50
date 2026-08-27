import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"

import { ConfirmModal } from "@/components/modals"
import { setupBrowserA11y } from "@/test/browserA11y"

setupBrowserA11y()

// Regression for the real-world case: a dialog opened from a table header
// inherits daisyUI's `.table :where(thead,tfoot){white-space:nowrap}`, which
// put every paragraph on one line and let the modal box clip it.
describe("modal opened from a table header", () => {
  it("wraps its prose despite the inherited nowrap", async () => {
    render(
      <table className="table">
        <thead>
          <tr>
            <th>
              <ConfirmModal
                open
                title="Delete 65 assignments?"
                description="This removes the selected assignments from the classroom's assignments.json in a single commit. Student repositories and their submissions are NOT deleted."
                dangerous
                needsConfirm
                confirmText="delete"
                onConfirm={async () => {}}
                onClose={() => {}}
              />
            </th>
          </tr>
        </thead>
      </table>,
    )
    await new Promise((r) => setTimeout(r, 60))

    const box = document.querySelector(".modal-box") as HTMLElement
    const boxWidth = box.getBoundingClientRect().width
    // Every block inside the box must fit it — no horizontal overflow.
    for (const el of box.querySelectorAll<HTMLElement>("div,p")) {
      expect(el.scrollWidth).toBeLessThanOrEqual(Math.ceil(boxWidth))
      expect(getComputedStyle(el).whiteSpace).not.toBe("nowrap")
    }
  })
})
