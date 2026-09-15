import { describe, expect, it } from "vitest"
import {
  dueDateSeed,
  isDeliberatelyCleared,
  releaseDateSeed,
  utcIsoToDatetimeLocalValue,
} from "./formFieldHelpers"

describe("schedule picker seeds (#999)", () => {
  it("due date seeds a week out at 23:59 local, every segment filled", () => {
    expect(dueDateSeed(new Date(2026, 8, 15, 10, 50))).toBe("2026-09-22T23:59")
  })

  it("due date seed rolls over month and year boundaries", () => {
    expect(dueDateSeed(new Date(2026, 11, 28, 9, 0))).toBe("2027-01-04T23:59")
  })

  it("release date seeds the top of the next hour", () => {
    expect(releaseDateSeed(new Date(2026, 8, 15, 10, 50))).toBe(
      "2026-09-15T11:00",
    )
    expect(releaseDateSeed(new Date(2026, 8, 15, 23, 5))).toBe(
      "2026-09-16T00:00",
    )
  })

  it("seeds round-trip through the stored-value parser", () => {
    const seed = dueDateSeed()
    expect(utcIsoToDatetimeLocalValue(new Date(seed).toISOString())).toBe(seed)
  })

  it("prefills a legacy bare date as that day's end, in every zone", () => {
    expect(utcIsoToDatetimeLocalValue("2026-09-15")).toBe("2026-09-15T23:59")
    expect(utcIsoToDatetimeLocalValue("not a date")).toBe("")
  })
})

describe("isDeliberatelyCleared", () => {
  const input = (value: string, badInput: boolean) =>
    ({ value, validity: { badInput } }) as unknown as HTMLInputElement

  it("is true only for an empty value the browser did not flag as partial", () => {
    expect(isDeliberatelyCleared(input("", false))).toBe(true)
    expect(isDeliberatelyCleared(input("", true))).toBe(false)
    expect(isDeliberatelyCleared(input("2026-09-22T23:59", false))).toBe(false)
  })
})
