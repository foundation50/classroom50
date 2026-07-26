import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { classifyDefaults } from "@/orgPolicy/desiredState"

// The two member-privilege fields that decide whether a student can create their
// assignment repository. The master switch gates repo creation at all; the
// private switch decides whether the private repo accept asks for is allowed. On
// Team/Free the granular booleans are slaved to the master switch, which is why
// the verdicts come from classifyDefaults rather than a hand-rolled read.
const MASTER_SWITCH = "members_can_create_repositories"
const PRIVATE_SWITCH = "members_can_create_private_repositories"

export type OrgRepoCreationWarning =
  | { show: false }
  // Which field is off decides the copy: the master switch and the private
  // checkbox are different controls with different remedies, so one shared
  // message would name the wrong one half the time.
  | { show: true; field: "master" | "private" }

// Whether to warn a teacher that the org will refuse student repo creation,
// before a student hits the accept-time 403 (issue #413).
//
// Reuses the org-policy seam: `classifyDefaults` is the single source of truth
// for interpreting a GET /orgs/{org} response, already marks the master switch
// `critical`, and already encodes the Team/Free master-switch slaving. This is the
// assignment-scoped view of the same signal OrgPreflightNotice shows owners on
// ClassesPage — keep the two copies in step.
const useOrgRepoCreationWarning = (
  org: string | undefined,
): OrgRepoCreationWarning => {
  const { data, isPending, isError } = useGetOrgPlanDetails(org)

  if (!org || isPending || isError || !data) return { show: false }

  // Deliberately inverts classifyDefaults' fail-closed reading for this one
  // consumer: there, an absent field reads as unenforced (`live[field] === value`
  // is false), which is right for an audit. Here it would fire on every
  // non-admin, since GitHub omits the member-privilege fields for them — and a
  // teacher who can't read the setting can't be told anything useful about it.
  // So warn only when the field is explicitly false.
  const live = data as unknown as Record<string, unknown>
  const explicitlyOff = (field: string) => live[field] === false

  const { verdicts } = classifyDefaults(live, data.plan?.name)
  const unenforced = (field: string) =>
    verdicts.some((v) => v.setting.field === field && !v.enforced)

  if (unenforced(MASTER_SWITCH) && explicitlyOff(MASTER_SWITCH)) {
    return { show: true, field: "master" }
  }
  if (unenforced(PRIVATE_SWITCH) && explicitlyOff(PRIVATE_SWITCH)) {
    return { show: true, field: "private" }
  }
  return { show: false }
}

export default useOrgRepoCreationWarning
