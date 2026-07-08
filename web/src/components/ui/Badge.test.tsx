// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Badge } from "./Badge"

afterEach(cleanup)

// Badge is the one status-chip recipe, so these lock the tone/size/soft/ghost
// mapping and confirm neutral stays a bare `badge` without a soft modifier.
describe("Badge", () => {
  it("renders a bare badge (sm) for the neutral default", () => {
    render(<Badge>n</Badge>)
    const cls = screen.getByText("n").className
    expect(cls).toContain("badge")
    expect(cls).toContain("badge-sm")
    expect(cls).not.toContain("badge-soft")
  })

  it("maps a semantic tone to a soft badge by default", () => {
    render(<Badge tone="error">e</Badge>)
    const cls = screen.getByText("e").className
    expect(cls).toContain("badge-error")
    expect(cls).toContain("badge-soft")
  })

  it("drops the soft modifier when soft is false", () => {
    render(
      <Badge tone="success" soft={false}>
        s
      </Badge>,
    )
    const cls = screen.getByText("s").className
    expect(cls).toContain("badge-success")
    expect(cls).not.toContain("badge-soft")
  })

  it("uses badge-ghost and ignores tone when ghost", () => {
    render(
      <Badge ghost tone="error">
        g
      </Badge>,
    )
    const cls = screen.getByText("g").className
    expect(cls).toContain("badge-ghost")
    expect(cls).not.toContain("badge-error")
    expect(cls).not.toContain("badge-soft")
  })

  it("maps the size prop", () => {
    render(<Badge size="xs">x</Badge>)
    expect(screen.getByText("x").className).toContain("badge-xs")
  })
})
