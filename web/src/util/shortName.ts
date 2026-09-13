// Classroom short-names and assignment slugs both flow into repo/team names.
// Byte-mirror of the CLI's validate.ShortNamePattern (2-100 chars). The cap is
// per-segment — a READ-side tolerance so pre-cap documents keep validating.
// Write paths layer the composed repo-name budget on top (#691): see
// repoNameBudget (CLASSROOM_SHORT_NAME_MAX_LEN, composedRepoNameFits).
import { STAFF_ROLES, type StaffRole } from "@/types/classroom"

export const SHORT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/
export const SHORT_NAME_PATTERN_DESCRIPTION =
  "2-100 chars, lowercase letters/digits/hyphens, starting with a letter or digit"

// A short-name with consecutive/trailing hyphens slugifies to something other
// than `classroom50-<short>`, breaking the team slug. Mirrors the CLI's
// CanonicalTeamSlugShortName.
export function isCanonicalTeamShortName(shortName: string): boolean {
  return !shortName.endsWith("-") && !shortName.includes("--")
}

// Well-shaped check (pattern + canonical-team form) for the create-form
// validators.
export function isValidShortName(shortName: string): boolean {
  return (
    SHORT_NAME_PATTERN.test(shortName) && isCanonicalTeamShortName(shortName)
  )
}

// The staff role suffix a NEW classroom short-name must not end in, or null.
// Such a classroom's student team `classroom50-<short>` would sit at another
// classroom's staff slug (`ml-ta` -> `classroom50-ml-ta`, which is `ml`'s TA
// team), so every path that derives a staff team from a slug would have to
// disambiguate the two. Creation-time only: an existing classroom with such a
// name stays operable. Mirrors the CLI's validate.ClassroomShortNameSuffix.
export function reservedShortNameSuffix(shortName: string): StaffRole | null {
  return STAFF_ROLES.find((role) => shortName.endsWith(`-${role}`)) ?? null
}
