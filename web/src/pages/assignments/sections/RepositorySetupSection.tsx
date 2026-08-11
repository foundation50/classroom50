import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { ExternalLink, RefreshCw } from "lucide-react"
import { Alert, Button, cx, FormField, Select } from "@/components/ui"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { getRepo } from "@/github-core/repoReads"
import { REPO_PERMISSIONS, defaultStudentPermission } from "@/types/classroom"
import { TemplateField } from "../TemplateField"
import { ToggleRow } from "../AdvancedRuntimeFields"
import type { AssignmentForm, RepoSource } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"

// GitHub's own reference for the repo role ladder (read/triage/write/maintain/
// admin), linked next to the Student repo access help so teachers can see what
// each level grants.
const REPO_ROLES_DOCS_URL =
  "https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization#repository-roles-for-organizations"

// Repository Setup (IA overhaul U5/U6 + repo-source remodel; features
// consolidated in): mirrors GitHub's own repo-creation flow. Two columns:
//   - Left — repo-shape config: the "Start with a template" source (default No;
//     no template -> an "Add a README" toggle picks initialized vs. bare;
//     a template shows the picker + an "Include all branches" toggle), then the
//     Feedback PR toggle (decoupled from autograding — available for any
//     non-empty repo), then Student repo access.
//   - Right — Repository features (Wiki / Issues / Projects / Pull requests),
//     the tri-state controls folded in from the former standalone section so
//     all repo config lives in one card.
// The source choice folds into empty_repo + template on submit via
// deriveFormShape; the choice is immutable after creation (locked on edit).
export function RepositorySetupSection({
  form,
  edit,
  status,
  org,
  classroom,
  slug,
}: {
  form: AssignmentForm
  edit: boolean
  status: SectionStatus
  org?: string
  classroom?: string
  slug?: string
}) {
  const { t } = useTranslation()

  return (
    <SectionCard
      title={t("assignments.form.repositorySetupSection")}
      status={status}
    >
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 sm:items-start">
        <div className="flex flex-col gap-4">
          {/* Repository source: template vs no template (default No). Immutable
              after creation (locked on edit): already-accepted repos can't be
              retrofitted from one source to the other. */}
          <form.Field name="repo_source">
            {(field) => (
              <fieldset
                className={edit ? "pointer-events-none opacity-50" : ""}
                disabled={edit}
                aria-disabled={edit}
              >
                <legend className="label font-bold mb-2">
                  {t("assignments.form.repoSource.label")}
                </legend>
                <div className="flex flex-col gap-2">
                  {(["none", "template"] as const).map((option) => (
                    <label
                      key={option}
                      htmlFor={`${field.name}-${option}`}
                      className="label cursor-pointer items-start justify-start gap-3 p-0"
                    >
                      <input
                        id={`${field.name}-${option}`}
                        type="radio"
                        className="radio mt-1"
                        name={field.name}
                        value={option}
                        checked={field.state.value === option}
                        disabled={edit}
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
                {edit ? (
                  <p className="mt-1.5 text-sm text-base-content/70">
                    {t("assignments.form.repoSource.lockedHelp")}
                  </p>
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
              </>
            )}
          </form.Subscribe>

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
        </div>

        <div className="flex flex-col gap-4">
          {/* Repository features (Wiki / Issues / Projects / Pull requests):
              the right column. RepoFeatureControls renders its own heading,
              refresh, help, and override warning; stacked here so each select
              gets the full column width. Wrap it in the subscription that feeds
              it the template ref + bare-repo flag. */}
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
        </div>
      </div>
    </SectionCard>
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

// Parse an `owner/repo` template ref for the advisory feature read. Tolerates a
// bare repo (no owner) by returning null — the read only runs on a full ref.
function parseOwnerRepo(ref: string): { owner: string; repo: string } | null {
  const parts = ref.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}

// Exported for focused unit tests of the resolved-inherit label, loading state,
// and refresh behavior without mounting the whole section.
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
      {/* Inline rows — "Wiki: [choice]" — with the select sized to its content
          (w-auto) rather than stretching the column, so each control reads as a
          compact labeled dropdown. FormField isn't used here because it always
          stacks the label above the control. */}
      <div
        className={cx("flex flex-col gap-3", isRefreshing && "opacity-60")}
        aria-busy={isRefreshing}
      >
        {REPO_FEATURE_KEYS.map(({ field: fieldName, key }) => (
          <form.Field key={fieldName} name={fieldName}>
            {(field) => (
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={field.name} className="label font-bold">
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
              <span>{t("assignments.form.repoFeatures.overrideWarning")}</span>
            </Alert>
          ) : null
        }
      </form.Subscribe>
    </>
  )
}
