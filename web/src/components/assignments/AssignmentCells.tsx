import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui"
import {
  dueDeadlineInstant,
  formatDueDate,
  formatDueDateTime,
  formatRelativeToNow,
  isPastDue,
} from "@/util/formatDate"
import type { Assignment } from "@/types/classroom"

// Shared cell recipes for the teacher and student assignment tables, so the
// two lists read as one design (one recipe, one source).

// The individual/group type chip: fixed width so the column aligns down the
// rows; info vs secondary distinguishes the modes at a glance. Team mode is
// the product's "Group" — the legacy collaborator-based mode is labeled
// "Group (legacy)" (wider chip: the longer label would clip at w-20).
export function ModeBadge({ mode }: { mode: Assignment["mode"] }) {
  const { t } = useTranslation()
  if (mode === "team") {
    return (
      <Badge tone="secondary" className="w-20 justify-center max-xl:w-16">
        {t("assignments.table.group")}
      </Badge>
    )
  }
  if (mode === "group") {
    return (
      <Badge tone="secondary" soft className="w-28 justify-center max-xl:w-24">
        {t("assignments.table.groupLegacy")}
      </Badge>
    )
  }
  return (
    <Badge tone="info" className="w-20 justify-center max-xl:w-16">
      {t("assignments.table.individual")}
    </Badge>
  )
}

// The due-date cell. Dates are data, not status: a real date renders as plain
// text with the full timestamp on hover, and "no due date" is muted
// placeholder text. Overdue is a state, so it keeps the error badge, unless
// `highlightOverdue` is off: for a student who already submitted, a red past
// deadline reads as "you missed it". `relative` appends the live countdown
// ("in 3 days"), on for the student list and off for the denser teacher table.
// The countdown uses dueDeadlineInstant so bare-date deadlines agree with
// isPastDue on end-of-local-day semantics.
export function DueDateCell({
  due,
  relative = false,
  highlightOverdue = true,
}: {
  due?: string
  relative?: boolean
  highlightOverdue?: boolean
}) {
  const { t } = useTranslation()
  if (!due) {
    return (
      <span className="whitespace-nowrap text-base-content/60 max-xl:text-xs xl:text-sm">
        {t("assignments.table.noDueDate")}
      </span>
    )
  }
  const countdown = relative
    ? ` (${formatRelativeToNow(dueDeadlineInstant(due) ?? new Date(due))})`
    : ""
  if (highlightOverdue && isPastDue(due)) {
    return (
      <Badge
        tone="error"
        className="whitespace-nowrap"
        title={formatDueDateTime(due)}
      >
        {formatDueDate(due)}
        {countdown}
      </Badge>
    )
  }
  return (
    <span
      className="whitespace-nowrap max-xl:text-xs xl:text-sm"
      title={formatDueDateTime(due)}
    >
      {formatDueDate(due)}
      {countdown}
    </span>
  )
}
