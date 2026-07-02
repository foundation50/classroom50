import { HardDriveUpload, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import Papa from "papaparse"
import { bulkEnrollStudentsInClassroom } from "@/hooks/github/mutations"
import type { GitHubClient } from "@/hooks/github/client"
import {
  isLikelyGithubUsername,
  normalizeGithubUsername,
  type BulkImportResult,
} from "@/api/mutations/students"

const parseUsernameImportFile = (text: string): string[] => {
  const trimmed = text.trim()

  if (!trimmed) return []

  const parsed = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    delimiter: "",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  })

  let candidates: string[]

  if (
    parsed.errors.length === 0 &&
    parsed.meta.fields?.some((field) => field.toLowerCase() === "username")
  ) {
    candidates = parsed.data.map((row) => row.username ?? "")
  } else {
    candidates = trimmed.split(/\r?\n/)
  }

  const seen = new Set<string>()
  const usernames: string[] = []

  for (const candidate of candidates) {
    const username = normalizeGithubUsername(candidate)

    if (!username || !isLikelyGithubUsername(username)) {
      continue
    }

    const key = username.toLowerCase()

    if (seen.has(key)) continue

    seen.add(key)
    usernames.push(username)
  }

  return usernames
}

type UploadRosterProps = {
  org: string
  classroom: string
  client: GitHubClient
  onSuccess?: (result: BulkImportResult) => void
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
}: UploadRosterProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()

  const [phase, setPhase] = useState<ImportPhase>("idle")
  const [fileName, setFileName] = useState("")
  const [usernames, setUsernames] = useState<string[]>([])
  const [progress, setProgress] = useState<ImportProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isOpen = phase !== "idle"

  // Drive the native <dialog> so we get focus-trap, Escape, and backdrop
  // inertness for free (matches the app's other modals).
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (isOpen && !dialog.open) dialog.showModal()
    if (!isOpen && dialog.open) dialog.close()
  }, [isOpen])

  const reset = () => {
    setPhase("idle")
    setFileName("")
    setUsernames([])
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

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget
    const file = input.files?.[0]

    if (!file) return

    try {
      const text = await file.text()
      const parsedUsernames = parseUsernameImportFile(text)

      setFileName(file.name)
      setUsernames(parsedUsernames)
      setResult(null)
      setError(null)
      setProgress({
        processed: 0,
        total: parsedUsernames.length,
        message: "",
      })
      setPhase("preview")
    } catch (err) {
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
      total: usernames.length,
      message: t("students.startingImport"),
    })

    try {
      const importResult = await bulkEnrollStudentsInClassroom(client, {
        org,
        classroom,
        usernames,
        onProgress: setProgress,
      })

      setResult(importResult)
      setPhase("complete")
      onSuccess?.(importResult)
    } catch (err) {
      console.error(err)
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
      <div className="card card-border bg-base-100 shadow-sm">
        <div className="card-body">
          <p className="font-bold">{t("students.uploadRosterTitle")}</p>
          <span>{t("students.uploadRosterHint")}</span>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".txt,.csv,text/plain,text/csv"
            onChange={handleFileChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn"
          >
            <HardDriveUpload aria-hidden="true" />
            {t("students.chooseFile")}
          </button>
          <p className="text-center text-base-content/70 text-sm">
            {t("students.supportedFormats")}
          </p>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby={titleId}
        onCancel={(event) => {
          // Escape during an in-flight import would abandon it; block it.
          if (phase === "importing") {
            event.preventDefault()
            return
          }
          reset()
        }}
      >
        <div className="modal-box max-w-3xl">
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

            {phase !== "importing" && (
              <button
                type="button"
                className="btn btn-sm btn-circle btn-ghost"
                aria-label={t("common.close")}
                onClick={reset}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>

          {phase === "preview" && (
            <div className="mt-6">
              <div className="alert mb-4">
                <span>
                  {t("students.usernamesFound", { count: usernames.length })}
                </span>
              </div>

              {usernames.length > 0 ? (
                <div className="max-h-80 overflow-auto rounded-box border border-base-300">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">
                          {t("students.githubUsernameColumn")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {usernames.map((username, index) => (
                        <tr key={username.toLowerCase()}>
                          <td>{index + 1}</td>
                          <td>
                            <code>{username}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="alert alert-warning">
                  {t("students.noValidUsernames")}
                </div>
              )}

              <div className="modal-action">
                <button type="button" className="btn btn-ghost" onClick={reset}>
                  {t("common.cancel")}
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={usernames.length === 0}
                  onClick={startImport}
                >
                  {t("students.importCount", { count: usernames.length })}
                </button>
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

              <div className="mt-6 alert">
                <span>{t("students.keepTabOpen")}</span>
              </div>
            </div>
          )}

          {phase === "complete" && result && (
            <div className="mt-6 space-y-4">
              <div className="alert alert-success">
                <span>
                  {t("students.addedCount", {
                    count: result.addedStudents.length,
                  })}
                </span>
              </div>

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

              <div className="modal-action">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={reset}
                >
                  {t("students.done")}
                </button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="mt-6">
              <div className="alert alert-error" role="alert">
                <span>{error ?? t("students.somethingWentWrong")}</span>
              </div>

              <div className="modal-action">
                <button type="button" className="btn btn-ghost" onClick={reset}>
                  {t("common.close")}
                </button>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t("students.chooseAnotherFile")}
                </button>
              </div>
            </div>
          )}
        </div>

        {phase !== "importing" && (
          <form method="dialog" className="modal-backdrop">
            <button type="button" onClick={reset}>
              {t("common.close")}
            </button>
          </form>
        )}
      </dialog>
    </>
  )
}

export default UploadRoster
