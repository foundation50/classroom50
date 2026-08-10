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
//   - "empty"    : no template, no README. This is a bare repo (empty_repo: true)
//                  UNLESS the teacher picks built-in autograding, in which case
//                  the repo is initialized with the marker + default shim
//                  (init_shim: true) and DOES autograde — see initShim below.
// So "empty" source + built-in autograding is the init_shim state, not a bare
// repo; "empty" source + no built-in is the truly bare empty_repo.
export type RepositorySource = "template" | "readme" | "empty"
export type AssignmentType = "individual" | "group"

export type FormShape = {
  // The repository source, folded from the UI's repo_source + add_readme.
  // Everything template- and grading-related keys off it.
  repositorySource: RepositorySource
  // The wire empty_repo boolean this shape resolves to: a no-template no-README
  // repo where the teacher did NOT pick built-in autograding (a truly bare
  // repo). If they picked built-in on that same source, it's init_shim instead
  // (see below) and this is false.
  emptyRepo: boolean
  // The wire init_shim boolean: a no-template no-README repo WITH built-in
  // autograding — initialized with the marker + default shim, and it autogrades.
  initShim: boolean
  // The autograding tri-state as it applies to THIS form's values. A bare
  // (empty_repo) repo forces "empty"; otherwise it's the teacher's pick — and
  // note built-in is now allowed even on a no-template no-README repo (that is
  // exactly the init_shim case).
  autogradingState: AutogradingState
  assignmentType: AssignmentType
  // Max group size only applies to a group assignment.
  showGroupSize: boolean
  // Template ref + creation method only when a template is the source.
  showTemplateFields: boolean
  // The "Add a README" toggle only shows for the no-template source (a template
  // provides its own initial commit, so the choice is moot there).
  showAddReadme: boolean
  // The Feedback PR needs a baseline commit, so it's offered for any repo that
  // gets an initial commit — decoupled from autograding (KTD5). Only a truly
  // bare empty_repo disables it; an init_shim repo has a baseline commit.
  feedbackPrEnabled: boolean
  // Built-in autograder sub-controls (triggers, advanced, tests) render for the
  // "built-in" state, including the init_shim case (empty source + built-in).
  showBuiltInConfig: boolean
  // Container mode reveals image/user and hides apt (hosted-only); the two are
  // mutually exclusive on the wire.
  showContainerFields: boolean
}

// Derive the section-shape from form values. The repository source folds
// repo_source + add_readme into the three-way above; whether a no-template
// no-README repo is bare (empty_repo) or shim-initialized (init_shim) depends
// on the autograding pick. This collapse is the single definition toSubmitValues
// and the render gates both consume.
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

  // On a no-template no-README source, built-in autograding means "initialize
  // with a shim" (init_shim), NOT a bare repo. A stored empty_repo:true is a
  // hard bare override (no shim), so it never becomes init_shim.
  const noTemplateNoReadme = repositorySource === "empty"
  const initShim =
    noTemplateNoReadme &&
    !value.empty_repo &&
    value.autograding_state === "built-in"
  // Truly bare only when it's the empty source AND not the init_shim case.
  const emptyRepo = noTemplateNoReadme && !initShim

  // A bare repo can't autograde (forced "empty"); otherwise the teacher's pick.
  const autogradingState: AutogradingState = emptyRepo
    ? "empty"
    : value.autograding_state

  return {
    repositorySource,
    emptyRepo,
    initShim,
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
