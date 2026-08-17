import { useTranslation } from "react-i18next"
import { Alert, Button, MonoLtr } from "@/components/ui"
import type { ImportProblem } from "@/pages/students/importProblems"

// The per-line list both report variants share. The whole explanation is ONE
// interpolated string per reason rather than assembled fragments, so a translator
// can reorder it; the value is rendered LTR because a handle, address, or id is
// always LTR even in an RTL locale.
const ProblemList = ({ problems }: { problems: readonly ImportProblem[] }) => {
  const { t } = useTranslation()
  return (
    <ul className="ms-4 list-disc text-sm">
      {problems.map((p) => (
        <li key={`${p.line}-${p.key}`}>
          {p.value ? (
            <MonoLtr>{t(p.key, { line: p.line, value: p.value })}</MonoLtr>
          ) : (
            t(p.key, { line: p.line })
          )}
        </li>
      ))}
    </ul>
  )
}

// The blocking report: shown INSTEAD of the preview when any row carries content
// we couldn't use, so there is no table and no import button to press. The file
// and the app disagree about what the file says, and importing the remainder
// would act on that disagreement — see classifyImportProblems. Every problem is
// listed, including the non-blocking ones, so one pass over the file fixes all of
// them; re-importing is idempotent, so the round-trip costs only the upload.
export const ImportBlockedReport = ({
  problems,
  onCancel,
}: {
  problems: readonly ImportProblem[]
  onCancel: () => void
}) => {
  const { t } = useTranslation()
  const blocking = problems.filter((p) => p.blocking)
  return (
    <>
      <Alert tone="error" className="mb-4">
        <div className="flex flex-col gap-1">
          <span className="font-medium">
            {t("students.importBlocked", { count: blocking.length })}
          </span>
          <ProblemList problems={problems} />
          <span className="text-sm">{t("students.importBlockedHint")}</span>
        </div>
      </Alert>
      <div className="modal-action">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </>
  )
}

// The advisory report: every problem is a row with no identity cell at all, which
// is a student who hasn't supplied a handle rather than a mistake to correct. The
// import proceeds for everyone who IS addressable, so this only names who was
// left out.
export const ImportSkippedReport = ({
  problems,
}: {
  problems: readonly ImportProblem[]
}) => {
  const { t } = useTranslation()
  if (problems.length === 0) return null
  return (
    <Alert tone="warning" className="mb-4">
      <div className="flex flex-col gap-1">
        <span className="font-medium">
          {t("students.importSkipped", { count: problems.length })}
        </span>
        <ProblemList problems={problems} />
      </div>
    </Alert>
  )
}
