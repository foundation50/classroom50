// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { useRef, useState } from "react"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { selectRange, toggleRow } from "./selection"

type Row = { key: string }

// Mirrors the row-checkbox wiring shared by OrgMembersPage and EnrolledStudents:
// onClick handles a shift-range, onChange the plain toggle + anchor update. The
// regression this guards: preventDefault() in onClick does NOT suppress the
// checkbox's onChange under React, so a shift-click's endpoint got toggled back
// off. rangeHandledRef makes onChange swallow that follow-up toggle instead.
function Harness({ rows }: { rows: Row[] }) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const rangeAnchorKey = useRef<string | null>(null)
  const rangeHandledRef = useRef(false)

  const handleToggleRow = (key: string) => {
    if (rangeHandledRef.current) {
      rangeHandledRef.current = false
      return
    }
    setSelectedKeys((prev) => toggleRow(prev, key))
    rangeAnchorKey.current = key
  }
  const handleRowCheckboxClick = (
    e: React.MouseEvent<HTMLInputElement>,
    key: string,
  ) => {
    const anchor = rangeAnchorKey.current
    if (e.shiftKey && anchor && anchor !== key) {
      rangeHandledRef.current = true
      setSelectedKeys((prev) =>
        selectRange(rows, anchor, key, prev, () => true),
      )
      rangeAnchorKey.current = key
    }
  }

  return (
    <ul>
      <li data-testid="selected">{[...selectedKeys].sort().join(",")}</li>
      {rows.map((row) => (
        <li key={row.key}>
          <input
            type="checkbox"
            aria-label={row.key}
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

describe("shift-click range selection (checkbox wiring)", () => {
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
})
