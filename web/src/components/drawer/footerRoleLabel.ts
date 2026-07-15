// Pure derivation of the sidebar footer's org-level role label, split from the
// component so its branching is unit-testable. The classroom-route branch stays
// inline in the component (it maps a resolved classroom role through
// roleLabelKey/i18n; this helper has no "owner" concept to reuse there).
//
// Non-obvious gotcha: owner-pending only counts as a spinner when an org is in
// scope. Off the $org boundary useGitHubOrgRole stays `unresolved` forever, so
// gating on `hasOrg` prevents a permanent spinner on the org-less /orgs list.

export type OrgFooterLabelInput = {
  hasOrg: boolean
  isOrgSetup: boolean
  isOwner: boolean
  ownerPending: boolean
  // Owner read settled in a transient error (retries exhausted). The verdict is
  // not trustworthy, so it neither grants "Instructor" nor falls back to
  // "Student".
  ownerError: boolean
  isStudent: boolean
  roleLoading: boolean
}

export type OrgFooterLabel = {
  // Translation key, or null for no label. Callers pass through t().
  labelKey: "nav.roleInstructor" | "nav.roleStudent" | null
  pending: boolean
}

export function orgFooterRoleLabel(input: OrgFooterLabelInput): OrgFooterLabel {
  const {
    hasOrg,
    isOrgSetup,
    isOwner,
    ownerPending,
    ownerError,
    isStudent,
    roleLoading,
  } = input

  const ownerUnsettled = ownerPending || ownerError

  let labelKey: OrgFooterLabel["labelKey"] = null
  if (isOrgSetup || isOwner) {
    labelKey = "nav.roleInstructor"
  } else if (!ownerUnsettled && !roleLoading && isStudent) {
    labelKey = "nav.roleStudent"
  }

  return {
    labelKey,
    pending: roleLoading || (hasOrg && ownerPending),
  }
}
