// Pure draft math for the per-group manage dialog: membership edits are
// staged (pending adds/removals) and applied only on Save, mirroring
// GroupCollaboratorsModal's interaction model. Kept out of component state
// math so the capacity/diff rules are unit-testable.

export type MembershipDraftChanges = {
  // Current members marked for removal (original casing, current order).
  toRemove: string[]
  // Pending additions that aren't already members (deduped, draft order).
  toAdd: string[]
  // Member count after the draft applies — what the count line previews.
  resultingCount: number
  hasChanges: boolean
  // Gate for further adds, on the DRAFT count (not the live one).
  atCapacity: boolean
}

// Resolve a draft against the live member list. `removals` holds lowercased
// logins; a removal of a non-member and an addition of an unremoved member
// are both ignored, so a stale draft can never overshoot reality.
export function resolveMembershipDraft(input: {
  currentMembers: readonly string[]
  removals: ReadonlySet<string>
  additions: readonly string[]
  maxGroupSize?: number
}): MembershipDraftChanges {
  const { currentMembers, removals, additions, maxGroupSize } = input
  const currentLower = new Set(
    currentMembers.map((login) => login.trim().toLowerCase()),
  )

  const toRemove = currentMembers.filter((login) =>
    removals.has(login.trim().toLowerCase()),
  )

  const seen = new Set<string>()
  const toAdd: string[] = []
  for (const login of additions) {
    const trimmed = login.trim()
    const lower = trimmed.toLowerCase()
    if (!trimmed || seen.has(lower) || currentLower.has(lower)) continue
    seen.add(lower)
    toAdd.push(trimmed)
  }

  const resultingCount = currentMembers.length - toRemove.length + toAdd.length
  return {
    toRemove,
    toAdd,
    resultingCount,
    hasChanges: toRemove.length > 0 || toAdd.length > 0,
    atCapacity: maxGroupSize !== undefined && resultingCount >= maxGroupSize,
  }
}
