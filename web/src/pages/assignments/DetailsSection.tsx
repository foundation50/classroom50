import type { Dispatch, SetStateAction } from "react"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ExternalLink, RefreshCw } from "lucide-react"
import { slugify } from "@/util/slug"
import {
  Alert,
  Button,
  Card,
  cx,
  FormField,
  Input,
  Select,
  Textarea,
} from "@/components/ui"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { getRepo } from "@/github-core/repoReads"
import { TemplateField } from "./TemplateField"
import { FieldLabel, ToggleRow } from "./AdvancedRuntimeFields"
import {
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  REPO_PERMISSIONS,
  defaultStudentPermission,
} from "@/types/classroom"
import {
  parseSubmissionTags,
  validateSubmissionTags,
} from "@/util/submissionTags"
import type { AssignmentForm } from "./assignmentFormModel"

// GitHub's own reference for the repo role ladder (read/triage/write/maintain/
// admin), linked next to the Student repo access help so teachers can see what
// each level grants.
const REPO_ROLES_DOCS_URL =
  "https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization#repository-roles-for-organizations"

const FormErrors = ({ form }: { form: AssignmentForm }) => (
  <form.Subscribe selector={(state) => [state.errors]}>
    {([errors]) => (
      <div>
        {errors.map((err) => (
          <p className="text-error" key={String(err)}>
            {String(err)}
          </p>
        ))}
      </div>
    )}
  </form.Subscribe>
)

// The assignment details + core settings. Owns the create-only slug auto-fill
// and the opt-in due-date toggle, wired via props from the orchestrator.
export const DetailsSection = ({
  form,
  edit,
  org,
  classroom,
  slug,
  slugTouched,
  setSlugTouched,
  dueDateEnabled,
  setDueDateEnabled,
  availableFromEnabled,
  setAvailableFromEnabled,
}: {
  form: AssignmentForm
  edit: boolean
  org?: string
  classroom?: string
  slug?: string
  slugTouched: boolean
  setSlugTouched: Dispatch<SetStateAction<boolean>>
  dueDateEnabled: boolean
  setDueDateEnabled: Dispatch<SetStateAction<boolean>>
  availableFromEnabled: boolean
  setAvailableFromEnabled: Dispatch<SetStateAction<boolean>>
}) => {
  const { t } = useTranslation()
  const tzShort = new Intl.DateTimeFormat(undefined, {
    timeZoneName: "short",
  })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value

  return (
    <Card bordered={false} className="w-full mb-6">
      <Card.Body>
        <h3 className="text-lg font-bold pb-4">
          {t("assignments.form.detailsSection")}
        </h3>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <form.Field name="name">
            {(field) => (
              <FormField
                htmlFor={field.name}
                required
                label={t("assignments.form.name")}
              >
                {({ id }) => (
                  <Input
                    id={id}
                    name={field.name}
                    required
                    aria-required="true"
                    placeholder={t("assignments.form.namePlaceholder")}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => {
                      field.handleChange(e.target.value)
                      if (!edit && !slugTouched) {
                        form.setFieldValue("slug", slugify(e.target.value))
                      }
                    }}
                  />
                )}
              </FormField>
            )}
          </form.Field>

          <form.Field name="slug">
            {(field) => {
              const slugError =
                !edit && field.state.meta.errors.length > 0
                  ? String(field.state.meta.errors[0])
                  : undefined
              return (
                <FormField
                  htmlFor={field.name}
                  required={!edit}
                  help={t(
                    edit
                      ? "assignments.form.slugEditHelp"
                      : "assignments.form.slugHelp",
                  )}
                  label={t("assignments.form.slug")}
                  error={slugError}
                >
                  {({ id, describedById, invalid }) => (
                    <Input
                      id={id}
                      name={field.name}
                      required={!edit}
                      aria-required={!edit}
                      // The slug is the assignment's repo-path identity;
                      // renaming isn't supported, so it's read-only on edit.
                      disabled={edit}
                      invalid={invalid}
                      aria-describedby={describedById}
                      placeholder={t("assignments.form.slugPlaceholder")}
                      value={field.state.value}
                      onBlur={(e) => {
                        // Normalize on blur so what the teacher sees is what's
                        // saved (the repo path segment). An emptied slug falls
                        // back to the name-derived default, so leaving it blank
                        // restores the auto slug.
                        const normalized = slugify(e.target.value)
                        field.handleChange(
                          normalized || slugify(form.state.values.name),
                        )
                        field.handleBlur()
                      }}
                      onChange={(e) => {
                        // Clearing the slug re-arms auto-fill from the name; any
                        // non-empty edit latches it off so a deliberate slug
                        // isn't clobbered by later name edits.
                        setSlugTouched(e.target.value.trim() !== "")
                        field.handleChange(e.target.value)
                      }}
                    />
                  )}
                </FormField>
              )
            }}
          </form.Field>
        </div>

        <form.Field name="description">
          {(field) => (
            <FormField
              htmlFor={field.name}
              className="mt-4"
              label={
                <>
                  {t("assignments.form.description")}
                  <span className="ms-1.5 font-normal text-base-content/60">
                    ({t("assignments.form.optional")})
                  </span>
                </>
              }
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  name={field.name}
                  placeholder={t("assignments.form.descriptionPlaceholder")}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </FormField>
          )}
        </form.Field>

        {/* An empty repo starts with no content, so the template picker is
            hidden while the toggle is on (the submit path clears the value
            too). */}
        <form.Subscribe selector={(state) => state.values.empty_repo}>
          {(emptyRepo) =>
            emptyRepo ? null : (
              <div className="mt-4">
                <form.Field name="template_repo">
                  {(field) => (
                    <TemplateField
                      field={field}
                      org={org}
                      classroom={classroom}
                      slug={slug}
                    />
                  )}
                </form.Field>
              </div>
            )
          }
        </form.Subscribe>

        <div className="divider my-2" />
        <h3 className="text-lg font-bold pb-2">
          {t("assignments.form.settingsSection")}
        </h3>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 sm:items-start">
          <div className="flex flex-col gap-4">
            <form.Field name="mode">
              {(field) => (
                <fieldset>
                  <legend className="label font-bold mb-2">
                    {t("assignments.form.type")}
                  </legend>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    {(["individual", "group"] as const).map((value) => (
                      <label
                        key={value}
                        htmlFor={`${field.name}-${value}`}
                        className="label cursor-pointer gap-2 p-0"
                      >
                        <input
                          id={`${field.name}-${value}`}
                          type="radio"
                          className="radio"
                          name={field.name}
                          value={value}
                          checked={field.state.value === value}
                          onBlur={field.handleBlur}
                          onChange={() => field.handleChange(value)}
                        />
                        {t(
                          value === "individual"
                            ? "assignments.form.typeIndividual"
                            : "assignments.form.typeGroup",
                        )}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </form.Field>

            <form.Subscribe selector={(state) => state.values.mode}>
              {(modeValue) =>
                modeValue === "group" && (
                  <form.Field name="max_group_size">
                    {(field) => (
                      <div className="border-s-2 border-base-300 ps-4">
                        <FieldLabel
                          htmlFor={field.name}
                          label={t("assignments.form.maxGroupSize")}
                        />
                        <Input
                          id={field.name}
                          name={field.name}
                          type="number"
                          className="validator w-full sm:max-w-[8rem]"
                          placeholder="#"
                          min={GROUP_SIZE_MIN}
                          max={GROUP_SIZE_MAX}
                          step="1"
                          title={t("assignments.form.maxGroupSizeTitle", {
                            min: GROUP_SIZE_MIN,
                            max: GROUP_SIZE_MAX,
                          })}
                          value={
                            Number.isFinite(field.state.value)
                              ? field.state.value
                              : ""
                          }
                          onBlur={() => {
                            // Snap to a valid whole number on blur so the CLI
                            // never sees a non-integer or out-of-range size.
                            const raw = field.state.value
                            const next = Number.isFinite(raw)
                              ? Math.min(
                                  Math.max(Math.floor(raw), GROUP_SIZE_MIN),
                                  GROUP_SIZE_MAX,
                                )
                              : GROUP_SIZE_MIN
                            if (next !== raw) field.handleChange(next)
                            field.handleBlur()
                          }}
                          onChange={(e) =>
                            field.handleChange(e.target.valueAsNumber)
                          }
                        />
                      </div>
                    )}
                  </form.Field>
                )
              }
            </form.Subscribe>

            {/* Student repo access sits directly under Assignment type: the
                mode drives its default (push individual / admin group) and its
                help text. */}
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
                        help={
                          mode === "group"
                            ? t("assignments.form.studentPermission.groupHelp")
                            : t("assignments.form.studentPermission.help")
                        }
                        labelExtra={
                          <a
                            className="link inline-flex items-center gap-1 text-sm font-normal text-base-content/60 hover:text-base-content"
                            href={REPO_ROLES_DOCS_URL}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("assignments.form.studentPermission.learnMore")}
                            <ExternalLink
                              aria-hidden="true"
                              className="size-3.5"
                            />
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

            {/* Submission trigger: every-push (the default) or tag mode
                (only submit/* tags grade — the Actions-cost lever). A bare
                repo has no shim, so the picker locks to the default. On
                EDIT, a change only affects new accepts: warn that existing
                repos need the retrofit action. */}
            <form.Subscribe selector={(state) => state.values.empty_repo}>
              {(emptyRepo) => (
                <form.Field name="submission_mode">
                  {(field) => (
                    <div
                      className={
                        emptyRepo ? "pointer-events-none opacity-50" : ""
                      }
                      aria-disabled={emptyRepo}
                    >
                      <FormField
                        htmlFor={field.name}
                        label={t("assignments.form.submissionMode.label")}
                        help={
                          emptyRepo
                            ? t("assignments.form.submissionMode.emptyRepoHelp")
                            : t("assignments.form.submissionMode.help")
                        }
                      >
                        {({ id, describedById }) => (
                          <Select
                            id={id}
                            name={field.name}
                            className="w-full sm:max-w-xs"
                            aria-describedby={describedById}
                            value={emptyRepo ? "every-push" : field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) =>
                              field.handleChange(
                                e.target.value as typeof field.state.value,
                              )
                            }
                          >
                            <option value="every-push">
                              {t(
                                "assignments.form.submissionMode.choices.everyPush",
                              )}
                            </option>
                            <option value="tag">
                              {t("assignments.form.submissionMode.choices.tag")}
                            </option>
                          </Select>
                        )}
                      </FormField>
                      {edit ? (
                        <form.Subscribe
                          selector={(state) => state.values.submission_mode}
                        >
                          {(mode) =>
                            mode !==
                            (form.options.defaultValues?.submission_mode ??
                              "every-push") ? (
                              <Alert
                                tone="warning"
                                role="status"
                                className="mt-2 text-sm"
                              >
                                <span>
                                  {t(
                                    "assignments.form.submissionMode.editWarning",
                                  )}
                                </span>
                              </Alert>
                            ) : null
                          }
                        </form.Subscribe>
                      ) : null}
                    </div>
                  )}
                </form.Field>
              )}
            </form.Subscribe>

            {/* Milestone submission tags: teacher-named tag patterns (e.g.
                phase1, phase2, complete) that ALSO trigger grading — a
                student pushing a matching tag gets that commit graded, with
                the record still living at the canonical submit/* tag the
                runner mints. Union with submit/* in the shim, orthogonal to
                the mode picker above; the same shim-retrofit warning applies
                on edit. Locked like the mode picker for a bare repo. */}
            <form.Subscribe selector={(state) => state.values.empty_repo}>
              {(emptyRepo) => (
                <form.Field name="submission_tags">
                  {(field) => {
                    const error = field.state.meta.errors[0] as
                      string | undefined
                    return (
                      <div
                        className={
                          emptyRepo ? "pointer-events-none opacity-50" : ""
                        }
                        aria-disabled={emptyRepo}
                      >
                        <FormField
                          htmlFor={field.name}
                          label={t("assignments.form.submissionTags.label")}
                          help={
                            emptyRepo
                              ? t(
                                  "assignments.form.submissionMode.emptyRepoHelp",
                                )
                              : t("assignments.form.submissionTags.help")
                          }
                        >
                          {({ id, describedById }) => (
                            <Textarea
                              id={id}
                              name={field.name}
                              className="font-mono w-full sm:max-w-xs"
                              rows={3}
                              spellCheck={false}
                              placeholder={"phase1\nphase2\ncomplete"}
                              aria-describedby={describedById}
                              value={emptyRepo ? "" : field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) =>
                                field.handleChange(e.target.value)
                              }
                            />
                          )}
                        </FormField>
                        {error ? (
                          <p role="alert" className="mt-1.5 text-sm text-error">
                            {error}
                          </p>
                        ) : null}
                        <form.Subscribe
                          selector={(state) => state.values.submission_tags}
                        >
                          {(tags) => {
                            // Surface the same problems the save-time validator
                            // catches, live and ahead of save (the form only
                            // validates onSubmit). Priority, most to least
                            // actionable:
                            //   1. comma — the obvious wrong guess for a
                            //      one-per-line field; its own friendly hint
                            //      since the generic charset error wouldn't
                            //      explain the real fix.
                            //   2. a hard validation error (bad charset,
                            //      duplicate, stacked quantifier) — the exact
                            //      message the save path would show.
                            //   3. broad-glob caution / edit-retrofit warning —
                            //      advisory, not errors.
                            const parsed = parseSubmissionTags(tags)
                            const hasComma = (tags ?? "").includes(",")
                            const validationError =
                              validateSubmissionTags(parsed)
                            const broad = parsed.some(
                              (p) => p.includes("*") || p.includes("+"),
                            )
                            const changed =
                              edit &&
                              tags !==
                                (form.options.defaultValues?.submission_tags ??
                                  "")
                            if (
                              !hasComma &&
                              !validationError &&
                              !broad &&
                              !changed
                            )
                              return null
                            const message = hasComma
                              ? t("assignments.form.submissionTags.commaHint")
                              : (validationError ??
                                (broad
                                  ? t(
                                      "assignments.form.submissionTags.wildcardCaution",
                                    )
                                  : t(
                                      "assignments.form.submissionMode.editWarning",
                                    )))
                            // Errors read as errors; the advisory cautions stay
                            // warning-toned.
                            const isError = hasComma || Boolean(validationError)
                            return (
                              <Alert
                                tone={isError ? "error" : "warning"}
                                role="status"
                                className="mt-2 text-sm"
                              >
                                <span>{message}</span>
                              </Alert>
                            )
                          }}
                        </form.Subscribe>
                      </div>
                    )
                  }}
                </form.Field>
              )}
            </form.Subscribe>
          </div>

          <div className="flex flex-col gap-4">
            {/* An empty repo has no baseline commit, so the Feedback PR is
                structurally off: render the toggle locked-off (not hidden) so
                the trade-off stays visible. */}
            <form.Subscribe selector={(state) => state.values.empty_repo}>
              {(emptyRepo) => (
                <form.Field name="feedback_pr">
                  {(field) => (
                    <div
                      className={
                        emptyRepo ? "pointer-events-none opacity-50" : ""
                      }
                      aria-disabled={emptyRepo}
                    >
                      <ToggleRow
                        id={field.name}
                        checked={emptyRepo ? false : field.state.value}
                        onChange={(checked) => field.handleChange(checked)}
                        onBlur={field.handleBlur}
                        label={t("assignments.form.feedbackPr")}
                        help={
                          emptyRepo
                            ? t("assignments.form.feedbackPrEmptyRepoHelp")
                            : t("assignments.form.feedbackPrHelp")
                        }
                      />
                    </div>
                  )}
                </form.Field>
              )}
            </form.Subscribe>

            {/* Immutable after creation: locked in edit mode. */}
            <form.Field name="empty_repo">
              {(field) => (
                <div
                  className={edit ? "pointer-events-none opacity-50" : ""}
                  aria-disabled={edit}
                >
                  <ToggleRow
                    id={field.name}
                    checked={field.state.value}
                    onChange={(checked) => field.handleChange(checked)}
                    onBlur={field.handleBlur}
                    label={t("assignments.form.emptyRepo")}
                    help={
                      edit
                        ? `${t("assignments.form.emptyRepoHelp")} ${t("assignments.form.emptyRepoLocked")}`
                        : t("assignments.form.emptyRepoHelp")
                    }
                  />
                </div>
              )}
            </form.Field>

            <form.Field name="available_from_date">
              {(field) => (
                <div>
                  <ToggleRow
                    id={`${field.name}-enabled`}
                    checked={availableFromEnabled}
                    onChange={(checked) => {
                      setAvailableFromEnabled(checked)
                      if (!checked) field.handleChange("")
                    }}
                    label={t("assignments.form.setAvailableFrom")}
                    help={t("assignments.form.setAvailableFromTip")}
                  />
                  {availableFromEnabled ? (
                    <div className="mt-2 ms-[3.75rem]">
                      <Input
                        id={field.name}
                        name={field.name}
                        type="datetime-local"
                        className="w-full sm:max-w-xs"
                        aria-label={t("assignments.form.availableFrom", {
                          tz: tzShort,
                        })}
                        value={field.state.value}
                        onBlur={(e) => {
                          // Clearing the picker retires the release date: hide it
                          // and uncheck the box (value is already "").
                          if (!e.target.value) setAvailableFromEnabled(false)
                          field.handleBlur()
                        }}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                      <p className="mt-1.5 text-sm text-base-content/70">
                        {t("assignments.form.availableFromTz", { tz: tzShort })}
                      </p>
                    </div>
                  ) : null}
                </div>
              )}
            </form.Field>

            <form.Field name="due_date">
              {(field) => (
                <div>
                  <ToggleRow
                    id={`${field.name}-enabled`}
                    checked={dueDateEnabled}
                    onChange={(checked) => {
                      setDueDateEnabled(checked)
                      if (!checked) field.handleChange("")
                    }}
                    label={t("assignments.form.setDueDate")}
                    help={t("assignments.form.setDueDateTip")}
                  />
                  {dueDateEnabled ? (
                    <div className="mt-2 ms-[3.75rem]">
                      <Input
                        id={field.name}
                        name={field.name}
                        type="datetime-local"
                        className="w-full sm:max-w-xs"
                        aria-label={t("assignments.form.dueDate", {
                          tz: tzShort,
                        })}
                        value={field.state.value}
                        onBlur={(e) => {
                          // Clearing the picker retires the due date: hide it
                          // and uncheck the box (value is already "").
                          if (!e.target.value) setDueDateEnabled(false)
                          field.handleBlur()
                        }}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                      <p className="mt-1.5 text-sm text-base-content/70">
                        {t("assignments.form.dueDateTz", { tz: tzShort })}
                      </p>
                    </div>
                  ) : null}
                </div>
              )}
            </form.Field>
          </div>
        </div>

        <RepoFeaturesFieldset form={form} />
      </Card.Body>
      <FormErrors form={form} />
    </Card>
  )
}

// The repo-feature controls (Issues / Wiki / Projects / Pull requests), one uniform
// tri-state Select each. The default choice is context-aware: "Inherit from
// template" when a template is set (its help names the template's live setting,
// which accept re-applies since /generate drops the flags), else "Default"
// (no override — GitHub's own create default stands).
const REPO_FEATURE_KEYS = [
  { field: "repo_feature_wiki", key: "wiki" },
  { field: "repo_feature_issues", key: "issues" },
  { field: "repo_feature_projects", key: "projects" },
  { field: "repo_feature_pull_requests", key: "pull_requests" },
] as const

const RepoFeaturesFieldset = ({ form }: { form: AssignmentForm }) => {
  return (
    <>
      <div className="divider my-2" />
      <form.Subscribe
        selector={(state) => ({
          templateRepo: state.values.template_repo.trim(),
          emptyRepo: state.values.empty_repo,
        })}
      >
        {({ templateRepo, emptyRepo }) => (
          <RepoFeatureControls
            form={form}
            templateRepo={templateRepo}
            emptyRepo={emptyRepo}
          />
        )}
      </form.Subscribe>
    </>
  )
}

// Parse an `owner/repo` template ref for the advisory feature read. Tolerates a
// bare repo (no owner) by returning null — the read only runs on a full ref.
function parseOwnerRepo(ref: string): { owner: string; repo: string } | null {
  const parts = ref.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}

// Exported for focused unit tests of the resolved-inherit label, loading state,
// and refresh behavior without mounting the whole DetailsSection.
export const RepoFeatureControls = ({
  form,
  templateRepo,
  emptyRepo,
}: {
  form: AssignmentForm
  templateRepo: string
  emptyRepo: boolean
}) => {
  const { t } = useTranslation()
  const client = useOptionalGitHubClient()
  const parsed = parseOwnerRepo(templateRepo)

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
        <h3 className="text-lg font-bold">
          {t("assignments.form.repoFeatures.heading")}
        </h3>
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
          <RefreshCw
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
      </p>
      <div
        className={cx(
          "grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2",
          isRefreshing && "opacity-60",
        )}
        aria-busy={isRefreshing}
      >
        {REPO_FEATURE_KEYS.map(({ field: fieldName, key }) => (
          <form.Field key={fieldName} name={fieldName}>
            {(field) => (
              <FormField
                htmlFor={field.name}
                label={t(`assignments.form.repoFeatures.${key}.label`)}
              >
                {({ id, describedById }) => (
                  <Select
                    id={id}
                    name={field.name}
                    className="w-full"
                    disabled={isRefreshing}
                    aria-describedby={describedById}
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
                )}
              </FormField>
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
              <span>{t("assignments.form.repoFeatures.overrideWarning")}</span>
            </Alert>
          ) : null
        }
      </form.Subscribe>
    </>
  )
}
