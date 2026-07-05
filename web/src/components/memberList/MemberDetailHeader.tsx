import { ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"

import Avatar from "@/components/avatar"
import {
  GitHubIdentity,
  initialsFor,
} from "@/pages/orgMembers/memberPresentation"
import type { MemberListRow } from "@/util/memberRow"

// The identity header shared by the Org Members detail modal and the classroom
// roster detail modal: avatar + GitHub identity line + a "Manage on GitHub"
// link. This is the genuinely common surface between the two otherwise-disjoint
// modal bodies; everything below it (per-classroom access vs. metadata edit /
// unenroll / resend) stays view-owned.
const MemberDetailHeader = ({
  row,
  org,
}: {
  row: MemberListRow
  org: string
}) => {
  const { t } = useTranslation()
  const label = row.username || row.email

  return (
    <div className="flex flex-col gap-4">
      <Avatar
        name={row.name || label}
        github={row.username}
        initials={initialsFor(row)}
        subtitle={<GitHubIdentity row={row} />}
      />

      <a
        href={`https://github.com/orgs/${org}/people${
          row.username ? `?query=${encodeURIComponent(row.username)}` : ""
        }`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline"
      >
        <ExternalLink aria-hidden="true" className="size-3.5" />
        {t("orgMembers.manageOnGitHub")}
      </a>
    </div>
  )
}

export default MemberDetailHeader
