import { describe, expect, it } from "vitest"
import type { Assignment } from "@/types/classroom"
import {
  provisioningFieldsFromAssignment,
  provisioningSettingsChanged,
} from "./provisioningChange"

const base: Assignment = {
  slug: "hw1",
  name: "Homework 1",
  mode: "individual",
  autograder: "default",
}

describe("provisioningFieldsFromAssignment", () => {
  it("normalizes absent flags to false and absent grading to auto", () => {
    expect(provisioningFieldsFromAssignment(base)).toEqual({
      empty_repo: false,
      no_autograder: false,
      init_shim: false,
      gradingMode: "auto",
    })
  })

  it("reads explicit values", () => {
    expect(
      provisioningFieldsFromAssignment({
        ...base,
        empty_repo: true,
        grading: { mode: "manual", max_points: 20 },
      }),
    ).toEqual({
      empty_repo: true,
      no_autograder: false,
      init_shim: false,
      gradingMode: "manual",
    })
  })
})

describe("provisioningSettingsChanged", () => {
  it("is false when nothing provisioning-class changed", () => {
    expect(
      provisioningSettingsChanged(base, {
        empty_repo: false,
        no_autograder: false,
        init_shim: false,
        gradingMode: "auto",
      }),
    ).toBe(false)
  })

  it("treats absent-vs-false and absent-vs-auto as unchanged", () => {
    // A no-op edit that expresses the same state differently must not gate.
    expect(provisioningSettingsChanged(base, {})).toBe(false)
  })

  it("detects an empty_repo flip", () => {
    expect(provisioningSettingsChanged(base, { empty_repo: true })).toBe(true)
  })

  it("detects a no_autograder flip", () => {
    expect(provisioningSettingsChanged(base, { no_autograder: true })).toBe(
      true,
    )
  })

  it("detects an init_shim flip", () => {
    expect(provisioningSettingsChanged(base, { init_shim: true })).toBe(true)
  })

  it("detects a grading-mode change (auto -> manual)", () => {
    expect(provisioningSettingsChanged(base, { gradingMode: "manual" })).toBe(
      true,
    )
  })

  it("detects a grading-mode change (manual -> auto)", () => {
    const manual: Assignment = {
      ...base,
      grading: { mode: "manual", max_points: 50 },
    }
    expect(provisioningSettingsChanged(manual, { gradingMode: "auto" })).toBe(
      true,
    )
    // Same manual mode is not a change even if max_points differs (display-only).
    expect(provisioningSettingsChanged(manual, { gradingMode: "manual" })).toBe(
      false,
    )
  })
})
