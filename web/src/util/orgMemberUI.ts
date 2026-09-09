import type { BadgeTone } from "@/types/badgeTone"
import type { MemberClassification, OrgMemberRow } from "@/util/orgMembers"
import { failedInvitationBadge } from "@/util/classroomRoleUI"

// Single source for how a Members row's standing is presented, the way
// classroomRoleUI is for the roster: the table's Status column and the detail
// modal both render this list, so the two can't drift (they were hand-synced
// before, and the modal had already lost the "Not enrolled" chip).
export type MemberStatusBadge = { labelKey: string; tone: BadgeTone }

// Classification -> chip. Healthy members get none: the Roles column already
// says Member/Owner, and the Status column is for what needs attention.
const CLASSIFICATION_BADGE: Partial<
  Record<MemberClassification, MemberStatusBadge>
> = {
  "on-roster-not-member": {
    labelKey: "orgMembers.badgeNotMember",
    tone: "error",
  },
  "invitation-pending": {
    labelKey: "orgMembers.badgeInvitePending",
    tone: "warning",
  },
  unlinked: { labelKey: "orgMembers.badgeUnlinked", tone: "neutral" },
}

export function memberStatusBadges(row: OrgMemberRow): MemberStatusBadge[] {
  const badges: MemberStatusBadge[] = []
  if (row.failed_invitation)
    badges.push(failedInvitationBadge(row.failed_invitation))
  const byClass = CLASSIFICATION_BADGE[row.classification]
  if (byClass) badges.push(byClass)
  // CSV/team drift is a member-only fact (a non-member has nothing to be on a
  // team of), so it never stacks with the chips above.
  if (row.isMember && row.unprovisionedClassrooms.length > 0) {
    badges.push({ labelKey: "orgMembers.unprovisionedBadge", tone: "warning" })
  }
  return badges
}
