import type {
  Assignment,
  AssignmentMode,
  RepoPermission,
  RepoVisibility,
} from "@/types/classroom"
import { founderPermission } from "./permissions"

// The provisioning-class settings that, once changed, only take effect for
// repositories accepted from now on — already-accepted repos are never
// retrofitted. The edit form is permissive about changing them, but confirms
// when students have already accepted so the teacher knows they own reconciling
// the difference.
//
// empty_repo / no_autograder / init_shim / grading.mode are the four transitions
// the domain layer used to reject in editAssignment. student_permission and
// repo_visibility share the "future accepts only" semantics (existing repos are
// changed from the submissions page). max_points is deliberately excluded — it's
// only a display max, safe to adjust.
export type ProvisioningFields = {
  empty_repo?: boolean
  no_autograder?: boolean
  init_shim?: boolean
  // Resolved grading mode; absent reads as "auto" everywhere downstream.
  gradingMode?: string
  // Accept-time role on the student's own repo; absent reads as the mode
  // default (and is clamped like the write path, so "push" on a group
  // assignment is not a change from absent).
  student_permission?: RepoPermission
  // Visibility each repo is created with; absent reads as "private".
  repo_visibility?: RepoVisibility
}

// Which setting a provisioning change touched, one per confirm bullet.
export type ProvisioningField =
  | "repo_source"
  | "autograder"
  | "grading_mode"
  | "student_permission"
  | "repo_visibility"

type NormalizedProvisioning = {
  empty_repo: boolean
  no_autograder: boolean
  init_shim: boolean
  gradingMode: string
  student_permission: RepoPermission
  repo_visibility: RepoVisibility
}

function normalizeProvisioning(
  mode: AssignmentMode,
  fields: ProvisioningFields,
): NormalizedProvisioning {
  return {
    empty_repo: Boolean(fields.empty_repo),
    no_autograder: Boolean(fields.no_autograder),
    init_shim: Boolean(fields.init_shim),
    gradingMode: fields.gradingMode ?? "auto",
    student_permission: founderPermission(mode, fields.student_permission),
    repo_visibility: fields.repo_visibility ?? "private",
  }
}

// Normalize a stored assignment to the comparable provisioning shape. Absent
// booleans read as false, an absent grading block reads as "auto", absent
// permission/visibility read as their mode/wire defaults, matching the wire's
// omitempty semantics so an unchanged edit never looks like a flip.
export function provisioningFieldsFromAssignment(
  assignment: Assignment,
): NormalizedProvisioning {
  return normalizeProvisioning(assignment.mode, {
    empty_repo: assignment.empty_repo,
    no_autograder: assignment.no_autograder,
    init_shim: assignment.init_shim,
    gradingMode: assignment.grading?.mode,
    student_permission: assignment.student_permission,
    repo_visibility: assignment.repo_visibility,
  })
}

// The provisioning-class settings an edit changes relative to the stored
// assignment, in display order. Both sides are normalized the same way so an
// edit that leaves a field at its stored value (even expressed differently,
// e.g. absent vs false) is not counted. empty_repo and init_shim both describe
// the repository's starting content, so they collapse into one bullet.
export function provisioningChanges(
  stored: Assignment,
  next: ProvisioningFields,
): ProvisioningField[] {
  const before = provisioningFieldsFromAssignment(stored)
  const after = normalizeProvisioning(stored.mode, next)
  const changed: ProvisioningField[] = []
  if (
    before.empty_repo !== after.empty_repo ||
    before.init_shim !== after.init_shim
  ) {
    changed.push("repo_source")
  }
  if (before.no_autograder !== after.no_autograder) changed.push("autograder")
  if (before.gradingMode !== after.gradingMode) changed.push("grading_mode")
  if (before.student_permission !== after.student_permission) {
    changed.push("student_permission")
  }
  if (before.repo_visibility !== after.repo_visibility) {
    changed.push("repo_visibility")
  }
  return changed
}

// Whether an edit changes any provisioning-class setting relative to the stored
// assignment.
export function provisioningSettingsChanged(
  stored: Assignment,
  next: ProvisioningFields,
): boolean {
  return provisioningChanges(stored, next).length > 0
}

// One line of the edit confirm. Access changes take effect for every student
// the moment the save lands; provisioning changes only for future accepts.
export type EditImpact =
  | { kind: "lock" }
  | { kind: "unlock" }
  | { kind: "provisioning"; field: ProvisioningField }

// What an edit will change for students, in display order: a lock transition
// first (it always matters, even before anyone accepted, because it also
// withholds or restores the private template read), then the provisioning
// changes, which are only worth confirming once repositories exist that won't
// be retrofitted. An empty list means the save needs no confirmation.
export function editImpactSummary(
  stored: Assignment,
  next: ProvisioningFields & { locked?: boolean },
  acceptedCount: number,
): EditImpact[] {
  const impact: EditImpact[] = []
  // Undefined means the caller renders no lock control, so the stored state
  // is carried forward (see editAssignment).
  if (next.locked !== undefined) {
    const wasLocked = Boolean(stored.locked)
    if (next.locked && !wasLocked) impact.push({ kind: "lock" })
    if (!next.locked && wasLocked) impact.push({ kind: "unlock" })
  }
  if (acceptedCount > 0) {
    for (const field of provisioningChanges(stored, next)) {
      impact.push({ kind: "provisioning", field })
    }
  }
  return impact
}
