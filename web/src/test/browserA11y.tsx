import { afterEach, beforeAll } from "vitest"
import { cleanup, render } from "@testing-library/react"
import type { ReactElement } from "react"

// Shared harness for the browser-project a11y layout guards (2.5.8 target size,
// 1.4.10 reflow, 1.4.4 resize text, 1.4.12 text spacing). These run in real
// Chromium via the vitest browser project — happy-dom has no layout engine, so
// measured boxes would all be 0 and the checks would silently pass. This module
// centralizes the setup each guard used to repeat: the app stylesheet import (so
// daisyUI/theme sizes are real), the `sumi` theme on <html>, and cleanup — plus
// the DOM-measurement helpers. Test-infra, mirroring src/test/axe.ts; imported
// only by *.browser.test.tsx, which only the browser project collects.

// Importing the app CSS as a side effect gives the rendered primitives their
// real daisyUI/theme sizing (a bare render would measure unstyled boxes).
import "@/index.css"

/** The narrow-viewport width used by the reflow / resize guards (px). */
export const VIEWPORT = 320

/**
 * Wire the standard browser-guard lifecycle: apply the `sumi` theme to <html>
 * before the suite (daisyUI reads it for real sizing) and clean up the rendered
 * tree after each test. Call once at the top of a guard's module. (Not a React
 * hook despite touching test lifecycle — named without the `use` prefix so the
 * hooks lint rule doesn't misfire on a top-level call.)
 */
export function setupBrowserA11y() {
  beforeAll(() => {
    document.documentElement.setAttribute("data-theme", "sumi")
  })
  afterEach(cleanup)
}

/** An element's measured box in the real layout engine. */
export function rect(el: Element): { width: number; height: number } {
  const r = el.getBoundingClientRect()
  return { width: r.width, height: r.height }
}

/** Measured widths of every descendant element under `root` (reflow checks). */
export function descendantWidths(root: Element): number[] {
  return Array.from(root.querySelectorAll("*")).map(
    (el) => el.getBoundingClientRect().width,
  )
}

/**
 * Render `ui` inside a fixed-width container (default VIEWPORT) so a reflow /
 * resize guard measures against a constrained viewport. Returns the RTL result;
 * the container is the width-constrained wrapper.
 */
export function renderInViewport(ui: ReactElement, width: number = VIEWPORT) {
  return render(<div style={{ width }}>{ui}</div>)
}
