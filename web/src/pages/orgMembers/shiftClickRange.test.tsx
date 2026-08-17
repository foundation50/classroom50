// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { useState } from "react"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useRangeSelection } from "./useRangeSelection"

type Row = { key: string }

// Renders the REAL shared wiring (useRangeSelection) that OrgMembersPage and
// EnrolledStudents use, so a regression in the shipped hook fails here. The
// regression this guards: preventDefault() in onClick does NOT suppress the
// checkbox's onChange under React, so a shift-click's endpoint got toggled back
// off; the hook's rangeHandledRef makes onChange swallow that follow-up toggle.
function Harness({
  rows,
  selectable = () => true,
  // Real callers disable a non-selectable checkbox. A test can turn that off to
  // exercise the hook's own gate rather than the DOM's.
  disableUnselectable = true,
}: {
  rows: Row[]
  selectable?: (row: Row) => boolean
  disableUnselectable?: boolean
}) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const { handleToggleRow, handleRowCheckboxClick } = useRangeSelection(
    rows,
    selectable,
    setSelectedKeys,
  )

  return (
    <ul>
      <li data-testid="selected">{[...selectedKeys].sort().join(",")}</li>
      {rows.map((row) => (
        <li key={row.key}>
          <input
            type="checkbox"
            aria-label={row.key}
            disabled={disableUnselectable && !selectable(row)}
            checked={selectedKeys.has(row.key)}
            onClick={(e) => handleRowCheckboxClick(e, row.key)}
            onChange={() => handleToggleRow(row.key)}
          />
        </li>
      ))}
    </ul>
  )
}

const shiftClick = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) => {
  await user.keyboard("{Shift>}")
  await user.click(screen.getByLabelText(label))
  await user.keyboard("{/Shift}")
}

describe("shift-click range selection (useRangeSelection wiring)", () => {
  const rows = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }]

  afterEach(cleanup)

  it("includes the shift-clicked endpoint row (not off-by-one)", async () => {
    const user = userEvent.setup()
    render(<Harness rows={rows} />)

    await user.click(screen.getByLabelText("a"))
    await shiftClick(user, "d")

    expect(screen.getByTestId("selected").textContent).toBe("a,b,c,d")
  })

  it("fills the range when shift-clicking backwards to an earlier row", async () => {
    const user = userEvent.setup()
    render(<Harness rows={rows} />)

    await user.click(screen.getByLabelText("d"))
    await shiftClick(user, "a")

    expect(screen.getByTestId("selected").textContent).toBe("a,b,c,d")
  })

  // #2: guards the EnrolledStudents group-by-section path — the hook must span
  // the ACTUAL rendered order it is handed, not the rows' source order. Here the
  // rendered order is c,d,a,b (as a flattened group view would be), so shift-
  // clicking c..b fills the contiguous rendered span, not source-order a..c.
  it("fills the range in the rendered order it is given (grouped view)", async () => {
    const reordered = [{ key: "c" }, { key: "d" }, { key: "a" }, { key: "b" }]
    const user = userEvent.setup()
    render(<Harness rows={reordered} />)

    await user.click(screen.getByLabelText("c"))
    await shiftClick(user, "b")

    expect(screen.getByTestId("selected").textContent).toBe("a,b,c,d")
  })

  it("skips a non-selectable row inside the range", async () => {
    const withSelf = [{ key: "a" }, { key: "self" }, { key: "c" }, { key: "d" }]
    const user = userEvent.setup()
    render(<Harness rows={withSelf} selectable={(row) => row.key !== "self"} />)

    await user.click(screen.getByLabelText("a"))
    await shiftClick(user, "d")

    expect(screen.getByTestId("selected").textContent).toBe("a,c,d")
  })

  it("refuses a plain click on a non-selectable row", async () => {
    // The single-click path must honour `selectable` as selectRange does. A caller
    // that doesn't also disable the input (or a click reaching it another way)
    // would otherwise add the key, render the box CHECKED, and then have
    // resolveSelectedRows filter it out — a ticked box that selects nothing.
    // Rendered enabled on purpose: a disabled input would mask the hook's own gate.
    const user = userEvent.setup()
    render(
      <Harness
        rows={[{ key: "a" }, { key: "pending" }]}
        selectable={(row) => row.key !== "pending"}
        disableUnselectable={false}
      />,
    )

    await user.click(screen.getByLabelText("pending"))
    expect(screen.getByTestId("selected").textContent).toBe("")

    // And a selectable row still toggles normally.
    await user.click(screen.getByLabelText("a"))
    expect(screen.getByTestId("selected").textContent).toBe("a")
  })
})
