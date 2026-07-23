import { describe, expect, it } from "vitest"
import { resolveAcceptShareWarning } from "./acceptShareWarning"

describe("resolveAcceptShareWarning", () => {
  const base = {
    isLoading: false,
    isError: false,
    enrolledStudents: 3,
    pending: 0,
    pendingHidden: false,
  }

  it("never warns while the roster is loading", () => {
    expect(
      resolveAcceptShareWarning({
        ...base,
        isLoading: true,
        enrolledStudents: 0,
      }),
    ).toEqual({ kind: "none" })
  })

  it("never warns on a roster read error (no false alarm on a blip)", () => {
    expect(
      resolveAcceptShareWarning({
        ...base,
        isError: true,
        enrolledStudents: 0,
      }),
    ).toEqual({ kind: "none" })
  })

  it("warns noStudents when zero students are enrolled", () => {
    expect(resolveAcceptShareWarning({ ...base, enrolledStudents: 0 })).toEqual(
      { kind: "noStudents" },
    )
  })

  it("flags pending invites when some students are enrolled", () => {
    expect(
      resolveAcceptShareWarning({ ...base, enrolledStudents: 2, pending: 4 }),
    ).toEqual({ kind: "pending", pending: 4 })
  })

  it("suppresses the pending note when pending is unreadable (non-owner)", () => {
    expect(
      resolveAcceptShareWarning({
        ...base,
        enrolledStudents: 2,
        pending: 4,
        pendingHidden: true,
      }),
    ).toEqual({ kind: "none" })
  })

  it("prefers noStudents over pending when zero are enrolled", () => {
    expect(
      resolveAcceptShareWarning({ ...base, enrolledStudents: 0, pending: 5 }),
    ).toEqual({ kind: "noStudents" })
  })

  it("returns none when enrolled and nothing pending", () => {
    expect(resolveAcceptShareWarning(base)).toEqual({ kind: "none" })
  })
})
