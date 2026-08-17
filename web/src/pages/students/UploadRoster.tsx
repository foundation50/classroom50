import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Upload } from "lucide-react"

import {
  resolveRosterUploadContext,
  bulkInviteByEmail,
} from "@/domain/students"
import type {
  BulkImportResult,
  BulkInviteByEmailResult,
  ImportRosterRow,
  RosterUploadContext,
} from "@/domain/students"
import type { GitHubClient } from "@/github-core/client"
import { Alert, Button, Modal } from "@/components/ui"
import {
  classifyRosterUpload,
  hasTeacherPromotion,
  type PreflightResult,
} from "@/util/rosterUploadPreflight"
import { logger } from "@/lib/logger"
import { isTeacherRole } from "@/authz"
import type { ClassroomRole } from "@/util/teamRoster"
import {
  DEFAULT_UPLOAD_KIND,
  type UploadKind,
} from "@/pages/students/uploadClassify"
import {
  parseEmailInviteFile,
  type InvalidEmailLine,
} from "@/pages/students/emailInvite"
import {
  DetectedFormatSelect,
  EmailInvitePreview,
  EmailInviteResult,
} from "@/pages/students/EmailInviteFlow"
import {
  identityKey,
  isAccountRow,
  isEmailRow,
  loginIdentityKey,
  resolveImportIdentities,
  type ImportIdentity,
  type ResolvedImportRow,
  type UnusableRow,
} from "@/pages/students/rosterImportResolve"
import {
  coerceImportRole,
  detectImportHeaderIssue,
  parseRosterImportFile,
  type DroppedRow,
  type ImportHeaderIssue,
  type ParsedImportRow,
} from "./rosterImportParse"
import { runRosterImport, type ImportProgress } from "./runRosterImport"
import type { InviteOutcome, RoleChangeOutcome } from "./runRosterImport"
import { PreflightRecap } from "./PreflightRecap"
import { PreflightSummary } from "./PreflightSummary"
import {
  RosterPreviewTable,
  type RowChanges,
  type RowIdentityChanges,
  type RowRoleChanges,
} from "./RosterPreviewTable"
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

// The unusable-row reasons that get their own alert, with the copy each uses. An
// unresolvable id is the teacher's file to fix; a lookup we couldn't complete is
// a retry. `no-identity` is absent deliberately — the parser's `dropped` count
// already reports those rows.
const ROW_ISSUE_KEYS = [
  ["unresolved-id", "students.unresolvedIdRows"],
  ["id-lookup-failed", "students.idLookupFailedRows"],
] as const satisfies readonly (readonly [UnusableRow["reason"], string])[]

type UploadRosterProps = {
  org: string
  classroom: string
  client: GitHubClient
  onSuccess?: (result: BulkImportResult) => void
  // Fired after any batch that sent email invitations — the dedicated
  // "Email addresses" upload, or a roster CSV carrying email-identity rows. Each
  // invited address lands a pending roster.csv row, so the parent refreshes the
  // pending-invite and team caches; for a mixed batch onSuccess fires too.
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
  // The raw uploaded text, kept so switching the format re-parses without
  // re-reading the file, and the format the parse is read under. Roster CSV is
  // always the initial one — its parser handles all three shapes — so the other
  // two exist only as the teacher's explicit override.
  const [fileText, setFileText] = useState("")
  const [uploadKind, setUploadKind] = useState<UploadKind>(DEFAULT_UPLOAD_KIND)
  // Rows as parsed, before identity resolution, plus the lines the parse could
  // not address to anyone. `parseId` increments on every parse so the resolution
  // effect below re-runs even when a re-parse yields identical identity cells.
  const [parsedRows, setParsedRows] = useState<ParsedImportRow[]>([])
  const [droppedRows, setDroppedRows] = useState<DroppedRow[]>([])
  const [parseId, setParseId] = useState(0)
  // Rows with a resolved identity (account or email), and the ones a github_id
  // made unusable. Null until resolution runs.
  const [resolved, setResolved] = useState<ResolvedImportRow[] | null>(null)
  const [unusableRows, setUnusableRows] = useState<UnusableRow[]>([])
  // Email-invite branch (uploadKind === "email-list"): parsed addresses, the
  // per-address role, the org-owner confirmation, and the send result. Kept
  // separate from the roster rows so the two flows don't entangle.
  const [emails, setEmails] = useState<string[]>([])
  // Non-empty lines in an email-list upload that aren't valid addresses, with
  // their file line numbers, so the preview can flag exactly which rows to fix
  // (empty lines are skipped silently). Valid emails still import.
  const [invalidEmails, setInvalidEmails] = useState<InvalidEmailLine[]>([])
  const [emailRoles, setEmailRoles] = useState<Record<string, ClassroomRole>>(
    {},
  )
  const [emailOwnerConfirmed, setEmailOwnerConfirmed] = useState(false)
  const [emailResult, setEmailResult] =
    useState<BulkInviteByEmailResult | null>(null)
  const [emailError, setEmailError] = useState<string | null>(null)
  // Why an empty parse produced no rows, when the cause is the file's shape (no
  // identity column, or malformed CSV) rather than merely unusable values.
  const [headerIssue, setHeaderIssue] = useState<ImportHeaderIssue | null>(null)
  // Per-row role the teacher is about to invite as, keyed by identityKey. Seeded
  // from the CSV `role` column (else "student") and editable.
  const [rolesByUser, setRolesByUser] = useState<Record<string, ClassroomRole>>(
    {},
  )
  // The role-independent GitHub membership + stored-roster read, fetched ONCE
  // per uploaded file and tagged with the parseId it was fetched for. Null
  // until the read resolves.
  const [preflightContext, setPreflightContext] = useState<
    (RosterUploadContext & { parseId: number }) | null
  >(null)
  const [preflighting, setPreflighting] = useState(false)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  // The teacher's explicit confirmation of the role-change (team-move) rows.
  const [roleChangesConfirmed, setRoleChangesConfirmed] = useState(false)
  // The teacher's explicit confirmation of the metadata-update rows (independent
  // of the role-change confirmation, so either or both can be pending).
  const [metadataConfirmed, setMetadataConfirmed] = useState(false)
  // The teacher's explicit confirmation that a row whose github_id disagrees
  // with its username cell should be imported under the id's account.
  const [mismatchConfirmed, setMismatchConfirmed] = useState(false)
  // Whether the detailed per-row preview table is expanded. Collapsed by default
  // so the summary reads cleanly; auto-opened when a confirmation is required so
  // the highlighted changes are visible.
  const [detailsOpen, setDetailsOpen] = useState(false)
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
    setUploadKind(DEFAULT_UPLOAD_KIND)
    setParsedRows([])
    setDroppedRows([])
    setResolved(null)
    setUnusableRows([])
    setHeaderIssue(null)
    setEmails([])
    setInvalidEmails([])
    setEmailRoles({})
    setEmailOwnerConfirmed(false)
    setEmailResult(null)
    setEmailError(null)
    setProgress({ processed: 0, total: 0, message: "" })
    setResult(null)
    setInviteOutcome(null)
    setInviteError(null)
    setError(null)
    setRolesByUser({})
    setPreflightContext(null)
    setPreflighting(false)
    setPreflightError(null)
    setRoleChangesConfirmed(false)
    setMetadataConfirmed(false)
    setMismatchConfirmed(false)
    setDetailsOpen(false)
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

  // Resolve identities and read the role-independent membership + stored-roster
  // context ONCE per parse. A stale-response guard drops a slow read superseded
  // by a new file. Both are tagged with the parse they ran for so the derived
  // classification below can reject leftovers from a prior file (this effect runs
  // post-commit, after the new rows are already set).
  //
  // Identity resolution has to happen here rather than in the parser: trading a
  // github_id for its current login is a network read, and the local org-member
  // map that usually satisfies it comes from this very context.
  //
  // Keyed on parseId, not on the rows' content: a re-parse that yields the same
  // identity cells (switching format on a headed CSV, or re-uploading a file that
  // only corrected a name) still has to re-resolve, or the cleared rows would
  // never come back and the preview would sit empty with the button disabled.
  const preflightToken = useRef(0)
  useEffect(() => {
    if (phase !== "preview" || parsedRows.length === 0) return
    const token = ++preflightToken.current
    const fetchedFor = parseId
    /* eslint-disable react-hooks/set-state-in-effect */
    setPreflighting(true)
    setPreflightError(null)
    setPreflightContext(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    void resolveRosterUploadContext(client, { org, classroom })
      .then(async (context) => {
        if (preflightToken.current !== token) return
        const resolvedFile = await resolveImportIdentities(
          client,
          parsedRows,
          context.loginById,
        )
        if (preflightToken.current !== token) return
        setResolved(resolvedFile.rows)
        setUnusableRows(resolvedFile.unusable)
        setRolesByUser((prev) =>
          Object.fromEntries(
            resolvedFile.rows.map((r) => {
              const key = identityKey(r.identity)
              return [key, prev[key] ?? r.role ?? "student"]
            }),
          ),
        )
        setPreflightContext({ parseId: fetchedFor, ...context })
      })
      .catch((err) => {
        if (preflightToken.current !== token) return
        log.warn("roster upload preflight failed", { err, record: true })
        setPreflightContext(null)
        setResolved(null)
        setPreflightError(
          err instanceof Error ? err.message : t("students.somethingWentWrong"),
        )
      })
      .finally(() => {
        if (preflightToken.current === token) setPreflighting(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, parseId, org, classroom])

  // The resolved rows split by identity kind. Account rows drive the preflight
  // classification (which is username-keyed by design); email rows never enter it
  // — they have no GitHub account to classify against — so every gate and label
  // below has to count them separately.
  const resolvedRows = useMemo(() => resolved ?? [], [resolved])
  const accountRows = useMemo(
    () => resolvedRows.filter(isAccountRow),
    [resolvedRows],
  )
  const emailRows = useMemo(
    () => resolvedRows.filter(isEmailRow),
    [resolvedRows],
  )
  // The role the teacher assigned a row, defaulting to student.
  const roleFor = (identity: ImportIdentity): ClassroomRole =>
    rolesByUser[identityKey(identity)] ?? "student"

  // Derive the classification synchronously from the fetched context + current
  // roles, so a role edit re-previews with no loading state. Only trust a
  // context fetched for the CURRENT parse — a stale context from a just-replaced
  // file must not classify the new rows (the fetch effect that nulls it runs
  // after this render).
  const preflight = useMemo<PreflightResult | null>(() => {
    if (!preflightContext || preflightContext.parseId !== parseId) return null
    const preflightRows = accountRows.map((r) => ({
      username: r.identity.username,
      github_id: r.identity.github_id,
      declaredUsername: r.identity.declaredUsername,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      section: r.section,
      role:
        rolesByUser[identityKey(r.identity)] ?? ("student" as ClassroomRole),
    }))
    return classifyRosterUpload(
      preflightRows,
      preflightContext.lookup,
      preflightContext.storedByIdentity,
    )
  }, [preflightContext, parseId, accountRows, rolesByUser])

  // A role edit changes the plan (a team move / owner grant may appear or
  // vanish), so any prior confirmation is stale — clear the checkboxes when the
  // assigned roles change.
  const rolesKey = resolvedRows
    .map((r) => {
      const key = identityKey(r.identity)
      return `${key}:${rolesByUser[key] ?? "student"}`
    })
    .join("|")
  useEffect(() => {
    setRoleChangesConfirmed(false)
    setMetadataConfirmed(false)
    setMismatchConfirmed(false)
  }, [rolesKey])

  const roleChanges = useMemo(() => preflight?.roleChanges ?? [], [preflight])

  // The preflight is keyed by username; the table is keyed by identity. Build all
  // three highlight maps in one pass so the bridging lookup lives inside the memo
  // (an honest dep array, no eslint suppression) and can't drift between them.
  const { rowChanges, roleChangeByUser, identityChangeByUser } = useMemo(() => {
    const rowKeyByUsername: Record<string, string> = {}
    for (const r of accountRows) {
      rowKeyByUsername[r.identity.username.toLowerCase()] = identityKey(
        r.identity,
      )
    }
    const rowKeyFor = (username: string) =>
      rowKeyByUsername[username.toLowerCase()] ?? loginIdentityKey(username)

    // metadata_update, role_change, and enroll all carry the same `changes` field;
    // the table shows each stored -> CSV transition inline.
    const changes: RowChanges = {}
    for (const o of [
      ...(preflight?.metadataUpdate ?? []),
      ...(preflight?.roleChanges ?? []),
      ...(preflight?.enroll ?? []),
    ]) {
      if (o.changes.length > 0) changes[rowKeyFor(o.username)] = o.changes
    }
    // A role change lives in the Role column's Select and an identity mismatch in
    // the username cell, so neither can ride in the metadata map.
    const roles: RowRoleChanges = {}
    for (const c of preflight?.roleChanges ?? []) {
      roles[rowKeyFor(c.username)] = { from: c.currentRole, to: c.role }
    }
    const identities: RowIdentityChanges = {}
    for (const m of preflight?.identityMismatches ?? []) {
      identities[rowKeyFor(m.username)] = {
        declaredUsername: m.declaredUsername,
      }
    }
    return {
      rowChanges: changes,
      roleChangeByUser: roles,
      identityChangeByUser: identities,
    }
  }, [preflight, accountRows])
  // Enroll rows targeting teacher grant org OWNER on process, so — like a
  // confirmed role change — they must sit behind the confirmation checkbox.
  const teacherEnrolls = useMemo(
    () => (preflight?.enroll ?? []).filter((e) => isTeacherRole(e.role)),
    [preflight],
  )
  // Invited rows targeting teacher grant org OWNER too, on acceptance. They are
  // not team moves, so the preflight puts them in `needsInvite` rather than
  // `enroll` — but the grant is identical, so they belong in the same gate.
  const teacherInvites = useMemo(
    () => (preflight?.needsInvite ?? []).filter((i) => isTeacherRole(i.role)),
    [preflight],
  )
  // Email rows assigned teacher are an org-OWNER grant too: accepting an admin
  // invitation makes that person an owner. They never reach the preflight, so
  // fold them into the same gate rather than letting a roster CSV do silently
  // what the dedicated email upload requires a checkbox for.
  const teacherEmailRows = useMemo(
    () => emailRows.filter((r) => isTeacherRole(roleFor(r.identity))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [emailRows, rolesByUser],
  )
  const mismatches = useMemo(
    () => preflight?.identityMismatches ?? [],
    [preflight],
  )
  const needsMismatchConfirm = mismatches.length > 0
  // Every path that hands someone org ownership goes through one checkbox.
  const ownerGrantCount =
    teacherEnrolls.length + teacherInvites.length + teacherEmailRows.length
  const needsRoleConfirm = roleChanges.length > 0 || ownerGrantCount > 0
  const confirmGrantsOwner = useMemo(
    () => hasTeacherPromotion(roleChanges) || ownerGrantCount > 0,
    [roleChanges, ownerGrantCount],
  )
  // Any teacher assignment is an org-OWNER grant on acceptance. Read from the
  // PARSED rows as well as the resolved ones: roles only land in `rolesByUser`
  // once identities resolve, and by then `preflight` is set, so a check on
  // `rolesByUser` alone could never fire while the notice below is visible.
  const anyTeacherAssigned = useMemo(
    () =>
      parsedRows.some((r) => r.role && isTeacherRole(r.role)) ||
      Object.values(rolesByUser).some(isTeacherRole),
    [parsedRows, rolesByUser],
  )
  const emailHasTeacher = emails.some((e) =>
    isTeacherRole(emailRoles[e.toLowerCase()] ?? "student"),
  )
  // Email-identity rows are actionable work in their own right: each one sends an
  // org invitation and lands a pending roster row. So is a confirmed identity
  // mismatch — it repairs the stored username. Counting only the preflight
  // buckets would leave either kind of file on a disabled "No changes to apply".
  const emailRowCount = emailRows.length
  const hasActionableWork =
    (preflight?.needsInvite.length ?? 0) +
      (preflight?.enroll.length ?? 0) +
      (preflight?.roleChanges.length ?? 0) +
      (preflight?.metadataUpdate.length ?? 0) +
      emailRowCount +
      mismatches.length >
    0
  const needsMetadataConfirm = (preflight?.metadataUpdate.length ?? 0) > 0
  const anyIdResolved = accountRows.some((r) => r.identity.resolvedFromId)
  const unusableCounts = useMemo(() => {
    const counts: Partial<Record<UnusableRow["reason"], number>> = {}
    for (const r of unusableRows) counts[r.reason] = (counts[r.reason] ?? 0) + 1
    return counts
  }, [unusableRows])
  // The table is forced open when a confirmation is pending (so the highlighted
  // role/detail changes are visible to confirm), when any row's identity came
  // from a github_id (the teacher can't eyeball a numeric id, so the resolved
  // login must be visible first), or when the preflight found NO actionable
  // changes — so the teacher still sees the whole parsed CSV and can confirm it
  // was read correctly. One expression, because the summary's toggle is exactly
  // its negation and hand-syncing the two lists is how a term gets missed.
  const forceDetails =
    needsRoleConfirm ||
    needsMetadataConfirm ||
    needsMismatchConfirm ||
    anyIdResolved ||
    (!!preflight && !hasActionableWork)
  const showDetails = detailsOpen || forceDetails
  const canProcess =
    uploadKind === "email-list"
      ? emails.length > 0 &&
        invalidEmails.length === 0 &&
        (!emailHasTeacher || emailOwnerConfirmed)
      : resolvedRows.length > 0 &&
        !preflighting &&
        !preflightError &&
        (!preflight || hasActionableWork) &&
        (!needsRoleConfirm || roleChangesConfirmed) &&
        (!needsMetadataConfirm || metadataConfirmed) &&
        (!needsMismatchConfirm || mismatchConfirmed)

  // The roster primary-button label reflects what processing will actually do.
  // An email row always sends an invitation, so it counts toward "will invite".
  const willSendInvites =
    (preflight?.needsInvite.length ?? 0) + emailRowCount > 0
  // Metadata-only: no invites, no enrolls, no role changes — just metadata.
  const metadataOnly =
    (preflight?.enroll.length ?? 0) === 0 &&
    (preflight?.roleChanges.length ?? 0) === 0 &&
    (preflight?.metadataUpdate.length ?? 0) > 0
  const rosterPrimaryLabel = (() => {
    if (willSendInvites)
      return t("students.importAndInviteMembers", {
        count: resolvedRows.length,
      })
    if (!preflight)
      return t("students.importMembers", { count: resolvedRows.length })
    if (metadataOnly)
      return t("students.updateMetadata", {
        count: preflight.metadataUpdate.length,
      })
    return hasActionableWork
      ? t("students.confirmChanges")
      : t("students.noChangesToApply")
  })()

  // Seed the preview state for a given format from the raw text. Used both on
  // initial ingest and when the teacher overrides the format.
  const applyKind = (text: string, kind: UploadKind) => {
    setUploadKind(kind)
    // A new file (or a re-parse under a different format) is a fresh plan, so any
    // confirmation the teacher ticked for the PREVIOUS content is stale — even
    // when the new file shares the same identities/roles (only metadata changed),
    // which the rolesKey reset effect wouldn't catch. Re-arm the gates here so a
    // changed plan can never be processed against an old confirmation.
    setRoleChangesConfirmed(false)
    setMetadataConfirmed(false)
    setMismatchConfirmed(false)
    setParseId((n) => n + 1)
    if (kind === "email-list") {
      const parsed = parseEmailInviteFile(text)
      setEmails(parsed.valid.map((r) => r.email))
      setInvalidEmails(parsed.invalid)
      setEmailRoles(
        Object.fromEntries(
          parsed.valid.map((r) => [r.email.toLowerCase(), "student"]),
        ),
      )
      setEmailOwnerConfirmed(false)
      setParsedRows([])
      setDroppedRows([])
      setResolved(null)
      setUnusableRows([])
      setHeaderIssue(null)
    } else {
      const parsed = parseRosterImportFile(text, kind)
      setParsedRows(parsed.rows)
      setDroppedRows(parsed.dropped)
      setResolved(null)
      setUnusableRows([])
      setHeaderIssue(
        parsed.rows.length === 0 ? detectImportHeaderIssue(text) : null,
      )
      setRolesByUser({})
      setEmails([])
      setInvalidEmails([])
    }
  }

  const ingestFile = async (file: File) => {
    const token = ++ingestToken.current
    try {
      const text = await file.text()
      if (ingestToken.current !== token) return
      setFileName(file.name)
      setFileText(text)
      applyKind(text, DEFAULT_UPLOAD_KIND)
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

    // Email-list branch: the teacher asserted every line is an address, so send
    // org invitations directly. Each one lands a pending roster row.
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
    setEmailResult(null)
    setEmailError(null)
    setRoleChangeOutcome(null)

    // Account rows go to the domain's username-keyed row shape; email rows carry
    // their own metadata to the invite pass. Both run inside runRosterImport,
    // sequentially, because every step commits to the same roster.csv.
    const accountImportRows: ImportRosterRow[] = accountRows.map((r) => ({
      username: r.identity.username,
      github_id: r.identity.github_id,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      section: r.section,
      role: roleFor(r.identity),
    }))
    const emailInvites = emailRows.map((r) => ({
      email: r.identity.email,
      role: roleFor(r.identity),
      first_name: r.first_name,
      last_name: r.last_name,
      section: r.section,
    }))

    const outcome = await runRosterImport(client, {
      org,
      classroom,
      rows: accountImportRows,
      emailInvites,
      // Snapshot the classification computed in the preview so the process pass
      // matches exactly what the teacher confirmed. It also carries the identity
      // mismatches the teacher just confirmed, which drive the username repair.
      plan: preflight,
      onProgress: setProgress,
      messages: {
        startingImport: t("students.startingImport"),
        invitingUploaded: t("students.invitingUploaded"),
        processRoleChanges: t("students.processRoleChanges"),
        importFailed: t("students.importFailed"),
        roleWritebackMalformed: t("students.roleWritebackMalformed"),
        roleWritebackFailed: t("students.roleWritebackFailed"),
        metadataWritebackMalformed: t("students.metadataWritebackMalformed"),
        metadataWritebackFailed: t("students.metadataWritebackFailed"),
        invitingEmails: t("students.invitingEmails"),
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
    setEmailResult(outcome.emailResult)
    setEmailError(outcome.emailError)
    setPhase("complete")
    onSuccess?.(outcome.importResult)
    // A mixed batch touches both caches, so both callbacks fire.
    if (outcome.emailResult) onEmailSuccess?.(outcome.emailResult)
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
        size="5xl"
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
            {/* How the file is being read, with an override, above the branch
                split. Roster CSV is always the initial choice. */}
            <DetectedFormatSelect
              value={uploadKind}
              onChange={(kind) => applyKind(fileText, kind)}
            />

            {uploadKind === "email-list" ? (
              <EmailInvitePreview
                emails={emails}
                invalidEmails={invalidEmails}
                emailRoles={emailRoles}
                emailOwnerConfirmed={emailOwnerConfirmed}
                emailHasTeacher={emailHasTeacher}
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
            {/* Preflight against current GitHub membership: what processing will
                do to each row. While it resolves, the summary/recap are withheld
                and the table below shows a skeleton; a hard failure surfaces an
                error and gates the primary button. */}
            {preflightError ? (
              <Alert tone="error" className="mb-4">
                <span>
                  {t("students.preflightFailed", { message: preflightError })}
                </span>
              </Alert>
            ) : preflight ? (
              <>
                {/* At-a-glance summary of add / update / skip, with an invite
                    note when memberships will be created, and a details toggle.
                    Email rows always send an invitation, so they count here. */}
                {preflight.needsInvite.length + emailRowCount > 0 ? (
                  <Alert tone="warning" className="mb-4">
                    <span>
                      {t("students.uploadInviteNotice", {
                        count: preflight.needsInvite.length + emailRowCount,
                      })}
                    </span>
                  </Alert>
                ) : null}
                <PreflightSummary
                  preflight={preflight}
                  emailInviteCount={emailRowCount}
                  detailsOpen={detailsOpen}
                  onToggleDetails={() => setDetailsOpen((v) => !v)}
                  canToggle={!forceDetails}
                />
                <PreflightRecap
                  roleChanges={roleChanges}
                  teacherEnrolls={teacherEnrolls}
                  teacherEmailCount={
                    teacherInvites.length + teacherEmailRows.length
                  }
                  needsRoleConfirm={needsRoleConfirm}
                  confirmGrantsOwner={confirmGrantsOwner}
                  roleChangesConfirmed={roleChangesConfirmed}
                  onRoleChangesConfirmedChange={setRoleChangesConfirmed}
                  needsMetadataConfirm={needsMetadataConfirm}
                  metadataUpdateCount={preflight.metadataUpdate.length}
                  metadataConfirmed={metadataConfirmed}
                  onMetadataConfirmedChange={setMetadataConfirmed}
                  identityMismatches={mismatches}
                  mismatchConfirmed={mismatchConfirmed}
                  onMismatchConfirmedChange={setMismatchConfirmed}
                />
              </>
            ) : null}

            {/* Teacher-owner notice even before preflight resolves, whenever
                any row is assigned the teacher role. */}
            {!preflight && anyTeacherAssigned ? (
              <Alert tone="warning" className="mb-4">
                <span>{t("students.uploadTeacherOwnerNotice")}</span>
              </Alert>
            ) : null}

            {/* Rows we refuse to act on. An unresolvable github_id fails closed
                rather than falling back to the row's username cell, which would
                target whoever holds that login today. `no-identity` isn't listed
                here — the parser's `dropped` count already covers those. */}
            {ROW_ISSUE_KEYS.map(([reason, key]) =>
              (unusableCounts[reason] ?? 0) > 0 ? (
                <Alert key={reason} tone="warning" className="mb-4">
                  <span>{t(key, { count: unusableCounts[reason] })}</span>
                </Alert>
              ) : null,
            )}
            {droppedRows.length > 0 ? (
              <Alert tone="warning" className="mb-4">
                <span>
                  {t("students.droppedRows", { count: droppedRows.length })}
                </span>
              </Alert>
            ) : null}

            {parsedRows.length > 0 ? (
              // While identities resolve, show the table as a skeleton (loading).
              // Before the preflight has ever resolved, show it so roles can be
              // assigned; after it resolves, show it only when expanded or a
              // confirmation needs the highlighted changes visible.
              preflighting || !preflight || showDetails ? (
                <RosterPreviewTable
                  rows={resolvedRows}
                  // Identities aren't resolved yet while loading, so drive the
                  // skeleton's row count off the parsed rows — otherwise the
                  // placeholder renders as an empty header-only table.
                  skeletonRowCount={parsedRows.length}
                  rolesByUser={rolesByUser}
                  changes={rowChanges}
                  roleChanges={roleChangeByUser}
                  identityChanges={identityChangeByUser}
                  loading={preflighting}
                  onRoleChange={(key, role) =>
                    setRolesByUser((prev) => ({ ...prev, [key]: role }))
                  }
                />
              ) : null
            ) : (
              <Alert tone="warning">
                {headerIssue?.kind === "missing-identity-header" ? (
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">
                      {t("students.missingIdentityHeader")}
                    </span>
                    <span className="text-sm">
                      {t("students.expectedHeaders", {
                        headers: headerIssue.identity.join(", "),
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
                  t("students.noUsableRows")
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

        {/* The dedicated "Email addresses" upload has no roster result to merge,
            so it keeps its own screen. */}
        {phase === "complete" && uploadKind === "email-list" && emailResult && (
          <EmailInviteResult
            result={emailResult}
            onDone={handleClose}
            renderSection={(props) => <ImportResultSection {...props} />}
          />
        )}

        {/* A roster CSV lands on ONE screen even when it carried both kinds of
            row: two independent result blocks would paint two success banners and
            two Done buttons. */}
        {phase === "complete" && uploadKind !== "email-list" && result && (
          <RosterImportResult
            result={result}
            inviteError={inviteError}
            inviteOutcome={inviteOutcome}
            roleChangeOutcome={roleChangeOutcome}
            emailResult={emailResult}
            emailError={emailError}
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
