import type { MemberDefaultSetting } from "@/orgPolicy/desiredState"

// Structured detail the orgDefaults setup step carries in InitStepUpdate.data:
// the member-privilege settings that didn't stick, plus the subset GitHub
// silently refuses because an enterprise policy pins them (a subset of
// `unenforced`).
export type OrgDefaultsStepData = {
  unenforced: MemberDefaultSetting[]
  enterprisePinned: MemberDefaultSetting[]
}

// One row of the failed-settings list: the setting, its by-hand fix, and whether
// it's enterprise-pinned (unfixable from the org, shown as a badge).
export type UnenforcedDefaultItem = {
  field: string
  desc: string
  manualFix: string
  pinned: boolean
}

// tryStep forwards the whole step result as `data: unknown`, so narrow it before
// rendering — a shape change must render nothing, not throw.
export function isOrgDefaultsStepData(
  data: unknown,
): data is OrgDefaultsStepData {
  if (typeof data !== "object" || data === null) return false
  const d = data as Record<string, unknown>
  return Array.isArray(d.unenforced) && Array.isArray(d.enterprisePinned)
}

// Render every unenforced field, flagging the enterprise-pinned subset by field.
export function unenforcedDefaultItems(
  data: OrgDefaultsStepData,
): UnenforcedDefaultItem[] {
  const pinned = new Set(data.enterprisePinned.map((s) => s.field))
  return data.unenforced.map((s) => ({
    field: s.field,
    desc: s.desc,
    manualFix: s.manualFix,
    pinned: pinned.has(s.field),
  }))
}
