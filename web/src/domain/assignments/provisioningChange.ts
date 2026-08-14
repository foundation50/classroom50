import type { Assignment } from "@/types/classroom"

// The provisioning-class settings that, once changed, only take effect for
// repositories accepted from now on — already-accepted repos are never
// retrofitted. The edit form is now permissive about changing them, but warns
// (and confirms) when students have already accepted so the teacher knows they
// own reconciling the difference.
//
// This mirrors exactly the four transitions the domain layer used to reject in
// editAssignment: empty_repo, no_autograder, init_shim, and grading.mode.
// max_points is deliberately excluded — it's only a display max, safe to adjust.
export type ProvisioningFields = {
  empty_repo?: boolean
  no_autograder?: boolean
  init_shim?: boolean
  // Resolved grading mode; absent reads as "auto" everywhere downstream.
  gradingMode?: string
}

// Normalize a stored assignment to the comparable provisioning shape. Absent
// booleans read as false and an absent grading block reads as "auto", matching
// the wire's omitempty semantics so an unchanged edit never looks like a flip.
export function provisioningFieldsFromAssignment(
  assignment: Assignment,
): Required<ProvisioningFields> {
  return {
    empty_repo: Boolean(assignment.empty_repo),
    no_autograder: Boolean(assignment.no_autograder),
    init_shim: Boolean(assignment.init_shim),
    gradingMode: assignment.grading?.mode ?? "auto",
  }
}

// Whether an edit changes any provisioning-class setting relative to the stored
// assignment. Both sides are normalized the same way so an edit that leaves a
// field at its stored value (even expressed differently, e.g. absent vs false)
// is not counted as a change.
export function provisioningSettingsChanged(
  stored: Assignment,
  next: ProvisioningFields,
): boolean {
  const before = provisioningFieldsFromAssignment(stored)
  return (
    before.empty_repo !== Boolean(next.empty_repo) ||
    before.no_autograder !== Boolean(next.no_autograder) ||
    before.init_shim !== Boolean(next.init_shim) ||
    before.gradingMode !== (next.gradingMode ?? "auto")
  )
}
