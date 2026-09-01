import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Badge, Button, Input, Select } from "@/components/ui"
import {
  CheckIcon,
  LinkExternalIcon,
  PencilIcon,
  PlusIcon,
  RepoIcon,
  TrashIcon,
  XIcon,
} from "@/components/ui/icons"
import type { GitHubUser } from "@/github-core/types"
import type { GroupTeamPrivacy, GroupTeamRef } from "@/domain/teams/groupTeams"

// A roster student the add picker can offer (not on any group team yet).
export type GroupPickerStudent = {
  key: string
  username: string
  label: string
}

// One row of the groups list: display name (+ inline rename), counter chip,
// drift badge, delete trigger, then a muted metadata line (member count, repo
// status, visibility) and the member chips with the quiet add picker. All
// writes are delegated to the page, which owns the mutations and the shared
// error alert.
export function GroupRow({
  team,
  displayName,
  members,
  maxGroupSize,
  drifted,
  busy,
  repo,
  availableStudents,
  onAddMember,
  onRemoveMember,
  onDelete,
  onRename,
  onPrivacyChange,
}: {
  team: GroupTeamRef
  displayName: string
  members: GitHubUser[]
  maxGroupSize?: number
  drifted: boolean
  busy: boolean
  // The group's repository: undefined while the org repo list loads (claim
  // nothing), null when no member has accepted yet, else name + link.
  repo: { name: string; htmlUrl: string } | null | undefined
  availableStudents: GroupPickerStudent[]
  onAddMember: (team: GroupTeamRef, username: string) => void
  onRemoveMember: (team: GroupTeamRef, username: string) => void
  onDelete: (team: GroupTeamRef) => void
  // Resolves true on success so the row can close the edit form; the page
  // surfaces failures in its shared alert and the form stays open.
  onRename: (team: GroupTeamRef, name: string) => Promise<boolean>
  onPrivacyChange: (team: GroupTeamRef, privacy: GroupTeamPrivacy) => void
}) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState("")
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState("")

  const isFull = maxGroupSize !== undefined && members.length >= maxGroupSize

  const startEditing = () => {
    setNameDraft(team.name ?? "")
    setEditing(true)
  }

  const saveName = async () => {
    if (busy) return
    if (await onRename(team, nameDraft.trim())) setEditing(false)
  }

  return (
    <li className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                inputSize="sm"
                className="flex-1"
                value={nameDraft}
                maxLength={80}
                placeholder={t("manageGroups.defaultName", { n: team.n })}
                aria-label={t("manageGroups.rename.nameAriaLabel", {
                  name: displayName,
                })}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void saveName()
                  }
                  if (e.key === "Escape") setEditing(false)
                }}
              />
              <Button
                variant="outline"
                size="sm"
                shape="square"
                disabled={busy}
                aria-label={t("manageGroups.rename.saveAriaLabel", {
                  name: displayName,
                })}
                onClick={() => void saveName()}
              >
                <CheckIcon aria-hidden="true" className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                disabled={busy}
                aria-label={t("common.cancel")}
                onClick={() => setEditing(false)}
              >
                <XIcon aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <p className="text-xs text-base-content/70">
              {t("manageGroups.rename.help")}
            </p>
          </div>
        ) : (
          <>
            {/* The canonical team slug stays out of the row copy; it lives in
                the hover title for anyone who needs the exact name. */}
            <span className="font-semibold" title={team.slug}>
              {displayName}
            </span>
            <Badge ghost size="sm">
              #{team.n}
            </Badge>
            <Button
              variant="ghost"
              size="xs"
              shape="square"
              className="text-base-content/60"
              disabled={busy}
              aria-label={t("manageGroups.rename.editAriaLabel", {
                name: displayName,
              })}
              onClick={startEditing}
            >
              <PencilIcon aria-hidden="true" className="size-3.5" />
            </Button>
          </>
        )}
        <span className="ms-auto flex items-center gap-2">
          {drifted && (
            <Badge tone="warning" size="sm">
              {t("manageGroups.driftBadge")}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            className="text-base-content/70 hover:text-error"
            disabled={busy}
            aria-label={t("manageGroups.deleteAriaLabel", {
              name: displayName,
            })}
            onClick={() => onDelete(team)}
          >
            <TrashIcon aria-hidden="true" className="size-4" />
          </Button>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-base-content/70">
        <span>
          {maxGroupSize !== undefined
            ? t("manageGroups.memberCountOfMax", {
                count: members.length,
                max: maxGroupSize,
              })
            : t("manageGroups.memberCount", { count: members.length })}
        </span>
        {repo === undefined ? null : repo ? (
          <a
            href={repo.htmlUrl}
            target="_blank"
            rel="noreferrer"
            title={repo.name}
            className="shrink-0 hover:opacity-80"
          >
            <Badge tone="success" size="sm" className="gap-1">
              <RepoIcon aria-hidden="true" className="size-3" />
              {t("manageGroups.repo.createdBadge")}
              <LinkExternalIcon aria-hidden="true" className="size-3" />
            </Badge>
          </a>
        ) : (
          <Badge
            ghost
            size="sm"
            className="gap-1 text-base-content/60"
            title={t("manageGroups.repo.noRepoHelp")}
          >
            <RepoIcon aria-hidden="true" className="size-3" />
            {t("manageGroups.repo.noRepoBadge")}
          </Badge>
        )}
        {team.privacy && (
          <label
            className="inline-flex items-center gap-2"
            title={t("manageGroups.visibility.help")}
          >
            {t("manageGroups.visibility.label")}
            <Select
              selectSize="sm"
              className="w-auto"
              value={team.privacy}
              disabled={busy}
              aria-label={t("manageGroups.visibility.ariaLabel", {
                name: displayName,
              })}
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
          </label>
        )}
      </div>

      <ul className="flex flex-wrap items-center gap-2">
        {members.map((member) => (
          <li
            key={member.login}
            className="flex items-center gap-1.5 rounded-full border border-base-200 py-0.5 ps-0.5 pe-1 text-sm"
          >
            {member.avatar_url ? (
              <img
                src={member.avatar_url}
                alt=""
                className="size-6 rounded-full"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex size-6 items-center justify-center rounded-full bg-base-200 text-xs text-primary"
              >
                {member.login.charAt(0).toUpperCase()}
              </span>
            )}
            <span>{member.login}</span>
            <Button
              variant="ghost"
              size="xs"
              shape="circle"
              className="text-base-content/60 hover:text-error"
              disabled={busy}
              aria-label={t("manageGroups.removeAriaLabel", {
                username: member.login,
              })}
              onClick={() => onRemoveMember(team, member.login)}
            >
              <XIcon aria-hidden="true" className="size-3" />
            </Button>
          </li>
        ))}
        {members.length === 0 && (
          <li className="text-sm text-base-content/70">
            {t("manageGroups.noMembers")}
          </li>
        )}
      </ul>

      {isFull ? (
        <p className="text-xs text-base-content/70">
          {t("manageGroups.groupFull", { max: maxGroupSize ?? 0 })}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Select
            selectSize="sm"
            className="select-ghost max-w-xs"
            value={picked}
            aria-label={t("manageGroups.addMemberAriaLabel", {
              name: displayName,
            })}
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="">{t("manageGroups.addMemberPlaceholder")}</option>
            {availableStudents.map((student) => (
              <option key={student.key} value={student.username}>
                {student.label}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !picked}
            onClick={() => {
              onAddMember(team, picked)
              setPicked("")
            }}
          >
            <PlusIcon aria-hidden="true" className="size-4" />
            {t("manageGroups.addMemberButton")}
          </Button>
        </div>
      )}
    </li>
  )
}

export default GroupRow
