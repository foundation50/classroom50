import { describe, expect, it } from "vitest"

import { assignmentToFormValues } from "./CreateAssignmentForm"
import { utcIsoToDatetimeLocalValue } from "./formFieldHelpers"
import * as formFieldHelpers from "./formFieldHelpers"
import type { Assignment } from "@/types/classroom"

const baseAssignment: Assignment = {
  slug: "hw1",
  name: "Homework 1",
  mode: "individual",
  autograder: "default",
  feedback_pr: true,
}

// #195: the form's due-date default is `utcIsoToDatetimeLocalValue(due)`. These
// tests pin the exact expressions that default is built from — the field default
// lives inside the non-exported useAssignmentForm, so proving the pieces is more
// precise (and far less brittle) than rendering the whole form.
describe("assignment due-date default (issue #195)", () => {
  it("Create mode: an absent stored due yields an empty field, not today+7", () => {
    // Create passes `defaultValues` undefined, so the default reduces to
    // utcIsoToDatetimeLocalValue(undefined). No fallback to a week from now.
    expect(utcIsoToDatetimeLocalValue(undefined)).toBe("")
  })

  it("Edit mode: an assignment with no stored due maps to an empty field", () => {
    const values = assignmentToFormValues(baseAssignment)
    expect(values.due_date).toBe("")
  })

  it("Edit mode: an assignment with a stored due keeps that value", () => {
    const withDue: Assignment = {
      ...baseAssignment,
      due: "2026-09-01T23:59:00Z",
    }
    const values = assignmentToFormValues(withDue)
    // The stored UTC instant round-trips to a local datetime-local string; the
    // exact wall-clock depends on the runner's zone, so assert it's the same
    // conversion the form uses (non-empty and matching the helper) rather than a
    // fixed string.
    expect(values.due_date).toBe(utcIsoToDatetimeLocalValue(withDue.due))
    expect(values.due_date).not.toBe("")
  })

  it("no longer exposes a sevenDaysFromNow prefill helper", () => {
    expect(
      (formFieldHelpers as Record<string, unknown>).sevenDaysFromNow,
    ).toBeUndefined()
  })
})
