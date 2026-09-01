import { useEffect, useMemo, useRef, useState } from "react"
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
  cx,
} from "@/components/ui"
import { CopyIcon, PeopleIcon, PlusIcon, SyncIcon } from "@/components/ui/icons"
import { EmptyState, ListSkeletonRows, SkeletonRegion } from "@/components/list"
import PageHeader from "@/components/PageHeader"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { errorText } from "@/types/localizedMessage"
import type { TeamFormation } from "@/types/classroom"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import { toGroupPickerStudents, useGroupRoster } from "@/hooks/useGroupRoster"
import useGroupTeams from "@/hooks/useGroupTeams"
import useGroupTeamMembers from "@/hooks/useGroupTeamMembers"
import useTeamsSnapshot from "@/hooks/useTeamsSnapshot"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useCreateGroupTeam from "@/hooks/mutations/useCreateGroupTeam"
import useAddGroupTeamMember from "@/hooks/mutations/useAddGroupTeamMember"
import { useSyncTeamsSnapshot } from "@/hooks/mutations/useSaveTeamsSnapshot"
import { snapshotDrift } from "@/domain/teams/teamsFile"
import type { GroupTeamRef } from "@/domain/teams/groupTeams"
import { groupRepoName } from "@/util/studentRepo"
import { groupDisplayName } from "@/util/groupTeam"
import { ManageGroupDialog, describeTeamWriteError } from "./ManageGroupDialog"
import { CopyGroupsModal } from "./CopyGroupsModal"
import { GroupRow } from "./GroupRow"
import { UnassignedStudentsPanel } from "./UnassignedStudentsPanel"

// Teacher-side management of a team-mode assignment's group teams: a
// glanceable list of read-only summary rows, a create dialog, the shared
// per-group manage dialog (ManageGroupDialog — membership, rename,
// visibility, delete), the unassigned-students panel, and keeping the
// teams.json snapshot in step. For
// teacher formation this is where groups come to exist; for student formation
// it's read-mostly (teams appear as students form them) with the same controls
// available to fix membership. Owns the page header too, so the title, the
// formation hint, and the page-level actions form one block.
export function GroupsManager({
  org,
  classroom,
  assignmentSlug,
  maxGroupSize,
  formation,
}: {
  org: string
  classroom: string
  assignmentSlug: string
  maxGroupSize?: number
  formation: TeamFormation
}) {
  const { t } = useTranslation()
  const { user } = useGithubAuth()

  const teamsQuery = useGroupTeams(org, classroom, assignmentSlug)
  const teams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data])
  const slugs = useMemo(() => teams.map((team) => team.slug), [teams])
  const {
    membersBySlug,
    logins: assignedLogins,
    isPending: membersPending,
  } = useGroupTeamMembers(org, slugs)

  const snapshotQuery = useTeamsSnapshot(org, classroom)
  const snapshotTeams = snapshotQuery.data?.assignments[assignmentSlug]?.teams
  const drift = useMemo(
    () => snapshotDrift(snapshotTeams, membersBySlug),
    [snapshotTeams, membersBySlug],
  )

  const { enrolled, rosterLogins, fullNameByLogin } = useGroupRoster(
    org,
    classroom,
  )
  // Students not on ANY of this assignment's teams — the add pickers' options
  // and the unassigned panel's rows.
  const availableStudents = useMemo(
    () => toGroupPickerStudents(enrolled, assignedLogins),
    [enrolled, assignedLogins],
  )

  // The classroom's OTHER team-mode assignments: the "Copy groups" sources.
  const { data: assignmentsData } = useGetClassroomAssignments(org, classroom)
  const copySourceOptions = useMemo(
    () =>
      (assignmentsData?.assignments ?? [])
        .filter(
          (candidate) =>
            candidate.mode === "team" && candidate.slug !== assignmentSlug,
        )
        .map((candidate) => ({ slug: candidate.slug, name: candidate.name })),
    [assignmentsData, assignmentSlug],
  )

  // Repo existence per group, from the already-listed org repos matched
  // against the canonical `<classroom>-<assignment>-group-<n>` name.
  const { data: orgRepos } = useGetOrgRepos(org)
  const repoByName = useMemo(() => {
    const map = new Map<string, { name: string; htmlUrl: string }>()
    for (const repo of orgRepos ?? []) {
      map.set(repo.name.toLowerCase(), {
        name: repo.name,
        htmlUrl: repo.html_url,
      })
    }
    return map
  }, [orgRepos])
  const repoForTeam = (team: GroupTeamRef) =>
    orgRepos === undefined
      ? undefined
      : (repoByName.get(groupRepoName(classroom, assignmentSlug, team.n)) ??
        null)

  const createTeam = useCreateGroupTeam({
    org,
    classroom,
    assignment: assignmentSlug,
  })
  const addMember = useAddGroupTeamMember({
    org,
    classroom,
    assignment: assignmentSlug,
  })
  const syncSnapshot = useSyncTeamsSnapshot({
    org,
    classroom,
    assignment: assignmentSlug,
  })

  const [displayName, setDisplayName] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  // Counter keyed onto the manage dialog so each open remounts it with fresh
  // draft state; the dialog is mounted only while a team is selected.
  const [manageSession, setManageSession] = useState(0)
  // Same remount-per-open key for the copy dialog: an abandoned plan must
  // never leak into the next open.
  const [copyOpen, setCopyOpen] = useState(false)
  const [copySession, setCopySession] = useState(0)
  // The team whose manage dialog is open (the ref as of the open click; the
  // dialog re-derives the live team itself), or null.
  const [managedTeam, setManagedTeam] = useState<GroupTeamRef | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const busy = createTeam.isPending || addMember.isPending

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

  // Auto-refresh once per visit, but only when live membership actually
  // drifted from the recorded snapshot — an unconditional sync would commit
  // to the config repo on every page load. Waits for the snapshot and the
  // members fan-out so a half-resolved read is never mistaken for drift.
  const autoSynced = useRef(false)
  useEffect(() => {
    if (autoSynced.current) return
    if (snapshotQuery.isLoading || teamsQuery.isLoading || membersPending)
      return
    if (drift.changed.size === 0 && drift.missing.size === 0) return
    autoSynced.current = true
    void resync()
    // resync is recreated per render; the ref guarantees one shot regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotQuery.isLoading, teamsQuery.isLoading, membersPending, drift])

  // Reset when OPENING, not when closing: the create dialog keeps painting
  // through its fade-out (see Modal), so clearing at close would blank it
  // mid-fade.
  const openCreate = () => {
    setDisplayName("")
    setActionError(null)
    setCreateOpen(true)
  }

  const openManage = (team: GroupTeamRef) => {
    setActionError(null)
    setManageSession((session) => session + 1)
    setManagedTeam(team)
  }

  const openCopy = () => {
    setActionError(null)
    setCopySession((session) => session + 1)
    setCopyOpen(true)
  }

  const handleCreate = async () => {
    if (!user?.login || busy) return
    setActionError(null)
    try {
      await createTeam.mutateAsync({
        displayName: displayName.trim() || undefined,
        creatorLogin: user.login,
        formation,
      })
      setCreateOpen(false)
      await resync()
    } catch (err) {
      setActionError(
        describeTeamWriteError(err, "create", t, errorText(t, err)),
      )
    }
  }

  const handleAdd = async (team: GroupTeamRef, username: string) => {
    const trimmed = username.trim()
    if (!trimmed || busy) return
    setActionError(null)
    try {
      await addMember.mutateAsync({
        teamSlug: team.slug,
        username: trimmed,
        currentMemberCount: membersBySlug.get(team.slug)?.length ?? 0,
        maxGroupSize,
        rosterLogins,
      })
      await resync()
    } catch (err) {
      setActionError(
        describeTeamWriteError(err, "membership", t, errorText(t, err)),
      )
    }
  }

  const teamDisplayName = (team: GroupTeamRef) => groupDisplayName(team, t)

  // Join targets for the unassigned panel: groups with room left.
  const openGroups = useMemo(
    () =>
      teams
        .filter(
          (team) =>
            maxGroupSize === undefined ||
            (membersBySlug.get(team.slug)?.length ?? 0) < maxGroupSize,
        )
        .map((team) => ({
          slug: team.slug,
          label: groupDisplayName(team, t),
        })),
    [teams, membersBySlug, maxGroupSize, t],
  )

  const handleUnassignedAdd = (username: string, teamSlug: string) => {
    const team = teams.find((candidate) => candidate.slug === teamSlug)
    if (team) void handleAdd(team, username)
  }

  const createGroupButton = (
    <Button
      variant="primary"
      size="sm"
      disabled={busy || !user?.login}
      onClick={openCreate}
    >
      <PlusIcon aria-hidden="true" className="size-4" />
      {t("manageGroups.createButton")}
    </Button>
  )

  const copyGroupsButton = (
    <Button
      variant="outline"
      size="sm"
      className="gap-2"
      disabled={busy || !user?.login}
      onClick={openCopy}
    >
      <CopyIcon aria-hidden="true" className="size-4" />
      {t("manageGroups.copy.button")}
    </Button>
  )

  // With no groups yet, the blankslate owns the formation actions — repeating
  // them in the header would give one action two competing entry points.
  const noGroupsYet = !teamsQuery.isLoading && teams.length === 0

  return (
    <>
      <PageHeader
        title={t("manageGroups.title")}
        subtitle={t(
          formation === "teacher"
            ? "manageGroups.teacherFormationHint"
            : "manageGroups.studentFormationHint",
        )}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              disabled={syncSnapshot.isPending}
              onClick={() => void resync()}
            >
              {/* The sync icon doubles as the progress indicator (spinning in
                  place) — the Button `loading` spinner would render a second
                  one beside it. */}
              <SyncIcon
                aria-hidden="true"
                className={cx(
                  "size-4",
                  syncSnapshot.isPending && "animate-spin",
                )}
              />
              {t("manageGroups.refreshSnapshot")}
            </Button>
            {!noGroupsYet && (
              <>
                {copyGroupsButton}
                {createGroupButton}
              </>
            )}
          </div>
        }
      />

      {actionError && !createOpen && !managedTeam ? (
        <Alert tone="error" className="text-sm">
          {actionError}
        </Alert>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Heading as="h2" variant="title-small">
            {t("manageGroups.heading")}
          </Heading>
          {!teamsQuery.isLoading && (
            <Badge ghost size="sm">
              {teams.length}
            </Badge>
          )}
        </div>

        {teamsQuery.isLoading ? (
          <SkeletonRegion
            label={t("manageGroups.loading")}
            className="rounded-box border border-base-200"
          >
            <ListSkeletonRows rows={3} />
          </SkeletonRegion>
        ) : teams.length === 0 ? (
          <EmptyState
            icon={PeopleIcon}
            title={t("manageGroups.emptyTitle")}
            titleAs="h3"
            body={t(
              formation === "teacher"
                ? "manageGroups.emptyTeacher"
                : "manageGroups.emptyStudent",
            )}
            action={
              // Both formations get the teacher tools here: student formation
              // waits on students by default, but copying last term's groups
              // or pre-seeding one is still the teacher's call.
              <div className="flex flex-wrap items-center justify-center gap-2">
                {copyGroupsButton}
                {createGroupButton}
              </div>
            }
          />
        ) : (
          <ul className="divide-y divide-base-200 rounded-box border border-base-200">
            {teams.map((team) => (
              <GroupRow
                key={team.slug}
                team={team}
                displayName={teamDisplayName(team)}
                members={membersBySlug.get(team.slug) ?? []}
                maxGroupSize={maxGroupSize}
                drifted={
                  drift.changed.has(team.slug) || drift.missing.has(team.slug)
                }
                repo={repoForTeam(team)}
                fullNameByLogin={fullNameByLogin}
                onManage={openManage}
              />
            ))}
          </ul>
        )}
      </section>

      <UnassignedStudentsPanel
        students={availableStudents}
        groups={openGroups}
        pending={teamsQuery.isLoading || membersPending}
        busy={busy}
        onAdd={handleUnassignedAdd}
      />

      {managedTeam && (
        <ManageGroupDialog
          key={manageSession}
          org={org}
          classroom={classroom}
          assignment={assignmentSlug}
          team={managedTeam}
          formation={formation}
          maxGroupSize={maxGroupSize}
          onClose={() => setManagedTeam(null)}
        />
      )}

      <CopyGroupsModal
        key={`copy-${copySession}`}
        open={copyOpen}
        onClose={() => setCopyOpen(false)}
        org={org}
        classroom={classroom}
        assignmentSlug={assignmentSlug}
        formation={formation}
        maxGroupSize={maxGroupSize}
        existingGroupCount={teams.length}
        takenLogins={assignedLogins}
        availableStudents={availableStudents}
        fullNameByLogin={fullNameByLogin}
        rosterLogins={rosterLogins}
        creatorLogin={user?.login ?? ""}
        sourceOptions={copySourceOptions}
      />

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        closeDisabled={createTeam.isPending}
        size="md"
        title={t("manageGroups.createTitle")}
        headerVisual={
          <ModalIcon tone="primary">
            <PeopleIcon aria-hidden="true" className="size-4" />
          </ModalIcon>
        }
        footer={
          <>
            <Button
              variant="ghost"
              disabled={createTeam.isPending}
              onClick={() => setCreateOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !user?.login}
              loading={createTeam.isPending}
              loadingLabel={t("manageGroups.createButton")}
              onClick={() => void handleCreate()}
            >
              {t("manageGroups.createButton")}
            </Button>
          </>
        }
      >
        <div className="mt-4 flex flex-col gap-4">
          {actionError ? (
            <Alert tone="error" className="text-sm">
              {actionError}
            </Alert>
          ) : null}
          <FormField
            label={t("manageGroups.createNameLabel")}
            hint={t("manageGroups.createNameHint")}
          >
            {({ id, describedById }) => (
              <Input
                id={id}
                aria-describedby={describedById}
                value={displayName}
                maxLength={80}
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void handleCreate()
                  }
                }}
              />
            )}
          </FormField>
        </div>
      </Modal>
    </>
  )
}

export default GroupsManager
