import { describe, expect, it } from "vitest"
import { classifyImportProblems } from "./importProblems"
import type { DroppedRow } from "./rosterImportParse"
import type { UnusableRow } from "./rosterImportResolve"

const dropped = (row: DroppedRow) => row
const unusable = (row: UnusableRow) => row

describe("classifyImportProblems", () => {
  it("blocks on a cell that held content we couldn't read", () => {
    const problems = classifyImportProblems(
      [
        dropped({ line: 2, reason: "bad-email", value: "n/a" }),
        dropped({ line: 3, reason: "bad-username", value: "-bad-" }),
        dropped({ line: 4, reason: "bad-value", value: "John Smith" }),
      ],
      [],
    )
    expect(problems.every((p) => p.blocking)).toBe(true)
    // The offending cell is quoted, so the teacher can find it in the file rather
    // than being told only how many rows failed.
    expect(problems.map((p) => p.value)).toEqual(["n/a", "-bad-", "John Smith"])
  })

  it("does NOT block on a row that merely has no identity cell", () => {
    // A student who hasn't supplied a handle yet is normal in an SIS export.
    // There is nothing to correct, and blocking would strand every classmate who
    // IS addressable.
    const problems = classifyImportProblems(
      [dropped({ line: 5, reason: "incomplete" })],
      [],
    )
    expect(problems).toEqual([
      { line: 5, key: "students.dropIncomplete", value: "", blocking: false },
    ])
  })

  it("blocks on an id lookup we couldn't complete, not just one that 404'd", () => {
    // Resolution fails closed on both: a transient failure means we don't know
    // whose account that id is, so skipping past it could invite the wrong person.
    const problems = classifyImportProblems(
      [],
      [
        unusable({ line: 2, reason: "unresolved-id", githubId: "999" }),
        unusable({ line: 3, reason: "id-lookup-failed", githubId: "1000" }),
      ],
    )
    expect(problems.map((p) => [p.key, p.blocking])).toEqual([
      ["students.dropUnresolvedId", true],
      ["students.dropIdLookupFailed", true],
    ])
  })

  it("tells a capped id apart from one we couldn't reach", () => {
    // The lookup cap is DETERMINISTIC, so "try again in a moment" would be a dead
    // end: the same file re-uploaded caps at the same place. It gets its own copy,
    // pointing at the fix that works (drop the column, or split the file).
    const problems = classifyImportProblems(
      [],
      [unusable({ line: 9, reason: "id-lookup-capped", githubId: "1234" })],
    )
    expect(problems).toEqual([
      {
        line: 9,
        key: "students.dropIdLookupCapped",
        value: "1234",
        blocking: true,
      },
    ])
  })

  it("merges both stages into one list ordered by file line", () => {
    // The two stages find problems independently; a teacher reads the FILE, so a
    // single ascending list is what one editing pass needs.
    const problems = classifyImportProblems(
      [
        dropped({ line: 9, reason: "bad-email", value: "x" }),
        dropped({ line: 3, reason: "incomplete" }),
      ],
      [unusable({ line: 5, reason: "unresolved-id", githubId: "999" })],
    )
    expect(problems.map((p) => p.line)).toEqual([3, 5, 9])
  })

  it("truncates a pathological cell so one bad row can't flood the report", () => {
    const problems = classifyImportProblems(
      [dropped({ line: 2, reason: "bad-value", value: "x".repeat(500) })],
      [],
    )
    expect(problems[0]?.value.length).toBeLessThan(100)
    expect(problems[0]?.value.endsWith("…")).toBe(true)
  })
})
