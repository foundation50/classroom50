import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"

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
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { teamMembersQuery } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { errorText } from "@/types/localizedMessage"
import type { TeamFormation } from "@/types/classroom"
import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import useGroupTeams from "@/hooks/useGroupTeams"
import useGroupTeamMembers from "@/hooks/useGroupTeamMembers"
import useAddGroupTeamMember from "@/hooks/mutations/useAddGroupTeamMember"
import useRemoveGroupTeamMember from "@/hooks/mutations/useRemoveGroupTeamMember"
import useRenameGroupTeam from "@/hooks/mutations/useRenameGroupTeam"
import useUpdateGroupTeamPrivacy from "@/hooks/mutations/useUpdateGroupTeamPrivacy"
import useDeleteGroupTeam from "@/hooks/mutations/useDeleteGroupTeam"
import { useSyncTeamsSnapshot } from "@/hooks/mutations/useSaveTeamsSnapshot"
import { resolveMembershipDraft } from "@/domain/teams/membershipDraft"
import { unassignedRosterStudents } from "@/domain/teams/groupTeams"
import type { GroupTeamPrivacy, GroupTeamRef } from "@/domain/teams/groupTeams"

// A roster student the add picker can offer (not on any group team yet).
export type GroupPickerStudent = {
  key: string
  username: string
  label: string
}

// The two guardrail 403s named in copy instead of a raw GitHub message: an org
// that restricts team creation to owners, and a team-sync/IdP-managed team
// that refuses membership writes. Shared with GroupsManager (create/quick-add).
export function describeTeamWriteError(
  err: unknown,
  kind: "create" | "membership",
  t: (key: string) => string,
  fallback: string,
): string {
  if (err instanceof GitHubAPIError && err.isForbidden) {
    return kind === "create"
      ? t("manageGroups.errors.createForbidden")
      : t("manageGroups.errors.membershipForbidden")
  }
  return fallback
}

// The per-group manage dialog, CONNECTED: rename, visibility, draft-based
// membership, and danger-zone delete, owning its own reads and writes so the
// manage-groups page and the submissions gradebook share one dialog. Given
// only the team ref and assignment context, it resolves live members, the
// roster picker, and the already-assigned exclusion set internally (React
// Query dedupes with whatever the host page already fetched). Membership
// edits are a DRAFT (pending adds/removals with live count preview, applied
// on Save — removals first, then adds, mirroring GroupCollaboratorsModal);
// rename and visibility keep their explicit immediate controls. Every write
// is followed by the teams.json snapshot resync (one per membership batch).
// Callers mount it per open (remount-per-open keeps draft state fresh) and
// unmount it on close.
export function ManageGroupDialog({
  org,
  classroom,
  assignment,
  team: teamAtOpen,
  formation,
  maxGroupSize,
  onClose,
}: {
  org: string
  classroom: string
  assignment: string
  // The team as it was when the dialog opened; the live listing below keeps
  // renames/privacy current, and this snapshot keeps the dialog painting
  // after a delete removes the team from the listing.
  team: GroupTeamRef
  formation: TeamFormation
  maxGroupSize?: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const client = useGitHubClient()

  const teamsQuery = useGroupTeams(org, classroom, assignment)
  const teams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data])
  const team = useMemo(
    () =>
      teams.find((candidate) => candidate.slug === teamAtOpen.slug) ??
      teamAtOpen,
    [teams, teamAtOpen],
  )

  // Live members of THIS team (the dialog's member list)…
  const membersQuery = useQuery(teamMembersQuery(client, org, team.slug))
  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data])
  // …and of every team, for the "already on a group" picker exclusion.
  const slugs = useMemo(() => teams.map((entry) => entry.slug), [teams])
  const { logins: assignedLogins } = useGroupTeamMembers(org, slugs)

  const { students: csvStudents } = useGetStudents(org, classroom)
  const { rows: teamRows } = useTeamRoster(org, classroom, csvStudents)
  const enrolled = useMemo(
    () =>
      teamRows.filter(
        (row) => row.state === "enrolled" && row.username.trim() !== "",
      ),
    [teamRows],
  )
  const rosterLogins = useMemo(
    () => new Set(enrolled.map((row) => row.username.trim().toLowerCase())),
    [enrolled],
  )
  // Lowercased login -> roster full name, for the members list.
  const fullNameByLogin = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of enrolled) {
      const name = `${row.first_name} ${row.last_name}`.trim()
      if (name) map.set(row.username.trim().toLowerCase(), name)
    }
    return map
  }, [enrolled])
  // Students not on ANY of this assignment's teams — the add picker's options.
  const availableStudents: GroupPickerStudent[] = useMemo(
    () =>
      unassignedRosterStudents(enrolled, assignedLogins).map((row) => {
        const name = `${row.first_name} ${row.last_name}`.trim()
        return {
          key: row.key,
          username: row.username,
          label: name ? `${name} (${row.username})` : row.username,
        }
      }),
    [enrolled, assignedLogins],
  )

  const addMember = useAddGroupTeamMember({ org, classroom, assignment })
  const removeMember = useRemoveGroupTeamMember({ org, classroom, assignment })
  const renameTeam = useRenameGroupTeam({ org, classroom, assignment })
  const updatePrivacy = useUpdateGroupTeamPrivacy({
    org,
    classroom,
    assignment,
  })
  const deleteTeam = useDeleteGroupTeam({ org, classroom, assignment })
  const syncSnapshot = useSyncTeamsSnapshot({ org, classroom, assignment })

  // Every teacher-side mutation is followed by a snapshot sync so teams.json
  // stays the source of truth (teacher formation) / drift baseline (student
  // formation). Best-effort: a failed sync leaves the drift badge to catch it.
  const resync = async () => {
    try {
      await syncSnapshot.mutateAsync({ formation })
    } catch {
      // The drift badge surfaces a stale snapshot; nothing else to do here.
    }
  }

  const [nameDraft, setNameDraft] = useState(() => teamAtOpen.name ?? "")
  const [picked, setPicked] = useState("")
  // Pending removals (lowercased logins) and pending adds — nothing is
  // written until Save changes.
  const [removals, setRemovals] = useState<Set<string>>(() => new Set())
  const [additions, setAdditions] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const busy =
    addMember.isPending ||
    removeMember.isPending ||
    renameTeam.isPending ||
    updatePrivacy.isPending ||
    deleteTeam.isPending
  const controlsDisabled = busy || saving

  const displayName = team.name || t("manageGroups.defaultName", { n: team.n })

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

  // Display-name only: the team NAME (== slug) never changes, so the group's
  // repository keeps its name.
  const saveName = async () => {
    if (controlsDisabled) return
    const trimmed = nameDraft.trim()
    if (trimmed === (team.name ?? "")) return
    setActionError(null)
    try {
      await renameTeam.mutateAsync({ teamSlug: team.slug, name: trimmed })
      await resync()
      setNameDraft(trimmed)
    } catch (err) {
      setActionError(errorText(t, err))
    }
  }

  const handlePrivacy = async (privacy: GroupTeamPrivacy) => {
    if (controlsDisabled || team.privacy === privacy) return
    setActionError(null)
    try {
      await updatePrivacy.mutateAsync({ teamSlug: team.slug, privacy })
    } catch (err) {
      setActionError(
        describeTeamWriteError(err, "membership", t, errorText(t, err)),
      )
    }
  }

  // Apply the membership DRAFT: removals first, then adds (mirrors
  // GroupCollaboratorsModal — a swap at max group size frees a slot first),
  // each item individually so one failure doesn't lose the rest, and ONE
  // snapshot resync after the whole batch. Failed items stay pending.
  const handleSaveMembers = async () => {
    if (saving || busy || !draft.hasChanges) return
    setSaving(true)
    setSubmitError(null)
    const failedRemovals: string[] = []
    const failedAdds: string[] = []
    let firstError: unknown = null

    try {
      let removed = 0
      for (const username of draft.toRemove) {
        try {
          await removeMember.mutateAsync({ teamSlug: team.slug, username })
          removed++
        } catch (err) {
          failedRemovals.push(username)
          firstError ??= err
        }
      }

      const liveCount = members.length
      let added = 0
      for (const username of draft.toAdd) {
        try {
          await addMember.mutateAsync({
            teamSlug: team.slug,
            username,
            // A failed remove keeps its slot, so the gate counts from what
            // actually happened, not from the draft's assumption.
            currentMemberCount: liveCount - removed + added,
            maxGroupSize,
            rosterLogins,
          })
          added++
        } catch (err) {
          failedAdds.push(username)
          firstError ??= err
        }
      }

      await resync()

      if (failedRemovals.length === 0 && failedAdds.length === 0) {
        onClose()
        return
      }
      // Keep only the failed items pending — what succeeded is already
      // reality (the mutation invalidations refresh the member list).
      setRemovals(new Set(failedRemovals.map((login) => login.toLowerCase())))
      setAdditions(failedAdds)
      setSubmitError(
        t("manageGroups.manage.membersError", {
          error: describeTeamWriteError(
            firstError,
            "membership",
            t,
            errorText(t, firstError),
          ),
        }),
      )
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (busy) return
    setActionError(null)
    try {
      await deleteTeam.mutateAsync({ slug: team.slug, id: team.id })
      setConfirmingDelete(false)
      // Fire-and-forget: the mutation outlives the dialog, and a failed sync
      // only leaves a stale snapshot row the drift badge surfaces.
      void resync()
      // Nothing left to manage; the hosts' caches invalidate (rows refresh).
      onClose()
    } catch (err) {
      setConfirmingDelete(false)
      setActionError(errorText(t, err))
    }
  }

  return (
    <>
      <Modal
        open
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
          {actionError ? (
            <Alert tone="error" className="text-sm">
              {actionError}
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
                    void handlePrivacy(e.target.value as GroupTeamPrivacy)
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
                        className="text-error/70 hover:text-error"
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
                onClick={() => setConfirmingDelete(true)}
              >
                {t("manageGroups.deleteConfirm")}
              </Button>
            </div>
          </section>
        </div>
      </Modal>

      {/* Delete confirm, stacked on the dialog (native <dialog> nesting), so
          cancel returns here. */}
      <Modal
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={t("manageGroups.deleteTitle")}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={deleteTeam.isPending}
              onClick={() => setConfirmingDelete(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="error"
              disabled={deleteTeam.isPending}
              loading={deleteTeam.isPending}
              loadingLabel={t("manageGroups.deleteConfirm")}
              onClick={() => void handleDelete()}
            >
              {t("manageGroups.deleteConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {t("manageGroups.deleteBody", { name: displayName })}
        </p>
      </Modal>
    </>
  )
}

export default ManageGroupDialog
