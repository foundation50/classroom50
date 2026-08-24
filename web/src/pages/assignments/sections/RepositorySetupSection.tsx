import { useQuery } from "@tanstack/react-query"
import { InlineSpinner } from "@/components/Spinner"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { LinkExternalIcon, SyncIcon } from "@/components/ui/icons"
import { Alert, Button, cx, FormField, Select } from "@/components/ui"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { getRepo } from "@/github-core/repoReads"
import { parseTemplateRef, repoContentsPathExists } from "@/domain/assignments"
import { REPO_PERMISSIONS, defaultStudentPermission } from "@/types/classroom"
import { TemplateField } from "../TemplateField"
import { ToggleRow } from "../AdvancedRuntimeFields"
import type { AssignmentForm, RepoSource } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import type { FormShape } from "../formShape"
import { SectionCard } from "./SectionCard"
import { CollapsibleAdvanced } from "./CollapsibleAdvanced"

// GitHub's own reference for the repo role ladder (read/triage/write/maintain/
// admin), linked next to the Student repo access help so teachers can see what
// each level grants.
const REPO_ROLES_DOCS_URL =
  "https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization#repository-roles-for-organizations"

// Repository Setup: the common path stays visible — the "Start with a template"
// source (default No; no template -> an "Add a README" toggle picks initialized
// vs. bare; a template shows the picker + an "Include all branches" toggle),
// then the Feedback PR toggle (decoupled from autograding — available for any
// non-empty repo). The rarer controls (copy About/Topics, feedback-PR template
// body, student repo access override, and Repository features) move into an
// "Advanced settings" collapsible so they don't overwhelm the common case.
// The source choice folds into empty_repo + template on submit via
// deriveFormShape; it stays editable on edit, but changing it only re-provisions
// repos accepted from now on (already-accepted repos aren't retrofitted), so the
// edit form warns when students have already accepted.
export function RepositorySetupSection({
  form,
  edit,
  onReset,
  org,
  classroom,
  slug,
  hasAcceptedStudents = false,
}: {
  form: AssignmentForm
  edit: boolean
  onReset?: () => void
  org?: string
  classroom?: string
  slug?: string
  // Edit mode: whether any student has already accepted. Gates the
  // repo-source change caveat so it shows only when a change would strand
  // existing repos.
  hasAcceptedStudents?: boolean
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      title={t("assignments.form.repositorySetupSection")}
      onReset={onReset}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4">
          {/* Repository source: template vs no template (default No). Editable
              after creation, but changing it only re-provisions repositories
              accepted from now on — the edit form warns before saving when
              students have already accepted (see AssignmentSettingsPage). */}
          <form.Field name="repo_source">
            {(field) => (
              <fieldset>
                <legend className="label font-bold mb-2">
                  {t("assignments.form.repoSource.label")}
                </legend>
                <div className="flex flex-col gap-2">
                  {(["none", "template"] as const).map((option) => (
                    <label
                      key={option}
                      htmlFor={`${field.name}-${option}`}
                      className="flex cursor-pointer items-start justify-start gap-3"
                    >
                      <input
                        id={`${field.name}-${option}`}
                        type="radio"
                        className="radio mt-1"
                        name={field.name}
                        value={option}
                        checked={field.state.value === option}
                        onBlur={field.handleBlur}
                        onChange={() =>
                          field.handleChange(option as RepoSource)
                        }
                      />
                      <span className="font-bold">
                        {t(`assignments.form.repoSource.${option}.label`)}
                        <span className="mt-0.5 block font-normal text-sm text-base-content/70">
                          {t(`assignments.form.repoSource.${option}.help`)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                {edit &&
                hasAcceptedStudents &&
                field.state.value !==
                  (form.options.defaultValues?.repo_source ?? "none") ? (
                  <Alert tone="warning" role="status" className="mt-2 text-sm">
                    <span>{t("assignments.form.repoSource.editHelp")}</span>
                  </Alert>
                ) : null}
              </fieldset>
            )}
          </form.Field>

          {/* No-template branch: "Add a README" picks initialized vs bare.
              Template branch: the template picker + an "Include all
              branches" toggle. deriveFormShape decides which shows. The
              Feedback PR toggle follows here so all repo-shape toggles sit
              together in the left column. */}
          <form.Subscribe selector={(state) => deriveFormShape(state.values)}>
            {(shape) => (
              <>
                {shape.showTemplateFields ? (
                  <>
                    <form.Field name="template_repo">
                      {(templateField) => (
                        <TemplateField
                          field={templateField}
                          org={org}
                          classroom={classroom}
                          slug={slug}
                        />
                      )}
                    </form.Field>

                    {/* Copy all template branches at generate (include_all_branches).
                        Only shown for a template source; default off. */}
                    <form.Field name="include_all_branches">
                      {(branchesField) => (
                        <ToggleRow
                          id={branchesField.name}
                          checked={branchesField.state.value}
                          onChange={(checked) =>
                            branchesField.handleChange(checked)
                          }
                          onBlur={branchesField.handleBlur}
                          label={t("assignments.form.includeAllBranches.label")}
                          help={t("assignments.form.includeAllBranches.help")}
                        />
                      )}
                    </form.Field>
                  </>
                ) : shape.showAddReadme ? (
                  <form.Field name="add_readme">
                    {(readmeField) => (
                      <ToggleRow
                        id={readmeField.name}
                        checked={readmeField.state.value}
                        onChange={(checked) =>
                          readmeField.handleChange(checked)
                        }
                        onBlur={readmeField.handleBlur}
                        label={t("assignments.form.addReadme.label")}
                        help={
                          readmeField.state.value
                            ? t("assignments.form.addReadme.helpOn")
                            : t("assignments.form.addReadme.helpOff")
                        }
                      />
                    )}
                  </form.Field>
                ) : null}

                {/* Feedback PR (U6): decoupled from autograding — available for
                    any non-empty repo, since it only needs a baseline commit. A
                    bare repo (no README, no template) has none, so it renders
                    locked-off (not hidden) to keep the trade-off visible. */}
                <form.Field name="feedback_pr">
                  {(field) => (
                    <div
                      className={
                        shape.feedbackPrEnabled
                          ? ""
                          : "pointer-events-none opacity-50"
                      }
                      aria-disabled={!shape.feedbackPrEnabled}
                    >
                      <ToggleRow
                        id={field.name}
                        checked={
                          shape.feedbackPrEnabled ? field.state.value : false
                        }
                        onChange={(checked) => field.handleChange(checked)}
                        onBlur={field.handleBlur}
                        label={t("assignments.form.feedbackPr")}
                        help={
                          shape.feedbackPrEnabled
                            ? t("assignments.form.feedbackPrHelp")
                            : t("assignments.form.feedbackPrEmptyRepoHelp")
                        }
                      />
                    </div>
                  )}
                </form.Field>

                {/* The rarer repo config a teacher usually leaves at its
                    default, grouped into a collapsible so the common path
                    (source, template, Feedback PR) stays scannable. */}
                <CollapsibleAdvanced>
                  <RepositoryAdvancedFields
                    form={form}
                    edit={edit}
                    org={org}
                    shape={shape}
                  />
                </CollapsibleAdvanced>
              </>
            )}
          </form.Subscribe>
        </div>
      </div>
    </SectionCard>
  )
}

// The Advanced settings body for Repository Setup: copy About/Topics from the
// template, the template's PR template as the Feedback PR body, the student
// repo-access override, and the repository features. Split out so the
// disclosure's contents don't nest under the section's render-prop chain.
function RepositoryAdvancedFields({
  form,
  edit,
  org,
  shape,
}: {
  form: AssignmentForm
  edit: boolean
  org?: string
  shape: FormShape
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4 pt-2">
      {/* Copy the template's About + Topics onto each student repo at accept
          time (issue #569). Template-only; GitHub's generate drops both, so
          accept re-applies. */}
      {shape.showTemplateFields ? (
        <>
          <form.Field name="copy_about">
            {(field) => (
              <ToggleRow
                id={field.name}
                checked={field.state.value}
                onChange={(checked) => field.handleChange(checked)}
                onBlur={field.handleBlur}
                label={t("assignments.form.copyAbout.label")}
                help={t("assignments.form.copyAbout.help")}
              />
            )}
          </form.Field>

          <form.Field name="copy_topics">
            {(field) => (
              <ToggleRow
                id={field.name}
                checked={field.state.value}
                onChange={(checked) => field.handleChange(checked)}
                onBlur={field.handleBlur}
                label={t("assignments.form.copyTopics.label")}
                help={t("assignments.form.copyTopics.help")}
              />
            )}
          </form.Field>
        </>
      ) : null}

      {/* Template-only, and only when the Feedback PR is available; auto-checks
          when a template PR file is detected. */}
      {shape.feedbackPrTemplateVisible ? (
        <form.Subscribe selector={(state) => state.values.template_repo}>
          {(templateRepoValue) => (
            <FeedbackPrTemplateToggle
              form={form}
              edit={edit}
              org={org}
              templateRepo={templateRepoValue}
              feedbackPrEnabled={shape.feedbackPrEnabled}
            />
          )}
        </form.Subscribe>
      ) : null}

      <StudentPermissionField form={form} />

      {/* RepoFeatureControls renders its own heading, refresh, help, and
          override warning; the subscription feeds it the template ref +
          bare-repo flag. */}
      <div className="pt-1">
        <form.Subscribe
          selector={(state) => ({
            templateRepo: state.values.template_repo.trim(),
            emptyRepo: state.values.empty_repo,
          })}
        >
          {({ templateRepo, emptyRepo }) => (
            <RepoFeatureControls
              form={form}
              edit={edit}
              org={org}
              templateRepo={templateRepo}
              emptyRepo={emptyRepo}
            />
          )}
        </form.Subscribe>
      </div>
    </div>
  )
}

// The student repo-access override. The empty choice means "no override": its
// label names the level the assignment type would grant anyway (admin for
// group, so the owner can add teammates; write otherwise).
function StudentPermissionField({ form }: { form: AssignmentForm }) {
  const { t } = useTranslation()
  return (
    <form.Field name="student_permission">
      {(field) => (
        <form.Subscribe selector={(state) => state.values.mode}>
          {(modeValue) => {
            const mode = modeValue === "group" ? "group" : "individual"
            const defaultLevel = defaultStudentPermission(mode)
            return (
              <FormField
                htmlFor={field.name}
                label={t("assignments.form.studentPermission.label")}
                help={t(
                  mode === "group"
                    ? "assignments.form.studentPermission.groupHelp"
                    : "assignments.form.studentPermission.help",
                )}
                labelExtra={
                  <a
                    className="link inline-flex items-center gap-1 text-sm font-normal text-base-content/60 hover:text-base-content"
                    href={REPO_ROLES_DOCS_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("assignments.form.studentPermission.learnMore")}
                    <LinkExternalIcon aria-hidden="true" className="size-4" />
                  </a>
                }
              >
                {({ id, describedById }) => (
                  <Select
                    id={id}
                    name={field.name}
                    className="w-full sm:max-w-xs"
                    aria-describedby={describedById}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) =>
                      field.handleChange(
                        e.target.value as typeof field.state.value,
                      )
                    }
                  >
                    <option value="">
                      {t("assignments.form.studentPermission.default", {
                        level: t(
                          `assignments.form.studentPermission.levels.${defaultLevel}`,
                        ),
                      })}
                    </option>
                    {REPO_PERMISSIONS.map((level) => (
                      <option key={level} value={level}>
                        {t(
                          `assignments.form.studentPermission.levels.${level}`,
                        )}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            )
          }}
        </form.Subscribe>
      )}
    </form.Field>
  )
}

// The repo-feature controls (Issues / Wiki / Projects / Pull requests), one
// uniform tri-state Select each. The default choice is context-aware: "Inherit
// from template" when a template is set (its help names the template's live
// setting, which accept re-applies since /generate drops the flags), else
// "Default" (no override — GitHub's own create default stands). Consolidated
// into Repository Setup from the former standalone Repository Features section.
const REPO_FEATURE_KEYS = [
  { field: "repo_feature_wiki", key: "wiki" },
  { field: "repo_feature_issues", key: "issues" },
  { field: "repo_feature_projects", key: "projects" },
  { field: "repo_feature_pull_requests", key: "pull_requests" },
] as const

// Resolve a template ref for the advisory feature read, accepting the same
// inputs the Template field does: `owner/repo`, `owner/repo@branch`, and a bare
// `repo` name (owner defaults to the org). Returns null on an empty/invalid ref
// or an unresolved owner (a bare name with no org), so the read (and the
// refresh button) stay gated on a resolvable template. Reuses the canonical
// parseTemplateRef so a bare name like "my-template" enables the read instead
// of silently disabling it.
function parseTemplateRefSafe(
  ref: string,
  org: string | undefined,
): { owner: string; repo: string } | null {
  if (!ref.trim()) return null
  try {
    const { owner, repo } = parseTemplateRef(ref, org ?? "")
    // A bare name with no org resolves to an empty owner — not usable.
    return owner && repo ? { owner, repo } : null
  } catch {
    return null
  }
}

// Native GitHub pull request template paths, probed in this order — mirrors the
// accept clients and the runner. Detection auto-checks the toggle.
const TEMPLATE_PR_BODY_PATHS = [
  ".github/pull_request_template.md",
  "pull_request_template.md",
  "docs/pull_request_template.md",
] as const

// The "Use the template's pull request template as the Feedback PR body" toggle
// (feedback_pr_template). Probes the picked template repo for a native
// pull_request_template.md; on the CREATE form it auto-checks once when one is
// found, respecting any later manual change. On EDIT it never overrides the
// saved value. Rendered only for a template source with the Feedback PR on;
// locked-off (not hidden) when the Feedback PR is off, mirroring feedback_pr.
export const FeedbackPrTemplateToggle = ({
  form,
  edit,
  org,
  templateRepo,
  feedbackPrEnabled,
}: {
  form: AssignmentForm
  edit: boolean
  org?: string
  templateRepo: string
  feedbackPrEnabled: boolean
}) => {
  const { t } = useTranslation()
  const client = useOptionalGitHubClient()
  const parsed = parseTemplateRefSafe(templateRepo, org)

  // Whether the teacher has taken ownership of the toggle (so a re-probe never
  // overrides their choice). On edit, seed it true — a saved assignment already
  // reflects a deliberate value — so auto-check is a create-form-only nicety.
  const userTouched = useRef(edit)

  const enabled = Boolean(client && parsed && feedbackPrEnabled)
  const probe = useQuery({
    queryKey: ["feedback-pr-template", parsed?.owner, parsed?.repo],
    queryFn: async () => {
      for (const path of TEMPLATE_PR_BODY_PATHS) {
        if (
          await repoContentsPathExists(
            client!,
            parsed!.owner,
            parsed!.repo,
            path,
          )
        ) {
          return true
        }
      }
      return false
    },
    enabled,
    staleTime: 30_000,
    retry: false,
  })

  const detected = enabled && probe.data === true
  const checking = enabled && probe.isFetching

  // Auto-check once on first detection (create form only). A later manual change
  // flips userTouched, after which re-probes never override.
  useEffect(() => {
    if (
      !userTouched.current &&
      detected &&
      !form.state.values.feedback_pr_template
    ) {
      form.setFieldValue("feedback_pr_template", true)
    }
  }, [detected, form])

  return (
    <form.Field name="feedback_pr_template">
      {(field) => (
        <div
          className={feedbackPrEnabled ? "" : "pointer-events-none opacity-50"}
          aria-disabled={!feedbackPrEnabled}
        >
          <ToggleRow
            id={field.name}
            checked={feedbackPrEnabled ? field.state.value : false}
            onChange={(checked) => {
              userTouched.current = true
              field.handleChange(checked)
            }}
            onBlur={field.handleBlur}
            label={t("assignments.form.feedbackPrTemplate.label")}
            help={
              feedbackPrEnabled
                ? t("assignments.form.feedbackPrTemplate.help")
                : t("assignments.form.feedbackPrEmptyRepoHelp")
            }
          />
          {checking ? (
            <p className="mt-1 flex items-center gap-1 text-xs opacity-70">
              <InlineSpinner />
              {t("assignments.form.feedbackPrTemplate.checking")}
            </p>
          ) : detected && field.state.value ? (
            <p className="mt-1 text-xs opacity-70">
              {t("assignments.form.feedbackPrTemplate.autoEnabled")}
            </p>
          ) : null}
        </div>
      )}
    </form.Field>
  )
}

// Exported for focused unit tests of the resolved-inherit label, loading state,
// and refresh behavior without mounting the whole section.
export const RepoFeatureControls = ({
  form,
  edit,
  org,
  templateRepo,
  emptyRepo,
}: {
  form: AssignmentForm
  edit: boolean
  org?: string
  templateRepo: string
  emptyRepo: boolean
}) => {
  const { t } = useTranslation()
  const client = useOptionalGitHubClient()
  const parsed = parseTemplateRefSafe(templateRepo, org)

  // Read the template's current feature flags so the "Inherit from template"
  // choice can name its resolved outcome (e.g. "matches template: on").
  // Advisory only: a failed/absent read falls back to a plain label. Skipped
  // for a bare empty_repo and when there's no full owner/repo ref yet — a
  // template-less assignment shows "Default" (no override) instead.
  const enabled = Boolean(client && parsed && !emptyRepo)
  const templateRepoQuery = useQuery({
    queryKey: ["template-repo-features", parsed?.owner, parsed?.repo],
    queryFn: () => getRepo(client!, parsed!.owner, parsed!.repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  })
  const template = enabled ? templateRepoQuery.data : null
  // While a (re)fetch is in flight for a real template, put the feature controls
  // in a loading state: disable them and show a loading label on the inherit
  // option, so a teacher who just refreshed sees the fields update rather than
  // reading a stale resolved value mid-fetch.
  const isRefreshing = enabled && templateRepoQuery.isFetching

  // Whether this assignment is templated. Drives the default choice's label:
  // "Inherit from template" (templated) vs. "Default" (no override).
  const templated = Boolean(parsed) && !emptyRepo

  // For a templated assignment, the concrete on/off the "inherit" choice
  // resolves to per feature (the template's live flag). undefined = not yet
  // known (still loading, or the read failed) or template-less (no override) —
  // the label then omits the "matches template" hint.
  const resolvedInherit = (
    key: "issues" | "wiki" | "projects" | "pull_requests",
  ): boolean | undefined => {
    if (!templated || !template) return undefined
    const flag = {
      issues: "has_issues",
      wiki: "has_wiki",
      projects: "has_projects",
      pull_requests: "has_pull_requests",
    } as const
    return template[flag[key]]
  }

  const inheritLabel = (resolved: boolean | undefined): string => {
    if (!templated) {
      return t("assignments.form.repoFeatures.choices.default")
    }
    if (isRefreshing) {
      return t("assignments.form.repoFeatures.choices.inheritLoading")
    }
    if (resolved === undefined) {
      return t("assignments.form.repoFeatures.choices.inherit")
    }
    return t(
      resolved
        ? "assignments.form.repoFeatures.choices.inheritOn"
        : "assignments.form.repoFeatures.choices.inheritOff",
    )
  }

  return (
    <>
      <div className="flex items-center gap-2 pb-1">
        <h4 className="font-bold">
          {t("assignments.form.repoFeatures.heading")}
        </h4>
        {/* Refetch the template's live feature flags — a teacher may toggle
            them on github.com while authoring the assignment here. Only useful
            when there's a template to read (disabled otherwise). */}
        <Button
          variant="ghost"
          size="xs"
          shape="square"
          onClick={() => templateRepoQuery.refetch()}
          disabled={!enabled || templateRepoQuery.isFetching}
          aria-label={t("assignments.form.repoFeatures.refresh")}
          title={t("assignments.form.repoFeatures.refresh")}
          className="text-base-content/60 hover:text-base-content disabled:opacity-40"
        >
          <SyncIcon
            aria-hidden="true"
            className={cx(
              "size-4",
              templateRepoQuery.isFetching && "animate-spin",
            )}
          />
        </Button>
      </div>
      <p className="mb-3 text-sm text-base-content/70">
        {t("assignments.form.repoFeatures.help")}
        {edit ? <> {t("assignments.form.repoFeatures.helpExisting")}</> : null}
      </p>
      {/* Answer-key leak caveat: only relevant when inheriting a template,
          since a template-less repo has no upstream content to copy. */}
      {templated ? (
        <Alert tone="warning" role="status" className="mb-3 text-sm">
          <span>
            {t("assignments.form.repoFeatures.templateContentWarning")}
          </span>
        </Alert>
      ) : null}
      {/* Inline rows — "Wiki: [choice]" — label and select sit together (a
          fixed-width label keeps the four selects vertically aligned) with the
          select sized to its content (w-auto). FormField isn't used here
          because it always stacks the label above the control. */}
      <div
        className={cx("flex flex-col gap-3", isRefreshing && "opacity-60")}
        aria-busy={isRefreshing || undefined}
      >
        {REPO_FEATURE_KEYS.map(({ field: fieldName, key }) => (
          <form.Field key={fieldName} name={fieldName}>
            {(field) => (
              <div className="flex items-center gap-3">
                <label
                  htmlFor={field.name}
                  className="label w-28 shrink-0 font-bold"
                >
                  {t(`assignments.form.repoFeatures.${key}.label`)}
                </label>
                <Select
                  id={field.name}
                  name={field.name}
                  selectSize="sm"
                  className="w-auto min-w-0"
                  disabled={isRefreshing}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) =>
                    field.handleChange(
                      e.target.value as typeof field.state.value,
                    )
                  }
                >
                  <option value="inherit">
                    {inheritLabel(resolvedInherit(key))}
                  </option>
                  <option value="on">
                    {t("assignments.form.repoFeatures.choices.on")}
                  </option>
                  <option value="off">
                    {t("assignments.form.repoFeatures.choices.off")}
                  </option>
                </Select>
              </div>
            )}
          </form.Field>
        ))}
      </div>
      <form.Subscribe
        selector={(state) =>
          state.values.repo_feature_issues !== "inherit" ||
          state.values.repo_feature_wiki !== "inherit" ||
          state.values.repo_feature_projects !== "inherit" ||
          state.values.repo_feature_pull_requests !== "inherit"
        }
      >
        {(anyOverridden) =>
          anyOverridden ? (
            <Alert tone="warning" role="status" className="mt-3 text-sm">
              <span>
                {templated
                  ? t("assignments.form.repoFeatures.overrideTemplate")
                  : t("assignments.form.repoFeatures.overrideNoTemplate")}
                {edit ? (
                  <> {t("assignments.form.repoFeatures.overrideExisting")}</>
                ) : null}
              </span>
            </Alert>
          ) : null
        }
      </form.Subscribe>
    </>
  )
}
