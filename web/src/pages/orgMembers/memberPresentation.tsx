import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { InfoIcon, ShieldCheckIcon } from "@/components/ui/icons"

import { Badge } from "@/components/ui"
import { CellPlaceholder } from "@/components/memberList/memberPresentation"
import type { GitHubClient } from "@/github-core/client"
import { inviteMemberToOrg } from "@/domain/orgMembers/inviteMemberToOrg"
import type { OrgMemberRow } from "@/util/orgMembers"
import { memberStatusBadges } from "@/util/orgMemberUI"
import { errorText } from "@/types/localizedMessage"

// Org-specific member presentation. The view-agnostic primitives (initialsFor,
// GitHubIdentity) moved down to components/memberList/memberPresentation so a
// shared component can use them without a components->pages reach-up; they are
// re-exported here so existing importers keep working unchanged.
// The badge components and runInviteMember stay here — they read
// `classification` and invite to the org, so they are genuinely org-feature
// code; the chip recipe itself is single-sourced in util/orgMemberUI.
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

// The table's Status column: every chip memberStatusBadges yields (the
// failed record, the classification, CSV/team drift), or the empty
// placeholder for a healthy member. The drift chip carries the classroom list
// as a title, since the cell has no room for it.
export const MemberStatusBadge = ({ row }: { row: OrgMemberRow }) => {
  const { t } = useTranslation()
  const badges = memberStatusBadges(row)
  if (badges.length === 0) return <CellPlaceholder />
  return (
    <span className="flex flex-wrap items-center gap-1">
      {badges.map((badge) => (
        <Badge
          key={badge.labelKey}
          tone={badge.tone}
          className="whitespace-nowrap"
          title={
            badge.labelKey === "orgMembers.unprovisionedBadge"
              ? t("orgMembers.unprovisionedTitle", {
                  classrooms: row.unprovisionedClassrooms.join(", "),
                })
              : undefined
          }
        >
          {t(badge.labelKey)}
        </Badge>
      ))}
    </span>
  )
}

// The detail modal's header chips: the same status list as the table, and
// when there is nothing to flag, the org role so the header isn't blank
// (Owner takes precedence; a member on no roster is still a member).
export const ClassificationBadge = ({
  row,
  isOwner = false,
}: {
  row: OrgMemberRow
  isOwner?: boolean
}) => {
  const { t } = useTranslation()
  const badges = memberStatusBadges(row)
  if (badges.length > 0) {
    return (
      <span className="flex flex-wrap items-center justify-end gap-1">
        {badges.map((badge) => (
          <Badge key={badge.labelKey} tone={badge.tone}>
            {t(badge.labelKey)}
          </Badge>
        ))}
      </span>
    )
  }
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

// Shared invite flow for the inline row button and the detail modal. It
// resolves the localized outcome copy and hands it to explicit callbacks so
// each call site owns its own surface (the page toasts both; the modal
// routes failures into its in-dialog banner) — routing is compiler-checked
// instead of inferred from a notify payload's tone.
export const runInviteMember = async (
  client: GitHubClient,
  org: string,
  row: OrgMemberRow,
  handlers: {
    onSuccess: (message: string) => void
    onError: (message: string) => void
  },
  onDone: () => void,
  t: TFunction,
) => {
  const label = row.username || row.email
  try {
    const result = await inviteMemberToOrg(client, { org, row })
    const who = result.currentUsername ? `@${result.currentUsername}` : label
    // Nothing new went out for pending/active: say so, and where to act, rather
    // than claim an invitation was sent.
    handlers.onSuccess(
      result.state === "invited"
        ? t("toasts.invited", { who, org })
        : result.state === "pending"
          ? t("orgMembers.inviteAlreadyPending", { who, org })
          : t("orgMembers.inviteAlreadyMember", { who, org }),
    )
    onDone()
  } catch (err) {
    handlers.onError(
      t("orgMembers.inviteFailed", {
        label,
        reason: errorText(t, err),
      }),
    )
  }
}
