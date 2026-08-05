// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { ThemeToggleTrack } from "./SidebarFooter"

afterEach(cleanup)

// The theme toggle is presentational (aria-hidden, not a form control) so it
// can't reintroduce the nested-interactive axe violation. Its whole job is to
// mirror the on/off state visually — a regression here (e.g. a DaisyUI .toggle
// span that never moves its knob) is silent, so assert the state-driven classes.
describe("ThemeToggleTrack", () => {
  it("fills the track and slides the knob right when on (dark mode)", () => {
    render(<ThemeToggleTrack on={true} />)
    const track = screen.getByTestId("theme-toggle-track")
    const knob = screen.getByTestId("theme-toggle-knob")
    expect(track.className).toContain("bg-primary")
    expect(knob.className).toContain("translate-x-4")
    // never a real form control (would nest inside the theme button)
    expect(track.querySelector("input")).toBeNull()
  })

  it("uses the muted track and keeps the knob left when off (light mode)", () => {
    render(<ThemeToggleTrack on={false} />)
    const track = screen.getByTestId("theme-toggle-track")
    const knob = screen.getByTestId("theme-toggle-knob")
    expect(track.className).toContain("bg-base-content/30")
    expect(track.className).not.toContain("bg-primary")
    expect(knob.className).not.toContain("translate-x-4")
  })

  it("stays hidden from assistive tech", () => {
    render(<ThemeToggleTrack on={true} />)
    expect(
      screen.getByTestId("theme-toggle-track").getAttribute("aria-hidden"),
    ).toBe("true")
  })
})
