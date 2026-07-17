import { ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"
import Avatar from "@/components/avatar"
import { Badge, rtlFlip } from "@/components/ui"
import { RoleBadges } from "./RoleBadges"
import { GitHubIdentity } from "@/pages/orgMembers/memberPresentation"
import { STATE_BADGE_TONE, STATE_LABEL_KEY } from "@/util/classroomRoleUI"
import { rosterRowToMemberRow, rosterRowInitials } from "@/util/memberRow"
import { ClickableRow } from "@/lib/motionComponents"
import type { TeamRosterRow } from "@/util/teamRoster"

// One roster row: avatar + identity, role/section/state badges, and the
// selection checkbox (disabled for the signed-in teacher's own row). Clicking
// the row opens the detail modal; the checkbox is selection-only.
export const RosterRow = ({
  row,
  selfRow,
  checked,
  onOpen,
  onCheckboxClick,
  onToggle,
}: {
  row: TeamRosterRow
  selfRow: boolean
  checked: boolean
  onOpen: (key: string) => void
  onCheckboxClick: (
    event: React.MouseEvent<HTMLInputElement>,
    key: string,
  ) => void
  onToggle: (key: string) => void
}) => {
  const { t } = useTranslation()
  const member = rosterRowToMemberRow(row)
  const displayName = member.name
  const displayHandle = row.username || row.email
  const displayInitials = rosterRowInitials(row)

  return (
    <ClickableRow
      className="group/row flex cursor-pointer items-center justify-between gap-4 px-6 py-4 hover:bg-base-200"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row.key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen(row.key)
        }
      }}
    >
      <input
        type="checkbox"
        className="checkbox checkbox-sm shrink-0"
        aria-label={
          selfRow
            ? t("students.bulk.selfNotSelectable")
            : t("students.bulk.selectRow", { label: displayHandle })
        }
        disabled={selfRow}
        title={selfRow ? t("students.bulk.selfNotSelectable") : undefined}
        checked={checked}
        onClick={(e) => {
          e.stopPropagation()
          onCheckboxClick(e, row.key)
        }}
        onChange={() => onToggle(row.key)}
      />
      <div className="min-w-0 flex-1">
        <Avatar
          name={displayName}
          github={displayHandle}
          initials={displayInitials}
          subtitle={<GitHubIdentity row={member} />}
        />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Enrolled/pending rows assert role(s) (the team is the authority),
            shown as one badge per role via RoleBadges. Needs-attention rows have
            no team role yet, so they render no role badge. */}
        {row.state === "needs_attention_in_org" ||
        row.state === "needs_attention_not_in_org" ? null : (
          <RoleBadges roles={row.roles} />
        )}
        {row.section.trim() ? (
          <Badge tone="info" className="shrink-0">
            {row.section.trim()}
          </Badge>
        ) : null}
        {row.state !== "enrolled" ? (
          <Badge
            size="sm"
            tone={STATE_BADGE_TONE[row.state]}
            className="shrink-0"
          >
            {t(STATE_LABEL_KEY[row.state])}
          </Badge>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          className={`size-4 text-base-content/30 transition-transform duration-150 ltr:group-hover/row:translate-x-0.5 rtl:group-hover/row:-translate-x-0.5 group-hover/row:text-base-content/70 ${rtlFlip}`}
        />
      </div>
    </ClickableRow>
  )
}
