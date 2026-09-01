import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, Button, Card, Heading, Input, Modal } from "@/components/ui"
import { PeopleIcon, PlusIcon, SyncIcon } from "@/components/ui/icons"
import { Spinner } from "@/components/Spinner"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { GitHubAPIError } from "@/github-core/errors"
import { errorText } from "@/types/localizedMessage"
import type { TeamFormation } from "@/types/classroom"
import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import useGroupTeams from "@/hooks/useGroupTeams"
import useGroupTeamMembers from "@/hooks/useGroupTeamMembers"
import useTeamsSnapshot from "@/hooks/useTeamsSnapshot"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useCreateGroupTeam from "@/hooks/mutations/useCreateGroupTeam"
import useDeleteGroupTeam from "@/hooks/mutations/useDeleteGroupTeam"
import useAddGroupTeamMember from "@/hooks/mutations/useAddGroupTeamMember"
import useRemoveGroupTeamMember from "@/hooks/mutations/useRemoveGroupTeamMember"
import useRenameGroupTeam from "@/hooks/mutations/useRenameGroupTeam"
import useUpdateGroupTeamPrivacy from "@/hooks/mutations/useUpdateGroupTeamPrivacy"
import { useSyncTeamsSnapshot } from "@/hooks/mutations/useSaveTeamsSnapshot"
import { snapshotDrift } from "@/domain/teams/teamsFile"
import { unassignedRosterStudents } from "@/domain/teams/groupTeams"
import type { GroupTeamPrivacy, GroupTeamRef } from "@/domain/teams/groupTeams"
import { groupRepoName } from "@/util/studentRepo"
import { GroupCard } from "./GroupCard"
import { UnassignedStudentsPanel } from "./UnassignedStudentsPanel"

// The two guardrail 403s named in copy instead of a raw GitHub message: an org
// that restricts team creation to owners, and a team-sync/IdP-managed team
// that refuses membership writes.
function describeTeamWriteError(
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

// Teacher-side management of a team-mode assignment's group teams: list, form
// (create + membership), rename, visibility, delete, the unassigned-students
// panel, and keeping the teams.json snapshot in step. For teacher formation
// this is where groups come to exist; for student formation it's read-mostly
// (teams appear as students form them) with the same controls available to
// fix membership.
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
  // Students not on ANY of this assignment's teams — the add pickers' options
  // and the unassigned panel's rows.
  const availableStudents = useMemo(
    () =>
      unassignedRosterStudents(enrolled, assignedLogins).map((row) => ({
        key: row.key,
        username: row.username,
        label:
          row.first_name || row.last_name
            ? `${row.first_name} ${row.last_name} (${row.username})`.trim()
            : row.username,
      })),
    [enrolled, assignedLogins],
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
  const deleteTeam = useDeleteGroupTeam({
    org,
    classroom,
    assignment: assignmentSlug,
  })
  const addMember = useAddGroupTeamMember({
    org,
    classroom,
    assignment: assignmentSlug,
  })
  const removeMember = useRemoveGroupTeamMember({
    org,
    classroom,
    assignment: assignmentSlug,
  })
  const renameTeam = useRenameGroupTeam({
    org,
    classroom,
    assignment: assignmentSlug,
  })
  const updatePrivacy = useUpdateGroupTeamPrivacy({
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
  const [pendingDelete, setPendingDelete] = useState<GroupTeamRef | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const busy =
    createTeam.isPending ||
    deleteTeam.isPending ||
    addMember.isPending ||
    removeMember.isPending ||
    renameTeam.isPending ||
    updatePrivacy.isPending

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

  const handleCreate = async () => {
    if (!user?.login || busy) return
    setActionError(null)
    try {
      await createTeam.mutateAsync({
        displayName: displayName.trim() || undefined,
        creatorLogin: user.login,
        formation,
      })
      setDisplayName("")
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

  const handleRemove = async (team: GroupTeamRef, username: string) => {
    if (busy) return
    setActionError(null)
    try {
      await removeMember.mutateAsync({ teamSlug: team.slug, username })
      await resync()
    } catch (err) {
      setActionError(
        describeTeamWriteError(err, "membership", t, errorText(t, err)),
      )
    }
  }

  const handleDelete = async () => {
    if (!pendingDelete || busy) return
    setActionError(null)
    const target = pendingDelete
    try {
      await deleteTeam.mutateAsync({ slug: target.slug, id: target.id })
      setPendingDelete(null)
      await resync()
    } catch (err) {
      setPendingDelete(null)
      setActionError(errorText(t, err))
    }
  }

  // Display-name only: the team NAME (== slug) never changes, so the group's
  // repository keeps its name. True on success so the card closes its editor.
  const handleRename = async (team: GroupTeamRef, name: string) => {
    if (busy) return false
    setActionError(null)
    try {
      await renameTeam.mutateAsync({ teamSlug: team.slug, name })
      await resync()
      return true
    } catch (err) {
      setActionError(errorText(t, err))
      return false
    }
  }

  const handlePrivacy = async (
    team: GroupTeamRef,
    privacy: GroupTeamPrivacy,
  ) => {
    if (busy || team.privacy === privacy) return
    setActionError(null)
    try {
      await updatePrivacy.mutateAsync({ teamSlug: team.slug, privacy })
    } catch (err) {
      setActionError(
        describeTeamWriteError(err, "membership", t, errorText(t, err)),
      )
    }
  }

  const teamDisplayName = (team: GroupTeamRef) =>
    team.name || t("manageGroups.defaultName", { n: team.n })

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
          label: team.name || t("manageGroups.defaultName", { n: team.n }),
        })),
    [teams, membersBySlug, maxGroupSize, t],
  )

  const handleUnassignedAdd = (username: string, teamSlug: string) => {
    const team = teams.find((candidate) => candidate.slug === teamSlug)
    if (team) void handleAdd(team, username)
  }

  return (
    <>
      <Card bordered={false} className="mb-6 w-full border border-base-200">
        <Card.Body className="gap-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Heading
                as="h2"
                variant="title-small"
                className="flex items-center gap-2"
              >
                <PeopleIcon aria-hidden="true" className="size-5" />
                {t("manageGroups.heading")}
              </Heading>
              <p className="mt-1 text-sm text-base-content/70">
                {t(
                  formation === "teacher"
                    ? "manageGroups.teacherFormationHint"
                    : "manageGroups.studentFormationHint",
                )}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              disabled={syncSnapshot.isPending}
              loading={syncSnapshot.isPending}
              onClick={() => void resync()}
            >
              <SyncIcon aria-hidden="true" className="size-4" />
              {t("manageGroups.refreshSnapshot")}
            </Button>
          </div>

          {actionError ? (
            <Alert tone="error" className="text-sm">
              {actionError}
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              className="flex-1"
              value={displayName}
              maxLength={80}
              placeholder={t("manageGroups.namePlaceholder")}
              aria-label={t("manageGroups.nameAriaLabel")}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
            />
            <Button
              variant="primary"
              disabled={busy || !user?.login}
              loading={createTeam.isPending}
              loadingLabel={t("manageGroups.createButton")}
              onClick={() => void handleCreate()}
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              {t("manageGroups.createButton")}
            </Button>
          </div>

          {teamsQuery.isLoading ? (
            <div className="flex py-10">
              <Spinner className="m-auto" label={t("manageGroups.loading")} />
            </div>
          ) : teams.length === 0 ? (
            <p className="py-6 text-center text-sm text-base-content/70">
              {t(
                formation === "teacher"
                  ? "manageGroups.emptyTeacher"
                  : "manageGroups.emptyStudent",
              )}
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {teams.map((team) => (
                <GroupCard
                  key={team.slug}
                  team={team}
                  displayName={teamDisplayName(team)}
                  members={membersBySlug.get(team.slug) ?? []}
                  maxGroupSize={maxGroupSize}
                  drifted={
                    drift.changed.has(team.slug) || drift.missing.has(team.slug)
                  }
                  busy={busy}
                  repo={repoForTeam(team)}
                  availableStudents={availableStudents}
                  onAddMember={(target, username) =>
                    void handleAdd(target, username)
                  }
                  onRemoveMember={(target, username) =>
                    void handleRemove(target, username)
                  }
                  onDelete={setPendingDelete}
                  onRename={handleRename}
                  onPrivacyChange={(target, privacy) =>
                    void handlePrivacy(target, privacy)
                  }
                />
              ))}
            </ul>
          )}
        </Card.Body>

        <Modal
          open={pendingDelete !== null}
          onClose={() => setPendingDelete(null)}
          title={t("manageGroups.deleteTitle")}
          footer={
            <>
              <Button
                variant="ghost"
                disabled={deleteTeam.isPending}
                onClick={() => setPendingDelete(null)}
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
            {t("manageGroups.deleteBody", {
              name: pendingDelete ? teamDisplayName(pendingDelete) : "",
            })}
          </p>
        </Modal>
      </Card>

      <UnassignedStudentsPanel
        students={availableStudents}
        groups={openGroups}
        pending={teamsQuery.isLoading || membersPending}
        busy={busy}
        onAdd={handleUnassignedAdd}
      />
    </>
  )
}

export default GroupsManager
