import type { GitHubClient } from "@/github-core/client"
import type { Assignment } from "@/types/classroom"
import {
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  PASS_THRESHOLD_MAX,
  PASS_THRESHOLD_MIN,
  REPO_PERMISSIONS,
  SUBMISSION_MODES,
  GRADING_MODES,
  GRADING_MAX_POINTS_MIN,
  TEST_FAILURE_DETAILS_LEVELS,
  assertAssignmentMode,
  defaultStudentPermission,
} from "@/types/classroom"
import {
  getBranchRef,
  getClassroomJson,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { classroomTeamSlug } from "@/util/teamSlug"
import { GitHubAPIError } from "@/github-core/errors"
import {
  draftToTest,
  makeSetupTest,
  validateTestTimeout,
} from "@/util/assignmentTests"
import { buildDueFields } from "@/util/formatDate"
import { prefixCommit } from "@/util/commit"
import {
  parseRunnerLabels,
  isRunnerLabelShapeValid,
  isSelfHostedRunnerValue,
  MAX_RUNNER_LABELS,
} from "@/util/runners"
import {
  RUNTIME_LANGUAGES,
  type RuntimeLanguage,
  isNonUbuntuHostedLabel,
  parseAptPackages,
  validateAptPackages,
  validateContainerImage,
  validateContainerUser,
  validateLanguageVersion,
} from "@/util/runtime"
import { parseAllowedFiles, validateAllowedFiles } from "@/util/allowedFiles"
import { parseReleaseAssets, validateReleaseAssets } from "@/util/releaseAssets"
import { validateSubmissionTags } from "@/util/submissionTags"
import {
  addRepositoryToTeam,
  removeRepositoryFromTeam,
  isDeletableClassroomTeamRef,
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { getRepo } from "@/github-core/repoReads"
import {
  getAssignmentsFile,
  type AssignmentsFile,
} from "../queries/assignments"
import {
  withGitConflictRetry,
  assertClassroomNotArchived,
  type CreateClassroomResult,
} from "../classrooms"
import {
  log,
  parseTemplateRef,
  resolveTemplate,
  templateRefUnchanged,
  contentsPathExists,
} from "./accessPrimitives"
import { CONFIG_REPO } from "@/util/configRepo"
import type { CreateAssignmentInput } from "./repoCreation"
import { resolveSubmissionMode } from "./submissionDetection"

export type CreateAssignmentResult = CreateClassroomResult & {
  // Set when the assignment saved but the follow-up team read grant on a
  // private in-org template failed — a non-fatal warning the UI surfaces
  // (students can't accept until fixed). Mirrors teamDeleteWarning.
  templateGrantWarning?: string
}

// Ownership of every Assignment entry-level key on the edit path. Typed as a
// total Record<keyof Assignment, ...>, so adding a field to Assignment fails to
// compile here until classified — closing the silent-desync trap where a new
// Classroom-50-owned field omitted from the set lets an edit that clears it get
// re-populated from the stale existing entry. "classroom50-owned":
// buildAssignmentEntry rebuilds it from form input, so a clearing edit must
// win. "preserved": the form never touches it; carry it verbatim on
// read-modify-write (mirrors the CLI's AssignmentEntry.Extra). ("Owned" here is
// always from Classroom 50's perspective — never the teacher's.)
const ASSIGNMENT_KEY_OWNERSHIP: Record<
  keyof Assignment,
  "classroom50-owned" | "preserved"
> = {
  slug: "classroom50-owned",
  name: "classroom50-owned",
  description: "classroom50-owned",
  template: "classroom50-owned",
  due: "classroom50-owned",
  due_meta: "classroom50-owned",
  available_from: "classroom50-owned",
  available_from_meta: "classroom50-owned",
  mode: "classroom50-owned",
  autograder: "classroom50-owned",
  max_group_size: "classroom50-owned",
  feedback_pr: "classroom50-owned",
  // Rebuilt from input and MUTABLE: an edit may flip empty_repo now (the UI
  // warns when students already accepted, since existing repos aren't
  // retrofitted). A clearing edit must win over the stale stored value.
  empty_repo: "classroom50-owned",
  no_autograder: "classroom50-owned",
  init_shim: "classroom50-owned",
  include_all_branches: "classroom50-owned",
  copy_about: "classroom50-owned",
  copy_topics: "classroom50-owned",
  feedback_pr_template: "classroom50-owned",
  // Rebuilt AND a closed object: the CLI decodes runtime strictly (RuntimeRef
  // has no Extra, DisallowUnknownFields; schema additionalProperties false), so
  // the rebuilt runtime must win and any unknown sub-key drops rather than
  // round-tripping into a file the CLI would reject.
  runtime: "classroom50-owned",
  allowed_files: "classroom50-owned",
  release_assets: "classroom50-owned",
  pass_threshold: "classroom50-owned",
  student_permission: "classroom50-owned",
  submission_mode: "classroom50-owned",
  submission_tags: "classroom50-owned",
  // Rebuilt from input and MUTABLE: an edit may change grading.mode now (the UI
  // warns when students already accepted — scores recorded under the old mode
  // may be misread, so the teacher reconciles them).
  grading: "classroom50-owned",
  repo_features: "classroom50-owned",
  tests: "classroom50-owned",
  // Rebuilt from input alongside tests; a clearing edit (back to the grader
  // defaults) must win over the stale stored block.
  test_defaults: "classroom50-owned",
  // Written only by the CLI's `migrate`; the form never rebuilds it, so it must
  // ride through a GUI edit untouched.
  migrated_from: "preserved",
  // Written only by the one-shot slug rename; carries the reservation and
  // collection-grandfather contracts, so an edit must never drop it.
  renamed_from: "preserved",
  // Owned by the separate lock/unlock action (useSetAssignmentLock), never the
  // create/edit form, so an edit must preserve it verbatim — otherwise saving
  // an edit would silently unlock a locked assignment.
  locked: "preserved",
  // Owned by the separate close/reopen action (useSetAssignmentClosed), never
  // the create/edit form, so an edit must preserve it verbatim — otherwise
  // saving an edit would silently reopen a closed submission window.
  closed: "preserved",
}

// Keys the edit form fully owns (Classroom-50-owned), derived from the
// ownership map above so it can never drift from the Assignment type.
const EDIT_MANAGED_ASSIGNMENT_KEYS = new Set<string>(
  Object.entries(ASSIGNMENT_KEY_OWNERSHIP)
    .filter(([, ownership]) => ownership === "classroom50-owned")
    .map(([key]) => key),
)

// Copy forward entry-level keys the edit form doesn't manage (e.g.
// `migrated_from`, unknown future keys) onto the rebuilt edit, without
// overwriting managed keys. Mirrors the CLI's AssignmentEntry.Extra round-trip.
//
// `runtime` is deliberately NOT preserved this way: it's a managed key, and the
// CLI decodes it as a CLOSED object (RuntimeRef has no Extra, decoded with
// DisallowUnknownFields; the schema sets additionalProperties:false). Carrying
// an unknown runtime sub-key forward would write an assignments.json the CLI
// refuses to parse. So an edit rebuilds runtime from the known sub-keys and any
// foreign key self-heals away — matching the CLI's own strictness.
export function preserveUnmanagedAssignmentKeys(
  existing: Assignment,
  edited: Assignment,
): Assignment {
  const merged: Record<string, unknown> = { ...edited }
  for (const [key, value] of Object.entries(
    existing as Record<string, unknown>,
  )) {
    if (EDIT_MANAGED_ASSIGNMENT_KEYS.has(key)) continue
    if (value === undefined) continue
    merged[key] = value
  }
  return merged as Assignment
}

export async function editAssignment(
  client: GitHubClient,
  input: CreateAssignmentInput,
): Promise<CreateAssignmentResult> {
  const { org, classroom, slug } = input

  log.info("edit assignment: started", { org, classroom, slug })

  // The archive guard is independent of the org ref read, so run them
  // concurrently — Promise.all rejects on the first rejection, so an archived
  // classroom still fails closed before any write.
  const [, configBranch] = await Promise.all([
    assertClassroomNotArchived(client, org, classroom),
    getConfigRepoBranch(client, org),
  ])
  const ref = await getBranchRef(client, org, configBranch)
  const commit = await getCommit(client, org, ref.object.sha)

  const assignmentsFilePath = `${classroom}/assignments.json`
  const currentAssignments = await getAssignmentsFile(client, {
    org,
    path: assignmentsFilePath,
    ref: ref.object.sha,
  })

  const targetAssignment = currentAssignments.assignments.find(
    (a) => a.slug === slug,
  )
  if (!targetAssignment) {
    throw new Error(`Existing assignment matching ${slug} was not found.`)
  }

  // Provisioning-class settings (empty_repo, no_autograder, init_shim) and the
  // grading.mode are no longer blocked on edit: student repos are provisioned
  // at accept time and never retrofitted, so a change only takes effect for
  // repos accepted from now on. The UI computes whether any student has already
  // accepted and, if so, confirms with a warning that existing repos keep the
  // old starter code / grading and that the teacher reconciles the difference
  // themselves (mirrors the CLI's non-blocking warning). The write path stays
  // permissive because it can't cheaply know the acceptance count.

  // Normalize the edit like create so it never leaves stray non-schema keys
  // the CLI rejects. Pass the stored template so an unchanged ref is reused
  // without a live lookup (non-template edits save even if the template moved).
  const { entry: editedAssignment, needsTeamGrant } =
    await buildAssignmentEntry(client, input, targetAssignment.template)

  // Renaming isn't supported: the slug is the assignment's repo-path identity
  // and its lookup key here. Pin the written slug to the stored one so the edit
  // can never rename an assignment, regardless of what the caller passed.
  editedAssignment.slug = targetAssignment.slug

  // The form rebuilds only the fields it manages; carry forward the rest
  // (e.g., `migrated_from`, unknown future keys) so an edit doesn't drop them.
  const preservedEntry = preserveUnmanagedAssignmentKeys(
    targetAssignment,
    editedAssignment,
  )

  const nextAssignments = {
    ...currentAssignments,
    assignments: [
      ...currentAssignments.assignments.filter((a) => a.slug !== slug),
      preservedEntry,
    ],
  }

  const tree = await createGitTree(client, {
    org: input.org,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: assignmentsFilePath,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(nextAssignments, null, 2) + "\n",
      },
    ],
  })

  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(`Edit assignment: ${input.classroom}/${slug}`),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })
  const updatedRef = await updateRef(
    client,
    input.org,
    newCommit.sha,
    configBranch,
  )

  // Grant the (possibly changed) in-org private template a team read — a
  // non-fatal warning, never thrown (the edit already committed). needsTeamGrant
  // implies a resolved template, so the guard just narrows the type.
  //
  // A LOCKED assignment intentionally has no student-team template read; editing
  // any other field must not re-grant it (needsTeamGrant re-affirms the grant on
  // every save of a private in-org template). Skip the grant while locked so an
  // ordinary edit can't silently re-open it — mirrors the CLI add/reuse guard.
  let templateGrantWarning: string | undefined
  if (needsTeamGrant && preservedEntry.template && !preservedEntry.locked) {
    templateGrantWarning = await resolveTemplateGrant(
      client,
      input.org,
      input.classroom,
      input.slug,
      preservedEntry.template,
      input.canGrantTemplateAccess,
    )
  }

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    templateGrantWarning,
  }
}

// Same pre-write probes gh-teacher runs before writing declarative tests (see
// "Writing assignments.json from another client" in the Advanced-Autograding
// wiki page).
async function ensureDeclarativeTestsWritable(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
) {
  const materializeScript = ".github/scripts/materialize_tests.py"
  if (!(await contentsPathExists(client, org, materializeScript))) {
    throw new Error(
      `${org}/${CONFIG_REPO} is missing ${materializeScript}, so autograding tests would never run. ` +
        "Re-initialize the organization (or run `gh teacher init`) to update the config repo, then retry.",
    )
  }

  const autograderPath = `${classroom}/autograders/${slug}/autograder.py`
  if (await contentsPathExists(client, org, autograderPath)) {
    throw new Error(
      `Assignment "${slug}" already has a custom autograder at ${autograderPath}. ` +
        "Autograding tests and a hand-written autograder.py are mutually exclusive — remove one before adding the other.",
    )
  }
}

// Assemble the normalized classroom50/assignments/v1 entry from form input,
// resolving the template the way the CLI does. Shared by create and edit so
// both write the same schema-valid shape and apply the team grant.
//
// `existingTemplate` (edit only): an unchanged ref (same owner/repo, branch
// unchanged or omitted) reuses the stored block WITHOUT a live lookup, so an
// unrelated-field edit still saves when the template was deleted/un-templated/
// made private-out-of-org. A changed ref is always re-resolved.
async function buildAssignmentEntry(
  client: GitHubClient,
  input: CreateAssignmentInput,
  existingTemplate?: Assignment["template"],
): Promise<{ entry: Assignment; needsTeamGrant: boolean }> {
  const userTests = input.tests.map(draftToTest)

  // A setup command is written as a leading 0-point `run` test named "setup" —
  // the CLI-blessed pre-grading idiom (no runtime.setup field; the runner runs
  // tests in order, non-zero exit fails the step). See makeSetupTest/isSetupTest.
  const setupCommand = input.setup_command?.trim()
  const setupTimeout = input.setup_timeout ?? 0
  if (!input.empty_repo && setupCommand) {
    const setupTimeoutError = validateTestTimeout(setupTimeout)
    if (setupTimeoutError) {
      throw new Error(`setup_timeout: ${setupTimeoutError}`)
    }
  }
  const tests = setupCommand
    ? [makeSetupTest(setupCommand, setupTimeout), ...userTests]
    : userTests

  // empty_repo rules out every grading-adjacent field — a bare repo never
  // carries the autograde shim, so none of them could take effect. Mirrors the
  // CLI's validateEmptyRepoFlags; the form disables these inputs, this is the
  // authoritative backstop.
  if (input.empty_repo) {
    if (input.template_repo.trim()) {
      throw new Error(
        "empty_repo: an empty repository can't use a template — it starts with no content at all.",
      )
    }
    if (tests.length > 0) {
      throw new Error(
        "empty_repo: an empty repository can't have autograding tests or a setup command — it never autogrades.",
      )
    }
    if (input.feedback_pr) {
      throw new Error(
        "empty_repo: an empty repository can't open a Feedback PR — it has no baseline commit.",
      )
    }
    if (input.allowed_files?.trim()) {
      throw new Error(
        "empty_repo: an empty repository can't restrict allowed files — it never autogrades.",
      )
    }
    if (input.release_assets.trim()) {
      throw new Error(
        "empty_repo: an empty repository can't attach submission release files — it never autogrades or publishes a submission Release.",
      )
    }
    if (input.pass_threshold !== undefined) {
      throw new Error(
        "empty_repo: an empty repository can't have a passing threshold — it never autogrades.",
      )
    }
  }

  // no_autograder is a narrower sibling of empty_repo: no shim, so the
  // grading-adjacent fields are rejected — but a template and the Feedback PR
  // are PERMITTED (a templated repo has a baseline commit). It REQUIRES a
  // template (it is the teacher-supplied-CI state: the template carries the
  // workflows). Mutually exclusive with empty_repo. Mirrors the CLI's
  // validateNoAutograderExclusions; the form gates these inputs, this is the
  // authoritative backstop.
  if (input.no_autograder) {
    if (!input.template_repo.trim()) {
      throw new Error(
        "no_autograder: teacher-supplied CI requires a template — the template carries its own workflows. Use an empty repository for a bare repo instead.",
      )
    }
    if (input.empty_repo) {
      throw new Error(
        "no_autograder: mutually exclusive with empty_repo — a bare repo already commits no shim.",
      )
    }
    if (tests.length > 0) {
      throw new Error(
        "no_autograder: teacher-supplied CI can't have autograding tests or a setup command — no shim runs them.",
      )
    }
    if (input.allowed_files?.trim()) {
      throw new Error(
        "no_autograder: teacher-supplied CI can't restrict allowed files — no shim enforces them.",
      )
    }
    if (input.release_assets.trim()) {
      throw new Error(
        "no_autograder: teacher-supplied CI can't attach submission release files — no shim autogrades.",
      )
    }
    if (input.pass_threshold !== undefined) {
      throw new Error(
        "no_autograder: teacher-supplied CI can't have a passing threshold — no shim autogrades.",
      )
    }
  }

  // init_shim is the built-in-autograder-on-an-otherwise-empty-repo state: a
  // template-less repo initialized with only the marker + default shim that
  // DOES autograde, so unlike empty_repo/no_autograder it PERMITS the
  // grading-adjacent fields. It only rules out a template (starter content comes
  // from the template), empty_repo (bare, no shim), and no_autograder (no shim).
  // Mirrors the CLI's validateInitShimExclusions.
  if (input.init_shim) {
    if (input.template_repo.trim()) {
      throw new Error(
        "init_shim: mutually exclusive with a template — init_shim initializes a template-less repo with only the autograde shim.",
      )
    }
    if (input.empty_repo) {
      throw new Error(
        "init_shim: mutually exclusive with empty_repo — empty_repo commits nothing, init_shim commits the default shim.",
      )
    }
    if (input.no_autograder) {
      throw new Error(
        "init_shim: mutually exclusive with no_autograder — one commits the default shim, the other commits none.",
      )
    }
  }

  // include_all_branches only affects the templated generate call, so it
  // requires a template and excludes the template-less states empty_repo /
  // init_shim. Compatible with everything else (branches don't affect grading).
  // Mirrors the CLI's validateIncludeAllBranchesExclusions.
  if (input.include_all_branches) {
    if (!input.template_repo.trim()) {
      throw new Error(
        "include_all_branches: requires a template — it only affects the template generate call.",
      )
    }
    if (input.empty_repo) {
      throw new Error(
        "include_all_branches: mutually exclusive with empty_repo — a bare repo is never generated from a template.",
      )
    }
    if (input.init_shim) {
      throw new Error(
        "include_all_branches: mutually exclusive with init_shim — an init_shim repo is template-less and never generated.",
      )
    }
  }

  // copy_about / copy_topics copy the template's About/Topics onto each student
  // repo at accept time, so both require a template (there is nothing to copy
  // from otherwise). Compatible with everything else. Mirrors the schema's
  // copy_about/copy_topics template-required rules. Issue #569.
  if (input.copy_about && !input.template_repo.trim()) {
    throw new Error(
      "copy_about: requires a template — it copies the template repo's About onto each student repo.",
    )
  }
  if (input.copy_topics && !input.template_repo.trim()) {
    throw new Error(
      "copy_topics: requires a template — it copies the template repo's Topics onto each student repo.",
    )
  }

  // feedback_pr_template reads the template repo's pull_request_template.md for
  // the Feedback PR body, so it needs a template AND the Feedback PR itself.
  // Mirrors the schema's feedback_pr_template conditional.
  if (input.feedback_pr_template) {
    if (!input.template_repo.trim()) {
      throw new Error(
        "feedback_pr_template: requires a template — it reads the template repo's pull request template for the Feedback PR body.",
      )
    }
    if (input.empty_repo || input.feedback_pr === false) {
      throw new Error(
        "feedback_pr_template: requires the Feedback PR to be enabled.",
      )
    }
  }

  if (tests.length > 0) {
    await ensureDeclarativeTestsWritable(
      client,
      input.org,
      input.classroom,
      input.slug,
    )
  }

  // Resolve the template like the CLI (parse, confirm template, default branch,
  // reject out-of-org private), reusing an unchanged stored ref on edit. The
  // template is OPTIONAL (mirrors `--template`): a blank field means a
  // template-less assignment, so skip parse/resolve/grant entirely.
  let template: Assignment["template"] | undefined
  let needsTeamGrant = false
  if (input.template_repo.trim()) {
    const parsedTemplate = parseTemplateRef(input.template_repo, input.org)
    if (templateRefUnchanged(parsedTemplate, existingTemplate)) {
      // Ref unchanged, but still re-resolve live via resolveTemplate — it fails
      // closed before any commit on a template that went truly unusable
      // (deleted, no longer a template, out-of-org private). Use the RESOLVED
      // block (not the stored one) so an edit heals a legacy non-default
      // `branch` down to the template's current default (#673): a custom branch
      // can't be honored, so an unrelated edit shouldn't re-persist a stale one.
      // Reuse needsTeamGrant so the unchanged-ref save re-affirms the
      // (idempotent) team read a prior failure may have dropped.
      const resolved = await resolveTemplate(client, input.org, parsedTemplate)
      template = resolved.template
      needsTeamGrant = resolved.needsTeamGrant
    } else {
      const resolved = await resolveTemplate(client, input.org, parsedTemplate)
      template = resolved.template
      needsTeamGrant = resolved.needsTeamGrant
    }
  }

  // Must match classroom50/assignments/v1 exactly — the CLI rejects unknown
  // fields, so a stray key breaks `gh teacher` for the whole classroom. Omit
  // optional fields (don't write them empty), as the CLI does.
  const entry: Assignment = {
    slug: input.slug,
    name: input.name,
    mode: assertAssignmentMode(input.mode),
    autograder: "default",
    // Mirrors the CLI's `--feedback-pr` default of true — except for an empty
    // repo, where the feature is structurally impossible (no baseline commit).
    feedback_pr: input.empty_repo ? false : (input.feedback_pr ?? true),
  }
  // Written only when true, matching the CLI's omitempty.
  if (input.empty_repo) {
    entry.empty_repo = true
  }
  // Written only when true (CLI omitempty). Teacher-supplied CI, no shim.
  if (input.no_autograder) {
    entry.no_autograder = true
  }
  // Written only when true (CLI omitempty). Built-in autograder on an
  // otherwise-empty, template-less repo (marker + default shim, no README).
  if (input.init_shim) {
    entry.init_shim = true
  }
  // Written only when true (CLI omitempty). Copy all template branches at
  // generate. No immutability check — it's mutable (only affects new accepts).
  if (input.include_all_branches) {
    entry.include_all_branches = true
  }
  // Written only when true (omitempty). Copy the template's About/Topics onto
  // each student repo at accept time (issue #569). Mutable (only affects new
  // accepts). The template-required guard above already rejected them without
  // a template, so no extra check here.
  if (input.copy_about) {
    entry.copy_about = true
  }
  if (input.copy_topics) {
    entry.copy_topics = true
  }
  // Written only when true (omitempty). Use the template's pull_request_template.md
  // as the Feedback PR body. The guard above already rejected it without a
  // template or with the Feedback PR off, so no extra check here.
  if (input.feedback_pr_template) {
    entry.feedback_pr_template = true
  }
  // Omit the template block entirely for a template-less assignment, matching
  // the CLI's nil TemplateRef.
  if (template) {
    entry.template = template
  }
  if (input.description.trim()) {
    entry.description = input.description.trim()
  }
  if (input.due_date.trim()) {
    const { due, due_meta } = buildDueFields(input.due_date.trim())
    entry.due = due
    if (due_meta) {
      entry.due_meta = due_meta
    }
  }
  // Reuses buildDueFields (UTC instant + provenance), remapped to available_from.
  if (input.available_from_date?.trim()) {
    const { due, due_meta } = buildDueFields(input.available_from_date.trim())
    entry.available_from = due
    if (due_meta) {
      entry.available_from_meta = due_meta
    }
  }
  if (input.mode === "group") {
    // A group size outside [GROUP_SIZE_MIN, GROUP_SIZE_MAX] (or non-integer)
    // produces an assignments.json the CLI refuses to parse; enforce the
    // schema bounds here, not just in the form.
    if (
      !Number.isInteger(input.max_group_size) ||
      input.max_group_size < GROUP_SIZE_MIN ||
      input.max_group_size > GROUP_SIZE_MAX
    ) {
      throw new Error(
        `max_group_size: group assignments require a whole number between ${GROUP_SIZE_MIN} and ${GROUP_SIZE_MAX} (got ${input.max_group_size}).`,
      )
    }
    entry.max_group_size = input.max_group_size
  }

  // Runtime overrides (Advanced Settings); omit the block when unset.
  // runs-on: write a string for one label, an array for many (both valid).
  const runnerLabels = parseRunnerLabels(input.runs_on ?? "")
  const containerImage = input.container_image?.trim()
  const containerUser = input.container_user?.trim()
  const runtime: NonNullable<Assignment["runtime"]> = {}
  // Shape-gate each runs-on label and cap the count, matching the CLI's
  // ValidateRunsOn — the RunnerField UI check is advisory only, so this is the
  // authoritative anti-injection gate before the label flows into `runs-on:`.
  if (runnerLabels.length > MAX_RUNNER_LABELS) {
    throw new Error(
      `runtime.runs-on has ${runnerLabels.length} labels (max ${MAX_RUNNER_LABELS}).`,
    )
  }
  const badRunnerLabel = runnerLabels.find(
    (label) => !isRunnerLabelShapeValid(label),
  )
  if (badRunnerLabel) {
    throw new Error(
      `runtime.runs-on ${JSON.stringify(badRunnerLabel)} must be a GitHub runner label — letters, numbers, and . - _ only, no whitespace or metacharacters.`,
    )
  }
  if (runnerLabels.length === 1) {
    runtime["runs-on"] = runnerLabels[0]
  } else if (runnerLabels.length > 1) {
    runtime["runs-on"] = runnerLabels
  }
  if (containerImage) {
    // Containers run on Ubuntu hosts only — reject a macOS/Windows runs-on
    // label, matching the CLI's ValidateRuntime (a custom/self-hosted or Ubuntu
    // label is fine, so a container can still target a specific runner).
    const badLabel = runnerLabels.find(isNonUbuntuHostedLabel)
    if (badLabel) {
      throw new Error(
        `runtime.runs-on ${JSON.stringify(badLabel)} can't be combined with a Docker image — GitHub Actions runs containers on Ubuntu hosts only.`,
      )
    }
    // Image/user flow into Actions' `container:` / `--user` — shape-gate them
    // against the CLI's ValidateContainer so a bad value can't reach the file.
    const imageError = validateContainerImage(containerImage)
    if (imageError) {
      throw new Error(`runtime.container.image: ${imageError}`)
    }
    runtime.container = { image: containerImage }
    if (containerUser) {
      const userError = validateContainerUser(containerUser)
      if (userError) {
        throw new Error(`runtime.container.user: ${userError}`)
      }
      runtime.container.user = containerUser
    }
  }
  // Language toolchains (setup-X versions) and apt packages, validated against
  // the same patterns the CLI enforces so a bad value can't reach the file.
  // Skip both on a self-hosted runner: the grade job ignores managed setup
  // there (runner.environment != 'self-hosted', issue #369), so writing them
  // would persist values the runtime discards. Mirrors the workflow, and keeps
  // the file honest about what will actually run. The UI also disables these
  // fields for self-hosted; this is the authoritative backstop for every
  // writer (CLI, hand-edited form state).
  const selfHosted = isSelfHostedRunnerValue(input.runs_on ?? "")
  const languageInputs: Record<RuntimeLanguage, string | undefined> = {
    python: input.runtime_python,
    node: input.runtime_node,
    java: input.runtime_java,
    go: input.runtime_go,
    rust: input.runtime_rust,
  }
  if (!selfHosted) {
    for (const language of RUNTIME_LANGUAGES) {
      const version = languageInputs[language]?.trim()
      if (!version) continue
      const error = validateLanguageVersion(version)
      if (error) {
        throw new Error(`runtime.${language}: ${error}`)
      }
      runtime[language] = version
    }
  }
  const aptPackages = selfHosted
    ? []
    : parseAptPackages(input.runtime_apt ?? "")
  if (aptPackages.length > 0) {
    // The image owns its packages, so the schema/CLI forbid apt with a
    // container — reject here rather than write a file the CLI won't parse.
    if (containerImage) {
      throw new Error(
        "runtime.apt: extra apt packages can't be combined with a Docker image — install them in the image instead.",
      )
    }
    const aptError = validateAptPackages(aptPackages)
    if (aptError) {
      throw new Error(`runtime.apt: ${aptError}`)
    }
    runtime.apt = aptPackages
  }
  if (Object.keys(runtime).length > 0) {
    entry.runtime = runtime
  }

  // allowed_files: parse the textarea, re-validate, omit when empty.
  const allowedFiles = parseAllowedFiles(input.allowed_files ?? "")
  if (allowedFiles.length > 0) {
    const allowedFilesError = validateAllowedFiles(allowedFiles)
    if (allowedFilesError) {
      throw new Error(`allowed_files: ${allowedFilesError}`)
    }
    entry.allowed_files = allowedFiles
  }

  // release_assets: parse the textarea, re-validate, omit when empty.
  const releaseAssets = parseReleaseAssets(input.release_assets)
  if (releaseAssets.length > 0) {
    const releaseAssetsError = validateReleaseAssets(releaseAssets)
    if (releaseAssetsError) {
      throw new Error(`release_assets: ${releaseAssetsError.message}`)
    }
    entry.release_assets = releaseAssets
  }

  if (tests.length > 0) {
    entry.tests = tests
  }

  // test_defaults: assignment-level defaults for the per-test reporting
  // options. Only meaningful with tests (the materializer folds it into
  // tests.json), so omit it otherwise; also omit when every value is the
  // grader default (the caller already collapses those away).
  if (
    tests.length > 0 &&
    input.test_defaults &&
    Object.keys(input.test_defaults).length > 0
  ) {
    const failureDetails = input.test_defaults["failure-details"]
    if (
      failureDetails !== undefined &&
      !TEST_FAILURE_DETAILS_LEVELS.includes(failureDetails)
    ) {
      throw new Error(
        `test_defaults.failure-details: must be one of ${TEST_FAILURE_DETAILS_LEVELS.join(", ")} (got "${String(failureDetails)}").`,
      )
    }
    entry.test_defaults = { ...input.test_defaults }
  }

  // pass_threshold: opt-in integer percentage [0,100]. Absent means the teacher
  // didn't enable a passing threshold, so omit the field entirely — absent =
  // "no passing concept" everywhere downstream. Validate bounds so a bad value
  // can't produce a file the CLI refuses to parse.
  if (input.pass_threshold !== undefined) {
    const threshold = input.pass_threshold
    if (
      !Number.isInteger(threshold) ||
      threshold < PASS_THRESHOLD_MIN ||
      threshold > PASS_THRESHOLD_MAX
    ) {
      throw new Error(
        `pass_threshold: must be a whole number between ${PASS_THRESHOLD_MIN} and ${PASS_THRESHOLD_MAX} (got ${threshold}).`,
      )
    }
    entry.pass_threshold = threshold
  }

  // student_permission: opt-in accept-time role for the enrolled student on
  // their own repo. Omit when it equals the mode default (absent = default
  // everywhere downstream), and clamp a group assignment up to admin (a founder
  // must manage members). Validate against the ladder so a bad value can't
  // produce a file the CLI refuses to parse.
  if (input.student_permission) {
    if (!REPO_PERMISSIONS.includes(input.student_permission)) {
      throw new Error(
        `student_permission: must be one of ${REPO_PERMISSIONS.join(", ")} (got "${input.student_permission}").`,
      )
    }
    const mode = assertAssignmentMode(input.mode)
    const effective =
      mode === "group" && input.student_permission !== "admin"
        ? "admin"
        : input.student_permission
    if (effective !== defaultStudentPermission(mode)) {
      entry.student_permission = effective
    }
  }

  // submission_mode: validate, then collapse the wire default away like the CLI
  // (assignment.go, submissionmode.go) so an every-push entry saved here stays
  // byte-identical to one `gh teacher assignment add` wrote — editing a
  // CLI-created assignment must not add a field the teacher never touched.
  // Absence IS every-push, so no intent is lost. Permitted for every repo shape
  // (including empty_repo / no_autograder): with no shim it carries no trigger,
  // but it still defines what the submissions page counts as a submission.
  const resolvedSubmissionMode = resolveSubmissionMode(input.submission_mode)
  if (!SUBMISSION_MODES.includes(resolvedSubmissionMode)) {
    throw new Error(
      `submission_mode: must be one of ${SUBMISSION_MODES.join(", ")} (got "${resolvedSubmissionMode}").`,
    )
  }
  if (resolvedSubmissionMode !== "every-push") {
    entry.submission_mode = resolvedSubmissionMode
  }

  // submission_tags: omit when empty (no milestone tags — today's behavior),
  // mirroring the CLI's omitempty. Validate so a bad pattern can't produce a
  // file the CLI refuses to parse. Permitted for every repo shape: with a shim
  // they widen the trigger; without one they are the submissions-page detection
  // definition.
  if (input.submission_tags && input.submission_tags.length > 0) {
    const tagsError = validateSubmissionTags(input.submission_tags)
    if (tagsError) {
      throw new Error(`submission_tags: ${tagsError}`)
    }
    entry.submission_tags = [...input.submission_tags]
  }

  // grading: omit when it resolves to plain auto with no max (today's behavior),
  // mirroring the CLI's omitempty. Validate mode against the enum and require a
  // whole-number max >= 1 for manual (a 0 max is the ungraded sentinel); reject
  // max_points for off/auto. Orthogonal to the autograding tri-state, so no
  // empty_repo/no_autograder cross-check here.
  if (input.grading && input.grading.mode !== "auto") {
    if (!GRADING_MODES.includes(input.grading.mode)) {
      throw new Error(
        `grading.mode: must be one of ${GRADING_MODES.join(", ")} (got "${input.grading.mode}").`,
      )
    }
    if (input.grading.mode === "manual") {
      const max = input.grading.max_points
      if (
        typeof max !== "number" ||
        !Number.isInteger(max) ||
        max < GRADING_MAX_POINTS_MIN
      ) {
        throw new Error(
          `grading.max_points: must be a whole number >= ${GRADING_MAX_POINTS_MIN} for manual grading (got ${String(max)}).`,
        )
      }
      entry.grading = { mode: "manual", max_points: max }
    } else {
      // "off" — no max_points.
      entry.grading = { mode: input.grading.mode }
    }
  } else if (input.grading?.max_points !== undefined) {
    // Defensive: an auto/absent grading must not carry max_points.
    throw new Error("grading.max_points: only valid for manual grading.")
  }

  // repo_features: write only the keys the teacher set (undefined = inherit),
  // and omit the block entirely when no key is set — mirroring runtime's
  // omit-when-empty rule so an all-inherit assignment carries no repo_features.
  const repoFeatures: NonNullable<Assignment["repo_features"]> = {}
  if (input.repo_features?.issues !== undefined) {
    repoFeatures.issues = input.repo_features.issues
  }
  if (input.repo_features?.wiki !== undefined) {
    repoFeatures.wiki = input.repo_features.wiki
  }
  if (input.repo_features?.projects !== undefined) {
    repoFeatures.projects = input.repo_features.projects
  }
  if (input.repo_features?.pull_requests !== undefined) {
    repoFeatures.pull_requests = input.repo_features.pull_requests
  }
  if (Object.keys(repoFeatures).length > 0) {
    entry.repo_features = repoFeatures
  }

  return { entry, needsTeamGrant }
}

// The NON-OWNER staff roles that get an eager read grant on a private in-org
// template (head-TA, then TA). Single-sources the slug set below so the web
// grant can't silently omit a role. Mirror of the Go source of truth
// configrepo.TemplateReadStaffRoles ([RoleHeadTA, RoleTA]) — the two are
// hand-synced; a parity test pins this list so a Go-side addition forces a
// visible TS edit here rather than silently dropping from the web grant. The
// teacher team is omitted (owners have repo access via ownership).
export const TEMPLATE_READ_STAFF_ROLES = ["hta", "ta"] as const

// Grant the classroom team read on an in-org private template so rostered
// students can generate from it (mirrors the CLI's assignment add). The slug
// comes from classroom.json (authoritative). A genuinely teamless classroom
// (404, or a read with no team block) gets "recreate the classroom" advice; a
// transient read failure must NOT — that could push a teacher to destroy a
// healthy classroom — so it gets a retry message instead.
async function grantTeamTemplateRead(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
  template: NonNullable<Assignment["template"]>,
) {
  let teamSlug: string | undefined
  let staffTeamSlugs: string[] = []
  try {
    const classroomJson = await getClassroomJson(client, { org, classroom })
    teamSlug = classroomJson.team?.slug
    // Non-owner staff teams (TEMPLATE_READ_STAFF_ROLES) need an explicit read on
    // a private template; the teacher team is omitted (owners have it via
    // ownership).
    staffTeamSlugs = TEMPLATE_READ_STAFF_ROLES.map(
      (role) => classroomJson.teams?.[role]?.slug,
    ).filter((s): s is string => Boolean(s))
  } catch (err) {
    // 404 = no classroom.json (pre-feature) is a genuine "no team"; fall
    // through. Anything else is transient and must not be misread as "no team".
    if (!(err instanceof GitHubAPIError && err.isNotFound)) {
      throw new Error(
        `Assignment "${slug}" was saved, but checking classroom "${classroom}" for its team failed (${getErrorMessage(err)}). The classroom team read on the private template ${template.owner}/${template.repo} could not be granted — retry the save; if it keeps failing, grant the team read on ${template.owner}/${template.repo} directly in GitHub (Settings -> Collaborators and teams).`,
        { cause: err },
      )
    }
    teamSlug = undefined
  }

  if (!teamSlug) {
    throw new Error(
      `Assignment "${slug}" was saved, but classroom "${classroom}" has no team to grant read on the private template ${template.owner}/${template.repo}. Recreate the classroom so the team exists, then students can accept.`,
    )
  }

  await addRepositoryToTeam(client, {
    org,
    teamSlug,
    owner: template.owner,
    repo: template.repo,
    permission: "pull",
  })

  // Best-effort staff-team grants (mirrors the CLI): non-blocking, since the
  // student grant above is what gates `student accept` and collect-scores
  // re-affirms these. The list is already filtered to present slugs.
  for (const staffTeamSlug of staffTeamSlugs) {
    try {
      await addRepositoryToTeam(client, {
        org,
        teamSlug: staffTeamSlug,
        owner: template.owner,
        repo: template.repo,
        permission: "pull",
      })
    } catch (err) {
      log.warn("granting staff team template read failed (non-fatal)", {
        org,
        classroom,
        staffTeamSlug,
        template: `${template.owner}/${template.repo}`,
        err,
      })
    }
  }
}

// Grant the template read but never throw: the commit already landed, so a
// grant failure can't be reported as a failed save. Returns an actionable
// warning on failure (the assignment works except for student accept against
// the private template), or undefined on success. Mirrors teamDeleteWarning.
export async function tryGrantTeamTemplateRead(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
  template: NonNullable<Assignment["template"]>,
): Promise<string | undefined> {
  try {
    await grantTeamTemplateRead(client, org, classroom, slug, template)
    return undefined
  } catch (err) {
    // Log the raw error so a dev-time bug isn't fully hidden behind the
    // user-facing warning string.
    log.error("grantTeamTemplateRead failed (assignment saved)", { err })
    const detail = getErrorMessage(err)
    return (
      `Assignment "${slug}" was saved, but granting the classroom team read on ` +
      `the private template ${template.owner}/${template.repo} failed (${detail}). ` +
      `Students can't accept it until the ${classroomTeamSlug(classroom)} team is granted ` +
      `read on that repo — grant the team read on ${template.owner}/${template.repo} ` +
      `directly in GitHub (Settings -> Collaborators and teams), then students can accept.`
    )
  }
}

// The warning returned (not undefined) when a non-owner author saves an
// assignment whose private in-org template needs the owner-only team read-grant.
// Returning undefined would read as "clean" and 404 students on accept with no
// signal; this points them at an owner instead.
export function templateGrantOwnerRequiredWarning(
  classroom: string,
  slug: string,
  template: NonNullable<Assignment["template"]>,
): string {
  return (
    `Assignment "${slug}" was saved, but its private template ${template.owner}/${template.repo} ` +
    `needs the ${classroomTeamSlug(classroom)} team granted read — a step only an organization owner can do. ` +
    `Students can't accept it until an owner opens this classroom (which grants it automatically) or grants ` +
    `the team read on ${template.owner}/${template.repo} directly in GitHub (Settings -> Collaborators and teams).`
  )
}

// The one grant-decision recipe shared by create / edit / reuse: attempt the
// owner-only team read-grant when canGrantTemplateAccess is set, else return the
// owner-required warning rather than silently skipping (a silent skip would 404
// students on accept). Single-sourced so the three write paths can't drift; the
// flag's tri-state derivation lives in useCanAttemptTemplateGrant.
export async function resolveTemplateGrant(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
  template: NonNullable<Assignment["template"]>,
  canGrantTemplateAccess: boolean | undefined,
): Promise<string | undefined> {
  return canGrantTemplateAccess
    ? tryGrantTeamTemplateRead(client, org, classroom, slug, template)
    : templateGrantOwnerRequiredWarning(classroom, slug, template)
}

// Refuse a write into an archived classroom (active: false). The UI hides the
// affordances, but the write path is the authoritative guard — a stale tab, a
// direct API call, or a CLI/agent must not mutate an archived classroom. Reads
// classroom.json fresh and fails closed before any commit. A teamless/legacy
// classroom (no `active`) reads as active, so this never blocks normal use.
export async function createAssignment(
  client: GitHubClient,
  input: CreateAssignmentInput,
): Promise<CreateAssignmentResult> {
  log.info("create assignment: started", {
    org: input.org,
    classroom: input.classroom,
    slug: input.slug,
  })
  // The archive guard, entry build, and org ref read are independent, so run
  // them concurrently — Promise.all rejects on the first rejection, so an
  // archived classroom still fails closed before any write.
  const [, { entry: assignmentBody, needsTeamGrant }, configBranch] =
    await Promise.all([
      assertClassroomNotArchived(client, input.org, input.classroom),
      buildAssignmentEntry(client, input),
      getConfigRepoBranch(client, input.org),
    ])
  const ref = await getBranchRef(client, input.org, configBranch)

  const commit = await getCommit(client, input.org, ref.object.sha)

  const assignmentsFilePath = `${input.classroom}/assignments.json`
  const currentAssignments = await getAssignmentsFile(client, {
    org: input.org,
    path: assignmentsFilePath,
    ref: ref.object.sha,
  })

  if (
    currentAssignments.assignments.some(
      (assignment) => assignment.slug === assignmentBody.slug,
    )
  ) {
    throw new Error(`Assignment already exists: ${assignmentBody.slug}`)
  }
  // The authoritative reservation counterpart to the form's optimistic check:
  // a renamed assignment's old slug must never be reused, even when the form's
  // cached assignments predate a CLI-side rename (see Assignment.renamed_from).
  const newSlugLower = assignmentBody.slug.toLowerCase()
  if (
    currentAssignments.assignments.some(
      (assignment) => assignment.renamed_from?.toLowerCase() === newSlugLower,
    )
  ) {
    throw new Error(
      `Slug "${assignmentBody.slug}" is reserved: it is the previous slug of a renamed assignment, and reusing it would break the redirects its renamed student repositories rely on — choose a different slug.`,
    )
  }

  const nextAssignments: AssignmentsFile = {
    ...currentAssignments,
    assignments: [...currentAssignments.assignments, assignmentBody],
  }

  const tree = await createGitTree(client, {
    ...input,
    base_tree: commit.tree.sha,
    tree: [
      {
        path: assignmentsFilePath,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(nextAssignments, null, 2) + "\n",
      },
    ],
  })
  const newCommit = await createGitCommit(client, {
    org: input.org,
    message: prefixCommit(
      `Create assignment: ${input.classroom}/${assignmentBody.slug}`,
    ),
    tree_sha: tree.sha,
    parents: [ref.object.sha],
  })
  const updatedRef = await updateRef(
    client,
    input.org,
    newCommit.sha,
    configBranch,
  )

  let templateGrantWarning: string | undefined
  if (needsTeamGrant && assignmentBody.template) {
    templateGrantWarning = await resolveTemplateGrant(
      client,
      input.org,
      input.classroom,
      input.slug,
      assignmentBody.template,
      input.canGrantTemplateAccess,
    )
  }

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
    templateGrantWarning,
  }
}

// editAssignment writes to the same classroom50 main branch as createAssignment
// and the roster commits, so a concurrent write 409s non-fast-forward. It
// re-reads the ref + assignments.json each call, so it's safe to retry —
// mirror the create path.
export async function editAssignmentWithConflictRetry(
  client: GitHubClient,
  input: CreateAssignmentInput,
) {
  return withGitConflictRetry(() => editAssignment(client, input))
}

export type SetAssignmentLockInput = {
  org: string
  classroom: string
  slug: string
  locked: boolean
}

export type SetAssignmentClosedInput = {
  org: string
  classroom: string
  slug: string
  closed: boolean
}

export type SetAssignmentClosedResult = Omit<
  CreateClassroomResult,
  "updatedRef"
> & {
  // Present only when the flag actually changed; a no-op (already in the
  // requested state) skips the commit and leaves this undefined.
  updatedRef?: CreateClassroomResult["updatedRef"]
  // The flag value that landed. Echoed so the caller doesn't reread.
  closed: boolean
}

export type SetAssignmentLockResult = Omit<
  CreateClassroomResult,
  "updatedRef"
> & {
  // Present only when the flag actually changed; a no-op (already in the
  // requested state) skips the commit and leaves this undefined.
  updatedRef?: CreateClassroomResult["updatedRef"]
  // The flag value that landed. Echoed so the caller doesn't reread.
  locked: boolean
  // Set when the flag flip committed but reconciling the private-template
  // student-team access failed (non-fatal): a locked assignment whose student
  // team still has read, or an unlocked one whose read wasn't restored. The UI
  // surfaces it like templateGrantWarning.
  templateAccessWarning?: string
}

// Remove ONLY the classroom student team's read on a private in-org template
// (the mirror of the student half of grantTeamTemplateRead). Staff teams are
// deliberately untouched. Never throws — the flag flip already landed, so a
// failure here is surfaced as a warning, not a failed lock.
async function revokeStudentTeamTemplateRead(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
  template: NonNullable<Assignment["template"]>,
): Promise<string | undefined> {
  let team: { id: number; slug: string } | undefined
  try {
    const classroomJson = await getClassroomJson(client, { org, classroom })
    team = classroomJson.team
  } catch (err) {
    if (!(err instanceof GitHubAPIError && err.isNotFound)) {
      log.error("revokeStudentTeamTemplateRead: classroom read failed", { err })
      return (
        `Assignment "${slug}" was locked, but reading classroom "${classroom}" to find its team failed ` +
        `(${getErrorMessage(err)}). The ${classroomTeamSlug(classroom)} team's read on the private template ` +
        `${template.owner}/${template.repo} was not removed — remove it in GitHub (Settings -> Collaborators and teams) ` +
        `so students can't accept while it's locked.`
      )
    }
    team = undefined
  }
  // No team recorded (pre-feature classroom): nothing was ever granted, so a
  // locked assignment already has no student-team template read.
  if (!team?.slug) return undefined
  const teamSlug = team.slug

  // Fail closed on a drifted/foreign ref: never strip repo access from a team
  // outside the classroom50- namespace this app owns (mirrors the CLI's
  // IsDeletableClassroomTeamRef guard on the destructive path).
  if (!isDeletableClassroomTeamRef(team)) {
    log.error("revokeStudentTeamTemplateRead: non-namespaced team ref", {
      teamSlug,
    })
    return (
      `Assignment "${slug}" was locked, but the recorded classroom team "${teamSlug}" is outside the ` +
      `classroom50- namespace, so its access to ${template.owner}/${template.repo} was left unchanged. ` +
      `Remove it in GitHub (Settings -> Collaborators and teams) if students should not have read while locked.`
    )
  }

  try {
    await removeRepositoryFromTeam(client, {
      org,
      teamSlug,
      owner: template.owner,
      repo: template.repo,
    })
    return undefined
  } catch (err) {
    log.error("revokeStudentTeamTemplateRead failed (assignment locked)", {
      err,
    })
    return (
      `Assignment "${slug}" was locked, but removing the ${classroomTeamSlug(classroom)} team's read on the ` +
      `private template ${template.owner}/${template.repo} failed (${getErrorMessage(err)}). Students may still be ` +
      `able to accept — remove the team's access to ${template.owner}/${template.repo} directly in GitHub ` +
      `(Settings -> Collaborators and teams).`
    )
  }
}

// Flip an assignment's `locked` flag in assignments.json and reconcile the
// private-template student-team access: locking removes the student team's read
// on a private in-org template, unlocking re-grants it (student + staff, via
// the shared grant path). Public/absent/out-of-org templates are a UX-gate-only
// lock with no GitHub access change. The template side effect never throws (the
// commit already landed); its failure returns a non-fatal warning.
export async function setAssignmentLock(
  client: GitHubClient,
  input: SetAssignmentLockInput,
): Promise<SetAssignmentLockResult> {
  const { org, classroom, slug, locked } = input
  log.info("set assignment lock: started", { org, classroom, slug, locked })

  const [, configBranch] = await Promise.all([
    assertClassroomNotArchived(client, org, classroom),
    getConfigRepoBranch(client, org),
  ])
  const ref = await getBranchRef(client, org, configBranch)
  const commit = await getCommit(client, org, ref.object.sha)

  const assignmentsFilePath = `${classroom}/assignments.json`
  const currentAssignments = await getAssignmentsFile(client, {
    org,
    path: assignmentsFilePath,
    ref: ref.object.sha,
  })

  const target = currentAssignments.assignments.find((a) => a.slug === slug)
  if (!target) {
    throw new Error(`Existing assignment matching ${slug} was not found.`)
  }

  const alreadyInState = Boolean(target.locked) === locked

  // Skip the commit when already in the requested state (a double-click or
  // stale tab), mirroring the CLI's no-op — but still reconcile template access
  // below, since a prior run may have flipped the flag yet failed the
  // grant/revoke. Reuse the current ref/tree as the "no change" result.
  let newCommitSha = ref.object.sha
  let newTreeSha = commit.tree.sha
  let updatedRef: CreateClassroomResult["updatedRef"] | undefined

  if (!alreadyInState) {
    const updatedEntry: Assignment = { ...target, locked }
    // Collapse to the wire's absent-is-false shape (matches the CLI's
    // omitempty), so unlocking drops the key rather than writing `locked: false`.
    if (!locked) delete updatedEntry.locked

    const nextAssignments: AssignmentsFile = {
      ...currentAssignments,
      assignments: [
        ...currentAssignments.assignments.filter((a) => a.slug !== slug),
        updatedEntry,
      ],
    }

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: [
        {
          path: assignmentsFilePath,
          mode: "100644",
          type: "blob",
          content: JSON.stringify(nextAssignments, null, 2) + "\n",
        },
      ],
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `${locked ? "Lock" : "Unlock"} assignment: ${classroom}/${slug}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    updatedRef = await updateRef(client, org, newCommit.sha, configBranch)
    newCommitSha = newCommit.sha
    newTreeSha = tree.sha
  }

  const templateAccessWarning = await reconcileLockTemplateAccess(
    client,
    org,
    classroom,
    slug,
    target.template,
    locked,
  )

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha,
    newCommitSha,
    updatedRef,
    locked,
    templateAccessWarning,
  }
}

// Reconcile the private in-org template's student-team read after a lock flip:
// revoke on lock, re-grant on unlock. Only a private in-org template has a
// student-team grant to change; public/absent/out-of-org is a UX-gate-only
// lock. Never throws (the flag flip already committed): a probe or reconcile
// failure downgrades to a non-fatal warning the caller surfaces.
async function reconcileLockTemplateAccess(
  client: GitHubClient,
  org: string,
  classroom: string,
  slug: string,
  template: Assignment["template"],
  locked: boolean,
): Promise<string | undefined> {
  if (!template) return undefined
  const inOrg = template.owner.toLowerCase() === org.toLowerCase()
  if (!inOrg) return undefined

  // getRepo returns null on 404 (since-deleted/invisible template → nothing to
  // reconcile) but rethrows a transient 5xx/429; catch it so a probe failure
  // can't fail an already-committed lock (the CLI treats this as a warning too).
  let repo
  try {
    repo = await getRepo(client, template.owner, template.repo)
  } catch (err) {
    log.error("reconcileLockTemplateAccess: template probe failed", { err })
    return locked
      ? `Assignment "${slug}" was locked, but checking the private template ${template.owner}/${template.repo} failed (${getErrorMessage(err)}); the ${classroomTeamSlug(classroom)} team's read was not removed. Remove it in GitHub (Settings -> Collaborators and teams) so students can't accept while it's locked.`
      : `Assignment "${slug}" was unlocked, but checking the private template ${template.owner}/${template.repo} failed (${getErrorMessage(err)}); the ${classroomTeamSlug(classroom)} team's read was not restored. Retry the unlock, or grant the team read on ${template.owner}/${template.repo} in GitHub.`
  }
  if (!repo?.private) return undefined

  return locked
    ? revokeStudentTeamTemplateRead(client, org, classroom, slug, template)
    : tryGrantTeamTemplateRead(client, org, classroom, slug, template)
}

// Same concurrency story as editAssignment: the lock write hits classroom50's
// default branch, so a concurrent write 409s; each attempt re-reads the ref and
// file, so retrying is safe.
export async function setAssignmentLockWithConflictRetry(
  client: GitHubClient,
  input: SetAssignmentLockInput,
) {
  return withGitConflictRetry(() => setAssignmentLock(client, input))
}

// Flip an assignment's `closed` flag in assignments.json. Unlike setAssignmentLock
// this has NO template-access side effect: closing only ends the submission
// window (the accept gate reads this flag). The teacher "Close submission" action
// pairs this write with a per-repo collaborator downgrade handled by the caller.
export async function setAssignmentClosed(
  client: GitHubClient,
  input: SetAssignmentClosedInput,
): Promise<SetAssignmentClosedResult> {
  const { org, classroom, slug, closed } = input
  log.info("set assignment closed: started", { org, classroom, slug, closed })

  const [, configBranch] = await Promise.all([
    assertClassroomNotArchived(client, org, classroom),
    getConfigRepoBranch(client, org),
  ])
  const ref = await getBranchRef(client, org, configBranch)
  const commit = await getCommit(client, org, ref.object.sha)

  const assignmentsFilePath = `${classroom}/assignments.json`
  const currentAssignments = await getAssignmentsFile(client, {
    org,
    path: assignmentsFilePath,
    ref: ref.object.sha,
  })

  const target = currentAssignments.assignments.find((a) => a.slug === slug)
  if (!target) {
    throw new Error(`Existing assignment matching ${slug} was not found.`)
  }

  const alreadyInState = Boolean(target.closed) === closed

  let newCommitSha = ref.object.sha
  let newTreeSha = commit.tree.sha
  let updatedRef: CreateClassroomResult["updatedRef"] | undefined

  if (!alreadyInState) {
    const updatedEntry: Assignment = { ...target, closed }
    // Collapse to the wire's absent-is-false shape (matches the CLI's
    // omitempty), so reopening drops the key rather than writing `closed: false`.
    if (!closed) delete updatedEntry.closed

    const nextAssignments: AssignmentsFile = {
      ...currentAssignments,
      assignments: [
        ...currentAssignments.assignments.filter((a) => a.slug !== slug),
        updatedEntry,
      ],
    }

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: [
        {
          path: assignmentsFilePath,
          mode: "100644",
          type: "blob",
          content: JSON.stringify(nextAssignments, null, 2) + "\n",
        },
      ],
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(
        `${closed ? "Close" : "Reopen"} assignment: ${classroom}/${slug}`,
      ),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    updatedRef = await updateRef(client, org, newCommit.sha, configBranch)
    newCommitSha = newCommit.sha
    newTreeSha = tree.sha
  }

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha,
    newCommitSha,
    updatedRef,
    closed,
  }
}

// Same concurrency story as setAssignmentLock: the write hits classroom50's
// default branch, so a concurrent write 409s; each attempt re-reads the ref and
// file, so retrying is safe.
export async function setAssignmentClosedWithConflictRetry(
  client: GitHubClient,
  input: SetAssignmentClosedInput,
) {
  return withGitConflictRetry(() => setAssignmentClosed(client, input))
}
