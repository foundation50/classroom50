import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"
import { FormField, Select } from "@/components/ui"
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

// Repository Setup (IA overhaul U5/U6 + repo-source remodel): mirrors GitHub's
// own repo-creation flow.
//   - "Start with a template" (default: No). No template -> an "Add a README"
//     toggle picks between an initialized repo (auto_init, README on) and a
//     bare repo (README off). A template hides the README toggle (the template
//     provides the initial commit) and shows an "Include all branches" toggle
//     (deferred/coming-soon).
//   - Student repo access, and the Feedback PR (decoupled from autograding —
//     available for any non-empty repo).
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
              Template branch: the template picker + a deferred "Include all
              branches" toggle. deriveFormShape decides which shows. */}
          <form.Subscribe selector={(state) => deriveFormShape(state.values)}>
            {(shape) =>
              shape.showTemplateFields ? (
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

                  {/* Deferred (R6/U9): include-all-branches mirror. Reserved as
                      an inert, disabled toggle (off) — the accept path doesn't
                      send include_all_branches yet, and there's no wire field
                      to carry it, so it writes nothing. */}
                  <div
                    className="pointer-events-none opacity-50"
                    aria-disabled="true"
                  >
                    <ToggleRow
                      id="include-all-branches-deferred"
                      checked={false}
                      onChange={() => {}}
                      label={t("assignments.form.includeAllBranches.label")}
                      help={t("assignments.form.includeAllBranches.help")}
                    />
                  </div>
                </>
              ) : shape.showAddReadme ? (
                <form.Field name="add_readme">
                  {(readmeField) => (
                    <ToggleRow
                      id={readmeField.name}
                      checked={readmeField.state.value}
                      onChange={(checked) => readmeField.handleChange(checked)}
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
              ) : null
            }
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
          {/* Feedback PR (U6): decoupled from autograding — available for any
              non-empty repo, since it only needs a baseline commit. A bare repo
              (no README, no template) has none, so it renders locked-off (not
              hidden) to keep the trade-off visible. */}
          <form.Subscribe
            selector={(state) =>
              deriveFormShape(state.values).feedbackPrEnabled
            }
          >
            {(feedbackPrEnabled) => (
              <form.Field name="feedback_pr">
                {(field) => (
                  <div
                    className={
                      feedbackPrEnabled ? "" : "pointer-events-none opacity-50"
                    }
                    aria-disabled={!feedbackPrEnabled}
                  >
                    <ToggleRow
                      id={field.name}
                      checked={feedbackPrEnabled ? field.state.value : false}
                      onChange={(checked) => field.handleChange(checked)}
                      onBlur={field.handleBlur}
                      label={t("assignments.form.feedbackPr")}
                      help={
                        feedbackPrEnabled
                          ? t("assignments.form.feedbackPrHelp")
                          : t("assignments.form.feedbackPrEmptyRepoHelp")
                      }
                    />
                  </div>
                )}
              </form.Field>
            )}
          </form.Subscribe>
        </div>
      </div>
    </SectionCard>
  )
}
