import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  Alert,
  Badge,
  Button,
  FormField,
  Heading,
  Input,
  Modal,
  ModalIcon,
  Select,
} from "@/components/ui"
import { PeopleIcon, PlusIcon, XIcon } from "@/components/ui/icons"
import type { GitHubUser } from "@/github-core/types"
import type { GroupTeamPrivacy, GroupTeamRef } from "@/domain/teams/groupTeams"
import { resolveMembershipDraft } from "@/domain/teams/membershipDraft"

// A roster student the add picker can offer (not on any group team yet).
export type GroupPickerStudent = {
  key: string
  username: string
  label: string
}

// What the page reports back from applying a membership draft: the items that
// failed (they stay pending in the dialog) and the message to surface.
export type MembershipSaveResult = {
  failedRemovals: string[]
  failedAdds: string[]
  message: string | null
}

// The per-group manage dialog: rename, visibility, membership, and a
// danger-zone delete trigger, all in one place so the list rows stay
// read-only summaries. Membership edits are a DRAFT (pending adds/removals
// with live count preview, applied on Save — removals first, then adds,
// mirroring GroupCollaboratorsModal); rename and visibility keep their
// explicit immediate controls. Writes are delegated to the page, which owns
// the mutations, the snapshot resync, and the shared error string surfaced
// here. The page remounts the dialog per open (a session key) so draft state
// starts fresh, and keeps `team` set through the close fade so content never
// blanks.
export function GroupManageModal({
  open,
  team,
  membersBySlug,
  maxGroupSize,
  fullNameByLogin,
  availableStudents,
  busy,
  error,
  onClose,
  onRename,
  onPrivacyChange,
  onSaveMembers,
  onDelete,
}: {
  open: boolean
  team: GroupTeamRef
  membersBySlug: Map<string, GitHubUser[]>
  maxGroupSize?: number
  // Lowercased login -> roster full name, for the members list.
  fullNameByLogin: Map<string, string>
  availableStudents: GroupPickerStudent[]
  busy: boolean
  error: string | null
  onClose: () => void
  // Resolves true on success so the dialog can settle the draft; the page
  // surfaces failures through `error`.
  onRename: (team: GroupTeamRef, name: string) => Promise<boolean>
  onPrivacyChange: (team: GroupTeamRef, privacy: GroupTeamPrivacy) => void
  // Applies the draft (removals first, then adds) with ONE snapshot resync
  // after the batch; failed items come back so the draft keeps only those.
  onSaveMembers: (
    team: GroupTeamRef,
    changes: { toRemove: string[]; toAdd: string[] },
  ) => Promise<MembershipSaveResult>
  // Opens the page's existing delete confirm dialog (this one stays open
  // beneath it, so cancel returns here).
  onDelete: (team: GroupTeamRef) => void
}) {
  const { t } = useTranslation()

  const [nameDraft, setNameDraft] = useState(() => team.name ?? "")
  const [picked, setPicked] = useState("")
  // Pending removals (lowercased logins) and pending adds — nothing is
  // written until Save changes.
  const [removals, setRemovals] = useState<Set<string>>(() => new Set())
  const [additions, setAdditions] = useState<string[]>([])
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const displayName = team.name || t("manageGroups.defaultName", { n: team.n })
  const members = useMemo(
    () => membersBySlug.get(team.slug) ?? [],
    [membersBySlug, team.slug],
  )

  const draft = useMemo(
    () =>
      resolveMembershipDraft({
        currentMembers: members.map((member) => member.login),
        removals,
        additions,
        maxGroupSize,
      }),
    [members, removals, additions, maxGroupSize],
  )
  // Show only the additions that still count (a background refetch may have
  // turned a pending add into a real member).
  const pendingAdds = draft.toAdd
  const controlsDisabled = busy || saving

  const markRemoval = (login: string) => {
    setRemovals((current) => new Set(current).add(login.toLowerCase()))
  }
  const undoRemoval = (login: string) => {
    setRemovals((current) => {
      const next = new Set(current)
      next.delete(login.toLowerCase())
      return next
    })
  }
  const undoAdd = (login: string) => {
    setAdditions((current) =>
      current.filter((entry) => entry.toLowerCase() !== login.toLowerCase()),
    )
  }
  const addPicked = () => {
    if (!picked) return
    setAdditions((current) => [...current, picked])
    setPicked("")
  }

  const pendingAddSet = useMemo(
    () => new Set(pendingAdds.map((login) => login.toLowerCase())),
    [pendingAdds],
  )
  const pickerStudents = availableStudents.filter(
    (student) => !pendingAddSet.has(student.username.trim().toLowerCase()),
  )

  const saveName = async () => {
    if (controlsDisabled) return
    const trimmed = nameDraft.trim()
    if (await onRename(team, trimmed)) setNameDraft(trimmed)
  }

  const handleSaveMembers = async () => {
    if (saving || busy || !draft.hasChanges) return
    setSaving(true)
    setSubmitError(null)
    try {
      const result = await onSaveMembers(team, {
        toRemove: draft.toRemove,
        toAdd: draft.toAdd,
      })
      if (
        result.failedRemovals.length === 0 &&
        result.failedAdds.length === 0
      ) {
        onClose()
        return
      }
      // Keep only the failed items pending — what succeeded is already
      // reality (the page's invalidations refresh the member list).
      setRemovals(
        new Set(result.failedRemovals.map((login) => login.toLowerCase())),
      )
      setAdditions(result.failedAdds)
      setSubmitError(result.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={saving}
      size="lg"
      title={t("manageGroups.manage.title", { name: displayName })}
      headerVisual={
        <ModalIcon tone="primary">
          <PeopleIcon aria-hidden="true" className="size-4" />
        </ModalIcon>
      }
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={controlsDisabled || !draft.hasChanges}
            loading={saving}
            loadingLabel={t("manageGroups.manage.saveMembers")}
            onClick={() => void handleSaveMembers()}
          >
            {t("manageGroups.manage.saveMembers")}
          </Button>
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-5">
        {error ? (
          <Alert tone="error" className="text-sm">
            {error}
          </Alert>
        ) : null}
        {submitError ? (
          <Alert tone="error" className="text-sm">
            {submitError}
          </Alert>
        ) : null}

        <FormField
          label={t("manageGroups.createNameLabel")}
          hint={t("manageGroups.rename.help")}
        >
          {({ id, describedById }) => (
            <div className="flex items-center gap-2">
              <Input
                id={id}
                aria-describedby={describedById}
                className="flex-1"
                value={nameDraft}
                maxLength={80}
                placeholder={t("manageGroups.defaultName", { n: team.n })}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void saveName()
                  }
                }}
              />
              <Button
                variant="outline"
                disabled={
                  controlsDisabled || nameDraft.trim() === (team.name ?? "")
                }
                onClick={() => void saveName()}
              >
                {t("manageGroups.rename.saveButton")}
              </Button>
            </div>
          )}
        </FormField>

        {team.privacy && (
          <FormField
            label={t("manageGroups.visibility.label")}
            hint={t("manageGroups.visibility.help")}
          >
            {({ id, describedById }) => (
              <Select
                id={id}
                aria-describedby={describedById}
                className="w-auto"
                value={team.privacy}
                disabled={controlsDisabled}
                onChange={(e) =>
                  onPrivacyChange(team, e.target.value as GroupTeamPrivacy)
                }
              >
                <option value="closed">
                  {t("manageGroups.visibility.visible")}
                </option>
                <option value="secret">
                  {t("manageGroups.visibility.hidden")}
                </option>
              </Select>
            )}
          </FormField>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Heading as="h4" variant="title-small">
              {t("manageGroups.manage.membersHeading")}
            </Heading>
            <Badge ghost size="sm">
              {maxGroupSize !== undefined
                ? t("manageGroups.memberCountOfMax", {
                    count: draft.resultingCount,
                    max: maxGroupSize,
                  })
                : t("manageGroups.memberCount", {
                    count: draft.resultingCount,
                  })}
            </Badge>
            {draft.hasChanges && (
              <span className="text-xs text-base-content/70">
                {t("manageGroups.manage.pendingNote")}
              </span>
            )}
          </div>

          <ul className="divide-y divide-base-200 rounded-box border border-base-200">
            {members.map((member) => {
              const fullName = fullNameByLogin.get(member.login.toLowerCase())
              const pendingRemoval = removals.has(member.login.toLowerCase())
              return (
                <li
                  key={member.login}
                  className={
                    pendingRemoval
                      ? "flex items-center gap-3 bg-error/5 px-4 py-2"
                      : "flex items-center gap-3 px-4 py-2"
                  }
                >
                  {member.avatar_url ? (
                    <img
                      src={member.avatar_url}
                      alt=""
                      className="size-8 shrink-0 rounded-full"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-base-200 text-xs text-primary"
                    >
                      {member.login.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div
                      className={
                        pendingRemoval
                          ? "truncate text-sm font-medium text-error line-through opacity-70"
                          : "truncate text-sm font-medium"
                      }
                    >
                      {fullName ?? member.login}
                    </div>
                    {fullName && (
                      <div
                        className={
                          pendingRemoval
                            ? "truncate text-xs text-error/70 line-through"
                            : "truncate text-xs text-base-content/70"
                        }
                      >
                        {member.login}
                      </div>
                    )}
                  </div>
                  {pendingRemoval ? (
                    <>
                      <span className="text-xs font-medium text-error/70">
                        {t("manageGroups.manage.willBeRemoved")}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-error"
                        disabled={controlsDisabled}
                        onClick={() => undoRemoval(member.login)}
                      >
                        {t("manageGroups.manage.undo")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      className="text-base-content/60 hover:text-error"
                      disabled={controlsDisabled}
                      aria-label={t("manageGroups.removeAriaLabel", {
                        username: member.login,
                      })}
                      onClick={() => markRemoval(member.login)}
                    >
                      <XIcon aria-hidden="true" className="size-4" />
                    </Button>
                  )}
                </li>
              )
            })}

            {pendingAdds.map((username) => {
              const fullName = fullNameByLogin.get(username.toLowerCase())
              return (
                <li
                  key={`add-${username}`}
                  className="flex items-center gap-3 bg-success/5 px-4 py-2"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-xs text-success"
                  >
                    <PlusIcon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {fullName ?? username}
                    </div>
                    {fullName && (
                      <div className="truncate text-xs text-base-content/70">
                        {username}
                      </div>
                    )}
                  </div>
                  <Badge tone="success" size="sm">
                    {t("manageGroups.manage.willBeAdded")}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={controlsDisabled}
                    onClick={() => undoAdd(username)}
                  >
                    {t("manageGroups.manage.undo")}
                  </Button>
                </li>
              )
            })}

            {members.length === 0 && pendingAdds.length === 0 && (
              <li className="px-4 py-3 text-sm text-base-content/70">
                {t("manageGroups.noMembers")}
              </li>
            )}
          </ul>

          {draft.atCapacity ? (
            <p className="text-xs text-base-content/70">
              {t("manageGroups.groupFull", { max: maxGroupSize ?? 0 })}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Select
                selectSize="sm"
                className="max-w-xs flex-1"
                value={picked}
                disabled={controlsDisabled}
                aria-label={t("manageGroups.addMemberAriaLabel", {
                  name: displayName,
                })}
                onChange={(e) => setPicked(e.target.value)}
              >
                <option value="">
                  {t("manageGroups.addMemberPlaceholder")}
                </option>
                {pickerStudents.map((student) => (
                  <option key={student.key} value={student.username}>
                    {student.label}
                  </option>
                ))}
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={controlsDisabled || !picked}
                onClick={addPicked}
              >
                <PlusIcon aria-hidden="true" className="size-4" />
                {t("manageGroups.addMemberButton")}
              </Button>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2 rounded-box border border-error/40 p-4">
          <Heading as="h4" variant="title-small">
            {t("manageGroups.manage.dangerHeading")}
          </Heading>
          <p className="text-sm text-base-content/70">
            {t("manageGroups.manage.dangerBody")}
          </p>
          <div>
            <Button
              variant="error"
              size="sm"
              disabled={controlsDisabled}
              onClick={() => onDelete(team)}
            >
              {t("manageGroups.deleteConfirm")}
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  )
}

export default GroupManageModal
