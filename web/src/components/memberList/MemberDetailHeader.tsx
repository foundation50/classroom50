import Avatar from "@/components/avatar"
import {
  GitHubIdentity,
  initialsFor,
} from "@/components/memberList/memberPresentation"
import type { MemberListRow } from "@/util/memberRow"

// The identity block shared by the Org Members and classroom roster detail
// modals: avatar + GitHub identity line + optional email. The "Manage on
// GitHub" affordance lives in each modal's footer, not here.
const MemberDetailHeader = ({ row }: { row: MemberListRow }) => {
  const label = row.username || row.email

  return (
    <Avatar
      name={row.name || label}
      github={row.username}
      initials={initialsFor(row)}
      subtitle={
        <span className="flex flex-col gap-0.5">
          <GitHubIdentity row={row} />
          {row.email ? (
            <span className="text-xs text-base-content/70">{row.email}</span>
          ) : null}
        </span>
      }
    />
  )
}

export default MemberDetailHeader
