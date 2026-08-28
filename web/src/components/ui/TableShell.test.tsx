// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

import { TableShell } from "./TableShell"

afterEach(cleanup)

const body = (
  <tbody>
    <tr>
      <td>cell</td>
    </tr>
  </tbody>
)

describe("TableShell", () => {
  it("renders the full-size house table inside the framed box by default", () => {
    const { container } = render(<TableShell animate={false}>{body}</TableShell>)
    const frame = container.firstElementChild as HTMLElement
    expect(frame.className).toContain("overflow-x-auto")
    expect(frame.className).toContain("border-base-300")
    const table = frame.querySelector("table") as HTMLTableElement
    expect(table.className).toContain("table")
    expect(table.className).not.toContain("table-sm")
  })

  it("adds table-sm for the compact density", () => {
    const { container } = render(
      <TableShell animate={false} size="sm">
        {body}
      </TableShell>,
    )
    expect(container.querySelector("table")?.className).toContain("table-sm")
  })

  it("merges frameClassName onto the frame, not the table", () => {
    const { container } = render(
      <TableShell animate={false} frameClassName="max-h-48 overflow-auto">
        {body}
      </TableShell>,
    )
    const frame = container.firstElementChild as HTMLElement
    expect(frame.className).toContain("max-h-48")
    expect(frame.className).toContain("overflow-auto")
    expect(container.querySelector("table")?.className).not.toContain("max-h-48")
  })

  it("keeps aria-busy and the padded recipe unchanged", () => {
    const { container } = render(
      <TableShell animate={false} ariaBusy padded>
        {body}
      </TableShell>,
    )
    const table = container.querySelector("table") as HTMLTableElement
    expect(table.getAttribute("aria-busy")).toBe("true")
    expect(table.className).toContain("[&_tbody_td]:py-4")
  })
})
