// Classroom short-names and assignment slugs both flow into repo/team names.
// Byte-mirror of the CLI's validate.ShortNamePattern (2-100 chars). The cap is
// per-segment — a READ-side tolerance so pre-cap documents keep validating.
// Write paths layer the composed repo-name budget on top (#691): see
// repoNameBudget (CLASSROOM_SHORT_NAME_MAX_LEN, composedRepoNameFits).
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
