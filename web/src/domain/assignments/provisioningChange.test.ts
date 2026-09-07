import { describe, expect, it } from "vitest"
import type { Assignment } from "@/types/classroom"
import {
  editImpactSummary,
  provisioningChanges,
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
      student_permission: "push",
      repo_visibility: "private",
    })
  })

  it("reads explicit values", () => {
    expect(
      provisioningFieldsFromAssignment({
        ...base,
        empty_repo: true,
        grading: { mode: "manual", max_points: 20 },
        student_permission: "admin",
        repo_visibility: "public",
      }),
    ).toEqual({
      empty_repo: true,
      no_autograder: false,
      init_shim: false,
      gradingMode: "manual",
      student_permission: "admin",
      repo_visibility: "public",
    })
  })

  it("resolves an absent permission to the mode default (group is admin)", () => {
    expect(
      provisioningFieldsFromAssignment({ ...base, mode: "group" })
        .student_permission,
    ).toBe("admin")
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

  it("detects a student_permission change but not an explicit default", () => {
    expect(
      provisioningSettingsChanged(base, { student_permission: "admin" }),
    ).toBe(true)
    // Pinning the mode default is byte-identical on the wire (the write path
    // omits it), so it must not gate.
    expect(
      provisioningSettingsChanged(base, { student_permission: "push" }),
    ).toBe(false)
    // On a group assignment the write path clamps up to admin, so "push"
    // resolves to the stored default too.
    expect(
      provisioningSettingsChanged(
        { ...base, mode: "group" },
        { student_permission: "push" },
      ),
    ).toBe(false)
  })

  it("detects a repo_visibility change but not absent-vs-private", () => {
    expect(
      provisioningSettingsChanged(base, { repo_visibility: "public" }),
    ).toBe(true)
    expect(
      provisioningSettingsChanged(base, { repo_visibility: "private" }),
    ).toBe(false)
    expect(
      provisioningSettingsChanged(
        { ...base, repo_visibility: "public" },
        { repo_visibility: "private" },
      ),
    ).toBe(true)
  })
})

describe("provisioningChanges", () => {
  it("lists each changed setting once, in display order", () => {
    expect(
      provisioningChanges(base, {
        empty_repo: true,
        init_shim: false,
        no_autograder: true,
        gradingMode: "manual",
        student_permission: "admin",
        repo_visibility: "public",
      }),
    ).toEqual([
      "repo_source",
      "autograder",
      "grading_mode",
      "student_permission",
      "repo_visibility",
    ])
  })

  it("collapses empty_repo and init_shim into one repository-source item", () => {
    expect(
      provisioningChanges({ ...base, init_shim: true }, { empty_repo: true }),
    ).toEqual(["repo_source"])
  })
})

describe("editImpactSummary", () => {
  it("is empty when nothing students see or can do changes", () => {
    expect(editImpactSummary(base, { locked: false }, 5)).toEqual([])
    expect(
      editImpactSummary({ ...base, locked: true }, { locked: true }, 5),
    ).toEqual([])
  })

  it("reports a lock even with zero accepted students", () => {
    expect(editImpactSummary(base, { locked: true }, 0)).toEqual([
      { kind: "lock" },
    ])
  })

  it("reports an unlock", () => {
    expect(
      editImpactSummary({ ...base, locked: true }, { locked: false }, 0),
    ).toEqual([{ kind: "unlock" }])
  })

  it("ignores the lock when the caller renders no lock control", () => {
    expect(editImpactSummary({ ...base, locked: true }, {}, 0)).toEqual([])
  })

  it("adds provisioning items only once students accepted, after the lock", () => {
    const next = { locked: true, repo_visibility: "public" as const }
    expect(editImpactSummary(base, next, 0)).toEqual([{ kind: "lock" }])
    expect(editImpactSummary(base, next, 2)).toEqual([
      { kind: "lock" },
      { kind: "provisioning", field: "repo_visibility" },
    ])
  })
})
