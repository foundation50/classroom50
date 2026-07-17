import { useTranslation } from "react-i18next"
import { Alert, Button } from "@/components/ui"
import type { RosterCsvProblem } from "@/domain/students"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { rosterPath } from "@/util/rosterPath"

// Malformed roster.csv: name every bad line so the teacher can fix the file on
// GitHub. Distinct from a network load error — this is a bad file, and
// reads/writes silently misbehave until it's corrected.
export const RosterParseProblems = ({
  parseProblems,
  org,
  classroom,
  onRecheckRoster,
  rechecking,
}: {
  parseProblems: RosterCsvProblem[]
  org: string
  classroom: string
  onRecheckRoster?: () => void
  rechecking?: boolean
}) => {
  const { t } = useTranslation()
  return (
    <Alert tone="error">
      <div className="flex flex-col gap-2">
        <span className="font-medium">{t("students.rosterParseError")}</span>
        <ul className="list-disc ps-5 text-sm">
          {parseProblems.map((p, i) => (
            <li key={`${p.line}-${i}`}>
              {t("students.rosterParseErrorLine", {
                line: p.line,
                message: p.message,
              })}
            </li>
          ))}
        </ul>
        <a
          href={`https://github.com/${encodeURIComponent(org)}/${CONFIG_REPO}/edit/${DEFAULT_BRANCH}/${rosterPath(
            classroom,
          )
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {t("students.rosterEditOnGitHub")}
        </a>
        {onRecheckRoster ? (
          <div>
            <Button
              variant="ghost"
              size="sm"
              loading={rechecking}
              loadingLabel={t("students.rosterRechecking")}
              disabled={rechecking}
              onClick={onRecheckRoster}
            >
              {t("students.rosterRecheck")}
            </Button>
          </div>
        ) : null}
      </div>
    </Alert>
  )
}
