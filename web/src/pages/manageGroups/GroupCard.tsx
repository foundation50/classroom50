import { useState } from "react"
import { useTranslation } from "react-i18next"

import {
  Badge,
  Button,
  HelpTooltip,
  Input,
  MonoLtr,
  Select,
} from "@/components/ui"
import {
  CheckIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "@/components/ui/icons"
import { GitHubLink } from "@/components/GitHubLink"
import type { GitHubUser } from "@/github-core/types"
import type { GroupTeamPrivacy, GroupTeamRef } from "@/domain/teams/groupTeams"

// A roster student the add picker can offer (not on any group team yet).
export type GroupPickerStudent = {
  key: string
  username: string
  label: string
}

// One group's management card: display name (+ inline rename), counter/slug,
// member count vs cap, drift badge, repo status, visibility control, member
// chips with remove, roster add picker, and the delete trigger. All writes are
// delegated to the page, which owns the mutations and the shared error alert.
export function GroupCard({
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
  // Resolves true on success so the card can close the edit form; the page
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
    <li className="rounded-box border border-base-200 p-4">
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
            <span className="font-medium">{displayName}</span>
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
        <Badge tone="neutral" size="sm">
          #{team.n}
        </Badge>
        <MonoLtr className="text-xs text-base-content/60">{team.slug}</MonoLtr>
        <span className="ms-auto text-xs text-base-content/70">
          {maxGroupSize !== undefined
            ? t("manageGroups.memberCountOfMax", {
                count: members.length,
                max: maxGroupSize,
              })
            : t("manageGroups.memberCount", { count: members.length })}
        </span>
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
          aria-label={t("manageGroups.deleteAriaLabel", { name: displayName })}
          onClick={() => onDelete(team)}
        >
          <TrashIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        {repo === undefined ? null : repo ? (
          <GitHubLink
            href={repo.htmlUrl}
            label={t("manageGroups.repo.openRepository")}
            title={repo.name}
            className="shrink-0"
          />
        ) : (
          <span className="inline-flex items-center gap-1">
            <Badge ghost size="sm" className="text-base-content/60">
              {t("manageGroups.repo.noRepoBadge")}
            </Badge>
            <HelpTooltip help={t("manageGroups.repo.noRepoHelp")} />
          </span>
        )}
        {team.privacy && (
          <label className="inline-flex items-center gap-2 text-xs text-base-content/70">
            {t("manageGroups.visibility.label")}
            <Select
              selectSize="sm"
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
            <HelpTooltip help={t("manageGroups.visibility.help")} />
          </label>
        )}
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
              aria-label={t("manageGroups.removeAriaLabel", {
                username: member.login,
              })}
              onClick={() => onRemoveMember(team, member.login)}
            >
              <TrashIcon aria-hidden="true" className="size-3" />
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
        <p className="mt-3 text-xs text-base-content/70">
          {t("manageGroups.groupFull", { max: maxGroupSize ?? 0 })}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Select
            className="flex-1"
            selectSize="sm"
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
            variant="outline"
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

export default GroupCard
