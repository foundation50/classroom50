import { describe, expect, it } from "vitest"

import { planBulkReuseSlugs } from "@/util/bulkReuseSlugs"
import type { Assignment } from "@/types/classroom"

const a = (slug: string, extra: Partial<Assignment> = {}): Assignment =>
  ({ slug, name: slug, ...extra }) as Assignment

const plan = (
  sources: Assignment[],
  targetAssignments: Assignment[],
  edits: Record<string, string> = {},
  targetClassroom = "cs101",
) => planBulkReuseSlugs({ sources, targetClassroom, targetAssignments, edits })

describe("planBulkReuseSlugs", () => {
  it("keeps the source slug when it is free in the target", () => {
    const { rows, valid } = plan([a("hw1")], [a("hw9")])
    expect(rows[0].targetSlug).toBe("hw1")
    expect(rows[0].issue).toBeNull()
    expect(valid).toBe(true)
  })

  it("counts up when the target already holds the slug", () => {
    const { rows } = plan([a("hw1")], [a("hw1"), a("hw1-2")])
    expect(rows[0].targetSlug).toBe("hw1-3")
  })

  it("dodges a reserved renamed_from slug", () => {
    const { rows } = plan([a("hw1")], [a("hw2", { renamed_from: "hw1" })])
    expect(rows[0].targetSlug).toBe("hw1-2")
  })

  it("keeps two copies in one run apart", () => {
    // Both would auto-resolve to hw1-2 if each row were planned alone.
    const { rows } = plan([a("hw1"), a("hw1-2")], [a("hw1")])
    expect(rows.map((r) => r.targetSlug)).toEqual(["hw1-2", "hw1-3"])
  })

  it("steps around a slug the teacher typed on an earlier row", () => {
    const { rows } = plan([a("hw1"), a("hw2")], [], { hw1: "hw2" })
    expect(rows.map((r) => r.targetSlug)).toEqual(["hw2", "hw2-2"])
  })

  it("flags a typed slug that collides with the target", () => {
    const { rows, valid } = plan([a("hw1")], [a("hw9")], { hw1: "hw9" })
    expect(rows[0].issue).toBe("taken")
    expect(valid).toBe(false)
  })

  it("flags a typed slug that collides with another row in the run", () => {
    const { rows, valid } = plan([a("hw1"), a("hw2")], [], { hw2: "hw1" })
    expect(rows[1].issue).toBe("duplicate")
    expect(valid).toBe(false)
  })

  it("flags a typed slug reserved by a rename in the target", () => {
    const { rows } = plan([a("hw1")], [a("hw2", { renamed_from: "old" })], {
      hw1: "old",
    })
    expect(rows[0].issue).toBe("reserved")
  })

  it("flags an emptied field", () => {
    const { rows, valid } = plan([a("hw1")], [], { hw1: "  " })
    expect(rows[0].issue).toBe("empty")
    expect(valid).toBe(false)
  })

  it("normalizes what would be written without rewriting the input", () => {
    const { rows } = plan([a("hw1")], [], { hw1: "Hausaufgabe Zwei!" })
    expect(rows[0].value).toBe("Hausaufgabe Zwei!")
    expect(rows[0].targetSlug).toBe("hausaufgabe-zwei")
  })

  it("flags a typed slug over the target classroom's repo-name budget", () => {
    const { rows, valid } = plan([a("hw1")], [], { hw1: "x".repeat(60) })
    expect(rows[0].issue).toBe("overBudget")
    expect(valid).toBe(false)
  })

  it("asks for a slug when the source name is too short to derive one", () => {
    // "a" is below the 2-character slug minimum, so nothing auto-resolves —
    // but the budget is fine, so the answer is "type one", not "no room".
    const { rows, valid } = plan([a("a")], [])
    expect(rows[0].issue).toBe("empty")
    expect(valid).toBe(false)
  })

  // reuseSlugStatus turns an over-budget issue into the "no slug of any length
  // fits, pick another classroom" wording once the budget is below the 2-char
  // minimum, so the planner does not carry a second kind for it.
  it("reports over budget when the classroom name eats the whole budget", () => {
    const { rows, valid } = plan([a("hw1")], [], {}, "c".repeat(58))
    expect(rows[0].targetSlug).toBe("")
    expect(rows[0].issue).toBe("overBudget")
    expect(valid).toBe(false)
  })
})
