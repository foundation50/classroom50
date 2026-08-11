import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { RefreshCw } from "lucide-react"
import { Alert, Button, cx, FormField, Select } from "@/components/ui"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { getRepo } from "@/github-core/repoReads"
import type { AssignmentForm } from "../assignmentFormModel"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"

// Repository Features (IA overhaul U8): the tri-state Issues / Wiki / Projects /
// Pull requests controls with inherit/on/off semantics and template-resolved
// "inherit" labels. Moved verbatim from the old DetailsSection; the template
// read + refresh behavior is unchanged.
export function RepositoryFeaturesSection({
  form,
  status,
}: {
  form: AssignmentForm
  status: SectionStatus
}) {
  const { t } = useTranslation()
  return (
    <SectionCard
      title={t("assignments.form.repositoryFeaturesSection")}
      status={status}
    >
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
    </SectionCard>
  )
}

// The repo-feature controls (Issues / Wiki / Projects / Pull requests), one
// uniform tri-state Select each. The default choice is context-aware: "Inherit
// from template" when a template is set (its help names the template's live
// setting, which accept re-applies since /generate drops the flags), else
// "Default" (no override — GitHub's own create default stands).
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
