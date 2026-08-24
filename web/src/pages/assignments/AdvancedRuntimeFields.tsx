import { useQuery } from "@tanstack/react-query"
import { InlineSpinner } from "@/components/Spinner"
import { Trans, useTranslation } from "react-i18next"
import {
  AlertIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  QuestionIcon,
  ServerIcon,
} from "@/components/ui/icons"
import { orgRunnersQuery } from "@/github-core/queries"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { Button, HelpTooltip, Input } from "@/components/ui"
import type { HelpTooltipPosition } from "@/components/ui"
import {
  isKnownHostedRunnerLabel,
  isRunnerLabelShapeValid,
  isStandardSelfHostedLabel,
  parseRunnerLabels,
  verifyRunnerLabels,
  type OrgRunnersResult,
  type RunnerVerification,
} from "@/util/runners"
import {
  RUNTIME_LANGUAGE_META,
  parseAptPackages,
  type RuntimeLanguage,
} from "@/util/runtime"
import {
  normalizeOnBlur,
  useDebouncedValue,
  type StringField,
} from "./formFieldHelpers"
import type { AssignmentForm } from "./assignmentFormModel"

// A question-mark help affordance now lives in the shared ui module; re-exported
// here so existing importers (CreateAssignmentForm) keep working.
export { HelpTooltip }

// A bold field label with an optional help affordance, for COMPOSITE controls
// (version dropdowns, verified inputs) whose custom anatomy doesn't fit
// FormField's render-prop shape. Simple label+control+error fields use
// FormField instead — it also owns error/hint wiring this recipe lacks.
export const FieldLabel = ({
  htmlFor,
  label,
  help,
  helpPosition,
}: {
  htmlFor?: string
  label: string
  help?: string
  helpPosition?: HelpTooltipPosition
}) => (
  <div className="mb-1.5 flex items-center gap-1.5">
    <label htmlFor={htmlFor} className="label font-bold">
      {label}
    </label>
    {help ? <HelpTooltip help={help} position={helpPosition} /> : null}
  </div>
)

// A language toolchain version input (python/node/java/go/rust). A themed combobox:
// a text input with a chevron that opens a DaisyUI dropdown of the actively-
// supported versions, but the input stays free-text so a teacher can type any
// custom version. Empty = toolchain off (except Python, which the runner
// defaults to 3.14). Advisory shape check mirrors the CLI's
// LanguageVersionPattern.
export const LanguageVersionField = ({
  form,
  language,
  disabled = false,
}: {
  form: AssignmentForm
  language: RuntimeLanguage
  disabled?: boolean
}) => {
  const { t } = useTranslation()
  const fieldName = `runtime_${language}` as const
  const meta = RUNTIME_LANGUAGE_META[language]
  return (
    <form.Field name={fieldName}>
      {(field) => {
        const error = field.state.meta.errors[0] as string | undefined
        const current = field.state.value.trim()
        return (
          <div>
            <FieldLabel
              htmlFor={field.name}
              label={meta.label}
              help={t("assignments.form.runtime.versionTip", {
                language: meta.label,
              })}
            />
            <div className="dropdown w-full max-w-xs">
              <div className="join w-full">
                <Input
                  id={field.name}
                  name={field.name}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                  invalid={Boolean(error)}
                  aria-describedby={error ? `${field.name}-error` : undefined}
                  className="join-item w-full"
                  placeholder={t(
                    "assignments.form.runtime.versionPlaceholder",
                    { version: meta.placeholder },
                  )}
                  value={field.state.value}
                  onBlur={normalizeOnBlur(field)}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <Button
                  shape="square"
                  tabIndex={0}
                  disabled={disabled}
                  className="join-item border-base-content/20"
                  aria-label={t("assignments.form.runtime.versionMenu", {
                    language: meta.label,
                  })}
                >
                  <ChevronDownIcon aria-hidden="true" className="size-4" />
                </Button>
              </div>
              {!disabled && (
                <ul
                  tabIndex={0}
                  role="menu"
                  className="dropdown-content menu z-10 mt-1 w-full rounded-box border border-base-300 bg-base-100 p-1 shadow"
                >
                  {meta.versions.map((version) => (
                    <li key={version}>
                      <button
                        type="button"
                        className={
                          version === current
                            ? "active font-semibold"
                            : undefined
                        }
                        onClick={(e) => {
                          field.handleChange(version)
                          // Close the focus-driven dropdown by blurring the
                          // clicked item (the focus holder that keeps a DaisyUI
                          // dropdown open) — scoped to this control so it can't
                          // steal focus from an unrelated element.
                          e.currentTarget.blur()
                        }}
                      >
                        <CheckIcon
                          aria-hidden="true"
                          className={`size-4 ${
                            version === current ? "" : "invisible"
                          }`}
                        />
                        {version}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error ? (
              <p
                id={`${field.name}-error`}
                role="alert"
                className="mt-1.5 text-sm text-error"
              >
                {error}
              </p>
            ) : null}
          </div>
        )
      }}
    </form.Field>
  )
}

// Free-form runner input with advisory, non-blocking verification: annotates
// the value but never rewrites or clears what the teacher typed.
export const RunnerField = ({
  field,
  org,
}: {
  field: StringField
  org?: string
}) => {
  const { t } = useTranslation()
  const client = useOptionalGitHubClient()
  const rawValue = field.state.value
  const debouncedValue = useDebouncedValue(rawValue.trim(), 400)

  // Hit the org runners API only for a well-shaped label not already recognized
  // client-side; everything else needs no network call.
  const needsOrgLookup = Boolean(
    client &&
    org &&
    parseRunnerLabels(debouncedValue).some(
      (label) =>
        isRunnerLabelShapeValid(label) &&
        !isKnownHostedRunnerLabel(label) &&
        !isStandardSelfHostedLabel(label),
    ),
  )

  const orgRunnersResultQuery = useQuery({
    ...orgRunnersQuery(client!, org ?? ""),
    enabled: needsOrgLookup,
  })

  const orgRunners: OrgRunnersResult = needsOrgLookup
    ? (orgRunnersResultQuery.data ?? { available: false, reason: "error" })
    : { available: false, reason: "no-access" }

  // Hold off on the "not found" verdict while the lookup is in flight.
  const isVerifying = needsOrgLookup && orgRunnersResultQuery.isLoading

  const pending = rawValue.trim() !== debouncedValue
  const verification = verifyRunnerLabels(debouncedValue, orgRunners)

  return (
    <div>
      <FieldLabel
        htmlFor={field.name}
        label={t("assignments.form.runner.label")}
        help={t("assignments.form.runner.tip")}
      />
      <Input
        id={field.name}
        name={field.name}
        autoComplete="off"
        spellCheck={false}
        className="w-full max-w-xs"
        placeholder="ubuntu-latest"
        value={rawValue}
        onBlur={normalizeOnBlur(field, (value) =>
          parseRunnerLabels(value).join(", "),
        )}
        onChange={(e) => field.handleChange(e.target.value)}
      />

      <RunnerVerificationNote
        verification={verification}
        pending={pending || isVerifying}
        hasValue={verification.kind !== "empty"}
      />

      {verification.kind === "self-hosted" && (
        <p className="mt-1.5 text-xs text-base-content/70">
          <Trans
            i18nKey="assignments.form.runner.selfHostedHint"
            components={{ code: <code dir="ltr" /> }}
          />
        </p>
      )}
    </div>
  )
}

// Container-runtime fields (Docker image + optional user). Rendered only in
// container mode. runs-on still shows in both modes (a container can target a
// specific Ubuntu/self-hosted runner); apt is hosted-only, enforced elsewhere.
export const ContainerFields = ({ form }: { form: AssignmentForm }) => {
  const { t } = useTranslation()
  return (
    <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
      <form.Field name="container_image">
        {(field) => (
          <div>
            <FieldLabel
              htmlFor={field.name}
              label={t("assignments.form.dockerImage")}
              help={t("assignments.form.dockerImageTip")}
            />
            <Input
              id={field.name}
              name={field.name}
              className="w-full max-w-xs"
              placeholder={t("assignments.form.dockerImagePlaceholder")}
              value={field.state.value}
              onBlur={normalizeOnBlur(field)}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="container_user">
        {(field) => (
          <div>
            <FieldLabel
              htmlFor={field.name}
              label={t("assignments.form.containerUser")}
              help={t("assignments.form.containerUserTip")}
            />
            <Input
              id={field.name}
              name={field.name}
              className="w-full max-w-xs"
              placeholder={t("assignments.form.containerUserPlaceholder")}
              value={field.state.value}
              onBlur={normalizeOnBlur(field)}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </div>
        )}
      </form.Field>
    </div>
  )
}

// Extra apt packages input. Rendered only in hosted mode (a container image
// owns its own packages), so apt-with-container can't be expressed.
export const AptField = ({
  form,
  disabled = false,
}: {
  form: AssignmentForm
  disabled?: boolean
}) => {
  const { t } = useTranslation()
  return (
    <form.Field name="runtime_apt">
      {(field) => {
        const packages = parseAptPackages(field.state.value)
        const error = field.state.meta.errors[0] as string | undefined
        return (
          <div className="mt-4">
            <FieldLabel
              htmlFor={field.name}
              label={t("assignments.form.runtime.aptLabel")}
              help={t("assignments.form.runtime.aptTip")}
            />
            <Input
              id={field.name}
              name={field.name}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              invalid={Boolean(error)}
              aria-describedby={error ? `${field.name}-error` : undefined}
              placeholder={t("assignments.form.runtime.aptPlaceholder")}
              value={field.state.value}
              onBlur={normalizeOnBlur(field, (value) =>
                parseAptPackages(value).join(", "),
              )}
              onChange={(e) => field.handleChange(e.target.value)}
            />
            {error ? (
              <p
                id={`${field.name}-error`}
                role="alert"
                className="mt-1.5 text-sm text-error"
              >
                {error}
              </p>
            ) : (
              packages.length > 0 && (
                <p className="mt-1.5 text-xs text-base-content/70">
                  {t("assignments.form.runtime.aptCount", {
                    count: packages.length,
                  })}
                </p>
              )
            )}
          </div>
        )
      }}
    </form.Field>
  )
}

const RunnerVerificationNote = ({
  verification,
  pending,
  hasValue,
}: {
  verification: RunnerVerification
  pending: boolean
  hasValue: boolean
}) => {
  const { t } = useTranslation()
  if (pending && hasValue) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-base-content/70">
        <InlineSpinner className="shrink-0" />
        {t("assignments.form.runner.checking")}
      </p>
    )
  }

  switch (verification.kind) {
    case "empty":
      return (
        <p className="mt-1.5 text-sm text-base-content/70">
          <Trans
            i18nKey="assignments.form.runner.emptyHint"
            components={{ code: <code dir="ltr" /> }}
          />
        </p>
      )

    case "hosted":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-success">
          <CheckCircleIcon aria-hidden="true" className="size-4 shrink-0" />
          {t("assignments.form.runner.hosted")}
        </p>
      )

    case "self-hosted": {
      const matched = verification.labels.filter(
        (l) => l.kind === "self-hosted-match",
      )
      const matchNames = matched.flatMap((l) =>
        l.kind === "self-hosted-match" ? l.runnerNames : [],
      )
      const uniqueNames = Array.from(new Set(matchNames))
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-success">
          <ServerIcon aria-hidden="true" className="size-4 shrink-0" />
          {verification.confirmed && uniqueNames.length > 0
            ? t("assignments.form.runner.selfHostedMatch", {
                count: uniqueNames.length,
                names: `${uniqueNames.slice(0, 3).join(", ")}${
                  uniqueNames.length > 3 ? "…" : ""
                }`,
              })
            : t("assignments.form.runner.selfHostedLabels")}
        </p>
      )
    }

    case "problem": {
      const badShape = verification.labels
        .filter((l) => l.kind === "invalid-shape")
        .map((l) => l.label)
      const unverified = verification.labels
        .filter((l) => l.kind === "unverified")
        .map((l) => l.label)
      const parts: string[] = []
      if (badShape.length > 0) {
        parts.push(
          t("assignments.form.runner.invalidLabel", {
            labels: badShape.map((l) => `"${l}"`).join(", "),
          }),
        )
      }
      if (unverified.length > 0) {
        parts.push(
          t("assignments.form.runner.noRunnerMatch", {
            labels: unverified.map((l) => `"${l}"`).join(", "),
          }),
        )
      }
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-error">
          <AlertIcon aria-hidden="true" className="size-4 shrink-0" />
          {parts.join(" ")}
        </p>
      )
    }

    case "too-many":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-error">
          <AlertIcon aria-hidden="true" className="size-4 shrink-0" />
          {t("assignments.form.runner.tooMany", {
            count: verification.count,
          })}
        </p>
      )

    case "unknown":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-base-content/70">
          <QuestionIcon aria-hidden="true" className="size-4 shrink-0" />
          {t("assignments.form.runner.cannotVerify")}
        </p>
      )

    default:
      return null
  }
}
