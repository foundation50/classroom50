import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Info, ShieldCheck } from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import type { GitHubClient } from "@/hooks/github/client"
import type { NotifyInput } from "@/context/notifications/NotificationProvider"
import { inviteMemberToOrg } from "@/pages/orgMembers/inviteMemberToOrg"
import type { OrgMemberRow } from "@/util/orgMembers"

// Presentation helpers shared by the Members list rows and the member-detail
// modal: the avatar-initial fallback, the GitHub identity line, the
// classification badge, and the shared invite flow. Kept in one module so the
// row and the modal render members identically and there's a single invite path.

// First initial of a row's best display string, for the avatar fallback.
export const initialsFor = (row: OrgMemberRow) =>
  (row.name || row.username || row.email || "?")[0]?.toUpperCase() ?? "?"

// GitHub identity line: makes it explicit these are GitHub members by showing
// the @username and the immutable numeric GitHub id together.
export const GitHubIdentity = ({ row }: { row: OrgMemberRow }) => {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-base-content/70">
      <GitHub aria-hidden="true" className="size-3.5 opacity-50" />
      {row.username ? (
        <span className="font-mono">@{row.username}</span>
      ) : (
        <span className="italic">{t("orgMembers.noGitHubUsername")}</span>
      )}
      {row.github_id ? (
        <span className="text-base-content/70">
          {t("orgMembers.idSuffix", { id: row.github_id })}
        </span>
      ) : null}
    </span>
  )
}

export const ClassificationBadge = ({
  row,
  isOwner = false,
}: {
  row: OrgMemberRow
  isOwner?: boolean
}) => {
  const { t } = useTranslation()
  if (row.classification === "on-roster-not-member") {
    return (
      <span className="badge badge-sm badge-error badge-soft gap-1">
        <AlertTriangle aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeNotMember")}
      </span>
    )
  }
  // An org owner/admin is labeled "Owner", not "Member" — takes precedence over
  // the no-roster badge (an owner with no classroom is still an owner).
  if (isOwner) {
    return (
      <span className="badge badge-sm badge-info badge-soft gap-1">
        <ShieldCheck aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeOwner")}
      </span>
    )
  }
  if (row.classification === "member-no-roster") {
    return (
      <span className="badge badge-sm badge-ghost gap-1">
        <Info aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeNoClassroom")}
      </span>
    )
  }
  return (
    <span className="badge badge-sm badge-success badge-soft">
      {t("orgMembers.badgeMember")}
    </span>
  )
}

// Shared invite flow for the inline row button and the detail modal. Errors are
// toasted here so both call sites only track their own in-flight flag.
export const runInviteMember = async (
  client: GitHubClient,
  org: string,
  row: OrgMemberRow,
  notify: (input: NotifyInput) => void,
  onDone: () => void,
  t: TFunction,
) => {
  const label = row.username || row.email
  try {
    const result = await inviteMemberToOrg(client, { org, row })
    const who = result.currentUsername ? `@${result.currentUsername}` : label
    notify({
      tone: "success",
      durationMs: 6000,
      message: t("toasts.invited", { who, org }),
    })
    onDone()
  } catch (err) {
    notify({
      tone: "error",
      message: t("orgMembers.inviteFailed", {
        label,
        reason:
          err instanceof Error ? err.message : t("orgMembers.somethingWrong"),
      }),
    })
  }
}
