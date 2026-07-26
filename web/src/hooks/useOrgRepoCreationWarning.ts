import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import {
  classifyDefaults,
  MEMBERS_CAN_CREATE_PRIVATE_REPOSITORIES,
  MEMBERS_CAN_CREATE_REPOSITORIES,
} from "@/orgPolicy/desiredState"

export type OrgRepoCreationWarning =
  | { show: false }
  // Which field is off decides the copy: the master switch and the private
  // checkbox are different controls with different remedies, so one shared
  // message would name the wrong one half the time.
  | { show: true; field: "master" | "private" }

// Whether to warn a teacher that the org will refuse student repo creation,
// before a student hits the accept-time 403 (issue #413).
//
// Scope comes from `classifyDefaults`, the single source of truth for which
// settings apply to a plan, so a field the plan filters out can never warn.
//
// Fails open on the value: warn only when GitHub reports the field as explicitly
// `false`. This deliberately inverts `classifyDefaults`' fail-closed reading,
// where an absent field counts as unenforced — right for an audit, wrong here,
// because GitHub omits the member-privilege fields for non-admins and a teacher
// who cannot read the setting cannot be told anything useful about it.
//
// The read is shared: `useGetOrgPlanDetails` keys on githubKeys.orgDetails with a
// 10-minute staleTime, and every org-scoped page already issues it, so mounting
// the notice on several surfaces costs no extra request.
const useOrgRepoCreationWarning = (
  org: string | undefined,
): OrgRepoCreationWarning => {
  const { data, isPending, isError } = useGetOrgPlanDetails(org)

  if (!org || isPending || isError || !data) return { show: false }

  const inScope = new Set(
    classifyDefaults(
      data as unknown as Record<string, unknown>,
      data.plan?.name,
    ).verdicts.map((v) => v.setting.field),
  )

  if (
    inScope.has(MEMBERS_CAN_CREATE_REPOSITORIES) &&
    data.members_can_create_repositories === false
  ) {
    return { show: true, field: "master" }
  }
  if (
    inScope.has(MEMBERS_CAN_CREATE_PRIVATE_REPOSITORIES) &&
    data.members_can_create_private_repositories === false
  ) {
    return { show: true, field: "private" }
  }
  return { show: false }
}

export default useOrgRepoCreationWarning
