import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import type { CSSProperties } from "react"

import { Card } from "@/components/ui"
import { setupBrowserA11y } from "./browserA11y"

// 1.4.12 Text Spacing: no loss of content when the user overrides line-height to
// 1.5x, paragraph spacing to 2x, letter-spacing to 0.12em, and word-spacing to
// 0.16em. Measured in real Chromium (happy-dom has no layout, so injected spacing
// never changes box sizes and the check would silently pass). Representative-
// sample scope (KTD5): proves the shared primitives absorb the overrides.

// The WCAG 1.4.12 author-override metrics, as inline style (em-relative so they
// track the WCAG ratios regardless of the element's font-size).
const TEXT_SPACING: CSSProperties = {
  lineHeight: 1.5,
  letterSpacing: "0.12em",
  wordSpacing: "0.16em",
}

setupBrowserA11y()

// A container with no clipping is one whose content isn't cut off by a fixed size:
// scroll size never exceeds client size on either axis.
function isNotClipped(el: HTMLElement): boolean {
  return el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth
}

function spacedSample(spacing: CSSProperties) {
  return (
    <div data-testid="host" style={{ width: 360, ...spacing }}>
      <Card>
        <Card.Body>
          <h2 style={spacing}>Accessibility</h2>
          <p style={{ marginBottom: "2em", ...spacing }}>
            A paragraph of body copy that must stay fully visible when the
            reader applies the WCAG text-spacing overrides — the container grows
            to fit rather than clipping the text.
          </p>
        </Card.Body>
      </Card>
    </div>
  )
}

describe("1.4.12 Text Spacing — WCAG author overrides on shared primitives", () => {
  it("the overrides actually take effect (taller layout than un-spaced)", () => {
    // Guard against a tautological pass: prove the spacing changes layout at all.
    // If TEXT_SPACING were a no-op (or silently dropped), these heights would be
    // equal and this assertion would fail — so the constrained test below is real.
    const bare = render(spacedSample({}))
    const bareHeight = bare.getByTestId("host").scrollHeight
    bare.unmount()

    const { getByTestId } = render(spacedSample(TEXT_SPACING))
    expect(getByTestId("host").scrollHeight).toBeGreaterThan(bareHeight)
  })

  it("a height-constrained container still shows all content with the overrides", () => {
    // A realistically-sized container (not unbounded): tall enough for the spaced
    // text, so a clip here would be a real 1.4.12 failure, not a tautology.
    const { getByTestId } = render(
      <div
        data-testid="host"
        style={{ width: 360, height: 320, overflow: "auto", ...TEXT_SPACING }}
      >
        <Card>
          <Card.Body>
            <h2 style={TEXT_SPACING}>Accessibility</h2>
            <p style={{ marginBottom: "2em", ...TEXT_SPACING }}>
              A paragraph of body copy that must stay fully visible when the
              reader applies the WCAG text-spacing overrides — the container
              grows to fit rather than clipping the text.
            </p>
          </Card.Body>
        </Card>
      </div>,
    )
    const host = getByTestId("host")
    expect(
      isNotClipped(host),
      `${host.scrollHeight}>${host.clientHeight}`,
    ).toBe(true)
  })

  // Fidelity: a fixed-height clipping box whose text overflows once the spacing
  // overrides are applied must be detected, so a regression can't silently pass.
  it("detects clipping when spacing overflows a fixed-height box (guard bites)", () => {
    const { getByTestId } = render(
      <div
        data-testid="clip"
        style={{ height: 20, overflow: "hidden", width: 200, ...TEXT_SPACING }}
      >
        Several words of copy whose 1.5x line-height and letter and word spacing
        push the text past a deliberately short twenty-pixel box.
      </div>,
    )
    const box = getByTestId("clip")
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight)
  })
})
