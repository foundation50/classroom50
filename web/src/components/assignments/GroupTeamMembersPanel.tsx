import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"

import {
  MarkGithubIcon,
  PeopleIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/ui/icons"
import { Alert, Badge, Button, Input } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { teamMembersQuery } from "@/github-core/queries"
import useAddGroupTeamMember from "@/hooks/mutations/useAddGroupTeamMember"
import useRemoveGroupTeamMember from "@/hooks/mutations/useRemoveGroupTeamMember"
import { errorText } from "@/types/localizedMessage"
import { normalizeUsername } from "@/components/modals/collaboratorHelpers"

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
}: {
  org: string
  classroom: string
  assignment: string
  teamSlug: string
  teamName?: string
  maxGroupSize?: number
  viewerLogin?: string
}) {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const [newMember, setNewMember] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)

  const membersQuery = useQuery(teamMembersQuery(client, org, teamSlug))
  const members = membersQuery.data ?? []

  const addMember = useAddGroupTeamMember({ org, classroom, assignment })
  const removeMember = useRemoveGroupTeamMember({ org, classroom, assignment })
  const busy = addMember.isPending || removeMember.isPending

  const isFull = maxGroupSize !== undefined && members.length >= maxGroupSize

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
    } catch (err) {
      setActionError(errorText(t, err))
    }
  }

  const handleRemove = async (username: string) => {
    if (busy) return
    setActionError(null)
    try {
      await removeMember.mutateAsync({ teamSlug, username })
    } catch (err) {
      setActionError(errorText(t, err))
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-100 p-4">
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <PeopleIcon aria-hidden="true" className="size-4" />
          {teamName || t("components.groupTeamMembers.title")}
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
              {viewerLogin &&
                normalizeUsername(member.login) ===
                  normalizeUsername(viewerLogin) && (
                  <Badge tone="primary">
                    {t("components.groupTeamMembers.youBadge")}
                  </Badge>
                )}
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
            </li>
          ))}
          {members.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-base-content/70">
              {t("components.groupTeamMembers.noMembers")}
            </li>
          )}
        </ul>
      )}

      {isFull ? (
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
      )}
    </div>
  )
}

export default GroupTeamMembersPanel
