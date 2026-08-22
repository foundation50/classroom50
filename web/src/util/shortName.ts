import { localizedError } from "@/types/localizedMessage"

// Classroom short-names and assignment slugs both flow into repo/team names.
// Byte-mirror of the CLI's validate.ShortNamePattern (2-100 chars). The cap is
// per-segment, not a guarantee the composed repo name fits GitHub's 100-char
// limit — see foundation50/classroom50#691.
export const SHORT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/
export const SHORT_NAME_PATTERN_DESCRIPTION =
  "2-100 chars, lowercase letters/digits/hyphens, starting with a letter or digit"

// A short-name with consecutive/trailing hyphens slugifies to something other
// than `classroom50-<short>`, breaking the team slug. Mirrors the CLI's
// CanonicalTeamSlugShortName.
export function isCanonicalTeamShortName(shortName: string): boolean {
  return !shortName.endsWith("-") && !shortName.includes("--")
}

// Boolean well-shaped check (pattern + canonical-team form) for the create-form
// validators, which can't consume assertValidShortName's thrown localized error.
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
