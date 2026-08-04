// Alt-text quality heuristic — the low-quality `alt` cases that PASS axe's
// `image-alt` rule but still fail WCAG 1.1.1 in spirit (a filename, a vague
// placeholder, or text that just repeats an adjacent label). Modeled on the
// idea behind @github/accessibility-scanner-alt-text-plugin (KTD7), but kept as
// a pure, dependency-free util/ leaf so it can run in the fast hermetic gate.
//
// This checks the STRING, not the DOM: callers (a lint rule, a test, or the
// scheduled scanner's richer plugin) supply the alt value and optional adjacent
// text. `null`/absent alt is out of scope here — that is axe's `image-alt` job;
// this only judges the quality of a PRESENT, non-empty alt.

export type AltTextIssue =
  "filename" | "placeholder" | "redundantWord" | "duplicateOfAdjacentText"

export type AltTextFinding = {
  issue: AltTextIssue
  /** Why it was flagged — safe to surface to a developer. */
  detail: string
}

// Common raster/vector extensions that betray a raw filename used as alt.
const FILENAME_RE = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?)$/i
// A bare token that looks like a filename even without a dir separator.
const FILENAME_LIKE_RE =
  /^[\w\-. ]+\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?)$/i

// Vague/placeholder values that carry no information.
const PLACEHOLDER_VALUES = new Set([
  "image",
  "img",
  "photo",
  "picture",
  "icon",
  "logo",
  "graphic",
  "screenshot",
  "placeholder",
  "untitled",
  "alt",
  "alt text",
  "spacer",
  "thumbnail",
  "avatar",
])

// Words that add nothing because the element role already conveys "image".
const REDUNDANT_WORDS = /\b(image|photo|picture|graphic) of\b/i

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")

/**
 * Return the quality issues with a present alt string. Empty array = no issue
 * this heuristic can see (not a guarantee the alt is good). `adjacentText`, when
 * given, is nearby visible text (e.g. a link label the image sits inside) used
 * to catch alt that merely duplicates it.
 */
export function assessAltText(
  alt: string,
  adjacentText?: string,
): AltTextFinding[] {
  const findings: AltTextFinding[] = []
  const value = alt.trim()
  if (value.length === 0) return findings // empty alt is axe's domain, not ours.

  const lower = normalize(value)

  if (FILENAME_RE.test(value) || FILENAME_LIKE_RE.test(value)) {
    findings.push({
      issue: "filename",
      detail: `alt "${value}" looks like a filename, not a description`,
    })
  }

  if (PLACEHOLDER_VALUES.has(lower)) {
    findings.push({
      issue: "placeholder",
      detail: `alt "${value}" is a generic placeholder`,
    })
  }

  if (REDUNDANT_WORDS.test(value)) {
    findings.push({
      issue: "redundantWord",
      detail: `alt "${value}" starts with a redundant "image/photo of" phrase`,
    })
  }

  if (adjacentText && normalize(adjacentText) === lower && lower.length > 0) {
    findings.push({
      issue: "duplicateOfAdjacentText",
      detail: `alt "${value}" duplicates the adjacent visible text`,
    })
  }

  return findings
}

/** Convenience: true when the alt has no quality issue this heuristic detects. */
export const isLikelyMeaningfulAlt = (
  alt: string,
  adjacentText?: string,
): boolean => assessAltText(alt, adjacentText).length === 0
