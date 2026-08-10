import type { AutogradingState } from "@/domain/assignments/autogradingState"
import type { CreateAssignmentFormValues } from "./assignmentFormModel"

// The single derived "form shape" (KTD3): every section's visibility, disabled
// state, and on-submit clearing is computed from form values here, rather than
// the form's older scattered per-field form.Subscribe show/hide/clear blocks
// for empty_repo, runtime_env, and mode. One source keeps the five-section IA
// consistent and lets a new capability add a gate here instead of another
// bespoke conditional.
//
// This is a pure view over the form values: it reads nothing and writes
// nothing, so both the render gates and toSubmitValues can share it without a
// second copy of the rules drifting.
export type RepositorySource = "empty" | "template-or-blank"
export type AssignmentType = "individual" | "group"

export type FormShape = {
  // The repository source is the primary Repository Setup choice; empty_repo
  // is its wire representation. Everything template- and grading-related keys
  // off it.
  repositorySource: RepositorySource
  // The autograding tri-state as it applies to THIS form's values: empty_repo
  // forces "empty" (a bare repo can never autograde) regardless of the picked
  // radio; otherwise it's the teacher's autograding_state choice. Mirrors the
  // collapse toSubmitValues performs before writing the wire fields.
  autogradingState: AutogradingState
  assignmentType: AssignmentType
  // Max group size only applies to a group assignment.
  showGroupSize: boolean
  // Template ref + creation method only when the source isn't a bare repo.
  showTemplateFields: boolean
  // The Feedback PR needs a baseline commit, so it's offered for any non-empty
  // repo — decoupled from autograding (KTD5). Only empty_repo disables it.
  feedbackPrEnabled: boolean
  // Built-in autograder sub-controls (triggers, advanced, tests) render only
  // for the "built-in" state; "empty" and "none" commit no shim.
  showBuiltInConfig: boolean
  // Container mode reveals image/user and hides apt (hosted-only); the two are
  // mutually exclusive on the wire.
  showContainerFields: boolean
}

// Derive the section-shape from form values. empty_repo wins over a stale
// autograding_state pick (the radios can hold "built-in" while empty_repo is
// on); the collapse here is the single definition toSubmitValues and the render
// gates both consume.
export function deriveFormShape(value: CreateAssignmentFormValues): FormShape {
  const repositorySource: RepositorySource = value.empty_repo
    ? "empty"
    : "template-or-blank"
  const autogradingState: AutogradingState =
    repositorySource === "empty" ? "empty" : value.autograding_state
  const nonEmpty = repositorySource !== "empty"

  return {
    repositorySource,
    autogradingState,
    assignmentType: value.mode === "group" ? "group" : "individual",
    showGroupSize: value.mode === "group",
    showTemplateFields: nonEmpty,
    feedbackPrEnabled: nonEmpty,
    showBuiltInConfig: autogradingState === "built-in",
    showContainerFields: value.runtime_env === "container",
  }
}
