import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Upload } from "lucide-react"

import Papa from "papaparse"
import { bulkEnrollStudentsInClassroom } from "@/domain/students"
import type { GitHubClient } from "@/github-core/client"
import { Alert, Badge, Button, Modal, Select, Spinner } from "@/components/ui"
import {
  applyRosterRoleChange,
  bulkInviteByEmail,
  inviteRosterStudents,
  isLikelyGithubUsername,
  NoNewStudentsError,
  normalizeGithubUsername,
  resolveRosterUploadPreflight,
  RosterCsvMalformedError,
  splitName,
  writeRosterRoles,
  type BulkImportResult,
  type BulkInviteByEmailResult,
  type ImportRosterRow,
} from "@/domain/students"
import {
  hasInstructorPromotion,
  type PreflightResult,
} from "@/util/rosterUploadPreflight"
import { ROLE_LABEL_KEY } from "@/util/rosterRoles"
import { logger } from "@/lib/logger"
import type { RosterRole } from "@/util/teamRoster"
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
  OPTIONAL_IMPORT_HEADERS,
  RECOGNIZED_IMPORT_HEADERS,
  type OptionalImportHeader,
} from "@/pages/students/rosterImportHeaders"

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
      // Read the optional columns generically from the shared header list so
      // the parser can't drift from what the diagnostic advertises. Two columns
      // get special handling on top of the generic read: `name` is an alias
      // that fills first/last when those split columns are ABSENT (not merely
      // empty), and `role` is coerced through the known-role guard.
      const cell = (header: OptionalImportHeader): string =>
        (raw[header] ?? "").trim()
      const fromName = splitName(raw.name ?? null)
      push({
        username: raw.username ?? "",
        first_name: (raw.first_name ?? fromName.first_name).trim(),
        last_name: (raw.last_name ?? fromName.last_name).trim(),
        email: cell("email"),
        section: cell("section"),
        role: coerceImportRole(cell("role")),
      })
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      push({ username: line })
    }
  }

  return rows
}

// Why an uploaded file yielded no importable rows, when the cause is the file's
// SHAPE rather than just invalid handles. `null` means "no structural problem" —
// either a valid header file or a bare one-username-per-line list, both of which
// the parser handles; an empty result there is genuinely "no valid usernames".
//   - missing-username-header: the file has a header row (a delimiter or a
//     recognized column name) but no `username` column, so the required field
//     can't be mapped. We surface the required + optional columns instead of
//     silently falling back to treating each line as a username.
//   - malformed: Papa reported a structural parse error (ragged rows, unclosed
//     quote, ...), so the columns can't be trusted.
export type ImportHeaderIssue =
  | { kind: "missing-username-header"; present: string[]; optional: string[] }
  | { kind: "malformed"; detail: string }

// Inspect an uploaded file's structure to explain an empty/mis-parsed import.
// Pure and side-effect-free so it's unit-testable and can run alongside
// parseRosterImportFile without re-reading the file. Deliberately does NOT flag
// a bare one-username-per-line list (the supported headerless format): that is
// only "a header row missing username" when the first line looks like headers.
export const detectImportHeaderIssue = (
  text: string,
): ImportHeaderIssue | null => {
  const trimmed = text.trim()
  if (!trimmed) return null

  const parsed = Papa.parse<Record<string, string>>(trimmed, {
    header: true,
    delimiter: "",
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim().toLowerCase(),
  })

  // Papa emits a benign "Delimiter" warning for single-column input (a bare
  // username list) — that's not a structural defect, so ignore it. Only genuine
  // structural errors (ragged rows, unclosed quotes) mean "malformed".
  const structuralError = parsed.errors.find((e) => e.type !== "Delimiter")
  if (structuralError) {
    return { kind: "malformed", detail: structuralError.message }
  }

  const fields = (parsed.meta.fields ?? []).map((f) => f.trim()).filter(Boolean)
  if (fields.includes("username")) return null

  // A header row is one with >1 column (a delimiter was found) or a single
  // recognized column name. A lone unrecognized token is a bare username list,
  // not a mis-headered CSV — leave it to the one-per-line fallback.
  const looksLikeHeaderRow =
    fields.length > 1 ||
    fields.some((f) =>
      (RECOGNIZED_IMPORT_HEADERS as readonly string[]).includes(f),
    )
  if (!looksLikeHeaderRow) return null

  return {
    kind: "missing-username-header",
    present: fields,
    optional: [...OPTIONAL_IMPORT_HEADERS],
  }
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
      <Badge>{count}</Badge>
    </div>
  )
}

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
  const [emailRoles, setEmailRoles] = useState<Record<string, RosterRole>>({})
  const [emailOwnerConfirmed, setEmailOwnerConfirmed] = useState(false)
  const [emailResult, setEmailResult] =
    useState<BulkInviteByEmailResult | null>(null)
  // Why an empty parse produced no rows, when the cause is the file's shape (no
  // `username` header, or malformed CSV) rather than merely invalid handles.
  // Lets the preview explain the required columns instead of a generic "no
  // valid usernames". Null when the file shape is fine.
  const [headerIssue, setHeaderIssue] = useState<ImportHeaderIssue | null>(null)
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

  // Visibility is owned by the controlling parent via `open` (the roster page
  // always passes it). Fall back to phase-driven only if used uncontrolled.
  const isOpen = open ?? phase !== "idle"

  // A stale-response token for the async file ingest (see ingestFile). Bumped
  // here so a reset/close cancels an in-flight file.text() read before its
  // writes can land on a cleared modal.
  const ingestToken = useRef(0)

  // Clear the file/preview state and return to the drop-zone (idle) screen —
  // WITHOUT closing the modal. Used when the user cancels/dismisses the preview:
  // they land back on the drop zone to pick a different file, and there's no
  // close-then-reopen flash.
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

  // The X / backdrop / Esc always dismiss the whole modal, from any screen —
  // that's what a close affordance means. Stepping back to the drop zone is a
  // distinct, explicit action (the preview's "Cancel" button), not what the X
  // does. State is cleared by the open->false effect, so there's no flash.
  const handleClose = () => {
    onOpenChange?.(false)
  }

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
  // The listed confirmation items (role changes + instructor enrolls) grant org
  // OWNER only when one of THOSE targets instructor — not merely because some
  // other row in the file is an instructor. Keeps the in-box owner warning
  // matched to the change it sits next to (a Student -> TA move must not claim
  // it grants owner).
  const confirmGrantsOwner = useMemo(
    () => hasInstructorPromotion(roleChanges) || instructorEnrolls.length > 0,
    [roleChanges, instructorEnrolls],
  )
  // The broad "any row is assigned instructor" signal — used only for the
  // general pre-preflight notice above the table (a fresh instructor invite also
  // grants owner, and that row isn't in the confirm box).
  const anyInstructorAssigned = useMemo(
    () =>
      confirmGrantsOwner ||
      Object.values(rolesByUser).some((r) => r === "instructor"),
    [confirmGrantsOwner, rolesByUser],
  )
  // The primary action is blocked while the preflight is resolving/failed, or
  // while role changes / instructor enrolls await explicit confirmation.
  const emailHasInstructor = emails.some(
    (e) => (emailRoles[e.toLowerCase()] ?? "student") === "instructor",
  )
  // Once the preflight resolves, "process" is only meaningful when it will do
  // something (send an invite, enroll onto a team, or change a role). An upload
  // where every row is already correctly enrolled is all no-action, so the
  // primary button is disabled — there's nothing to confirm.
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

  // The roster primary-button label reflects what processing will actually do:
  //   - some rows need an org invite -> "Import & invite N members"
  //   - everyone's already a member (no invites) -> a generic "Confirm changes",
  //     since the recap already spells out the team moves being confirmed
  //   - preflight not resolved yet -> a neutral "Import N members"
  // "members" (not "students") because a batch can assign TA/instructor too.
  const willSendInvites = (preflight?.needsInvite.length ?? 0) > 0
  const rosterPrimaryLabel = willSendInvites
    ? t("students.importAndInviteMembers", { count: rows.length })
    : preflight
      ? hasActionableWork
        ? t("students.confirmChanges")
        : t("students.noChangesToApply")
      : t("students.importMembers", { count: rows.length })

  // Seed the preview state for a given kind from the raw text. Used both on
  // initial ingest (with the auto-detected kind) and when the teacher overrides
  // the detected kind in the preview — re-parsing the same text, no re-read.
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
      // Clear roster-side state so a switch back and forth can't leave stale rows.
      setRows([])
      setHeaderIssue(null)
    } else {
      const parsedRows = parseRosterImportFile(text)
      setRows(parsedRows)
      // Only diagnose the file shape when nothing parsed — a non-empty result
      // means the header path worked, so the (rare) header issue is moot.
      setHeaderIssue(
        parsedRows.length === 0 ? detectImportHeaderIssue(text) : null,
      )
      // Seed the per-row role from the CSV role column (else student).
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

  // Read + classify a chosen/dropped file, seed the auto-detected kind, and show
  // the preview (where the teacher can override the kind before processing).
  // A stale-response token guards the post-await writes (mirroring
  // preflightToken): a close (resetToDropZone via the open->false effect) or a
  // second file dropped while file.text() is in flight bumps the token, so the
  // superseded read bails instead of re-populating a closed/replaced modal.
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
    if (!file) {
      return
    }
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
    // Re-entry guard: a synchronous double-click (before React re-renders the
    // button out of the preview phase) would otherwise fire two concurrent
    // imports racing the same roster.csv read-modify-write.
    if (phase === "importing") return

    // Email-list branch: send org invitations by email (no roster.csv write),
    // then land on the same result screen. Kept before the roster pass so the
    // two flows never both run.
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
            {/* Detected format + override, rendered once above the branch
                split: the file was auto-classified; the teacher can switch if
                the guess is wrong before processing. The roster-CSV / username
                body renders in the block below (it carries the preflight). */}
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
                    {confirmGrantsOwner ? (
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
            {!preflight && anyInstructorAssigned ? (
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
                              onChange={(e) => {
                                // Read the value synchronously — React nulls the
                                // event's currentTarget after the handler
                                // returns, so a deferred setState updater must
                                // not touch `e`.
                                const role =
                                  coerceImportRole(e.target.value) ?? "student"
                                setRolesByUser((prev) => ({
                                  ...prev,
                                  [key]: role,
                                }))
                              }}
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
              <Button variant="primary" onClick={handleClose}>
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
