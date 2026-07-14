// Pure derivation of the sidebar footer's ORG-LEVEL role label (the branch U1
// changed), split out so its logic is unit-testable without rendering the whole
// drawer. The classroom-route branch stays inline in the component because it
// maps a resolved classroom role through roleLabelKey/i18n.
//
// Rule: only a confirmed org owner shows "Instructor" (a non-owner staffer's
// role is per-classroom, so we leave it blank rather than mislabel a TA).
// Owner-pending only counts as a spinner when an org is in scope — off the $org
// boundary useOrgRole stays `unresolved` forever, so gating on `org` prevents a
// permanent spinner on the org-less /orgs list.

export type OrgFooterLabelInput = {
  hasOrg: boolean
  isOrgSetup: boolean
  isOwner: boolean
  ownerPending: boolean
  isStudent: boolean
  roleLoading: boolean
}

export type OrgFooterLabel = {
  // Translation key, or null for no label. Callers pass through t().
  labelKey: "nav.roleInstructor" | "nav.roleStudent" | null
  pending: boolean
}

export function orgFooterRoleLabel(input: OrgFooterLabelInput): OrgFooterLabel {
  const { hasOrg, isOrgSetup, isOwner, ownerPending, isStudent, roleLoading } =
    input

  let labelKey: OrgFooterLabel["labelKey"] = null
  if (isOrgSetup || isOwner) {
    labelKey = "nav.roleInstructor"
  } else if (!ownerPending && !roleLoading && isStudent) {
    labelKey = "nav.roleStudent"
  }

  return {
    labelKey,
    pending: roleLoading || (hasOrg && ownerPending),
  }
}
