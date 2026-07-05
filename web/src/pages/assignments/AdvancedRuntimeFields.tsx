import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  Loader2,
  ServerCog,
} from "lucide-react"
import { orgRunnersQuery } from "@/hooks/github/queries"
import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
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
import type { AssignmentForm } from "./CreateAssignmentForm"

// A question-mark help affordance: a focusable button carrying detailed
// guidance as its accessible name, wrapped in a theme-aware DaisyUI tooltip
// that reveals `help` on hover/focus. The single source for the help-icon
// markup and a11y contract — reused by FieldLabel and any inline toggle label.
export const HelpTooltip = ({ help }: { help: string }) => (
  <span
    className="tooltip tooltip-bottom before:max-w-xs before:whitespace-normal before:text-left"
    data-tip={help}
  >
    <button
      type="button"
      aria-label={help}
      className="btn btn-ghost btn-xs btn-circle text-base-content/50 hover:text-base-content"
    >
      <HelpCircle aria-hidden="true" className="size-4" />
    </button>
  </span>
)

// A bold field label with an optional help affordance: a question-mark icon
// that reveals detailed guidance on hover/focus (DaisyUI tooltip, theme-aware).
// Keeps the label short so the form stays scannable while the "why/how" moves
// into the tooltip. `help` is the tooltip text; `htmlFor` ties the label to its
// control.
export const FieldLabel = ({
  htmlFor,
  label,
  help,
  required,
}: {
  htmlFor?: string
  label: string
  help?: string
  required?: boolean
}) => (
  <div className="mb-1.5 flex items-center gap-1.5">
    <label htmlFor={htmlFor} className="label font-bold">
      {label}
      {required ? <span className="text-error">*</span> : null}
    </label>
    {help ? <HelpTooltip help={help} /> : null}
  </div>
)

// A language toolchain version input (python/node/java/go). A themed combobox:
// a text input with a chevron that opens a DaisyUI dropdown of the actively-
// supported versions, but the input stays free-text so a teacher can type any
// custom version. Empty = toolchain off (except Python, which the runner
// defaults to 3.12). Advisory shape check mirrors the CLI's
// LanguageVersionPattern.
export const LanguageVersionField = ({
  form,
  language,
}: {
  form: AssignmentForm
  language: RuntimeLanguage
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
                <input
                  id={field.name}
                  name={field.name}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="input join-item w-full"
                  placeholder={t(
                    "assignments.form.runtime.versionPlaceholder",
                    { version: meta.placeholder },
                  )}
                  value={field.state.value}
                  onBlur={normalizeOnBlur(field)}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                <button
                  type="button"
                  tabIndex={0}
                  className="btn btn-square join-item border-base-content/20"
                  aria-label={t("assignments.form.runtime.versionMenu", {
                    language: meta.label,
                  })}
                >
                  <ChevronDown aria-hidden="true" className="size-4" />
                </button>
              </div>
              <ul
                tabIndex={0}
                className="dropdown-content menu z-10 mt-1 w-full rounded-box border border-base-content/5 bg-base-100 p-1 shadow"
              >
                {meta.versions.map((version) => (
                  <li key={version}>
                    <button
                      type="button"
                      className={
                        version === current ? "active font-semibold" : undefined
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
                      <Check
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
            </div>
            {error ? (
              <p
                role="alert"
                className="mt-1.5 flex items-center gap-1.5 text-sm text-error"
              >
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
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
      <input
        id={field.name}
        name={field.name}
        type="text"
        autoComplete="off"
        spellCheck={false}
        className="input w-full max-w-xs"
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
          {t("assignments.form.runner.selfHostedHint_prefix")}{" "}
          <code>self-hosted, linux, x64</code>
          {t("assignments.form.runner.selfHostedHint_suffix")}
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
            <input
              id={field.name}
              name={field.name}
              type="text"
              className="input w-full max-w-xs"
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
            <input
              id={field.name}
              name={field.name}
              type="text"
              className="input w-full max-w-xs"
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
export const AptField = ({ form }: { form: AssignmentForm }) => {
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
            <input
              id={field.name}
              name={field.name}
              type="text"
              autoComplete="off"
              spellCheck={false}
              className="input w-full"
              placeholder={t("assignments.form.runtime.aptPlaceholder")}
              value={field.state.value}
              onBlur={normalizeOnBlur(field, (value) =>
                parseAptPackages(value).join(", "),
              )}
              onChange={(e) => field.handleChange(e.target.value)}
            />
            {error ? (
              <p
                role="alert"
                className="mt-1.5 flex items-center gap-1.5 text-sm text-error"
              >
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
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
        <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        {t("assignments.form.runner.checking")}
      </p>
    )
  }

  switch (verification.kind) {
    case "empty":
      return (
        <p className="mt-1.5 text-sm text-base-content/70">
          {t("assignments.form.runner.emptyHint_prefix")}{" "}
          <code>ubuntu-latest</code>
          {t("assignments.form.runner.emptyHint_suffix")}
        </p>
      )

    case "hosted":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
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
          <ServerCog aria-hidden="true" className="size-4 shrink-0" />
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
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          {parts.join(" ")}
        </p>
      )
    }

    case "too-many":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-error">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          {t("assignments.form.runner.tooMany", {
            count: verification.count,
          })}
        </p>
      )

    case "unknown":
      return (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-base-content/70">
          <HelpCircle aria-hidden="true" className="size-4 shrink-0" />
          {t("assignments.form.runner.cannotVerify")}
        </p>
      )

    default:
      return null
  }
}
