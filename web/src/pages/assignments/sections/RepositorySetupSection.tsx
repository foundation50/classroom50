import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"
import { FormField, Input, Select } from "@/components/ui"
import {
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  REPO_PERMISSIONS,
  defaultStudentPermission,
} from "@/types/classroom"
import { TemplateField } from "../TemplateField"
import { FieldLabel, ToggleRow } from "../AdvancedRuntimeFields"
import type { AssignmentForm } from "../assignmentFormModel"
import { deriveFormShape } from "../formShape"
import type { SectionStatus } from "./sectionStatus"
import { SectionCard } from "./SectionCard"

// GitHub's own reference for the repo role ladder (read/triage/write/maintain/
// admin), linked next to the Student repo access help so teachers can see what
// each level grants.
const REPO_ROLES_DOCS_URL =
  "https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization#repository-roles-for-organizations"

// Repository Setup (IA overhaul U5/U6): the repository source (empty vs
// template), the template ref and creation method, group provisioning (max
// group size + student repo access), and the Feedback PR. The source choice
// drives the downstream gates via deriveFormShape.
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
          {/* Repository source: empty repo vs template. Immutable after
              creation (locked on edit), since already-accepted repos can't be
              retrofitted from one source to the other. */}
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

          {/* Template picker + creation method: only when the source isn't a
              bare empty repo (which starts with no content). */}
          <form.Subscribe
            selector={(state) =>
              deriveFormShape(state.values).showTemplateFields
            }
          >
            {(showTemplateFields) =>
              showTemplateFields ? (
                <>
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

                  {/* Creation method (R6/U9): generate-from-default-branch is
                      today's only path; the fork-like mirror is reserved as a
                      disabled "coming soon" option that writes nothing. */}
                  <fieldset>
                    <legend className="label font-bold mb-2">
                      {t("assignments.form.creationMethod.label")}
                    </legend>
                    <div className="flex flex-col gap-2">
                      <label
                        htmlFor="creation-method-generate"
                        className="label cursor-pointer items-start justify-start gap-3 p-0"
                      >
                        <input
                          id="creation-method-generate"
                          type="radio"
                          className="radio mt-1"
                          name="creation_method"
                          value="generate"
                          checked
                          readOnly
                        />
                        <span className="font-bold">
                          {t("assignments.form.creationMethod.generate.label")}
                          <span className="mt-0.5 block font-normal text-sm text-base-content/70">
                            {t("assignments.form.creationMethod.generate.help")}
                          </span>
                        </span>
                      </label>
                      <label
                        htmlFor="creation-method-mirror"
                        className="label items-start justify-start gap-3 p-0 pointer-events-none opacity-50"
                        aria-disabled="true"
                      >
                        <input
                          id="creation-method-mirror"
                          type="radio"
                          className="radio mt-1"
                          name="creation_method"
                          value="mirror"
                          disabled
                        />
                        <span className="font-bold">
                          {t("assignments.form.creationMethod.mirror.label")}
                          <span className="mt-0.5 block font-normal text-sm text-base-content/70">
                            {t("assignments.form.creationMethod.mirror.help")}
                          </span>
                        </span>
                      </label>
                    </div>
                  </fieldset>
                </>
              ) : null
            }
          </form.Subscribe>

          {/* Assignment type drives group provisioning: max group size shows
              only for a group, and student repo access takes the mode default. */}
          <form.Subscribe
            selector={(state) => deriveFormShape(state.values).showGroupSize}
          >
            {(showGroupSize) =>
              showGroupSize ? (
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
              non-empty repo, since it only needs a baseline commit. An empty
              repo has none, so it renders locked-off (not hidden) to keep the
              trade-off visible. */}
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
