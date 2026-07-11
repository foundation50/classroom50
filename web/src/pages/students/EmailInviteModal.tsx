import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, Button, Modal, Select, Spinner } from "@/components/ui"
import {
  bulkInviteByEmail,
  type BulkInviteByEmailResult,
} from "@/api/mutations/students"
import type { GitHubClient } from "@/hooks/github/client"
import { ROLE_LABEL_KEY } from "@/util/rosterRoles"
import { logger } from "@/lib/logger"
import type { RosterRole } from "@/util/teamRoster"
import { coerceImportRole } from "@/pages/students/UploadRoster"
import { parseEmailInviteFile } from "@/pages/students/emailInvite"

const log = logger.scope("students:EmailInviteModal")

type EmailInvitePhase = "idle" | "preview" | "inviting" | "complete" | "error"
type InviteProgress = { processed: number; total: number; message: string }

type EmailInviteModalProps = {
  org: string
  classroom: string
  client: GitHubClient
  onSuccess?: (result: BulkInviteByEmailResult) => void
  // Header-icon entry: when opened externally and idle, prompt for a file at
  // once (no visible trigger card in this mode), mirroring UploadRoster.
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

// A compact result list (email + optional detail). Local to this modal so the
// email flow stays self-contained.
const ResultSection = ({
  title,
  rows,
}: {
  title: string
  rows: { key: string; detail?: string }[]
}) => (
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

// Bulk email-invite modal: upload one email per line, pick a role per email
// (default Student), and send GitHub org invitations by email carrying the
// classroom team. Writes NOTHING to roster.csv (stated up front); invitees show
// up as `pending` rows via the org pending-invitations list until they accept.
const EmailInviteModal = ({
  org,
  classroom,
  client,
  onSuccess,
  open,
  onOpenChange,
}: EmailInviteModalProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()

  const [phase, setPhase] = useState<EmailInvitePhase>("idle")
  const [fileName, setFileName] = useState("")
  const [emails, setEmails] = useState<string[]>([])
  // Per-email role, keyed by lowercased email; defaults to student.
  const [rolesByEmail, setRolesByEmail] = useState<Record<string, RosterRole>>(
    {},
  )
  // Team moves to org OWNER need explicit confirmation: an instructor email
  // invite grants org owner on acceptance, mirroring the CSV upload gate.
  const [ownerConfirmed, setOwnerConfirmed] = useState(false)
  const [progress, setProgress] = useState<InviteProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkInviteByEmailResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isOpen = phase !== "idle"

  const reset = () => {
    setPhase("idle")
    setFileName("")
    setEmails([])
    setRolesByEmail({})
    setOwnerConfirmed(false)
    setProgress({ processed: 0, total: 0, message: "" })
    setResult(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open && !prevOpenRef.current && phase === "idle") {
      fileInputRef.current?.click()
      onOpenChange?.(false)
    }
    prevOpenRef.current = Boolean(open)
  }, [open, phase, onOpenChange])

  const roleFor = (email: string): RosterRole =>
    rolesByEmail[email.toLowerCase()] ?? "student"
  const hasInstructor = emails.some((e) => roleFor(e) === "instructor")
  const canProcess = emails.length > 0 && (!hasInstructor || ownerConfirmed)

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const parsed = parseEmailInviteFile(text)
      setFileName(file.name)
      setEmails(parsed.map((r) => r.email))
      setRolesByEmail(
        Object.fromEntries(
          parsed.map((r) => [r.email.toLowerCase(), "student"]),
        ),
      )
      setOwnerConfirmed(false)
      setResult(null)
      setError(null)
      setPhase("preview")
    } catch (err) {
      log.warn("email invite file read failed", { err, record: true })
      setError(
        err instanceof Error ? err.message : t("students.couldNotReadFile"),
      )
      setPhase("error")
    } finally {
      input.value = ""
    }
  }

  const startInvite = async () => {
    if (phase === "inviting") return
    setPhase("inviting")
    setError(null)
    setResult(null)
    setProgress({
      processed: 0,
      total: emails.length,
      message: t("students.startingImport"),
    })
    try {
      const res = await bulkInviteByEmail(client, {
        org,
        classroom,
        invites: emails.map((email) => ({ email, role: roleFor(email) })),
        onProgress: setProgress,
      })
      setResult(res)
      setPhase("complete")
      onSuccess?.(res)
    } catch (err) {
      log.error("bulk email invite failed", { err, record: true })
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
        closeDisabled={phase === "inviting"}
        size="3xl"
        aria-labelledby={titleId}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id={titleId} className="text-lg font-bold">
              {t("students.emailInviteTitle")}
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
            <Alert tone="info" className="mb-2">
              <span>{t("students.emailsFound", { count: emails.length })}</span>
            </Alert>

            {/* The defining property of this flow: invites only, no roster.csv. */}
            <Alert tone="warning" className="mb-4">
              <span>{t("students.emailInviteNoRosterNotice")}</span>
            </Alert>

            {emails.length > 0 ? (
              <>
                <div className="max-h-80 overflow-auto rounded-box border border-base-300">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">{t("students.emailColumn")}</th>
                        <th scope="col">{t("students.roleColumn")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {emails.map((email, index) => {
                        const key = email.toLowerCase()
                        return (
                          <tr key={key}>
                            <td>{index + 1}</td>
                            <td>
                              <code>{email}</code>
                            </td>
                            <td>
                              <Select
                                selectSize="xs"
                                className="w-32"
                                aria-label={t("students.assignRoleLabel")}
                                value={rolesByEmail[key] ?? "student"}
                                onChange={(e) =>
                                  setRolesByEmail((prev) => ({
                                    ...prev,
                                    [key]:
                                      coerceImportRole(e.currentTarget.value) ??
                                      "student",
                                  }))
                                }
                              >
                                <option value="student">
                                  {t("students.roleStudent")}
                                </option>
                                <option value="ta">
                                  {t("students.roleTa")}
                                </option>
                                <option value="instructor">
                                  {t("students.roleInstructor")}
                                </option>
                              </Select>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* An instructor email invite grants org OWNER on acceptance —
                    gate the send on an explicit confirmation. */}
                {hasInstructor ? (
                  <div className="mt-3 flex flex-col gap-2 rounded-box border border-error/30 bg-error/5 p-4">
                    <Alert tone="warning">
                      <span>{t("students.uploadInstructorOwnerNotice")}</span>
                    </Alert>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm mt-0.5"
                        checked={ownerConfirmed}
                        onChange={(e) =>
                          setOwnerConfirmed(e.currentTarget.checked)
                        }
                      />
                      <span>{t("students.emailInviteConfirmOwner")}</span>
                    </label>
                  </div>
                ) : null}
              </>
            ) : (
              <Alert tone="warning">{t("students.noValidEmails")}</Alert>
            )}

            <div className="modal-action">
              <Button variant="ghost" onClick={reset}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={!canProcess}
                onClick={startInvite}
              >
                {t("students.sendInviteCount", { count: emails.length })}
              </Button>
            </div>
          </div>
        )}

        {phase === "inviting" && (
          <div className="mt-6">
            <p className="mb-2 font-medium">
              {progress.message || t("students.invitingUploaded")}
            </p>
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
                {t("students.emailInvitedCount", {
                  count: result.invited.length,
                })}
              </span>
            </Alert>

            {result.invited.length > 0 && (
              <ResultSection
                title={t("students.resultInvited")}
                rows={result.invited.map(({ email, role }) => ({
                  key: email,
                  detail: t(ROLE_LABEL_KEY[role]),
                }))}
              />
            )}
            {result.skipped.length > 0 && (
              <ResultSection
                title={t("students.resultSkipped")}
                rows={result.skipped.map(({ email }) => ({
                  key: email,
                  detail: t("students.emailInviteSkippedDetail"),
                }))}
              />
            )}
            {result.deferred.length > 0 && (
              <ResultSection
                title={t("students.resultInvitesDeferred")}
                rows={result.deferred.map((email) => ({
                  key: email,
                  detail: t("students.inviteDeferredDetail"),
                }))}
              />
            )}
            {result.failed.length > 0 && (
              <ResultSection
                title={t("students.resultInvitesFailed")}
                rows={result.failed.map((f) => ({
                  key: f.email,
                  detail: f.message,
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
            </div>
          </div>
        )}

        {phase === "idle" && (
          <div className="mt-6">
            <div className="flex items-center gap-3">
              <Spinner size="sm" />
              <span className="text-sm opacity-70">
                {t("students.startingImport")}
              </span>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

export default EmailInviteModal
