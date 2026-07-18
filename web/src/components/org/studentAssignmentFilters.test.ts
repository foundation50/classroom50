import { describe, expect, it } from "vitest"
import {
  DEFAULT_STUDENT_FILTERS,
  DEFAULT_STUDENT_SORT,
  filterAndSortStudentAssignments,
} from "./studentAssignmentFilters"
import type { Assignment } from "@/types/classroom"

const a = (slug: string, over: Partial<Assignment> = {}): Assignment =>
  ({
    slug,
    name: over.name ?? slug,
    mode: over.mode ?? "individual",
    autograder: "default",
    ...over,
  }) as Assignment

const run = (
  assignments: Assignment[],
  opts: Partial<Parameters<typeof filterAndSortStudentAssignments>[1]> = {},
) =>
  filterAndSortStudentAssignments(assignments, {
    query: "",
    filters: { ...DEFAULT_STUDENT_FILTERS },
    sort: DEFAULT_STUDENT_SORT,
    acceptedSlugs: new Set(),
    now: Date.parse("2026-06-01T00:00:00Z"),
    ...opts,
  }).map((x) => x.slug)

describe("filterAndSortStudentAssignments", () => {
  it("defaults to due-soonest-first", () => {
    const list = [
      a("late", { due: "2026-12-01" }),
      a("soon", { due: "2026-06-15" }),
      a("mid", { due: "2026-09-01" }),
    ]
    expect(run(list)).toEqual(["soon", "mid", "late"])
  })

  it("sorts assignments with no due date last (both directions)", () => {
    const list = [a("nodue"), a("due", { due: "2026-07-01" })]
    expect(run(list, { sort: "due-asc" })).toEqual(["due", "nodue"])
    expect(run(list, { sort: "due-desc" })).toEqual(["due", "nodue"])
  })

  it("sorts by name asc/desc", () => {
    const list = [a("beta", { name: "Beta" }), a("alpha", { name: "Alpha" })]
    expect(run(list, { sort: "name-asc" })).toEqual(["alpha", "beta"])
    expect(run(list, { sort: "name-desc" })).toEqual(["beta", "alpha"])
  })

  it("searches by name and slug", () => {
    const list = [a("hw1", { name: "Loops" }), a("hw2", { name: "Recursion" })]
    expect(run(list, { query: "loop" })).toEqual(["hw1"])
    expect(run(list, { query: "hw2" })).toEqual(["hw2"])
  })

  it("filters by status (to-do vs accepted)", () => {
    const list = [
      a("done", { due: "2026-07-01" }),
      a("todo", { due: "2026-08-01" }),
    ]
    const accepted = new Set(["done"])
    expect(
      run(list, {
        filters: { ...DEFAULT_STUDENT_FILTERS, status: "accepted" },
        acceptedSlugs: accepted,
      }),
    ).toEqual(["done"])
    expect(
      run(list, {
        filters: { ...DEFAULT_STUDENT_FILTERS, status: "todo" },
        acceptedSlugs: accepted,
      }),
    ).toEqual(["todo"])
  })

  it("filters by type", () => {
    const list = [
      a("solo", { mode: "individual" }),
      a("team", { mode: "group" }),
    ]
    expect(
      run(list, { filters: { ...DEFAULT_STUDENT_FILTERS, type: "group" } }),
    ).toEqual(["team"])
  })

  it("filters overdue relative to now", () => {
    const list = [
      a("past", { due: "2026-01-01" }),
      a("future", { due: "2026-12-01" }),
      a("nodue"),
    ]
    expect(
      run(list, { filters: { ...DEFAULT_STUDENT_FILTERS, due: "overdue" } }),
    ).toEqual(["past"])
  })

  it("does not mutate the input array", () => {
    const list = [a("b", { due: "2026-12-01" }), a("a", { due: "2026-06-01" })]
    const before = list.map((x) => x.slug)
    filterAndSortStudentAssignments(list, {
      query: "",
      filters: { ...DEFAULT_STUDENT_FILTERS },
      sort: "due-asc",
      acceptedSlugs: new Set(),
    })
    expect(list.map((x) => x.slug)).toEqual(before)
  })
})
