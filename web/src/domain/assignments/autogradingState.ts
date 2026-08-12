import type { Assignment } from "@/types/classroom"

// The "does not autograde" predicate family, mirroring the Python
// skips_grading() unifier (is_empty_repo || is_no_autograder) in
// collect_scores.py / regrade_repos.py and the Go Entry.CommitsShim() inverse.
// A no-shim assignment produces no submit/* releases, so every grading surface
// (live polling, regrade, scores, the built-in autograder step) must be gated
// off for it. Both flags are strict-boolean on the wire (absent reads false),
// matching the readers on every other tool (Go bool, Python `is True`).

/** True only when the assignment is a bare empty_repo (no commits, no shim). */
export function isEmptyRepoAssignment(assignment: Assignment): boolean {
  return assignment.empty_repo === true
}

/**
 * True only when the assignment is teacher-supplied CI (templated, no built-in
 * autograde shim committed). Unlike empty_repo it keeps the template and the
 * Feedback PR.
 */
export function isNoAutograderAssignment(assignment: Assignment): boolean {
  return assignment.no_autograder === true
}

/**
 * True when the assignment never autogrades — either a bare empty_repo or a
 * templated no_autograder. The gradebook expects no scores and regrade never
 * tags it. Mirrors Python skips_grading().
 */
export function assignmentSkipsGrading(assignment: Assignment): boolean {
  return (
    isEmptyRepoAssignment(assignment) || isNoAutograderAssignment(assignment)
  )
}

// The autograding tri-state the assignment-form IA overhaul builds its selector
// on (empty repo / no built-in autograding / built-in autograding). Derived
// from the wire fields so the form and every read surface agree; no_autograder
// is the wire representation of the "none" state.
// NOTE: distinct from github-core's `AutogradeWorkflowState` (enabled/paused/…),
// which is the runtime workflow pause/resume state, not this form choice.
export type AutogradingState = "empty" | "none" | "built-in"

/**
 * Derive the autograding tri-state from an assignment's wire fields. empty_repo
 * wins (a bare repo can't autograde); a templated no_autograder is "none"
 * (teacher-supplied CI); everything else is the built-in shim path.
 */
export function deriveAutogradingState(
  assignment: Assignment,
): AutogradingState {
  if (isEmptyRepoAssignment(assignment)) return "empty"
  if (isNoAutograderAssignment(assignment)) return "none"
  return "built-in"
}

// The setup a submission view surfaces in its heading: whether student repos
// come from a template, and what grading (if any) runs. Single source so the
// teacher gradebook and the student page describe an assignment identically.
//
// The three autograding-tri-state states are framed around the STARTER CODE the
// student sees (template vs empty), since that's what the badge's detail message
// explains: empty -> "No template"; none -> "Template + custom CI"; built-in ->
// "Template" when a template is set, else "Built-in autograder".
export type AssignmentSetupInfo = {
  state: AutogradingState
  hasTemplate: boolean
  // i18n keys the shared badge + its detail modal render. The detail key's
  // message explains what is enabled/disabled for this setup.
  badgeKey: string
  detailKey: string
  // The badge tone: neutral for the fully-featured built-in path, info for the
  // reduced-capability setups so a teacher/student notices grading is limited.
  tone: "neutral" | "info"
}

export function assignmentSetupInfo(
  assignment: Assignment,
): AssignmentSetupInfo {
  const state = deriveAutogradingState(assignment)
  const hasTemplate = Boolean(assignment.template)

  if (state === "empty") {
    return {
      state,
      hasTemplate: false,
      badgeKey: "submissions.setup.badgeEmpty",
      detailKey: "submissions.setup.detailEmpty",
      tone: "info",
    }
  }
  if (state === "none") {
    return {
      state,
      hasTemplate,
      badgeKey: "submissions.setup.badgeCustomCi",
      detailKey: "submissions.setup.detailCustomCi",
      tone: "info",
    }
  }
  return {
    state,
    hasTemplate,
    badgeKey: hasTemplate
      ? "submissions.setup.badgeTemplate"
      : "submissions.setup.badgeBuiltIn",
    detailKey: hasTemplate
      ? "submissions.setup.detailTemplate"
      : "submissions.setup.detailBuiltIn",
    tone: "neutral",
  }
}
