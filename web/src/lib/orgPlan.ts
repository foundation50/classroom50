// Org-plan eligibility for Classroom 50. GitHub's GET /orgs/{org} only returns
// `plan` to org owners, so it's often absent (unknown) for a non-owner member.
// Team/Enterprise are supported; free isn't. Unknown must never be treated as
// free — we'd hide orgs the user can actually work with.

export type PlanCategory = "supported" | "free" | "unknown"

export function classifyPlan(name?: string): PlanCategory {
  if (name === "team" || name === "enterprise") return "supported"
  if (name === "free") return "free"
  return "unknown"
}
