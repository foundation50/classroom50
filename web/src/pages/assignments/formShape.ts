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
//                  UNLESS grading is "Autograded" AND the built-in autograder
//                  is on, in which case the repo is initialized with the marker
//                  + default shim (init_shim: true) and DOES autograde — see
//                  initShim below.
// So "empty" source + built-in autograder is the init_shim state, not a bare
// repo; "empty" source without the built-in autograder is the truly bare
// empty_repo.
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
  // The wire init_shim boolean: a no-template no-README repo that is Autograded
  // — initialized with the marker + default shim, and it autogrades.
  initShim: boolean
  // The wire no_autograder boolean: a TEMPLATED assignment the teacher marked
  // as teacher-supplied CI (grading is Autograded but the built-in shim is
  // off). Only a template source can be no_autograder — a README/empty repo
  // with the built-in autograder off is simply "no autograder", NOT the
  // teacher-supplied-CI wire state (which requires a template).
  noAutograder: boolean
  // The autograding tri-state as it applies to THIS form's values. A bare
  // (empty_repo) repo forces "empty"; otherwise it's derived from the grading
  // choice AND the built-in-autograder toggle — Autograded + built-in ->
  // "built-in" (including the init_shim case), everything else -> "none".
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
  // The autograding config controls (built-in toggle, advanced, tests) are
  // OFFERED only when grading is "Autograded" — for Manual / Not graded the
  // section shows a note instead (showAutogradingConfig). showBuiltInConfig is
  // the provisioning-based "the built-in shim is committed" flag
  // (autogradingState === "built-in", incl. init_shim): it drives the
  // built-in-only field clearing in toSubmitValues, so a stored built-in
  // assignment never loses its config even when its (immutable) grading choice
  // hides the panes. The UI renders the Advanced/Tests panes only when BOTH
  // showAutogradingConfig AND showBuiltInConfig hold.
  showAutogradingConfig: boolean
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

  // The built-in autograder is the repo-provisioning choice, driven by the
  // autograding_state toggle inside the Autograding section. It is orthogonal
  // to grading intent on the WIRE (a manual- or off-graded assignment can still
  // carry a built-in shim, teacher-supplied CI, or a bare repo — the schema
  // keeps grading orthogonal to the autograding tri-state), so the derivation
  // keys off autograding_state alone. grading_choice only decides whether the
  // toggle is OFFERED in the UI (showAutogradingConfig): the section is
  // configurable only under "Autograded". On create the default is "none" (no
  // built-in autograder); on edit the stored value round-trips unchanged.
  const gradingIsAuto = value.grading_choice === "auto"
  const wantsBuiltIn = value.autograding_state === "built-in"

  // On a no-template no-README source, built-in autograding means "initialize
  // with a shim" (init_shim), NOT a bare repo. A stored empty_repo:true is a
  // hard bare override (no shim), so it never becomes init_shim.
  const noTemplateNoReadme = repositorySource === "empty"
  const initShim = noTemplateNoReadme && !value.empty_repo && wantsBuiltIn
  // Truly bare only when it's the empty source AND not the init_shim case.
  const emptyRepo = noTemplateNoReadme && !initShim

  // no_autograder is the TEMPLATED teacher-supplied-CI wire state: it requires
  // a template (the template carries the workflows), so it applies ONLY to a
  // template source with the built-in autograder off. A README/empty source
  // with built-in off is NOT no_autograder — it just carries no autograder.
  const noAutograder = repositorySource === "template" && !wantsBuiltIn

  // A bare repo can't autograde (forced "empty"); otherwise the built-in toggle
  // decides: on -> built-in, off -> none (teacher-supplied CI on a template, or
  // simply no autograder on a README repo).
  const autogradingState: AutogradingState = emptyRepo
    ? "empty"
    : wantsBuiltIn
      ? "built-in"
      : "none"

  return {
    repositorySource,
    emptyRepo,
    initShim,
    noAutograder,
    autogradingState,
    assignmentType: value.mode === "group" ? "group" : "individual",
    showGroupSize: value.mode === "group",
    showTemplateFields: repositorySource === "template",
    showAddReadme: value.repo_source === "none",
    feedbackPrEnabled: !emptyRepo,
    showAutogradingConfig: gradingIsAuto,
    showBuiltInConfig: autogradingState === "built-in",
    showContainerFields: value.runtime_env === "container",
  }
}
