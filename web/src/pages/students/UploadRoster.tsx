import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import Papa from "papaparse"
import { bulkEnrollStudentsInClassroom } from "@/hooks/github/mutations"
import type { GitHubClient } from "@/hooks/github/client"
import { Alert, Button, Modal, Select, Spinner } from "@/components/ui"
import {
  applyRosterRoleChange,
  inviteRosterStudents,
  isLikelyGithubUsername,
  NoNewStudentsError,
  normalizeGithubUsername,
  resolveRosterUploadPreflight,
  RosterCsvMalformedError,
  splitName,
  writeRosterRoles,
  type BulkImportResult,
  type ImportRosterRow,
} from "@/api/mutations/students"
import {
  hasInstructorPromotion,
  type PreflightResult,
} from "@/util/rosterUploadPreflight"
import { ROLE_LABEL_KEY } from "@/util/rosterRoles"
import { logger } from "@/lib/logger"
import type { RosterRole } from "@/util/teamRoster"

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
        role: coerceImportRole(raw.role),
      })
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      push({ username: line })
    }
  }

  return rows
}

// Coerce a raw string to a RosterRole, or undefined when absent/unknown.
// Case-insensitive; the upload defaults undefined to "student" and lets the
// instructor override, so an unrecognized value degrades to student rather than
// failing the whole import. Exported so both the CSV parse and the preview
// Select coerce through one guard (no unchecked cast on raw input).
export const coerceImportRole = (
  raw: string | undefined,
): RosterRole | undefined => {
  const value = raw?.trim().toLowerCase()
  if (value === "student" || value === "instructor" || value === "ta") {
    return value
  }
  return undefined
}

// A small summary tile for a preflight bucket (count + label). Zero-count
// buckets dim so the teacher's eye goes to what actually changes.
const PreflightBucket = ({
  tone,
  title,
  count,
}: {
  tone: "neutral" | "info" | "warning" | "error"
  title: string
  count: number
}) => {
  const toneClass =
    count === 0
      ? "border-base-300 opacity-50"
      : tone === "error"
        ? "border-error/40 bg-error/5"
        : tone === "warning"
          ? "border-warning/40 bg-warning/5"
          : tone === "info"
            ? "border-info/40 bg-info/5"
            : "border-base-300"
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-box border px-4 py-2.5 ${toneClass}`}
    >
      <span className="text-sm">{title}</span>
      <span className="badge badge-sm">{count}</span>
    </div>
  )
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
  // Per-row role the instructor is about to invite as, keyed by lowercased
  // username. Seeded from the CSV `role` column (else "student") and editable in
  // the preview. Instructor -> org owner invite (called out in the confirm).
  const [rolesByUser, setRolesByUser] = useState<Record<string, RosterRole>>({})
  // Preflight against current GitHub membership (read-only). Null until the
  // preview's classification resolves; drives the no-action / invite / enroll /
  // role-change buckets and gates the confirm checkbox.
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
  // Outcome of the follow-up org-invite pass for uploaded non-members
  // (deferred = rate-limited, failed = couldn't invite). Surfaced in the result
  // dialog so an un-invited upload isn't silently lost (it won't appear on the
  // team-driven roster until re-invited or accepted).
  const [inviteOutcome, setInviteOutcome] = useState<{
    invited: { username: string; role: RosterRole }[]
    deferred: string[]
    failed: { username: string; message: string }[]
  } | null>(null)
  // A hard failure of the invite pass AFTER the roster.csv write already
  // succeeded. Surfaced inside the (still-shown) result view rather than
  // collapsing to the bare error screen, which would hide the rows that landed.
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Outcome of the confirmed role-change (team-move) pass, surfaced in the
  // result dialog alongside the invite outcomes.
  const [roleChangeOutcome, setRoleChangeOutcome] = useState<{
    changed: { username: string; to: RosterRole }[]
    failed: { username: string; message: string }[]
  } | null>(null)

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

  // Preflight the parsed rows against current GitHub membership whenever we're
  // in the preview and the rows or their assigned roles change (a role edit can
  // move a row between the no-action / enroll / role-change buckets). Read-only.
  // A stale-response guard (token) drops a slow classification superseded by a
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
    // Reset to the loading state, then fetch the fresh classification (an
    // external-system sync: the async read supersedes any prior result). The
    // synchronous resets here are the intended "clear then load" transition.
    /* eslint-disable react-hooks/set-state-in-effect */
    setPreflighting(true)
    setPreflightError(null)
    setRoleChangesConfirmed(false)
    setPreflight(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    const preflightRows = rows.map((r) => ({
      username: r.username,
      role: rolesByUser[r.username.toLowerCase()] ?? ("student" as RosterRole),
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
  // Confirmation is required for any team move (role change) or any org-owner
  // grant via an instructor enroll — both are actions the teacher must approve.
  const needsRoleConfirm =
    roleChanges.length > 0 || instructorEnrolls.length > 0
  const showInstructorOwnerNotice = useMemo(
    () =>
      hasInstructorPromotion(roleChanges) ||
      instructorEnrolls.length > 0 ||
      Object.values(rolesByUser).some((r) => r === "instructor"),
    [roleChanges, instructorEnrolls, rolesByUser],
  )
  // The primary action is blocked while the preflight is resolving/failed, or
  // while role changes / instructor enrolls await explicit confirmation.
  const canProcess =
    rows.length > 0 &&
    !preflighting &&
    !preflightError &&
    (!needsRoleConfirm || roleChangesConfirmed)

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
      // Seed the per-row role from the CSV role column (else student).
      setRolesByUser(
        Object.fromEntries(
          parsedRows.map((r) => [
            r.username.toLowerCase(),
            r.role ?? "student",
          ]),
        ),
      )
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
    // Re-entry guard: a synchronous double-click (before React re-renders the
    // button out of the preview phase) would otherwise fire two concurrent
    // imports racing the same roster.csv read-modify-write.
    if (phase === "importing") return
    setPhase("importing")
    setError(null)
    setResult(null)
    setInviteOutcome(null)
    setInviteError(null)
    setRoleChangeOutcome(null)
    setProgress({
      processed: 0,
      total: rows.length,
      message: t("students.startingImport"),
    })

    // 1) Write the roster.csv rows (identity + name/email/section) and team-add
    //    anyone already an active org member. A re-run where every uploaded row
    //    already exists throws NoNewStudentsError (nothing to commit) — that is
    //    benign here: we still run the invite pass below so a student whose
    //    first invite was rate-limited/failed gets re-invited. Any other enroll
    //    error is a genuine failure (nothing written) -> error screen.
    let importResult: BulkImportResult
    try {
      importResult = await bulkEnrollStudentsInClassroom(client, {
        org,
        classroom,
        rows,
        onProgress: setProgress,
      })
    } catch (err) {
      if (err instanceof NoNewStudentsError) {
        // All rows already in roster.csv — synthesize an empty result so the
        // completed view still renders, then fall through to the invite pass.
        importResult = { addedStudents: [], skippedStudents: [] }
      } else {
        log.error("roster import failed", { err, record: true })
        setError(
          err instanceof Error ? err.message : t("students.importFailed"),
        )
        setPhase("error")
        return
      }
    }
    setResult(importResult)

    // Snapshot the classification computed in the preview so the process pass
    // matches exactly what the teacher confirmed. (Recomputing here could drift
    // if membership changed between preview and process.)
    const plan = preflight

    // 2) The team is the source of truth for who shows on the roster, so send
    //    org invites for uploaded students who aren't already members — they
    //    then appear as a `pending` row. Invite the FULL uploaded set (not just
    //    the newly-added rows): inviteRosterStudents no-ops anyone already
    //    active/pending, so a re-run after a rate limit still re-invites a
    //    student whose first invite was deferred (their CSV row already exists,
    //    so they'd otherwise be skipped as a duplicate and, since CSV-only rows
    //    don't render, silently lost). Thread the github_id the enroll pass
    //    just resolved (from addedStudents, keyed by login) so the invite
    //    targets the immutable account rather than re-resolving a possibly
    //    recycled/renamed login. Their roster.csv row enriches the pending row;
    //    deferred/failed invites are surfaced in the result dialog.
    //
    //    SKIP the invite pass entirely when the preflight found every uploaded
    //    username is already an active org member — there's nothing to invite,
    //    so don't hammer the invite endpoint (requirement: skip invites when all
    //    are members).
    const idByLogin = new Map(
      importResult.addedStudents.map((s) => [
        s.username.toLowerCase(),
        s.github_id,
      ]),
    )
    if (!plan?.allAlreadyMembers) {
      setProgress({
        processed: 0,
        total: rows.length,
        message: t("students.invitingUploaded"),
      })
      try {
        const inviteRes = await inviteRosterStudents(client, {
          org,
          classroom,
          students: rows.map((r) => ({
            username: r.username,
            github_id: idByLogin.get(r.username.toLowerCase()) ?? "",
            role: rolesByUser[r.username.toLowerCase()] ?? "student",
          })),
          onProgress: setProgress,
        })
        setInviteOutcome({
          invited: inviteRes.invited,
          deferred: inviteRes.deferred,
          failed: inviteRes.failed.map((f) => ({
            username: f.username,
            message: f.message,
          })),
        })
      } catch (err) {
        // The roster.csv write already landed; a hard invite failure must not
        // hide it behind the bare error screen. Keep the completed view and show
        // the invite error there — the teacher can re-run to retry the invites.
        log.error("roster invite pass failed", { err, record: true })
        setInviteError(
          err instanceof Error ? err.message : t("students.importFailed"),
        )
      }
    }

    // 3) Persist the assigned role back to roster.csv for EVERY uploaded row,
    //    not just the freshly-invited ones. A row that was deferred (rate
    //    limit), skipped (already a member/pending), or failed still has a
    //    teacher-assigned role and a roster row from step 1 — omitting them
    //    would leave their role blank until a later sync. writeRosterRoles
    //    only touches existing rows whose role actually changed, so covering
    //    the full set is safe and idempotent. Best-effort: a writeback failure
    //    doesn't undo the invites (role converges on the next sync). A
    //    malformed roster.csv is surfaced distinctly so the teacher fixes it.
    const roleWriteback = rows
      .map((r) => ({
        username: r.username,
        role: rolesByUser[r.username.toLowerCase()] ?? "student",
      }))
      .filter((r) => r.username.trim())
    if (roleWriteback.length > 0) {
      try {
        await writeRosterRoles(client, {
          org,
          classroom,
          roles: roleWriteback,
        })
      } catch (err) {
        if (err instanceof RosterCsvMalformedError) {
          setInviteError(t("students.roleWritebackMalformed"))
        } else {
          // A transient/other writeback failure isn't fatal (the role converges
          // on the next sync), but the completed dialog would otherwise show a
          // bare success — surface a soft warning so the teacher knows the role
          // column didn't persist this run.
          setInviteError(t("students.roleWritebackFailed"))
        }
        log.warn("roster role writeback failed", { err, record: true })
      }
    }

    // 4) Apply the CONFIRMED team assignments the preflight identified:
    //    - role_change: an active member on a DIFFERENT classroom team -> move
    //      them (drop every non-target team; instructor target grants org owner,
    //      a demotion off instructor revokes it). Gated behind the confirmation
    //      checkbox in the preview.
    //    - enroll: an active member on NO classroom team -> an additive team-add
    //      onto the CSV role's team (empty fromRoles, so nothing is dropped).
    //    Both route through applyRosterRoleChange (re-verifies active membership,
    //    never team-adds a non-member). Best-effort per row: a failure is
    //    surfaced in the result dialog, not fatal (the roster write already
    //    landed).
    const moves: {
      username: string
      fromRoles: RosterRole[]
      toRole: RosterRole
    }[] = [
      ...(plan?.roleChanges ?? []).map((c) => ({
        username: c.username,
        fromRoles: c.currentRoles,
        toRole: c.role,
      })),
      ...(plan?.enroll ?? []).map((e) => ({
        username: e.username,
        fromRoles: [] as RosterRole[],
        toRole: e.role,
      })),
    ]
    if (moves.length > 0) {
      setProgress({
        processed: 0,
        total: moves.length,
        message: t("students.processRoleChanges"),
      })
      const changed: {
        username: string
        to: RosterRole
      }[] = []
      const failed: { username: string; message: string }[] = []
      let done = 0
      for (const move of moves) {
        try {
          const res = await applyRosterRoleChange(client, {
            org,
            classroom,
            username: move.username,
            github_id: idByLogin.get(move.username.toLowerCase()),
            fromRoles: move.fromRoles,
            toRole: move.toRole,
          })
          changed.push({ username: res.username, to: res.toRole })
          // A best-effort old-team removal failure is a warning, not a hard
          // failure — surface it alongside so the teacher can retry.
          for (const w of res.warnings) {
            failed.push({ username: move.username, message: w })
          }
        } catch (err) {
          log.error("roster role change failed", { err, record: true })
          failed.push({
            username: move.username,
            message: err instanceof Error ? err.message : String(err),
          })
        } finally {
          done += 1
          setProgress({
            processed: done,
            total: moves.length,
            message: t("students.processRoleChanges"),
          })
        }
      }
      setRoleChangeOutcome({ changed, failed })
    }

    setPhase("complete")
    onSuccess?.(importResult)
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
              <div className="mb-4 flex flex-col gap-2">
                {preflight.allAlreadyMembers ? (
                  <Alert tone="info">
                    <span>{t("students.preflightAllMembersNote")}</span>
                  </Alert>
                ) : preflight.needsInvite.length > 0 ? (
                  <Alert tone="warning">
                    <span>
                      {t("students.uploadInviteNotice", {
                        count: preflight.needsInvite.length,
                      })}
                    </span>
                  </Alert>
                ) : null}

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <PreflightBucket
                    tone="neutral"
                    title={t("students.preflightNoActionTitle")}
                    count={preflight.noAction.length}
                  />
                  <PreflightBucket
                    tone="warning"
                    title={t("students.preflightInviteTitle")}
                    count={preflight.needsInvite.length}
                  />
                  <PreflightBucket
                    tone="info"
                    title={t("students.preflightEnrollTitle")}
                    count={preflight.enroll.length}
                  />
                  <PreflightBucket
                    tone="error"
                    title={t("students.preflightRoleChangeTitle")}
                    count={preflight.roleChanges.length}
                  />
                </div>

                {/* Team moves and org-owner grants need explicit confirmation:
                    a role change is a destructive team move, and an instructor
                    target (role change OR enroll) grants org OWNER. List each
                    and gate the primary button on the checkbox. */}
                {needsRoleConfirm ? (
                  <div className="mt-1 flex flex-col gap-2 rounded-box border border-error/30 bg-error/5 p-4">
                    <h4 className="text-sm font-semibold">
                      {t("students.preflightConfirmTitle")}
                    </h4>
                    <ul className="flex flex-col gap-1 text-sm">
                      {roleChanges.map((c) => (
                        <li
                          key={`change-${c.username}`}
                          className="flex items-center justify-between gap-2"
                        >
                          <code>{c.username}</code>
                          <span className="opacity-70">
                            {t("students.preflightRoleChangeDetail", {
                              from: t(ROLE_LABEL_KEY[c.currentRole]),
                              to: t(ROLE_LABEL_KEY[c.role]),
                            })}
                          </span>
                        </li>
                      ))}
                      {instructorEnrolls.map((e) => (
                        <li
                          key={`enroll-${e.username}`}
                          className="flex items-center justify-between gap-2"
                        >
                          <code>{e.username}</code>
                          <span className="opacity-70">
                            {t("students.preflightEnrollOwnerDetail")}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {showInstructorOwnerNotice ? (
                      <Alert tone="warning">
                        <span>
                          {t("students.preflightRoleChangeOwnerNotice")}
                        </span>
                      </Alert>
                    ) : null}
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm mt-0.5"
                        checked={roleChangesConfirmed}
                        onChange={(e) =>
                          setRoleChangesConfirmed(e.currentTarget.checked)
                        }
                      />
                      <span>
                        {t("students.preflightConfirmRoleChanges", {
                          count: roleChanges.length + instructorEnrolls.length,
                        })}
                      </span>
                    </label>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Instructor-owner notice even before preflight resolves, whenever
                any row is assigned the instructor role. */}
            {!preflight && showInstructorOwnerNotice ? (
              <Alert tone="warning" className="mb-4">
                <span>{t("students.uploadInstructorOwnerNotice")}</span>
              </Alert>
            ) : null}

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
                      <th scope="col">{t("students.roleColumn")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const key = row.username.toLowerCase()
                      return (
                        <tr key={key}>
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
                          <td>
                            <Select
                              selectSize="xs"
                              className="w-32"
                              aria-label={t("students.assignRoleLabel")}
                              value={rolesByUser[key] ?? "student"}
                              onChange={(e) =>
                                setRolesByUser((prev) => ({
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
                              <option value="ta">{t("students.roleTa")}</option>
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
            ) : (
              <Alert tone="warning">{t("students.noValidUsernames")}</Alert>
            )}

            <div className="modal-action">
              <Button variant="ghost" onClick={reset}>
                {t("common.cancel")}
              </Button>

              <Button
                variant="primary"
                disabled={!canProcess}
                onClick={startImport}
              >
                {t("students.importAndInviteCount", { count: rows.length })}
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

            {inviteError && (
              <Alert tone="error">
                <span>
                  {t("students.invitePassFailed", { message: inviteError })}
                </span>
              </Alert>
            )}

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

            {inviteOutcome && inviteOutcome.invited.length > 0 && (
              <ImportResultSection
                title={t("students.resultInvited")}
                rows={inviteOutcome.invited.map(({ username, role }) => ({
                  key: username,
                  label: username,
                  detail: t(ROLE_LABEL_KEY[role]),
                }))}
              />
            )}

            {inviteOutcome && inviteOutcome.deferred.length > 0 && (
              <ImportResultSection
                title={t("students.resultInvitesDeferred")}
                rows={inviteOutcome.deferred.map((username) => ({
                  key: username,
                  label: username,
                  detail: t("students.inviteDeferredDetail"),
                }))}
              />
            )}

            {inviteOutcome && inviteOutcome.failed.length > 0 && (
              <ImportResultSection
                title={t("students.resultInvitesFailed")}
                rows={inviteOutcome.failed.map((f) => ({
                  key: f.username,
                  label: f.username,
                  detail: f.message,
                }))}
              />
            )}

            {roleChangeOutcome && roleChangeOutcome.changed.length > 0 && (
              <ImportResultSection
                title={t("students.resultRoleChanged")}
                rows={roleChangeOutcome.changed.map((c) => ({
                  key: c.username,
                  label: c.username,
                  detail: t(ROLE_LABEL_KEY[c.to]),
                }))}
              />
            )}

            {roleChangeOutcome && roleChangeOutcome.failed.length > 0 && (
              <ImportResultSection
                title={t("students.resultRoleChangeFailures")}
                rows={roleChangeOutcome.failed.map((f, i) => ({
                  key: `${f.username}-${i}`,
                  label: f.username,
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
