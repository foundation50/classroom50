import { describe, expect, it } from "vitest"

import type { Assignment } from "@/types/classroom"
import { dueDeadlineInstant } from "@/util/formatDate"
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  filterAndSortAssignments,
  type AssignmentFilters,
  type AssignmentSort,
} from "./assignmentList"

// Minimal factory — only the fields the list logic reads.
const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  slug: "hw",
  name: "Homework",
  mode: "individual",
  autograder: "",
  ...over,
})

const run = (
  assignments: Assignment[],
  over: {
    query?: string
    filters?: Partial<AssignmentFilters>
    sort?: AssignmentSort
    now?: number
  } = {},
) =>
  filterAndSortAssignments(assignments, {
    query: over.query ?? "",
    filters: { ...DEFAULT_FILTERS, ...over.filters },
    sort: over.sort ?? DEFAULT_SORT,
    now: over.now,
  })

const names = (assignments: Assignment[]) => assignments.map((a) => a.name)

// 2026-06-15 noon UTC — a fixed "now" for deterministic overdue tests.
const NOW = Date.parse("2026-06-15T12:00:00Z")

describe("filterAndSortAssignments — search", () => {
  const list = [
    assignment({ name: "Recursion", slug: "recursion" }),
    assignment({ name: "Sorting", slug: "sorting-algos" }),
  ]

  it("empty query returns all", () => {
    expect(run(list).length).toBe(2)
  })

  it("matches name case-insensitively", () => {
    expect(names(run(list, { query: "REC" }))).toEqual(["Recursion"])
  })

  it("matches slug", () => {
    expect(names(run(list, { query: "algos" }))).toEqual(["Sorting"])
  })

  it("non-matching query returns empty", () => {
    expect(run(list, { query: "zzz" })).toEqual([])
  })

  it("whitespace-only query is treated as empty", () => {
    expect(run(list, { query: "   " }).length).toBe(2)
  })
})

describe("filterAndSortAssignments — type filter", () => {
  const list = [
    assignment({ name: "Solo", mode: "individual" }),
    assignment({ name: "Team", mode: "group" }),
  ]

  it("all returns all", () => {
    expect(run(list, { filters: { type: "all" } }).length).toBe(2)
  })

  it("individual returns only individual", () => {
    expect(names(run(list, { filters: { type: "individual" } }))).toEqual([
      "Solo",
    ])
  })

  it("group returns only group", () => {
    expect(names(run(list, { filters: { type: "group" } }))).toEqual(["Team"])
  })
})

describe("filterAndSortAssignments — due filter", () => {
  const past = assignment({ name: "Past", due: "2026-06-10T00:00:00Z" })
  const future = assignment({ name: "Future", due: "2026-06-20T00:00:00Z" })
  const none = assignment({ name: "None" })
  const empty = assignment({ name: "Empty", due: "" })
  const malformed = assignment({ name: "Malformed", due: "not-a-date" })
  const list = [past, future, none, empty, malformed]

  it("has-due excludes no/empty/unparseable due", () => {
    expect(names(run(list, { filters: { due: "has-due" } })).sort()).toEqual([
      "Future",
      "Past",
    ])
  })

  it("no-due returns absent, empty, or unparseable due", () => {
    expect(names(run(list, { filters: { due: "no-due" } })).sort()).toEqual([
      "Empty",
      "Malformed",
      "None",
    ])
  })

  it("overdue returns only past-due with injected now", () => {
    expect(names(run(list, { filters: { due: "overdue" }, now: NOW }))).toEqual(
      ["Past"],
    )
  })

  it("treats a bare date as end-of-local-day, not UTC midnight", () => {
    const bare = assignment({ name: "Bare", due: "2026-06-15" })
    // Derive the deadline instant the same way the code does, so the assertion
    // holds in any runner timezone. A bare date is due at local end-of-day, so
    // one ms before it is not overdue and one ms after it is.
    const deadline = dueDeadlineInstant("2026-06-15")!.getTime()
    expect(
      run([bare], { filters: { due: "overdue" }, now: deadline - 1 }),
    ).toEqual([])
    expect(
      names(run([bare], { filters: { due: "overdue" }, now: deadline + 1 })),
    ).toEqual(["Bare"])
  })
})

describe("filterAndSortAssignments — sort", () => {
  const early = assignment({ name: "Beta", due: "2026-06-10T00:00:00Z" })
  const late = assignment({ name: "Alpha", due: "2026-06-20T00:00:00Z" })
  const undated = assignment({ name: "Gamma" })

  it("name-asc orders A→Z (default)", () => {
    expect(names(run([early, late, undated]))).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ])
  })

  it("name-desc orders Z→A", () => {
    expect(names(run([early, late, undated], { sort: "name-desc" }))).toEqual([
      "Gamma",
      "Beta",
      "Alpha",
    ])
  })

  it("due-asc is soonest-first, missing due last", () => {
    expect(names(run([late, early, undated], { sort: "due-asc" }))).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ])
  })

  it("due-desc is latest-first, missing due last", () => {
    expect(names(run([early, late, undated], { sort: "due-desc" }))).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ])
  })

  it("type groups by mode then name", () => {
    const list = [
      assignment({ name: "Zeta", mode: "individual" }),
      assignment({ name: "Yankee", mode: "group" }),
      assignment({ name: "Xray", mode: "individual" }),
    ]
    // "group" < "individual" alphabetically.
    expect(names(run(list, { sort: "type" }))).toEqual([
      "Yankee",
      "Xray",
      "Zeta",
    ])
  })
})

describe("filterAndSortAssignments — invariants", () => {
  it("does not mutate the input array", () => {
    const list = [assignment({ name: "Beta" }), assignment({ name: "Alpha" })]
    filterAndSortAssignments(list, {
      query: "",
      filters: DEFAULT_FILTERS,
      sort: "name-asc",
    })
    expect(names(list)).toEqual(["Beta", "Alpha"])
  })

  it("applies search, filter, and sort together", () => {
    const list = [
      assignment({ name: "Recursion lab", mode: "individual" }),
      assignment({ name: "Recursion quiz", mode: "group" }),
      assignment({ name: "Sorting", mode: "individual" }),
    ]
    expect(
      names(
        run(list, {
          query: "recursion",
          filters: { type: "individual" },
          sort: "name-asc",
        }),
      ),
    ).toEqual(["Recursion lab"])
  })
})
