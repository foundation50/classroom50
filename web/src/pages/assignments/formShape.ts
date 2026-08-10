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
//
// Repository source is a UI-only three-way, folded from repo_source + add_readme
// (mirroring GitHub's own repo-creation flow):
//   - "template" : start from a template repo (template_repo set on the wire).
//   - "readme"   : no template, initialized with a README — an auto_init repo
//                  with a baseline commit (empty_repo: false on the wire).
//   - "empty"    : no template, no README — a bare repo, no commit
//                  (empty_repo: true on the wire).
// Only "empty" is a no-shim/no-baseline state; "readme" behaves like any other
// non-empty repo (autograding + Feedback PR available).
export type RepositorySource = "template" | "readme" | "empty"
export type AssignmentType = "individual" | "group"

export type FormShape = {
  // The repository source, folded from the UI's repo_source + add_readme.
  // Everything template- and grading-related keys off it.
  repositorySource: RepositorySource
  // The wire empty_repo boolean this shape resolves to (source === "empty").
  // toSubmitValues writes this; the render gates read the richer source above.
  emptyRepo: boolean
  // The autograding tri-state as it applies to THIS form's values: a bare
  // (empty) repo forces "empty" (it can never autograde) regardless of the
  // picked radio; otherwise it's the teacher's autograding_state choice.
  autogradingState: AutogradingState
  assignmentType: AssignmentType
  // Max group size only applies to a group assignment.
  showGroupSize: boolean
  // Template ref + creation method only when a template is the source.
  showTemplateFields: boolean
  // The "Add a README" toggle only shows for the no-template source (a template
  // provides its own initial commit, so the choice is moot there).
  showAddReadme: boolean
  // The Feedback PR needs a baseline commit, so it's offered for any non-empty
  // repo — decoupled from autograding (KTD5). Only a bare repo disables it.
  feedbackPrEnabled: boolean
  // Built-in autograder sub-controls (triggers, advanced, tests) render only
  // for the "built-in" state; "empty" and "none" commit no shim.
  showBuiltInConfig: boolean
  // Container mode reveals image/user and hides apt (hosted-only); the two are
  // mutually exclusive on the wire.
  showContainerFields: boolean
}

// Derive the section-shape from form values. The repository source folds
// repo_source + add_readme into the three-way above; a bare repo forces the
// autograding state to "empty". This collapse is the single definition
// toSubmitValues and the render gates both consume.
export function deriveFormShape(value: CreateAssignmentFormValues): FormShape {
  // A raw empty_repo: true is honored as a hard override so a stored bare-repo
  // assignment (or a partial defaultValues that sets only empty_repo) still
  // resolves to "empty" even if the UI discriminator wasn't seeded. Otherwise
  // the source folds from repo_source + add_readme.
  const repositorySource: RepositorySource =
    value.repo_source === "template"
      ? "template"
      : value.empty_repo || !value.add_readme
        ? "empty"
        : "readme"
  const emptyRepo = repositorySource === "empty"
  const autogradingState: AutogradingState = emptyRepo
    ? "empty"
    : value.autograding_state

  return {
    repositorySource,
    emptyRepo,
    autogradingState,
    assignmentType: value.mode === "group" ? "group" : "individual",
    showGroupSize: value.mode === "group",
    showTemplateFields: repositorySource === "template",
    showAddReadme: value.repo_source === "none",
    feedbackPrEnabled: !emptyRepo,
    showBuiltInConfig: autogradingState === "built-in",
    showContainerFields: value.runtime_env === "container",
  }
}
