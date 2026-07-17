import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Upload } from "lucide-react"

import {
  bulkInviteByEmail,
  resolveRosterUploadPreflight,
} from "@/domain/students"
import type {
  BulkImportResult,
  BulkInviteByEmailResult,
  ImportRosterRow,
} from "@/domain/students"
import type { GitHubClient } from "@/github-core/client"
import { Alert, Button, Modal, Spinner } from "@/components/ui"
import {
  hasInstructorPromotion,
  type PreflightResult,
} from "@/util/rosterUploadPreflight"
import { logger } from "@/lib/logger"
import type { ClassroomRole } from "@/util/teamRoster"
import {
  classifyUploadFile,
  type UploadKind,
} from "@/pages/students/uploadClassify"
import { parseEmailInviteFile } from "@/pages/students/emailInvite"
import {
  DetectedFormatSelect,
  EmailInvitePreview,
  EmailInviteResult,
} from "@/pages/students/EmailInviteFlow"
import {
  coerceImportRole,
  detectImportHeaderIssue,
  parseRosterImportFile,
  type ImportHeaderIssue,
} from "./rosterImportParse"
import { runRosterImport, type ImportProgress } from "./runRosterImport"
import type { InviteOutcome, RoleChangeOutcome } from "./runRosterImport"
import { PreflightRecap } from "./PreflightRecap"
import { RosterPreviewTable } from "./RosterPreviewTable"
import { ImportResultSection, RosterImportResult } from "./RosterImportResult"

// Preserve the module's original public surface: the pure parse helpers live in
// ./rosterImportParse now, but UploadRoster.test.ts and any importer still pull
// them from here.
export {
  coerceImportRole,
  detectImportHeaderIssue,
  parseRosterImportFile,
  type ImportHeaderIssue,
} from "./rosterImportParse"

const log = logger.scope("students:UploadRoster")

type UploadRosterProps = {
  org: string
  classroom: string
  client: GitHubClient
  onSuccess?: (result: BulkImportResult) => void
  // Fired after a successful email-invite batch (uploadKind === "email-list").
  // Separate from onSuccess because email invites write no roster.csv row — the
  // parent refreshes the pending-invite + team caches rather than the roster.
  onEmailSuccess?: (result: BulkInviteByEmailResult) => void
  // When true, render the modal (idle -> drop zone). The drop zone / Choose File
  // button drives file selection from there.
  open?: boolean
  onOpenChange?: (open: boolean) => void
}
type ImportPhase = "idle" | "preview" | "importing" | "complete" | "error"

const UploadRoster = ({
  org,
  classroom,
  client,
  onSuccess,
  onEmailSuccess,
  open,
  onOpenChange,
}: UploadRosterProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const { t } = useTranslation()

  const [phase, setPhase] = useState<ImportPhase>("idle")
  const [fileName, setFileName] = useState("")
  // The raw uploaded text, kept so switching the detected kind re-parses without
  // re-reading the file, and the auto-detected/overridable format.
  const [fileText, setFileText] = useState("")
  const [uploadKind, setUploadKind] = useState<UploadKind>("username-list")
  const [rows, setRows] = useState<ImportRosterRow[]>([])
  // Email-invite branch (uploadKind === "email-list"): parsed addresses, the
  // per-address role, the org-owner confirmation, and the send result. Kept
  // separate from the roster rows so the two flows don't entangle.
  const [emails, setEmails] = useState<string[]>([])
  const [emailRoles, setEmailRoles] = useState<Record<string, ClassroomRole>>(
    {},
  )
  const [emailOwnerConfirmed, setEmailOwnerConfirmed] = useState(false)
  const [emailResult, setEmailResult] =
    useState<BulkInviteByEmailResult | null>(null)
  // Why an empty parse produced no rows, when the cause is the file's shape (no
  // `username` header, or malformed CSV) rather than merely invalid handles.
  const [headerIssue, setHeaderIssue] = useState<ImportHeaderIssue | null>(null)
  // Per-row role the instructor is about to invite as, keyed by lowercased
  // username. Seeded from the CSV `role` column (else "student") and editable.
  const [rolesByUser, setRolesByUser] = useState<Record<string, ClassroomRole>>(
    {},
  )
  // Preflight against current GitHub membership (read-only). Null until the
  // preview's classification resolves.
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [preflighting, setPreflighting] = useState(false)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  // The teacher's explicit confirmation of the role-change (team-move) rows.
  const [roleChangesConfirmed, setRoleChangesConfirmed] = useState(false)
  const [progress, setProgress] = useState<ImportProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkImportResult | null>(null)
  const [inviteOutcome, setInviteOutcome] = useState<InviteOutcome | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [roleChangeOutcome, setRoleChangeOutcome] =
    useState<RoleChangeOutcome | null>(null)

  // Visibility is owned by the controlling parent via `open`.
  const isOpen = open ?? phase !== "idle"

  // A stale-response token for the async file ingest (see ingestFile).
  const ingestToken = useRef(0)

  const resetToDropZone = () => {
    ingestToken.current += 1
    setPhase("idle")
    setFileName("")
    setFileText("")
    setUploadKind("username-list")
    setRows([])
    setHeaderIssue(null)
    setEmails([])
    setEmailRoles({})
    setEmailOwnerConfirmed(false)
    setEmailResult(null)
    setProgress({ processed: 0, total: 0, message: "" })
    setResult(null)
    setInviteOutcome(null)
    setInviteError(null)
    setError(null)
    setRolesByUser({})
    setPreflight(null)
    setPreflighting(false)
    setPreflightError(null)
    setRoleChangesConfirmed(false)
    setRoleChangeOutcome(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  // Clear internal state after the modal has actually closed (open -> false),
  // so a programmatic close doesn't flash the idle drop-zone mid-close.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (wasOpenRef.current && open === false) {
      resetToDropZone()
    }
    wasOpenRef.current = Boolean(open)
  }, [open])

  const handleClose = () => {
    onOpenChange?.(false)
  }

  // Preflight the parsed rows against current GitHub membership whenever we're
  // in the preview and the rows or their assigned roles change. Read-only. A
  // stale-response guard (token) drops a slow classification superseded by a
  // newer role edit. Clearing the confirm checkbox on every re-run forces the
  // teacher to re-confirm after they change a role.
  const preflightToken = useRef(0)
  const rolesKey = rows
    .map(
      (r) =>
        `${r.username.toLowerCase()}:${rolesByUser[r.username.toLowerCase()] ?? "student"}`,
    )
    .join("|")
  useEffect(() => {
    if (phase !== "preview" || rows.length === 0) return
    const token = ++preflightToken.current
    /* eslint-disable react-hooks/set-state-in-effect */
    setPreflighting(true)
    setPreflightError(null)
    setRoleChangesConfirmed(false)
    setPreflight(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    const preflightRows = rows.map((r) => ({
      username: r.username,
      role:
        rolesByUser[r.username.toLowerCase()] ?? ("student" as ClassroomRole),
    }))
    void resolveRosterUploadPreflight(client, {
      org,
      classroom,
      rows: preflightRows,
    })
      .then((result) => {
        if (preflightToken.current !== token) return
        setPreflight(result)
      })
      .catch((err) => {
        if (preflightToken.current !== token) return
        log.warn("roster upload preflight failed", { err, record: true })
        setPreflight(null)
        setPreflightError(
          err instanceof Error ? err.message : t("students.somethingWentWrong"),
        )
      })
      .finally(() => {
        if (preflightToken.current === token) setPreflighting(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, rolesKey, org, classroom])

  const roleChanges = useMemo(() => preflight?.roleChanges ?? [], [preflight])
  // Enroll rows targeting instructor grant org OWNER on process, so — like a
  // confirmed role change — they must sit behind the confirmation checkbox.
  const instructorEnrolls = useMemo(
    () => (preflight?.enroll ?? []).filter((e) => e.role === "instructor"),
    [preflight],
  )
  const needsRoleConfirm =
    roleChanges.length > 0 || instructorEnrolls.length > 0
  const confirmGrantsOwner = useMemo(
    () => hasInstructorPromotion(roleChanges) || instructorEnrolls.length > 0,
    [roleChanges, instructorEnrolls],
  )
  const anyInstructorAssigned = useMemo(
    () =>
      confirmGrantsOwner ||
      Object.values(rolesByUser).some((r) => r === "instructor"),
    [confirmGrantsOwner, rolesByUser],
  )
  const emailHasInstructor = emails.some(
    (e) => (emailRoles[e.toLowerCase()] ?? "student") === "instructor",
  )
  const hasActionableWork =
    (preflight?.needsInvite.length ?? 0) +
      (preflight?.enroll.length ?? 0) +
      (preflight?.roleChanges.length ?? 0) >
    0
  const canProcess =
    uploadKind === "email-list"
      ? emails.length > 0 && (!emailHasInstructor || emailOwnerConfirmed)
      : rows.length > 0 &&
        !preflighting &&
        !preflightError &&
        (!preflight || hasActionableWork) &&
        (!needsRoleConfirm || roleChangesConfirmed)

  // The roster primary-button label reflects what processing will actually do.
  const willSendInvites = (preflight?.needsInvite.length ?? 0) > 0
  const rosterPrimaryLabel = willSendInvites
    ? t("students.importAndInviteMembers", { count: rows.length })
    : preflight
      ? hasActionableWork
        ? t("students.confirmChanges")
        : t("students.noChangesToApply")
      : t("students.importMembers", { count: rows.length })

  // Seed the preview state for a given kind from the raw text. Used both on
  // initial ingest and when the teacher overrides the detected kind.
  const applyKind = (text: string, kind: UploadKind) => {
    setUploadKind(kind)
    if (kind === "email-list") {
      const parsed = parseEmailInviteFile(text)
      setEmails(parsed.map((r) => r.email))
      setEmailRoles(
        Object.fromEntries(
          parsed.map((r) => [r.email.toLowerCase(), "student"]),
        ),
      )
      setEmailOwnerConfirmed(false)
      setRows([])
      setHeaderIssue(null)
    } else {
      const parsedRows = parseRosterImportFile(text)
      setRows(parsedRows)
      setHeaderIssue(
        parsedRows.length === 0 ? detectImportHeaderIssue(text) : null,
      )
      setRolesByUser(
        Object.fromEntries(
          parsedRows.map((r) => [
            r.username.toLowerCase(),
            r.role ?? "student",
          ]),
        ),
      )
      setEmails([])
    }
  }

  const ingestFile = async (file: File) => {
    const token = ++ingestToken.current
    try {
      const text = await file.text()
      if (ingestToken.current !== token) return
      setFileName(file.name)
      setFileText(text)
      applyKind(text, classifyUploadFile(text))
      setResult(null)
      setEmailResult(null)
      setInviteOutcome(null)
      setInviteError(null)
      setError(null)
      setProgress({ processed: 0, total: 0, message: "" })
      setPhase("preview")
    } catch (err) {
      if (ingestToken.current !== token) return
      log.warn("upload file read/parse failed", { err, record: true })
      setError(
        err instanceof Error ? err.message : t("students.couldNotReadFile"),
      )
      setPhase("error")
    }
  }

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    await ingestFile(file)
    input.value = ""
  }

  const [dragActive, setDragActive] = useState(false)
  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    const file = event.dataTransfer.files?.[0]
    if (file) await ingestFile(file)
  }

  const startImport = async () => {
    // Re-entry guard: a synchronous double-click would otherwise fire two
    // concurrent imports racing the same roster.csv read-modify-write.
    if (phase === "importing") return

    // Email-list branch: send org invitations by email (no roster.csv write),
    // then land on the same result screen.
    if (uploadKind === "email-list") {
      setPhase("importing")
      setError(null)
      setEmailResult(null)
      setProgress({
        processed: 0,
        total: emails.length,
        message: t("students.startingImport"),
      })
      try {
        const res = await bulkInviteByEmail(client, {
          org,
          classroom,
          invites: emails.map((email) => ({
            email,
            role: emailRoles[email.toLowerCase()] ?? "student",
          })),
          onProgress: setProgress,
        })
        setEmailResult(res)
        setPhase("complete")
        onEmailSuccess?.(res)
      } catch (err) {
        log.error("bulk email invite failed", { err, record: true })
        setError(
          err instanceof Error ? err.message : t("students.importFailed"),
        )
        setPhase("error")
      }
      return
    }

    setPhase("importing")
    setError(null)
    setResult(null)
    setInviteOutcome(null)
    setInviteError(null)
    setRoleChangeOutcome(null)

    const outcome = await runRosterImport(client, {
      org,
      classroom,
      rows,
      rolesByUser,
      // Snapshot the classification computed in the preview so the process pass
      // matches exactly what the teacher confirmed.
      plan: preflight,
      onProgress: setProgress,
      messages: {
        startingImport: t("students.startingImport"),
        invitingUploaded: t("students.invitingUploaded"),
        processRoleChanges: t("students.processRoleChanges"),
        importFailed: t("students.importFailed"),
        roleWritebackMalformed: t("students.roleWritebackMalformed"),
        roleWritebackFailed: t("students.roleWritebackFailed"),
      },
    })

    if (!outcome.ok) {
      setError(outcome.error)
      setPhase("error")
      return
    }

    setResult(outcome.importResult)
    setInviteOutcome(outcome.inviteOutcome)
    setInviteError(outcome.inviteError)
    setRoleChangeOutcome(outcome.roleChangeOutcome)
    setPhase("complete")
    onSuccess?.(outcome.importResult)
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
        onClose={handleClose}
        closeDisabled={phase === "importing"}
        size="3xl"
        aria-labelledby={titleId}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id={titleId} className="text-lg font-bold">
              {t("students.uploadTitle")}
            </h3>
            {fileName && (
              <p className="text-sm opacity-70 mt-1">
                {t("students.fileLabel", { fileName })}
              </p>
            )}
          </div>
        </div>

        {phase === "idle" && (
          <div className="mt-6">
            {/* Drop zone + click-to-pick. One entry for all three formats; the
                file is auto-classified on receipt and shown in the preview with
                an override. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-box border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragActive
                  ? "border-primary bg-primary/5"
                  : "border-base-300 hover:border-primary/50 hover:bg-base-200"
              }`}
            >
              <Upload aria-hidden="true" className="size-8 opacity-50" />
              <p className="font-medium">{t("students.uploadDropPrompt")}</p>
              <p className="text-sm opacity-70">
                {t("students.uploadHintAll")}
              </p>
              <Button variant="primary" size="sm" className="mt-2">
                {t("students.chooseFile")}
              </Button>
            </div>
            <p className="mt-3 text-center text-xs opacity-60">
              {t("students.supportedFormats")}
            </p>
          </div>
        )}

        {phase === "preview" && (
          <div className="mt-6">
            {/* Detected format + override, above the branch split. */}
            <DetectedFormatSelect
              value={uploadKind}
              onChange={(kind) => applyKind(fileText, kind)}
            />

            {uploadKind === "email-list" ? (
              <EmailInvitePreview
                emails={emails}
                emailRoles={emailRoles}
                emailOwnerConfirmed={emailOwnerConfirmed}
                emailHasInstructor={emailHasInstructor}
                canProcess={canProcess}
                onRoleChange={(key, rawValue) => {
                  const role = coerceImportRole(rawValue) ?? "student"
                  setEmailRoles((prev) => ({ ...prev, [key]: role }))
                }}
                onOwnerConfirmedChange={setEmailOwnerConfirmed}
                onCancel={resetToDropZone}
                onSend={startImport}
              />
            ) : null}
          </div>
        )}

        {phase === "preview" && uploadKind !== "email-list" && (
          <div>
            <Alert tone="info" className="mb-4">
              <span>
                {t("students.usernamesFound", { count: rows.length })}
              </span>
            </Alert>

            {/* Preflight against current GitHub membership: what processing will
                do to each row. Resolving/failed states gate the primary button. */}
            {preflighting ? (
              <div className="mb-4 flex items-center gap-3 rounded-box border border-base-300 px-4 py-3 text-sm text-base-content/70">
                <Spinner size="sm" />
                <span>{t("students.preflightChecking")}</span>
              </div>
            ) : preflightError ? (
              <Alert tone="error" className="mb-4">
                <span>
                  {t("students.preflightFailed", { message: preflightError })}
                </span>
              </Alert>
            ) : preflight ? (
              <PreflightRecap
                preflight={preflight}
                roleChanges={roleChanges}
                instructorEnrolls={instructorEnrolls}
                needsRoleConfirm={needsRoleConfirm}
                confirmGrantsOwner={confirmGrantsOwner}
                roleChangesConfirmed={roleChangesConfirmed}
                onRoleChangesConfirmedChange={setRoleChangesConfirmed}
              />
            ) : null}

            {/* Instructor-owner notice even before preflight resolves, whenever
                any row is assigned the instructor role. */}
            {!preflight && anyInstructorAssigned ? (
              <Alert tone="warning" className="mb-4">
                <span>{t("students.uploadInstructorOwnerNotice")}</span>
              </Alert>
            ) : null}

            {rows.length > 0 ? (
              <RosterPreviewTable
                rows={rows}
                rolesByUser={rolesByUser}
                onRoleChange={(key, role) =>
                  setRolesByUser((prev) => ({ ...prev, [key]: role }))
                }
              />
            ) : (
              <Alert tone="warning">
                {headerIssue?.kind === "missing-username-header" ? (
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">
                      {t("students.missingUsernameHeader")}
                    </span>
                    <span className="text-sm">
                      {t("students.expectedHeaders", {
                        headers: headerIssue.optional.join(", "),
                      })}
                    </span>
                  </div>
                ) : headerIssue?.kind === "malformed" ? (
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">
                      {t("students.malformedCsv")}
                    </span>
                    <span className="text-sm">{headerIssue.detail}</span>
                  </div>
                ) : (
                  t("students.noValidUsernames")
                )}
              </Alert>
            )}

            <div className="modal-action">
              <Button variant="ghost" onClick={resetToDropZone}>
                {t("common.cancel")}
              </Button>

              <Button
                variant="primary"
                disabled={!canProcess}
                onClick={startImport}
              >
                {rosterPrimaryLabel}
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

        {phase === "complete" && emailResult && (
          <EmailInviteResult
            result={emailResult}
            onDone={handleClose}
            renderSection={(props) => <ImportResultSection {...props} />}
          />
        )}

        {phase === "complete" && result && (
          <RosterImportResult
            result={result}
            inviteError={inviteError}
            inviteOutcome={inviteOutcome}
            roleChangeOutcome={roleChangeOutcome}
            onDone={handleClose}
          />
        )}

        {phase === "error" && (
          <div className="mt-6">
            <Alert tone="error">
              <span>{error ?? t("students.somethingWentWrong")}</span>
            </Alert>

            <div className="modal-action">
              <Button variant="ghost" onClick={handleClose}>
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
