import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"

import {
  LinkExternalIcon,
  MarkGithubIcon,
  PeopleIcon,
  PlusIcon,
  SignOutIcon,
  TrashIcon,
} from "@/components/ui/icons"
import { Alert, Badge, Button, Input } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { Spinner } from "@/components/Spinner"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { teamMembersQuery } from "@/github-core/queries"
import useAddGroupTeamMember from "@/hooks/mutations/useAddGroupTeamMember"
import useRemoveGroupTeamMember from "@/hooks/mutations/useRemoveGroupTeamMember"
import useLeaveGroupTeam from "@/hooks/mutations/useLeaveGroupTeam"
import { groupTeamUrl } from "@/domain/teams/groupTeams"
import { errorText } from "@/types/localizedMessage"
import { normalizeUsername } from "@/components/modals/collaboratorHelpers"
import type { TeamFormation } from "@/types/classroom"

// Member management for a TEAM-mode group: the group is a real GitHub Team, so
// members come from live team membership (not repo collaborators — that is
// the legacy group modal's model). Adds enforce max_group_size in the domain
// gate; GitHub enforces who may write (team maintainer or org owner).
export function GroupTeamMembersPanel({
  org,
  classroom,
  assignment,
  teamSlug,
  teamName,
  maxGroupSize,
  viewerLogin,
  formation,
  canManage: canManageOverride,
  onMembershipChange,
}: {
  org: string
  classroom: string
  assignment: string
  teamSlug: string
  teamName?: string
  maxGroupSize?: number
  viewerLogin?: string
  // Student-formed groups gain the join-request affordances: a review link to
  // the team's GitHub page (the REST API exposes no join requests, so
  // requesting and approving live there) and the viewer's typed-confirmation
  // "Leave group". Teacher-formed groups show neither — the teacher owns
  // membership there.
  formation?: TeamFormation
  // Management-controls override for surfaces whose viewer's power doesn't
  // come from team membership (the teacher, an org owner). When absent, the
  // controls follow the viewer's team role: only a maintainer sees add/remove
  // — GitHub rejects a plain member's membership writes anyway, so a
  // non-maintainer must not be shown controls that can only fail.
  canManage?: boolean
  // Fired after a successful add/remove, for callers that maintain a
  // membership snapshot (the teacher surfaces); the student panel omits it.
  onMembershipChange?: () => void
}) {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const [newMember, setNewMember] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingLeave, setConfirmingLeave] = useState(false)

  const membersQuery = useQuery(teamMembersQuery(client, org, teamSlug))
  const members = membersQuery.data ?? []

  const addMember = useAddGroupTeamMember({ org, classroom, assignment })
  const removeMember = useRemoveGroupTeamMember({ org, classroom, assignment })
  const leaveTeam = useLeaveGroupTeam({ org, classroom, assignment })
  const busy =
    addMember.isPending || removeMember.isPending || leaveTeam.isPending

  const isFull = maxGroupSize !== undefined && members.length >= maxGroupSize
  const viewerMember = viewerLogin
    ? members.find(
        (m) => normalizeUsername(m.login) === normalizeUsername(viewerLogin),
      )
    : undefined
  const viewerIsMember = Boolean(viewerMember)
  const viewerIsMaintainer = viewerMember?.role === "maintainer"
  // Only a maintainer (or an override caller — the teacher) may manage
  // membership; GitHub rejects a plain member's writes, so the controls are
  // hidden rather than shown-to-fail.
  const canManage = canManageOverride ?? viewerIsMaintainer
  const studentFormed = formation === "student"
  const groupName = teamName || t("components.groupTeamMembers.title")

  const handleAdd = async () => {
    const username = normalizeUsername(newMember)
    if (!username || busy) return
    if (members.some((m) => normalizeUsername(m.login) === username)) {
      setNewMember("")
      return
    }
    setActionError(null)
    try {
      await addMember.mutateAsync({
        teamSlug,
        username,
        currentMemberCount: members.length,
        maxGroupSize,
      })
      setNewMember("")
      onMembershipChange?.()
    } catch (err) {
      setActionError(errorText(t, err))
    }
  }

  const handleRemove = async (username: string) => {
    if (busy) return
    setActionError(null)
    try {
      await removeMember.mutateAsync({ teamSlug, username })
      onMembershipChange?.()
    } catch (err) {
      setActionError(errorText(t, err))
    }
  }

  // Typed-confirmation leave (ConfirmModal renders and validates the phrase):
  // rejoining needs a fresh request-and-approval round on GitHub, so leaving
  // must never be one accidental click. Errors surface inside the modal.
  const handleLeave = async () => {
    if (!viewerLogin) return
    await leaveTeam.mutateAsync({ teamSlug, username: viewerLogin })
    setConfirmingLeave(false)
    onMembershipChange?.()
  }

  return (
    <div className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-100 p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <PeopleIcon aria-hidden="true" className="size-4" />
          {groupName}
        </span>
        <span className="text-xs text-base-content/70">
          {maxGroupSize !== undefined
            ? t("components.groupTeamMembers.memberCountOfMax", {
                count: members.length,
                max: maxGroupSize,
              })
            : t("components.groupTeamMembers.memberCount", {
                count: members.length,
              })}
        </span>
      </div>

      {actionError ? (
        <Alert tone="error" className="text-sm">
          {actionError}
        </Alert>
      ) : null}

      {membersQuery.isLoading ? (
        <div className="flex py-6">
          <Spinner
            className="m-auto"
            label={t("components.groupTeamMembers.loading")}
          />
        </div>
      ) : (
        <ul className="divide-y divide-base-200 rounded-box border border-base-200">
          {members.map((member) => (
            <li
              key={member.login}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              {member.avatar_url ? (
                <img
                  src={member.avatar_url}
                  alt=""
                  className="size-5 shrink-0 rounded-full"
                />
              ) : (
                <MarkGithubIcon
                  aria-hidden="true"
                  className="size-5 shrink-0 text-base-content/70"
                />
              )}
              <span className="min-w-0 flex-1 truncate leading-tight">
                {member.login}
              </span>
              {member.role === "maintainer" && (
                <Badge ghost>
                  {t("components.groupTeamMembers.maintainerBadge")}
                </Badge>
              )}
              {viewerLogin &&
                normalizeUsername(member.login) ===
                  normalizeUsername(viewerLogin) && (
                  <Badge tone="primary">
                    {t("components.groupTeamMembers.youBadge")}
                  </Badge>
                )}
              {/* Membership writes are maintainer/owner-only, and a
                  maintainer's own exit is Leave (blocked for them below), so
                  the remove control never targets the viewer's own row. */}
              {canManage &&
                !(
                  viewerLogin &&
                  normalizeUsername(member.login) ===
                    normalizeUsername(viewerLogin)
                ) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    shape="square"
                    className="text-base-content/70 hover:text-error"
                    disabled={busy}
                    aria-label={t("components.groupTeamMembers.removeUser", {
                      username: member.login,
                    })}
                    onClick={() => void handleRemove(member.login)}
                  >
                    <TrashIcon aria-hidden="true" className="size-4" />
                  </Button>
                )}
            </li>
          ))}
          {members.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-base-content/70">
              {t("components.groupTeamMembers.noMembers")}
            </li>
          )}
        </ul>
      )}

      {canManage &&
        (isFull ? (
          <p className="text-xs text-base-content/70">
            {t("components.groupTeamMembers.groupFull", {
              max: maxGroupSize ?? 0,
            })}
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              className="flex-1"
              placeholder={t("components.groupTeamMembers.addPlaceholder")}
              aria-label={t("components.groupTeamMembers.addAriaLabel")}
              value={newMember}
              onChange={(e) => setNewMember(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void handleAdd()
                }
              }}
            />
            <Button
              variant="outline"
              disabled={busy}
              loading={addMember.isPending}
              onClick={() => void handleAdd()}
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              {t("components.groupTeamMembers.add")}
            </Button>
          </div>
        ))}

      {studentFormed && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-base-200 pt-3">
          {/* Join requests exist only on GitHub: a visible team's page carries
              the native request-to-join flow, and the REST API exposes none of
              it — so both requesting and reviewing deep-link there. Reviewing
              is a maintainer power, so only managers get the link. */}
          {canManage ? (
            <a
              className="link link-hover inline-flex items-center gap-1.5 text-sm"
              href={groupTeamUrl(org, teamSlug)}
              target="_blank"
              rel="noreferrer"
            >
              {t("components.groupTeamMembers.reviewJoinRequests")}
              <LinkExternalIcon aria-hidden="true" className="size-3.5" />
            </a>
          ) : (
            <span />
          )}
          {/* A maintainer never leaves their own group: the group would be
              left without anyone who can manage it. A plain member's only
              membership control is leaving. */}
          {viewerIsMember && !viewerIsMaintainer && (
            <Button
              variant="ghost"
              size="sm"
              className="text-error"
              disabled={busy}
              onClick={() => setConfirmingLeave(true)}
            >
              <SignOutIcon aria-hidden="true" className="size-4" />
              {t("components.groupTeamMembers.leave")}
            </Button>
          )}
          {viewerIsMember && viewerIsMaintainer && (
            <span className="text-xs text-base-content/70">
              {t("components.groupTeamMembers.maintainerCannotLeave")}
            </span>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirmingLeave}
        title={t("components.groupTeamMembers.leaveTitle", {
          name: groupName,
        })}
        description={t("components.groupTeamMembers.leaveBody", {
          name: groupName,
        })}
        confirmText={groupName}
        confirmLabel={t("components.groupTeamMembers.leaveConfirm")}
        tone="error"
        onConfirm={handleLeave}
        onClose={() => setConfirmingLeave(false)}
      />
    </div>
  )
}

export default GroupTeamMembersPanel
