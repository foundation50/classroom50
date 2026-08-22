import { localizedError } from "@/types/localizedMessage"

// Classroom short-names and assignment slugs both flow into repo/team names.
// Byte-mirror of the CLI's validate.ShortNamePattern.
//
// The cap is 100 per segment, matching GitHub's repo-name limit. It is NOT a
// full guarantee: `<classroom>-<assignment>-<username>` can exceed 100 even
// though each part is legal, and nothing here budgets the three against each
// other. Deciding that split is open — see foundation50/classroom50#691. Until
// then an overflow surfaces as a legible "name too long" error at accept.
export const SHORT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/
export const SHORT_NAME_PATTERN_DESCRIPTION =
  "2-100 chars, lowercase letters/digits/hyphens, starting with a letter or digit"

// A short-name with consecutive/trailing hyphens slugifies to something other
// than `classroom50-<short>`, breaking the team slug. Mirrors the CLI's
// CanonicalTeamSlugShortName.
export function isCanonicalTeamShortName(shortName: string): boolean {
  return !shortName.endsWith("-") && !shortName.includes("--")
}

// Whether a short-name is well-shaped for both the schema pattern and the
// team-slug canonical form. The boolean form the create-form validators need
// (assertValidShortName throws a localized error, which they can't consume).
export function isValidShortName(shortName: string): boolean {
  return (
    SHORT_NAME_PATTERN.test(shortName) && isCanonicalTeamShortName(shortName)
  )
}

// Validate a short-name (derived or user-supplied) for both the schema pattern
// and the team-slug canonical form. Throws an actionable error otherwise.
// `rawName`, when given, names the free-form source in the error (the migration
// case that slugified it).
export function assertValidShortName(
  shortName: string,
  rawName?: string,
): void {
  if (!SHORT_NAME_PATTERN.test(shortName)) {
    throw localizedError({
      key: rawName
        ? "migration.error.shortNameInvalidFrom"
        : "migration.error.shortNameInvalid",
      params: {
        shortName,
        rawName: rawName ?? "",
        description: SHORT_NAME_PATTERN_DESCRIPTION,
      },
    })
  }
  if (!isCanonicalTeamShortName(shortName)) {
    throw localizedError({
      key: "migration.error.shortNameNotCanonical",
      params: { shortName },
    })
  }
}
