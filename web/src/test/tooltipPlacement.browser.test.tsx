import { beforeAll, describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "@testing-library/react"

import { HelpTooltip, Tooltip, overlayArenaProps } from "@/components/ui"
import { setupBrowserA11y } from "./browserA11y"

// Tooltip bubbles must stay fully visible wherever the trigger sits. Issue
// #1026: the Grading help icon sat ~120px from the sidebar rail with a 320px
// bubble centered on it, so the bubble's first third was hidden. These run in
// real Chromium because the whole point is measured layout: happy-dom has no
// layout engine, so a happy-dom version would pass with every box at 0.
setupBrowserA11y()

// Desktop width, so the rail + column layout below matches the report.
beforeAll(() => page.viewport(1280, 800))

const LONG_HELP =
  'How this assignment is graded. "Autograded" runs the autograder you configure below. "Manual" lets you enter each student\'s score by hand on the submissions page. "Not graded" records no score.'

const openBubble = () =>
  document.querySelector<HTMLElement>(".tooltip-bubble:popover-open")

async function hoverHelp(name: string) {
  const trigger = page.getByRole("button", { name, exact: true })
  await trigger.hover()
  await expect.poll(openBubble).not.toBeNull()
  const bubble = openBubble()!
  await expect.poll(() => getComputedStyle(bubble).opacity).toBe("1")
  return { trigger: trigger.element() as HTMLElement, bubble }
}

describe("Tooltip stays on screen", () => {
  it("a help icon beside a short label near the viewport edge shows its whole bubble (#1026)", async () => {
    render(
      <div style={{ padding: 16 }}>
        <span className="label font-bold">
          Grading <HelpTooltip help={LONG_HELP} />
        </span>
      </div>,
    )
    const { trigger, bubble } = await hoverHelp(LONG_HELP)
    const t = trigger.getBoundingClientRect()
    const b = bubble.getBoundingClientRect()
    // Fidelity: this trigger really is too close to the edge for a centered
    // bubble, so a regression to daisyUI's centering would fail below.
    expect((t.left + t.right) / 2 - b.width / 2).toBeLessThan(0)
    expect(b.left).toBeGreaterThanOrEqual(0)
    expect(b.right).toBeLessThanOrEqual(window.innerWidth)
    expect(b.top).toBeGreaterThanOrEqual(t.bottom)
  })

  it("stays inside the page column beside a sidebar rail (#1026 layout)", async () => {
    // The app shell: a 240px z-40 rail, then <main> as the tooltip arena with a
    // short field label whose help icon sits ~120px into the column.
    render(
      <div style={{ display: "flex" }}>
        <div
          style={{
            width: 240,
            height: 400,
            flexShrink: 0,
            position: "relative",
            zIndex: 40,
            background: "black",
          }}
        />
        <main style={{ flex: 1, padding: 24 }} {...overlayArenaProps}>
          <span className="label font-bold">
            Grading <HelpTooltip help={LONG_HELP} />
          </span>
        </main>
      </div>,
    )
    const { trigger, bubble } = await hoverHelp(LONG_HELP)
    const t = trigger.getBoundingClientRect()
    const b = bubble.getBoundingClientRect()
    // A centered bubble would start under the rail; the arena keeps it off it.
    expect((t.left + t.right) / 2 - b.width / 2).toBeLessThan(240)
    expect(b.left).toBeGreaterThanOrEqual(240)
    expect(b.right).toBeLessThanOrEqual(window.innerWidth)
  })

  it("is not clipped by an overflow ancestor nor covered by a z-indexed sibling", async () => {
    // A 120px-wide clipping column (modal box / scrolling frame) with a sibling
    // painted over everything to its right, like the sidebar rail does.
    render(
      <div style={{ position: "relative", height: 300 }}>
        <div style={{ width: 120, overflow: "hidden", padding: 8 }}>
          <Tooltip tip={LONG_HELP} position="right">
            <button type="button" aria-label="clipped trigger">
              ?
            </button>
          </Tooltip>
        </div>
        <div
          style={{
            position: "absolute",
            inset: "0 0 0 120px",
            zIndex: 50,
            background: "white",
          }}
        />
      </div>,
    )
    const { bubble } = await hoverHelp("clipped trigger")
    const b = bubble.getBoundingClientRect()
    expect(b.right).toBeGreaterThan(120)
    // Hit-test a point well outside the clipping column and over the
    // z-indexed sibling: the bubble is what paints there.
    bubble.style.pointerEvents = "auto"
    const probe = document.elementFromPoint(
      Math.min(b.right - 8, window.innerWidth - 1),
      (b.top + b.bottom) / 2,
    )
    expect(probe).toBe(bubble)
  })

  it("flips to the other side when the preferred side has no room", async () => {
    render(
      <div
        style={{
          position: "fixed",
          left: 300,
          bottom: 0,
          padding: 4,
        }}
      >
        <HelpTooltip help={LONG_HELP} position="bottom" />
      </div>,
    )
    const { trigger, bubble } = await hoverHelp(LONG_HELP)
    const t = trigger.getBoundingClientRect()
    const b = bubble.getBoundingClientRect()
    expect(bubble.dataset.side).toBe("top")
    expect(b.bottom).toBeLessThanOrEqual(t.top)
    expect(b.top).toBeGreaterThanOrEqual(0)
  })

  it("dismisses on Escape without moving focus and closes on pointer leave", async () => {
    render(
      <div style={{ padding: 40 }}>
        <HelpTooltip help={LONG_HELP} />
        <button type="button">Elsewhere</button>
      </div>,
    )
    const { trigger } = await hoverHelp(LONG_HELP)
    await page.getByRole("button", { name: "Elsewhere", exact: true }).hover()
    await expect.poll(openBubble).toBeNull()

    trigger.focus()
    await expect.poll(openBubble).not.toBeNull()
    await userEvent.keyboard("{Escape}")
    await expect.poll(openBubble).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
