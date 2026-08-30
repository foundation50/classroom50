import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, Badge, Button, Input, TableShell } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import MemberLinkPicker from "@/pages/students/MemberLinkPicker"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { getErrorMessage } from "@/github-core/errorMessage"
import {
  applyRosterEdits,
  unlinkedRowRef,
  type ApplyRosterEditsResult,
  type DirectoryMember,
  type RosterEdit,
} from "@/domain/students"
import { nameFromParts } from "@/util/students"
import type { TeamRosterRow } from "@/util/teamRoster"

// One row's staged (not yet saved) values. Metadata fields are undefined until
// touched, so "dirty" is derivable against the live row; `link` is the staged
// member for an unlinked row.
type RowDraft = {
  first_name?: string
  last_name?: string
  section?: string
  link?: DirectoryMember | null
}

// Batch Edit mode for the roster table: the teacher stages metadata edits and
// unlinked-row links across many rows, then saves them all in ONE commit via
// applyRosterEdits (which re-proves every guard at commit time — a stale view
// only costs a reported miss, never a wrong write). Rendered in PLACE of the
// normal roster table, with its own Save/Cancel header.
export function RosterEditMode({
  org,
  classroom,
  rows,
  linkCandidates,
  onCancel,
  onSaved,
}: {
  org: string
  classroom: string
  rows: TeamRosterRow[]
  // Directory members the link pickers may offer (the parent already excludes
  // identities claiming a roster row); staged picks exclude each other too.
  linkCandidates: DirectoryMember[]
  onCancel: () => void
  onSaved: (result: ApplyRosterEditsResult) => void
}) {
  const { t } = useTranslation()
  const client = useGitHubClient()
  // Freeze the rows as of entering edit mode: drafts key on row.key, so a
  // background sync mutating a derived key would silently drop staged edits.
  // applyRosterEdits re-proves every guard at commit time, so editing a frozen
  // view is safe — staleness only costs a reported miss.
  const [editRows] = useState(() => rows)
  const [drafts, setDrafts] = useState<Map<string, RowDraft>>(new Map())
  // Per-row link picker text; only one picker panel is open at a time.
  const [linkQueries, setLinkQueries] = useState<Record<string, string>>({})
  const [openPickerKey, setOpenPickerKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const setDraft = (key: string, patch: Partial<RowDraft>) => {
    setDrafts((prev) => {
      const next = new Map(prev)
      next.set(key, { ...next.get(key), ...patch })
      return next
    })
  }

  // Editable-metadata gate mirrors the member modal's canEdit: any row with a
  // roster identity (username or email), plus unlinked rows. Email is NOT
  // editable here — a pending row's address is its identity and its invite
  // team's hash, so this surface never touches it.
  const canEditMetadata = (row: TeamRosterRow) =>
    row.state === "unlinked" || Boolean(row.username || row.email)

  const draftValue = (
    row: TeamRosterRow,
    field: "first_name" | "last_name" | "section",
  ) => drafts.get(row.key)?.[field] ?? row[field]

  const metadataDirty = (row: TeamRosterRow) => {
    const draft = drafts.get(row.key)
    if (!draft) return false
    return (
      (draft.first_name !== undefined &&
        draft.first_name.trim() !== row.first_name.trim()) ||
      (draft.last_name !== undefined &&
        draft.last_name.trim() !== row.last_name.trim()) ||
      (draft.section !== undefined &&
        draft.section.trim() !== row.section.trim())
    )
  }

  const stagedLink = (row: TeamRosterRow) => drafts.get(row.key)?.link ?? null

  const rowDirty = (row: TeamRosterRow) =>
    metadataDirty(row) || stagedLink(row) !== null

  // The save payload, recomposed from the drafts. A linked row's dirty
  // metadata rides INSIDE its link edit (one atomic unit — if the link misses,
  // the patch dies with it instead of resolving by login to another student's
  // pre-existing row); a plain metadata edit is keyed by github_id/username,
  // else the identity-less ref.
  const stagedEdits = useMemo((): RosterEdit[] => {
    const edits: RosterEdit[] = []
    for (const row of editRows) {
      const link = stagedLink(row)
      const patch = metadataDirty(row)
        ? {
            first_name: draftValue(row, "first_name"),
            last_name: draftValue(row, "last_name"),
            section: draftValue(row, "section"),
          }
        : undefined
      if (link) {
        edits.push({
          kind: "link",
          rowRef: unlinkedRowRef(row),
          member: { id: link.id, login: link.login },
          ...(patch ? { patch } : {}),
        })
        continue
      }
      if (!patch) continue
      const key =
        row.github_id.trim() || row.username.trim()
          ? {
              github_id: row.github_id.trim() || undefined,
              username: row.username.trim() || undefined,
            }
          : { rowRef: unlinkedRowRef(row) }
      edits.push({ kind: "metadata", key, patch })
    }
    return edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRows, drafts])

  // One edit = one staged unit: a link carrying a patch counts once, matching
  // how applyRosterEdits counts it applied or missed.
  const stagedCount = stagedEdits.length

  // Members already staged on some row, so two pickers can't stage the same
  // account (the domain would miss the second anyway; don't offer it).
  const stagedMemberIds = useMemo(() => {
    const ids = new Set<number>()
    for (const draft of drafts.values()) {
      if (draft.link) ids.add(draft.link.id)
    }
    return ids
  }, [drafts])

  // Candidate pool for one row's picker: staged picks exclude each other (the
  // domain would miss the second anyway; don't offer it). The typed-query
  // filter and item cap live in MemberLinkPicker.
  const pickerPool = (row: TeamRosterRow) => {
    const selected = stagedLink(row)
    return linkCandidates.filter(
      (m) => !stagedMemberIds.has(m.id) || m.id === selected?.id,
    )
  }

  const handleSave = async () => {
    if (saving || stagedCount === 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await applyRosterEdits(client, {
        org,
        classroom,
        edits: stagedEdits,
      })
      onSaved(result)
    } catch (err) {
      setSaveError(
        t("students.editRoster.saveFailed", { error: getErrorMessage(err) }),
      )
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    if (saving) return
    if (stagedCount > 0) {
      setConfirmingDiscard(true)
      return
    }
    onCancel()
  }

  const displayLabel = (row: TeamRosterRow) =>
    nameFromParts(row.first_name, row.last_name) || row.username || row.email

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">
            {t("students.editRoster.title")}
          </h3>
          {stagedCount > 0 ? (
            <Badge tone="warning" size="sm">
              {t("students.editRoster.stagedCount", { count: stagedCount })}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={handleCancel}
          >
            {t("students.editRoster.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            loadingLabel={t("students.editRoster.saving")}
            disabled={saving || stagedCount === 0}
            onClick={() => void handleSave()}
          >
            {t("students.editRoster.save")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-base-content/60">
        {t("students.editRoster.hint")}
      </p>

      {saveError ? (
        <Alert tone="error" className="text-sm">
          {saveError}
        </Alert>
      ) : null}

      {/* A scroll container, capped to the viewport: the link pickers' panels
          paint below their cells INSIDE the frame, so an open panel scrolls
          with the table instead of pushing the page past its container.
          Opening a picker centers its row (below) so the panel is visible
          without hand-scrolling. */}
      <TableShell animate={false} frameClassName="max-h-[65vh] overflow-y-auto">
        <thead>
          <tr>
            <th scope="col">{t("students.table.colMember")}</th>
            <th scope="col">{t("students.table.colUsername")}</th>
            <th scope="col">{t("students.editRoster.firstName")}</th>
            <th scope="col">{t("students.editRoster.lastName")}</th>
            <th scope="col">{t("students.editRoster.section")}</th>
          </tr>
        </thead>
        <tbody>
          {editRows.map((row, index) => {
            const editable = canEditMetadata(row)
            const dirty = rowDirty(row)
            const link = stagedLink(row)
            return (
              <tr key={row.key} className={dirty ? "bg-warning/10" : undefined}>
                <td className="min-w-0">
                  <span className="text-sm">{displayLabel(row)}</span>
                </td>
                <td className="min-w-52">
                  {row.state === "unlinked" ? (
                    <MemberLinkPicker
                      id={`roster-edit-link-${index}`}
                      label={t("students.editRoster.linkLabel")}
                      placeholder={t("students.editRoster.linkPlaceholder")}
                      emptyState={t("students.editRoster.linkEmpty")}
                      inputSize="sm"
                      // The metadata Inputs disable while saving; the picker
                      // must freeze too or a keystroke mutates mid-save.
                      frozen={saving}
                      items={pickerPool(row)}
                      value={linkQueries[row.key] ?? ""}
                      onInputChange={(value) => {
                        setLinkQueries((prev) => ({
                          ...prev,
                          [row.key]: value,
                        }))
                        // Typing past the picked login unstages the link.
                        if (link && value !== link.login) {
                          setDraft(row.key, { link: null })
                        }
                      }}
                      open={openPickerKey === row.key}
                      onOpenChange={(open) => {
                        setOpenPickerKey(open ? row.key : null)
                        // Center the row inside the scrollable frame so the
                        // panel below it is visible without hand-scrolling.
                        // After the rAF the panel has rendered and extended
                        // the frame's scroll area. (jsdom has no scrollIntoView.)
                        if (open) {
                          requestAnimationFrame(() =>
                            document
                              .getElementById(`roster-edit-link-${index}`)
                              ?.scrollIntoView?.({ block: "center" }),
                          )
                        }
                      }}
                      onSelect={(m) => {
                        setDraft(row.key, { link: m })
                        setLinkQueries((prev) => ({
                          ...prev,
                          [row.key]: m.login,
                        }))
                      }}
                    />
                  ) : (
                    <span className="font-mono text-sm">
                      {row.username || "—"}
                    </span>
                  )}
                </td>
                <td>
                  <Input
                    inputSize="sm"
                    aria-label={t("students.editRoster.firstName")}
                    disabled={!editable || saving}
                    value={draftValue(row, "first_name")}
                    onChange={(e) =>
                      setDraft(row.key, { first_name: e.target.value })
                    }
                  />
                </td>
                <td>
                  <Input
                    inputSize="sm"
                    aria-label={t("students.editRoster.lastName")}
                    disabled={!editable || saving}
                    value={draftValue(row, "last_name")}
                    onChange={(e) =>
                      setDraft(row.key, { last_name: e.target.value })
                    }
                  />
                </td>
                <td>
                  <Input
                    inputSize="sm"
                    aria-label={t("students.editRoster.section")}
                    disabled={!editable || saving}
                    value={draftValue(row, "section")}
                    onChange={(e) =>
                      setDraft(row.key, { section: e.target.value })
                    }
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </TableShell>

      <ConfirmModal
        open={confirmingDiscard}
        title={t("students.editRoster.discardTitle")}
        description={t("students.editRoster.discardBody", {
          count: stagedCount,
        })}
        confirmLabel={t("students.editRoster.discardConfirm")}
        needsConfirm={false}
        onConfirm={async () => {
          onCancel()
        }}
        onClose={() => setConfirmingDiscard(false)}
      />
    </div>
  )
}

export default RosterEditMode
