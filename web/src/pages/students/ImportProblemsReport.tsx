import { Trans, useTranslation } from "react-i18next"
import { Alert, Button, modalActionClass, MonoLtr } from "@/components/ui"
import type { ImportProblem } from "@/pages/students/importProblems"

// The per-line list both report variants share. Each explanation is ONE
// translatable sentence so a translator can reorder it, with the offending value
// marked up as a <v> tag: only the identifier is monospaced and LTR-isolated,
// which keeps the sentence itself reading correctly in an RTL locale.
const ProblemList = ({ problems }: { problems: readonly ImportProblem[] }) => (
  <ul className="ms-4 list-disc text-sm">
    {problems.map((p) => (
      <li key={`${p.line}-${p.key}`}>
        <Trans
          i18nKey={p.key}
          values={{ line: p.line, value: p.value }}
          components={{ v: <MonoLtr /> }}
        />
      </li>
    ))}
  </ul>
)

// The blocking report: shown INSTEAD of the preview when any row carries content we
// couldn't use, so there is no table and no import button to press. Every problem is
// listed, including the non-blocking ones, so one pass over the file fixes all.
export const ImportBlockedReport = ({
  problems,
  onRetry,
  onCancel,
}: {
  problems: readonly ImportProblem[]
  onRetry: () => void
  onCancel: () => void
}) => {
  const { t } = useTranslation()
  const blocking = problems.filter((p) => p.blocking)
  // A transient GitHub lookup failure blocks a file that is perfectly correct, so
  // "fix these lines and re-upload" would send the teacher to edit nothing. When
  // every blocker is that kind, offer the retry that actually resolves it instead.
  const onlyTransient =
    blocking.length > 0 &&
    blocking.every((p) => p.key === "students.dropIdLookupFailed")
  return (
    <>
      <Alert tone="error" className="mb-4">
        <div className="flex flex-col gap-1">
          <span className="font-medium">
            {t("students.importBlocked", { count: blocking.length })}
          </span>
          <ProblemList problems={problems} />
          {onlyTransient ? null : (
            <span className="text-sm">{t("students.importBlockedHint")}</span>
          )}
        </div>
      </Alert>
      <div className={modalActionClass}>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        {onlyTransient ? (
          <Button variant="primary" onClick={onRetry}>
            {t("students.importRetryLookup")}
          </Button>
        ) : null}
      </div>
    </>
  )
}

// The advisory report: a row with no identity cell at all, which is a student who
// hasn't supplied a handle rather than a mistake to correct. Filters for itself
// rather than trusting the caller to pre-split — counting a blocking row as
// "skipped" would tell the teacher the import continued when it did not.
export const ImportSkippedReport = ({
  problems,
}: {
  problems: readonly ImportProblem[]
}) => {
  const { t } = useTranslation()
  const skipped = problems.filter((p) => !p.blocking)
  if (skipped.length === 0) return null
  return (
    <Alert tone="warning" className="mb-4">
      <div className="flex flex-col gap-1">
        <span className="font-medium">
          {t("students.importSkipped", { count: skipped.length })}
        </span>
        <ProblemList problems={skipped} />
      </div>
    </Alert>
  )
}
