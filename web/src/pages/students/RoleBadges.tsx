import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui"
import {
  ROLE_BADGE_TONE,
  ROLE_LABEL_KEY,
  sortRolesByRank,
} from "@/util/rosterRoles"
import type { RosterRole } from "@/util/teamRoster"

// One badge per classroom role a member holds, highest-precedence first
// (instructor > ta > student; student renders as the neutral ghost chip). A
// person on more than one team (e.g. an instructor who is also a student) shows
// a chip for each, making a "mixed team" membership visible at a glance rather
// than collapsing to a single primary role. Uses the shared role presentation
// maps so the roster row and any other role-badge surface can't drift.
export function RoleBadges({ roles }: { roles: RosterRole[] }) {
  const { t } = useTranslation()

  return (
    <>
      {sortRolesByRank(roles).map((role) => (
        <Badge
          key={role}
          size="sm"
          tone={ROLE_BADGE_TONE[role]}
          ghost={role === "student"}
          className="shrink-0"
        >
          {t(ROLE_LABEL_KEY[role])}
        </Badge>
      ))}
    </>
  )
}
