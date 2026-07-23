import { describe, expect, it } from "vitest"
import { resolveAcceptShareSummary } from "./acceptShareWarning"

describe("resolveAcceptShareSummary", () => {
  const base = {
    isLoading: false,
    isError: false,
    enrolledStudents: 3,
    pending: 0,
    pendingHidden: false,
  }

  it("never warns and reports 0 while the roster is loading", () => {
    expect(
      resolveAcceptShareSummary({
        ...base,
        isLoading: true,
        enrolledStudents: 0,
      }),
    ).toEqual({ acceptableStudents: 0, warnNoStudents: false })
  })

  it("never warns on a roster read error (no false alarm on a blip)", () => {
    expect(
      resolveAcceptShareSummary({
        ...base,
        isError: true,
        enrolledStudents: 0,
      }),
    ).toEqual({ acceptableStudents: 0, warnNoStudents: false })
  })

  it("warns when zero students are enrolled and none pending", () => {
    expect(resolveAcceptShareSummary({ ...base, enrolledStudents: 0 })).toEqual(
      {
        acceptableStudents: 0,
        warnNoStudents: true,
      },
    )
  })

  it("counts pending invites as acceptable (accept flow auto-accepts them)", () => {
    expect(
      resolveAcceptShareSummary({ ...base, enrolledStudents: 2, pending: 4 }),
    ).toEqual({ acceptableStudents: 6, warnNoStudents: false })
  })

  it("does not warn when only pending students exist (they can still accept)", () => {
    expect(
      resolveAcceptShareSummary({ ...base, enrolledStudents: 0, pending: 5 }),
    ).toEqual({ acceptableStudents: 5, warnNoStudents: false })
  })

  it("excludes pending from the count when unreadable (non-owner)", () => {
    expect(
      resolveAcceptShareSummary({
        ...base,
        enrolledStudents: 2,
        pending: 4,
        pendingHidden: true,
      }),
    ).toEqual({ acceptableStudents: 2, warnNoStudents: false })
  })

  it("warns when only-pending but pending is unreadable (non-owner)", () => {
    expect(
      resolveAcceptShareSummary({
        ...base,
        enrolledStudents: 0,
        pending: 5,
        pendingHidden: true,
      }),
    ).toEqual({ acceptableStudents: 0, warnNoStudents: true })
  })

  it("reports the enrolled count when nothing is pending", () => {
    expect(resolveAcceptShareSummary(base)).toEqual({
      acceptableStudents: 3,
      warnNoStudents: false,
    })
  })
})
