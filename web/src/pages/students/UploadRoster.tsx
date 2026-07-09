import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import Papa from "papaparse"
import { bulkEnrollStudentsInClassroom } from "@/hooks/github/mutations"
import type { GitHubClient } from "@/hooks/github/client"
import { Alert, Button, Modal } from "@/components/ui"
import {
  isLikelyGithubUsername,
  normalizeGithubUsername,
  splitName,
  type BulkImportResult,
  type ImportRosterRow,
} from "@/api/mutations/students"
import { logger } from "@/lib/logger"

const log = logger.scope("students:UploadRoster")

// Parse an uploaded roster into metadata rows. A CSV with a `username` header
// column also honors first_name/last_name/name/email/section columns (case- and
// order-insensitive); anything without a header falls back to one-username-per
// -line. github_id in the file is ignored — it's re-derived from GitHub on
// import so the stored id is authoritative. Rows are deduped by username.
// Exported for unit testing.
export const parseRosterImportFile = (text: string): ImportRosterRow[] => {
  const trimmed = text.trim()
  if (!trimmed) return []

  const parsed = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    delimiter: "",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  })

  const fields = parsed.meta.fields ?? []
  const hasUsernameColumn =
    parsed.errors.length === 0 && fields.includes("username")

  const seen = new Set<string>()
  const rows: ImportRosterRow[] = []

  const push = (row: ImportRosterRow) => {
    const username = normalizeGithubUsername(row.username)
    if (!username || !isLikelyGithubUsername(username)) return
    const key = username.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ ...row, username })
  }

  if (hasUsernameColumn) {
    for (const raw of parsed.data) {
      // Support either split first/last name columns or a single "name".
      const fromName = splitName(raw.name ?? null)
      push({
        username: raw.username ?? "",
        first_name: (raw.first_name ?? fromName.first_name).trim(),
        last_name: (raw.last_name ?? fromName.last_name).trim(),
        email: (raw.email ?? "").trim(),
        section: (raw.section ?? "").trim(),
      })
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      push({ username: line })
    }
  }

  return rows
}

type UploadRosterProps = {
  org: string
  classroom: string
  client: GitHubClient
  onSuccess?: (result: BulkImportResult) => void
  // When true, immediately prompt for a file (header-icon entry point). The
  // component has no visible trigger of its own in this mode.
  open?: boolean
  onOpenChange?: (open: boolean) => void
}
type ImportPhase = "idle" | "preview" | "importing" | "complete" | "error"
type ImportProgress = {
  processed: number
  total: number
  message: string
}

const ImportResultSection = ({
  title,
  rows,
}: {
  title: string
  rows: {
    key: string
    label: string
    detail?: string
  }[]
}) => {
  return (
    <div>
      <h4 className="font-bold mb-2">{title}</h4>

      <div className="max-h-48 overflow-auto rounded-box border border-base-300">
        <table className="table table-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <code>{row.key}</code>
                </td>
                <td className="opacity-70">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const UploadRoster = ({
  org,
  classroom,
  client,
  onSuccess,
  open,
  onOpenChange,
}: UploadRosterProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()

  const [phase, setPhase] = useState<ImportPhase>("idle")
  const [fileName, setFileName] = useState("")
  const [rows, setRows] = useState<ImportRosterRow[]>([])
  const [progress, setProgress] = useState<ImportProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isOpen = phase !== "idle"

  const reset = () => {
    setPhase("idle")
    setFileName("")
    setRows([])
    setProgress({
      processed: 0,
      total: 0,
      message: "",
    })
    setResult(null)
    setError(null)

    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  // Header-icon entry point: when opened externally and idle, prompt for a file
  // right away (there's no visible trigger card in this mode). Edge-triggered —
  // we fire the native picker and immediately clear `open`, since the dialog's
  // own phase state drives everything from here.
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open && !prevOpenRef.current && phase === "idle") {
      fileInputRef.current?.click()
      onOpenChange?.(false)
    }
    prevOpenRef.current = Boolean(open)
  }, [open, phase, onOpenChange])

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget
    const file = input.files?.[0]

    if (!file) return

    try {
      const text = await file.text()
      const parsedRows = parseRosterImportFile(text)

      setFileName(file.name)
      setRows(parsedRows)
      setResult(null)
      setError(null)
      setProgress({
        processed: 0,
        total: parsedRows.length,
        message: "",
      })
      setPhase("preview")
    } catch (err) {
      log.warn("roster file read/parse failed", { err, record: true })
      setError(
        err instanceof Error ? err.message : t("students.couldNotReadFile"),
      )
      setPhase("error")
    } finally {
      input.value = ""
    }
  }

  const startImport = async () => {
    setPhase("importing")
    setError(null)
    setResult(null)
    setProgress({
      processed: 0,
      total: rows.length,
      message: t("students.startingImport"),
    })

    try {
      const importResult = await bulkEnrollStudentsInClassroom(client, {
        org,
        classroom,
        rows,
        onProgress: setProgress,
      })

      setResult(importResult)
      setPhase("complete")
      onSuccess?.(importResult)
    } catch (err) {
      log.error("roster import failed", { err, record: true })
      setError(err instanceof Error ? err.message : t("students.importFailed"))
      setPhase("error")
    }
  }

  const progressPercent =
    progress.total === 0
      ? 0
      : Math.round((progress.processed / progress.total) * 100)

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".txt,.csv,text/plain,text/csv"
        onChange={handleFileChange}
      />

      <Modal
        open={isOpen}
        onClose={reset}
        closeDisabled={phase === "importing"}
        size="3xl"
        aria-labelledby={titleId}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id={titleId} className="text-lg font-bold">
              {t("students.importStudentsTitle")}
            </h3>
            {fileName && (
              <p className="text-sm opacity-70 mt-1">
                {t("students.fileLabel", { fileName })}
              </p>
            )}
          </div>
        </div>

        {phase === "preview" && (
          <div className="mt-6">
            <Alert tone="info" className="mb-4">
              <span>
                {t("students.usernamesFound", { count: rows.length })}
              </span>
            </Alert>

            {rows.length > 0 ? (
              <div className="max-h-80 overflow-auto rounded-box border border-base-300">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">{t("students.githubUsernameColumn")}</th>
                      <th scope="col">{t("students.nameColumn")}</th>
                      <th scope="col">{t("students.emailColumn")}</th>
                      <th scope="col">{t("students.sectionColumn")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={row.username.toLowerCase()}>
                        <td>{index + 1}</td>
                        <td>
                          <code>{row.username}</code>
                        </td>
                        <td className="opacity-70">
                          {[row.first_name, row.last_name]
                            .filter(Boolean)
                            .join(" ")}
                        </td>
                        <td className="opacity-70">{row.email}</td>
                        <td className="opacity-70">{row.section}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Alert tone="warning">{t("students.noValidUsernames")}</Alert>
            )}

            <div className="modal-action">
              <Button variant="ghost" onClick={reset}>
                {t("common.cancel")}
              </Button>

              <Button
                variant="primary"
                disabled={rows.length === 0}
                onClick={startImport}
              >
                {t("students.importCount", { count: rows.length })}
              </Button>
            </div>
          </div>
        )}

        {phase === "importing" && (
          <div className="mt-6">
            <p className="mb-2 font-medium">{progress.message}</p>

            <progress
              className="progress progress-primary w-full"
              value={progress.processed}
              max={progress.total || 1}
            />

            <div className="mt-2 flex justify-between text-sm opacity-70">
              <span>
                {t("students.progressProcessed", {
                  processed: progress.processed,
                  total: progress.total,
                })}
              </span>
              <span>
                {t("students.progressPercent", { percent: progressPercent })}
              </span>
            </div>

            <Alert tone="info" className="mt-6">
              <span>{t("students.keepTabOpen")}</span>
            </Alert>
          </div>
        )}

        {phase === "complete" && result && (
          <div className="mt-6 space-y-4">
            <Alert tone="success">
              <span>
                {t("students.addedCount", {
                  count: result.addedStudents.length,
                })}
              </span>
            </Alert>

            {result.addedStudents.length > 0 && (
              <ImportResultSection
                title={t("students.resultAdded")}
                rows={result.addedStudents.map((student) => ({
                  key: student.username,
                  label: student.username,
                  detail: [student.first_name, student.last_name]
                    .filter(Boolean)
                    .join(" "),
                }))}
              />
            )}

            {result.skippedStudents.length > 0 && (
              <ImportResultSection
                title={t("students.resultSkipped")}
                rows={result.skippedStudents.map((student) => ({
                  key: student.username,
                  label: student.username,
                  detail: student.message ?? student.reason,
                }))}
              />
            )}

            {result.teamResults?.some(
              (teamResult) => teamResult.status === "failed",
            ) && (
              <ImportResultSection
                title={t("students.resultTeamFailures")}
                rows={result.teamResults
                  .filter((teamResult) => teamResult.status === "failed")
                  .map((teamResult) => ({
                    key: teamResult.username,
                    label: teamResult.username,
                    detail:
                      teamResult.message ?? t("students.couldNotAddToTeam"),
                  }))}
              />
            )}

            {result.notInOrg && result.notInOrg.length > 0 && (
              <ImportResultSection
                title={t("students.resultNotInOrg")}
                rows={result.notInOrg.map((username) => ({
                  key: username,
                  label: username,
                  detail: t("students.notInOrgDetail"),
                }))}
              />
            )}

            <div className="modal-action">
              <Button variant="primary" onClick={reset}>
                {t("students.done")}
              </Button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="mt-6">
            <Alert tone="error">
              <span>{error ?? t("students.somethingWentWrong")}</span>
            </Alert>

            <div className="modal-action">
              <Button variant="ghost" onClick={reset}>
                {t("common.close")}
              </Button>

              <Button
                variant="primary"
                onClick={() => fileInputRef.current?.click()}
              >
                {t("students.chooseAnotherFile")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

export default UploadRoster
