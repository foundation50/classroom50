// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useRowSelection } from "./useRowSelection"

type Row = { key: string; self?: boolean }

const rows: Row[] = [
  { key: "a" },
  { key: "b" },
  { key: "me", self: true },
  { key: "c" },
]
const keyOf = (r: Row) => r.key
const notSelf = (r: Row) => !r.self

const shiftClick = () =>
  ({ shiftKey: true }) as unknown as React.MouseEvent<HTMLInputElement>

describe("useRowSelection", () => {
  it("toggles rows, resolves them against the full set, and clears", () => {
    const { result } = renderHook(() =>
      useRowSelection({ rows, filtered: rows, isSelectable: notSelf, keyOf }),
    )
    act(() => result.current.handleToggleRow("a"))
    act(() => result.current.handleToggleRow("c"))
    expect([...result.current.selectedKeys]).toEqual(["a", "c"])
    expect(result.current.selectedRows.map(keyOf)).toEqual(["a", "c"])
    expect(result.current.someSelected).toBe(true)
    expect(result.current.allSelected).toBe(false)

    act(() => result.current.deselect("a"))
    expect([...result.current.selectedKeys]).toEqual(["c"])
    act(() => result.current.clear())
    expect(result.current.selectedKeys.size).toBe(0)
  })

  it("retain narrows the selection to the given keys and keeps the Set when nothing changes", () => {
    const { result } = renderHook(() =>
      useRowSelection({ rows, filtered: rows, isSelectable: notSelf, keyOf }),
    )
    act(() => result.current.handleToggleRow("a"))
    act(() => result.current.handleToggleRow("b"))
    act(() => result.current.handleToggleRow("c"))

    act(() => result.current.retain(["a", "c"]))
    expect([...result.current.selectedKeys]).toEqual(["a", "c"])
    expect(result.current.selectedRows.map(keyOf)).toEqual(["a", "c"])

    // Keys not selected are ignored; an unchanged set keeps its identity so
    // memos keyed on it don't rerun.
    const before = result.current.selectedKeys
    act(() => result.current.retain(["a", "c", "zzz"]))
    expect(result.current.selectedKeys).toBe(before)

    act(() => result.current.retain([]))
    expect(result.current.selectedKeys.size).toBe(0)
  })

  it("never admits a non-selectable row, even through select-all", () => {
    const { result } = renderHook(() =>
      useRowSelection({ rows, filtered: rows, isSelectable: notSelf, keyOf }),
    )
    act(() => result.current.handleToggleRow("me"))
    expect(result.current.selectedKeys.size).toBe(0)

    let outcome: string | undefined
    act(() => {
      outcome = result.current.toggleSelectAll()
    })
    expect(outcome).toBe("toggled")
    expect([...result.current.selectedKeys].sort()).toEqual(["a", "b", "c"])
    expect(result.current.allSelected).toBe(true)
    expect(result.current.selectableFiltered.map(keyOf)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("select-all targets only the filtered view and reports why it did nothing", () => {
    const { result, rerender } = renderHook(
      ({ filtered }: { filtered: Row[] }) =>
        useRowSelection({ rows, filtered, isSelectable: notSelf, keyOf }),
      { initialProps: { filtered: [rows[0], rows[1]] } },
    )
    act(() => void result.current.toggleSelectAll())
    expect([...result.current.selectedKeys].sort()).toEqual(["a", "b"])

    // Filtered to rows none of which are selectable: warn, keep the selection.
    rerender({ filtered: [rows[2]] })
    let outcome: string | undefined
    act(() => {
      outcome = result.current.toggleSelectAll()
    })
    expect(outcome).toBe("none-selectable")
    expect([...result.current.selectedKeys].sort()).toEqual(["a", "b"])

    // An empty view is a no-op, not a warning.
    rerender({ filtered: [] })
    act(() => {
      outcome = result.current.toggleSelectAll()
    })
    expect(outcome).toBe("empty")
  })

  it("shift-click fills the range over the rendered order, not the filtered list", () => {
    // Rendered order reverses the filtered list, as a grouped view might.
    const rendered = [...rows].reverse()
    const { result } = renderHook(() =>
      useRowSelection({
        rows,
        filtered: rows,
        rendered,
        isSelectable: notSelf,
        keyOf,
      }),
    )
    act(() => result.current.handleToggleRow("c"))
    act(() => result.current.handleRowCheckboxClick(shiftClick(), "b"))
    // Range c..b in rendered order [c, me, b, a] spans c, me, b; self excluded.
    expect([...result.current.selectedKeys].sort()).toEqual(["b", "c"])
  })

  it("prunes keys whose rows left the set only when asked", () => {
    const withPrune = renderHook(
      ({ rows: r }: { rows: Row[] }) =>
        useRowSelection({
          rows: r,
          filtered: r,
          isSelectable: notSelf,
          keyOf,
          pruneMissing: true,
        }),
      { initialProps: { rows } },
    )
    act(() => withPrune.result.current.handleToggleRow("b"))
    withPrune.rerender({ rows: rows.filter((r) => r.key !== "b") })
    expect(withPrune.result.current.selectedKeys.size).toBe(0)

    const withoutPrune = renderHook(
      ({ rows: r }: { rows: Row[] }) =>
        useRowSelection({ rows: r, filtered: r, isSelectable: notSelf, keyOf }),
      { initialProps: { rows } },
    )
    act(() => withoutPrune.result.current.handleToggleRow("b"))
    withoutPrune.rerender({ rows: rows.filter((r) => r.key !== "b") })
    // The key survives (an optimistic removal may bring the row back), but it
    // resolves to no row so nothing acts on it.
    expect([...withoutPrune.result.current.selectedKeys]).toEqual(["b"])
    expect(withoutPrune.result.current.selectedRows).toEqual([])
  })

  it("dedupes selected rows that share a key", () => {
    const dup: Row[] = [{ key: "a" }, { key: "a" }, { key: "b" }]
    const { result } = renderHook(() =>
      useRowSelection({
        rows: dup,
        filtered: dup,
        isSelectable: notSelf,
        keyOf,
      }),
    )
    act(() => result.current.handleToggleRow("a"))
    expect(result.current.selectedRows).toHaveLength(1)
  })
})
