import { ChevronRightIcon } from "@/components/ui/icons"
import { useTranslation } from "react-i18next"
import Avatar from "@/components/avatar"
import { Badge, rtlFlip } from "@/components/ui"
import { RoleBadges } from "./RoleBadges"
import { GitHubIdentity } from "@/pages/orgMembers/memberPresentation"
import { STATE_BADGE_TONE, STATE_LABEL_KEY } from "@/util/classroomRoleUI"
import { rosterRowToMemberRow, rosterRowInitials } from "@/util/memberRow"
import { ClickableTr } from "@/lib/motionComponents"
import type { TeamRosterRow } from "@/util/teamRoster"

// Primer-style placeholder for a cell with nothing to report (an enrolled
// member's Status, a section-less row), so an empty cell reads as intentional.
const CellPlaceholder = () => (
  <span aria-hidden="true" className="text-base-content/60">
    —
  </span>
)

// One roster table row: selection checkbox, avatar + identity, then role /
// section / state cells (the checkbox is disabled for the viewer's own row and
// for rows the bulk bar can't act on). Clicking the row opens the detail
// modal; the checkbox is selection-only.
export const RosterRow = ({
  row,
  selfRow,
  checked,
  onOpen,
  onCheckboxClick,
  onToggle,
  selectable = true,
  showSection = false,
}: {
  row: TeamRosterRow
  selfRow: boolean
  // False when the bulk bar can't act on this row. Rendered as a disabled
  // checkbox so it reads as unavailable rather than silently ignoring the click.
  selectable?: boolean
  checked: boolean
  onOpen: (key: string) => void
  onCheckboxClick: (
    event: React.MouseEvent<HTMLInputElement>,
    key: string,
  ) => void
  onToggle: (key: string) => void
  // Whether the table renders the Section column (only when some row has one).
  showSection?: boolean
}) => {
  const { t } = useTranslation()
  const member = rosterRowToMemberRow(row)
  const displayName = member.name
  const displayHandle = row.username || row.email
  const displayInitials = rosterRowInitials(row)

  // Enrolled/pending rows assert role(s) (the team is the authority), shown as
  // one badge per role via RoleBadges. Needs-attention rows have no team role
  // yet, so they render the empty-cell placeholder.
  const hasRoles =
    row.state !== "needs_attention_in_org" &&
    row.state !== "needs_attention_not_in_org" &&
    row.roles.length > 0
  const section = row.section.trim()

  return (
    <ClickableTr
      className="group/row hover:bg-base-200"
      onClick={() => onOpen(row.key)}
    >
      <td className="w-0">
        <input
          type="checkbox"
          className="checkbox checkbox-sm size-6"
          aria-label={
            selfRow
              ? t("students.bulk.selfNotSelectable")
              : t("students.bulk.selectRow", { label: displayHandle })
          }
          disabled={selfRow || !selectable}
          title={selfRow ? t("students.bulk.selfNotSelectable") : undefined}
          checked={checked}
          onClick={(e) => {
            e.stopPropagation()
            onCheckboxClick(e, row.key)
          }}
          onChange={() => onToggle(row.key)}
        />
      </td>
      <td className="min-w-0">
        <Avatar
          name={displayName}
          github={displayHandle}
          initials={displayInitials}
          subtitle={<GitHubIdentity row={member} />}
          onClick={() => onOpen(row.key)}
        />
      </td>
      <td>
        {hasRoles ? (
          <div className="flex flex-wrap items-center gap-1">
            <RoleBadges roles={row.roles} />
          </div>
        ) : (
          <CellPlaceholder />
        )}
      </td>
      {showSection ? (
        <td>
          {section ? (
            <Badge tone="info" className="whitespace-nowrap">
              {section}
            </Badge>
          ) : (
            <CellPlaceholder />
          )}
        </td>
      ) : null}
      <td>
        {row.state !== "enrolled" ? (
          <Badge
            size="sm"
            tone={STATE_BADGE_TONE[row.state]}
            className="whitespace-nowrap"
          >
            {t(STATE_LABEL_KEY[row.state])}
          </Badge>
        ) : (
          <CellPlaceholder />
        )}
      </td>
      <td className="w-0 ps-2">
        <div className="flex items-center justify-end">
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-4 text-base-content/30 transition-transform duration-150 ltr:group-hover/row:translate-x-0.5 rtl:group-hover/row:-translate-x-0.5 group-hover/row:text-base-content/70 ${rtlFlip}`}
          />
        </div>
      </td>
    </ClickableTr>
  )
}
