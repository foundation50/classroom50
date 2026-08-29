import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import {
  AlertIcon,
  InfoIcon,
  ReadIcon,
  ShieldCheckIcon,
} from "@/components/ui/icons"

import { Badge } from "@/components/ui"
import { CellPlaceholder } from "@/components/memberList/memberPresentation"
import type { GitHubClient } from "@/github-core/client"
import type { NotifyInput } from "@/context/notifications/NotificationProvider"
import { inviteMemberToOrg } from "@/domain/orgMembers/inviteMemberToOrg"
import type { OrgMemberRow } from "@/util/orgMembers"

// Org-specific member presentation. The view-agnostic primitives (initialsFor,
// GitHubIdentity) moved down to components/memberList/memberPresentation so a
// shared component can use them without a components->pages reach-up; they are
// re-exported here so existing importers keep working unchanged.
// ClassificationBadge and runInviteMember stay here — they read `classification`
// and invite to the org, so they are genuinely org-feature code.
export {
  CellPlaceholder,
  GitHubIdentity,
  initialsFor,
} from "@/components/memberList/memberPresentation"

// Org-role badge for the table's Roles column: Owner or Member; a non-member
// shows the empty placeholder (the discrepancy lives in the Status column).
export const OrgRoleBadge = ({
  row,
  isOwner = false,
}: {
  row: OrgMemberRow
  isOwner?: boolean
}) => {
  const { t } = useTranslation()
  if (isOwner) {
    return (
      <Badge tone="info" className="gap-1">
        <ShieldCheckIcon aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeOwner")}
      </Badge>
    )
  }
  if (row.isMember) {
    return <Badge tone="success">{t("orgMembers.badgeMember")}</Badge>
  }
  return <CellPlaceholder />
}

// Health-only badge for the table's Status column: the actionable
// discrepancy, the pending invite, or CSV/team drift; the empty placeholder
// otherwise. The three are mutually exclusive — drift is only computed for
// live members, which the other two are not.
export const MemberStatusBadge = ({ row }: { row: OrgMemberRow }) => {
  const { t } = useTranslation()
  if (row.classification === "on-roster-not-member") {
    return (
      <Badge tone="error" className="gap-1 whitespace-nowrap">
        <AlertIcon aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeNotMember")}
      </Badge>
    )
  }
  if (row.classification === "invitation-pending") {
    return (
      <Badge tone="info" className="gap-1 whitespace-nowrap">
        <ReadIcon aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeInvitePending")}
      </Badge>
    )
  }
  if (row.unprovisionedClassrooms.length > 0) {
    return (
      <Badge
        tone="warning"
        className="gap-1 whitespace-nowrap"
        title={t("orgMembers.unprovisionedTitle", {
          classrooms: row.unprovisionedClassrooms.join(", "),
        })}
      >
        <AlertIcon aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.unprovisionedBadge")}
      </Badge>
    )
  }
  return <CellPlaceholder />
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
      <Badge tone="error" className="gap-1">
        <AlertIcon aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeNotMember")}
      </Badge>
    )
  }
  // An unaccepted email invite. Informational, not a discrepancy: there is no
  // account yet to be missing from the org.
  if (row.classification === "invitation-pending") {
    return (
      <Badge tone="info" className="gap-1">
        <ReadIcon aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeInvitePending")}
      </Badge>
    )
  }
  // An owner/admin is labeled "Owner", not "Member" — takes precedence over the
  // no-roster badge (an owner with no classroom is still an owner).
  if (isOwner) {
    return (
      <Badge tone="info" className="gap-1">
        <ShieldCheckIcon aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeOwner")}
      </Badge>
    )
  }
  if (row.classification === "member-no-roster") {
    return (
      <Badge ghost className="gap-1">
        <InfoIcon aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeNoClassroom")}
      </Badge>
    )
  }
  return <Badge tone="success">{t("orgMembers.badgeMember")}</Badge>
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
    // Kept as a toast: the pending badge lags the eventually-consistent
    // refetch, so the outcome isn't immediately evident in the list.
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
