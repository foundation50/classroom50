import type { MemberDefaultSetting } from "@/orgPolicy/desiredState"

// Structured detail the orgDefaults setup step carries in InitStepUpdate.data:
// the member-privilege settings that didn't stick, plus the subset the API
// accepted (200) but that still didn't take on read-back — a subset of
// `unenforced` that a Fix it / re-run can't change (often an org or enterprise
// policy, but we can't prove which).
export type OrgDefaultsStepData = {
  unenforced: MemberDefaultSetting[]
  enterprisePinned: MemberDefaultSetting[]
}

// One row of the failed-settings list: the setting, its by-hand fix, and whether
// it's pinned — the write was accepted but didn't stick, so it must be set
// manually (shown as a badge).
export type UnenforcedDefaultItem = {
  field: string
  desc: string
  manualFix: string
  pinned: boolean
}

// The one place a MemberDefaultSetting becomes a display row, shared by the setup
// step and the audit pane so the two can't map differently. `pinnedFields` is the
// subset (by field) that couldn't be written, sourced per surface.
export function toUnenforcedItems(
  settings: MemberDefaultSetting[],
  pinnedFields: Set<string>,
): UnenforcedDefaultItem[] {
  return settings.map((s) => ({
    field: s.field,
    desc: s.desc,
    manualFix: s.manualFix,
    pinned: pinnedFields.has(s.field),
  }))
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

// Render every unenforced field, flagging the pinned subset by field.
export function unenforcedDefaultItems(
  data: OrgDefaultsStepData,
): UnenforcedDefaultItem[] {
  return toUnenforcedItems(
    data.unenforced,
    new Set(data.enterprisePinned.map((s) => s.field)),
  )
}
