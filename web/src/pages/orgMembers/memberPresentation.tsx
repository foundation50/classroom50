import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { AlertTriangle, Info, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui"
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
  GitHubIdentity,
  initialsFor,
} from "@/components/memberList/memberPresentation"

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
        <AlertTriangle aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeNotMember")}
      </Badge>
    )
  }
  // An owner/admin is labeled "Owner", not "Member" — takes precedence over the
  // no-roster badge (an owner with no classroom is still an owner).
  if (isOwner) {
    return (
      <Badge tone="info" className="gap-1">
        <ShieldCheck aria-hidden="true" className="size-3" />{" "}
        {t("orgMembers.badgeOwner")}
      </Badge>
    )
  }
  if (row.classification === "member-no-roster") {
    return (
      <Badge ghost className="gap-1">
        <Info aria-hidden="true" className="size-3" />{" "}
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
