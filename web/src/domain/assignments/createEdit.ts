import type { GitHubClient } from "@/github-core/client"
import type { Assignment } from "@/types/classroom"
import {
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  PASS_THRESHOLD_MAX,
  PASS_THRESHOLD_MIN,
  assertAssignmentMode,
} from "@/types/classroom"
import {
  getBranchRef,
  getClassroomJson,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import { classroomTeamSlug } from "@/util/teamSlug"
import { GitHubAPIError } from "@/github-core/errors"
import { draftToTest, makeSetupTest } from "@/util/assignmentTests"
import { buildDueFields } from "@/util/formatDate"
import { prefixCommit } from "@/util/commit"
import {
  parseRunnerLabels,
  isRunnerLabelShapeValid,
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
import {
  addRepositoryToTeam,
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
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

export type CreateAssignmentResult = CreateClassroomResult & {
  // Set when the assignment saved but the follow-up team read grant on a
  // private in-org template failed — a non-fatal warning the UI surfaces
  // (students can't accept until fixed). Mirrors teamDeleteWarning.
  templateGrantWarning?: string
}

// Ownership of every Assignment entry-level key on the edit path. Typed as a
// total Record<keyof Assignment, ...>, so adding a field to Assignment fails to
// compile here until classified — closing the silent-desync trap where a new
// managed field omitted from the set lets an edit that clears it get
// re-populated from the stale existing entry. "managed": buildAssignmentEntry
// rebuilds it from input, so a clearing edit must win. "unmanaged": the form
// never touches it; preserve verbatim on read-modify-write (mirrors the CLI's
// AssignmentEntry.Extra).
const ASSIGNMENT_KEY_OWNERSHIP: Record<
  keyof Assignment,
  "managed" | "unmanaged"
> = {
  slug: "managed",
  name: "managed",
  description: "managed",
  template: "managed",
  due: "managed",
  due_meta: "managed",
  mode: "managed",
  autograder: "managed",
  max_group_size: "managed",
  feedback_pr: "managed",
  // Managed (rebuilt from input) but IMMUTABLE: editAssignment rejects an edit
  // whose empty_repo differs from the stored entry, so the rebuild can only
  // ever re-write the same value. The edit form shows it read-only.
  empty_repo: "managed",
  // Fully managed AND a closed object: the CLI decodes runtime strictly
  // (RuntimeRef has no Extra, DisallowUnknownFields; schema additionalProperties
  // false), so the rebuilt runtime must win and any unknown sub-key drops rather
  // than round-tripping into a file the CLI would reject.
  runtime: "managed",
  allowed_files: "managed",
  pass_threshold: "managed",
  tests: "managed",
  // Written only by the CLI's `migrate`; the form never manages it, so it must
  // ride through a GUI edit untouched.
  migrated_from: "unmanaged",
}

// Keys the edit form fully owns, derived from the ownership map above so it can
// never drift from the Assignment type.
const EDIT_MANAGED_ASSIGNMENT_KEYS = new Set<string>(
  Object.entries(ASSIGNMENT_KEY_OWNERSHIP)
    .filter(([, ownership]) => ownership === "managed")
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

  // empty_repo is immutable: student repos were provisioned (or left bare) at
  // accept time and are never retrofitted, so flipping the flag would strand
  // every already-accepted repo on the old behavior. Mirrors the CLI's
  // ValidateEmptyRepoUnchanged. Checked before the build so the error names
  // the real constraint rather than a mutual-exclusion side effect.
  if (Boolean(input.empty_repo) !== Boolean(targetAssignment.empty_repo)) {
    throw new Error(
      `empty_repo cannot be changed after creation (assignment "${slug}"): repositories students already accepted are not retrofitted. Create a new assignment under a different slug instead — reusing this slug (even after removing it) would leave already-accepted repos on the old setting.`,
    )
  }

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
  // (e.g. `migrated_from`, unknown future keys) so an edit doesn't drop them.
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
  let templateGrantWarning: string | undefined
  if (needsTeamGrant && preservedEntry.template) {
    templateGrantWarning = await tryGrantTeamTemplateRead(
      client,
      input.org,
      input.classroom,
      input.slug,
      preservedEntry.template,
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
// the "For other clients" section of the Autograders wiki).
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
  const tests = setupCommand
    ? [makeSetupTest(setupCommand), ...userTests]
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
    if (input.pass_threshold !== undefined) {
      throw new Error(
        "empty_repo: an empty repository can't have a passing threshold — it never autogrades.",
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
      // Ref unchanged, but still re-validate live via resolveTemplate — it runs
      // the cross-org private-fork guard and fails closed before any commit if
      // the stored ref went unreliable (a fork whose upstream went private, a
      // repo predating the guard). Reuse its needsTeamGrant so an unchanged-ref
      // save re-affirms the (idempotent) team read: a grant GitHub or a prior
      // failure dropped is repaired on the next edit, not left stranded.
      const resolved = await resolveTemplate(client, input.org, parsedTemplate)
      template = existingTemplate!
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
  const languageInputs: Record<RuntimeLanguage, string | undefined> = {
    python: input.runtime_python,
    node: input.runtime_node,
    java: input.runtime_java,
    go: input.runtime_go,
    rust: input.runtime_rust,
  }
  for (const language of RUNTIME_LANGUAGES) {
    const version = languageInputs[language]?.trim()
    if (!version) continue
    const error = validateLanguageVersion(version)
    if (error) {
      throw new Error(`runtime.${language}: ${error}`)
    }
    runtime[language] = version
  }
  const aptPackages = parseAptPackages(input.runtime_apt ?? "")
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

  if (tests.length > 0) {
    entry.tests = tests
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

  return { entry, needsTeamGrant }
}

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
  let taTeamSlug: string | undefined
  try {
    const classroomJson = await getClassroomJson(client, { org, classroom })
    teamSlug = classroomJson.team?.slug
    taTeamSlug = classroomJson.teams?.ta?.slug
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

  // Best-effort: grant the TA staff team the same read so a base-permission-
  // `none` TA can read the private template without waiting for collect-scores
  // (mirrors the CLI). Non-blocking — the student grant above is what gates
  // `student accept`; a TA-grant failure only warns and collect-scores
  // re-affirms it. A classroom with no recorded TA team is a clean skip.
  if (taTeamSlug) {
    try {
      await addRepositoryToTeam(client, {
        org,
        teamSlug: taTeamSlug,
        owner: template.owner,
        repo: template.repo,
        permission: "pull",
      })
    } catch (err) {
      log.warn("granting TA staff team template read failed (non-fatal)", {
        org,
        classroom,
        taTeamSlug,
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
    templateGrantWarning = await tryGrantTeamTemplateRead(
      client,
      input.org,
      input.classroom,
      input.slug,
      assignmentBody.template,
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
