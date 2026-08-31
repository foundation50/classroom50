import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  Alert,
  Badge,
  Button,
  Card,
  Heading,
  Input,
  Modal,
  MonoLtr,
  Select,
} from "@/components/ui"
import {
  PeopleIcon,
  PlusIcon,
  SyncIcon,
  TrashIcon,
} from "@/components/ui/icons"
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
import useCreateGroupTeam from "@/hooks/mutations/useCreateGroupTeam"
import useDeleteGroupTeam from "@/hooks/mutations/useDeleteGroupTeam"
import useAddGroupTeamMember from "@/hooks/mutations/useAddGroupTeamMember"
import useRemoveGroupTeamMember from "@/hooks/mutations/useRemoveGroupTeamMember"
import { useSyncTeamsSnapshot } from "@/hooks/mutations/useSaveTeamsSnapshot"
import { snapshotDrift } from "@/domain/teams/teamsFile"
import type { GroupTeamRef } from "@/domain/teams/groupTeams"

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
      ? t("assignmentSettings.teams.errors.createForbidden")
      : t("assignmentSettings.teams.errors.membershipForbidden")
  }
  return fallback
}

// Teacher-side management of a team-mode assignment's group teams: list, form
// (create + membership), delete, and keep the teams.json snapshot in step.
// For teacher formation this is where groups come to exist; for student
// formation it's read-mostly (teams appear as students form them) with the
// same controls available to fix membership.
export function GroupTeamsSection({
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
  const { membersBySlug, logins: assignedLogins } = useGroupTeamMembers(
    org,
    slugs,
  )

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
  // Students not on ANY of this assignment's teams — the add picker's options.
  const availableStudents = useMemo(
    () =>
      enrolled.filter(
        (row) => !assignedLogins.has(row.username.trim().toLowerCase()),
      ),
    [enrolled, assignedLogins],
  )

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
  const syncSnapshot = useSyncTeamsSnapshot({
    org,
    classroom,
    assignment: assignmentSlug,
  })

  const [displayName, setDisplayName] = useState("")
  const [pendingDelete, setPendingDelete] = useState<GroupTeamRef | null>(null)
  const [pickerBySlug, setPickerBySlug] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState<string | null>(null)

  const busy =
    createTeam.isPending ||
    deleteTeam.isPending ||
    addMember.isPending ||
    removeMember.isPending

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
      })
      setDisplayName("")
      await resync()
    } catch (err) {
      setActionError(
        describeTeamWriteError(err, "create", t, errorText(t, err)),
      )
    }
  }

  const handleAdd = async (team: GroupTeamRef) => {
    const username = pickerBySlug[team.slug]?.trim()
    if (!username || busy) return
    setActionError(null)
    try {
      await addMember.mutateAsync({
        teamSlug: team.slug,
        username,
        currentMemberCount: membersBySlug.get(team.slug)?.length ?? 0,
        maxGroupSize,
        rosterLogins,
      })
      setPickerBySlug((prev) => ({ ...prev, [team.slug]: "" }))
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

  const teamDisplayName = (team: GroupTeamRef) =>
    team.name || t("assignmentSettings.teams.defaultName", { n: team.n })

  return (
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
              {t("assignmentSettings.teams.heading")}
            </Heading>
            <p className="mt-1 text-sm text-base-content/70">
              {t(
                formation === "teacher"
                  ? "assignmentSettings.teams.teacherFormationHint"
                  : "assignmentSettings.teams.studentFormationHint",
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
            {t("assignmentSettings.teams.refreshSnapshot")}
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
            placeholder={t("assignmentSettings.teams.namePlaceholder")}
            aria-label={t("assignmentSettings.teams.nameAriaLabel")}
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
            loadingLabel={t("assignmentSettings.teams.createButton")}
            onClick={() => void handleCreate()}
          >
            <PlusIcon aria-hidden="true" className="size-4" />
            {t("assignmentSettings.teams.createButton")}
          </Button>
        </div>

        {teamsQuery.isLoading ? (
          <div className="flex py-10">
            <Spinner
              className="m-auto"
              label={t("assignmentSettings.teams.loading")}
            />
          </div>
        ) : teams.length === 0 ? (
          <p className="py-6 text-center text-sm text-base-content/70">
            {t(
              formation === "teacher"
                ? "assignmentSettings.teams.emptyTeacher"
                : "assignmentSettings.teams.emptyStudent",
            )}
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {teams.map((team) => {
              const members = membersBySlug.get(team.slug) ?? []
              const isFull =
                maxGroupSize !== undefined && members.length >= maxGroupSize
              const drifted =
                drift.changed.has(team.slug) || drift.missing.has(team.slug)
              return (
                <li
                  key={team.slug}
                  className="rounded-box border border-base-200 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{teamDisplayName(team)}</span>
                    <Badge tone="neutral" size="sm">
                      #{team.n}
                    </Badge>
                    <MonoLtr className="text-xs text-base-content/60">
                      {team.slug}
                    </MonoLtr>
                    <span className="ms-auto text-xs text-base-content/70">
                      {maxGroupSize !== undefined
                        ? t("assignmentSettings.teams.memberCountOfMax", {
                            count: members.length,
                            max: maxGroupSize,
                          })
                        : t("assignmentSettings.teams.memberCount", {
                            count: members.length,
                          })}
                    </span>
                    {drifted && (
                      <Badge tone="warning" size="sm">
                        {t("assignmentSettings.teams.driftBadge")}
                      </Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="square"
                      className="text-base-content/70 hover:text-error"
                      disabled={busy}
                      aria-label={t(
                        "assignmentSettings.teams.deleteAriaLabel",
                        {
                          name: teamDisplayName(team),
                        },
                      )}
                      onClick={() => setPendingDelete(team)}
                    >
                      <TrashIcon aria-hidden="true" className="size-4" />
                    </Button>
                  </div>

                  <ul className="mt-3 flex flex-wrap gap-2">
                    {members.map((member) => (
                      <li
                        key={member.login}
                        className="flex items-center gap-2 rounded-full border border-base-200 py-1 ps-1 pe-2 text-sm"
                      >
                        {member.avatar_url ? (
                          <img
                            src={member.avatar_url}
                            alt=""
                            className="size-5 rounded-full"
                          />
                        ) : null}
                        <span>{member.login}</span>
                        <Button
                          variant="ghost"
                          size="xs"
                          shape="square"
                          className="text-base-content/60 hover:text-error"
                          disabled={busy}
                          aria-label={t(
                            "assignmentSettings.teams.removeAriaLabel",
                            { username: member.login },
                          )}
                          onClick={() => void handleRemove(team, member.login)}
                        >
                          <TrashIcon aria-hidden="true" className="size-3" />
                        </Button>
                      </li>
                    ))}
                    {members.length === 0 && (
                      <li className="text-sm text-base-content/70">
                        {t("assignmentSettings.teams.noMembers")}
                      </li>
                    )}
                  </ul>

                  {isFull ? (
                    <p className="mt-3 text-xs text-base-content/70">
                      {t("assignmentSettings.teams.groupFull", {
                        max: maxGroupSize ?? 0,
                      })}
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <Select
                        className="flex-1"
                        selectSize="sm"
                        value={pickerBySlug[team.slug] ?? ""}
                        aria-label={t(
                          "assignmentSettings.teams.addMemberAriaLabel",
                          { name: teamDisplayName(team) },
                        )}
                        onChange={(e) =>
                          setPickerBySlug((prev) => ({
                            ...prev,
                            [team.slug]: e.target.value,
                          }))
                        }
                      >
                        <option value="">
                          {t("assignmentSettings.teams.addMemberPlaceholder")}
                        </option>
                        {availableStudents.map((row) => (
                          <option key={row.key} value={row.username}>
                            {row.first_name || row.last_name
                              ? `${row.first_name} ${row.last_name} (${row.username})`.trim()
                              : row.username}
                          </option>
                        ))}
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || !pickerBySlug[team.slug]}
                        onClick={() => void handleAdd(team)}
                      >
                        <PlusIcon aria-hidden="true" className="size-4" />
                        {t("assignmentSettings.teams.addMemberButton")}
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card.Body>

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t("assignmentSettings.teams.deleteTitle")}
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
              loadingLabel={t("assignmentSettings.teams.deleteConfirm")}
              onClick={() => void handleDelete()}
            >
              {t("assignmentSettings.teams.deleteConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {t("assignmentSettings.teams.deleteBody", {
            name: pendingDelete ? teamDisplayName(pendingDelete) : "",
          })}
        </p>
      </Modal>
    </Card>
  )
}

export default GroupTeamsSection
