import { describe, expect, it } from "vitest"

import {
  resolveSelectedRows,
  selectableRows,
  selectAllState,
  selectRange,
  shouldWarnNoneSelectable,
  toggleRow,
  toggleSelectAll,
} from "./selection"
import type { OrgMemberRow } from "@/util/orgMembers"

const row = (key: string, over: Partial<OrgMemberRow> = {}): OrgMemberRow => ({
  key,
  username: key,
  github_id: key,
  name: key,
  email: `${key}@x.edu`,
  isMember: true,
  classrooms: [],
  classification: "member-on-roster",
  unprovisionedClassrooms: [],
  ...over,
})

// "self" is the non-selectable row in these tests (the signed-in owner).
const notSelf = (self: string) => (r: OrgMemberRow) => r.key !== self

describe("selection helpers", () => {
  it("selectableRows excludes the non-selectable (self) row from the filtered set", () => {
    const filtered = [row("a"), row("self"), row("b")]
    expect(selectableRows(filtered, notSelf("self")).map((r) => r.key)).toEqual(
      ["a", "b"],
    )
  })

  it("selectAllState reports all/some over the selectable-filtered set only", () => {
    const selectable = [row("a"), row("b")]
    expect(selectAllState(selectable, new Set(["a", "b"]))).toEqual({
      allSelected: true,
      someSelected: true,
    })
    expect(selectAllState(selectable, new Set(["a"]))).toEqual({
      allSelected: false,
      someSelected: true,
    })
    expect(selectAllState(selectable, new Set())).toEqual({
      allSelected: false,
      someSelected: false,
    })
    // Empty selectable set is never "all selected".
    expect(selectAllState([], new Set(["x"]))).toEqual({
      allSelected: false,
      someSelected: false,
    })
  })

  it("toggleSelectAll selects the filtered set and leaves out-of-filter selections intact", () => {
    // Selection already holds "z" (hidden by the filter). Select-all over [a, b]
    // adds them without disturbing "z".
    const next = toggleSelectAll([row("a"), row("b")], new Set(["z"]))
    expect([...next].sort()).toEqual(["a", "b", "z"])
  })

  it("toggleSelectAll deselects exactly the filtered set when all are already selected", () => {
    const next = toggleSelectAll([row("a"), row("b")], new Set(["a", "b", "z"]))
    // a, b removed; the out-of-filter "z" survives.
    expect([...next]).toEqual(["z"])
  })

  it("toggleRow adds then removes a single key", () => {
    const added = toggleRow(new Set(), "a")
    expect([...added]).toEqual(["a"])
    const removed = toggleRow(added, "a")
    expect([...removed]).toEqual([])
  })

  it("resolveSelectedRows spans the full set and drops the non-selectable (self) row", () => {
    // "self" is checked (stale selection) but must never resolve into the
    // actionable set; "hidden" is selected but out of the filtered view — still
    // acted on because resolve spans the full row set.
    const all = [row("a"), row("self"), row("hidden")]
    const resolved = resolveSelectedRows(
      all,
      new Set(["a", "self", "hidden"]),
      notSelf("self"),
    )
    expect(resolved.map((r) => r.key).sort()).toEqual(["a", "hidden"])
  })

  describe("selectRange", () => {
    const order = [row("a"), row("b"), row("self"), row("c"), row("d")]

    it("fills the inclusive span in rendered order, skipping the non-selectable row", () => {
      const next = selectRange(order, "a", "c", new Set(), notSelf("self"))
      expect([...next].sort()).toEqual(["a", "b", "c"])
    })

    it("fills the span regardless of click direction (target before anchor)", () => {
      const next = selectRange(order, "d", "b", new Set(), notSelf("self"))
      expect([...next].sort()).toEqual(["b", "c", "d"])
    })

    it("only adds to the selection (never deselects) and preserves existing keys", () => {
      const next = selectRange(order, "a", "b", new Set(["z"]), notSelf("self"))
      expect([...next].sort()).toEqual(["a", "b", "z"])
    })

    it("respects the actual rendered order it is given (reordered view)", () => {
      // Group-by-section reorders rows: c and d render before a and b.
      const reordered = [row("c"), row("d"), row("a"), row("b")]
      const next = selectRange(reordered, "d", "b", new Set(), () => true)
      expect([...next].sort()).toEqual(["a", "b", "d"])
    })

    it("selects only the anchor when anchor equals target", () => {
      const next = selectRange(order, "b", "b", new Set(), notSelf("self"))
      expect([...next]).toEqual(["b"])
    })

    it("returns an unchanged selection when either endpoint is not in the rendered order", () => {
      const gone = selectRange(
        order,
        "missing",
        "c",
        new Set(["a"]),
        () => true,
      )
      expect([...gone]).toEqual(["a"])
    })
  })

  describe("shouldWarnNoneSelectable", () => {
    it("warns when the view has rows but none are selectable (e.g. all staff)", () => {
      expect(shouldWarnNoneSelectable(3, 0)).toBe(true)
    })
    it("does not warn on an empty view (no rows to select)", () => {
      expect(shouldWarnNoneSelectable(0, 0)).toBe(false)
    })
    it("does not warn when at least one row is selectable", () => {
      expect(shouldWarnNoneSelectable(3, 1)).toBe(false)
    })
  })
})
