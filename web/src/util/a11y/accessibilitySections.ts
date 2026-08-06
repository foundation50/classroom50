// The /accessibility page's sections and their URL-hash deep links, shared by
// the page (which renders the active panel) and the public drawer (which links
// to each). Keeping this in one leaf module lets the drawer reference the
// sections without importing the page (a components -> pages boundary breach).
//
// The hash is the single source of truth for the active section: /accessibility
// (no hash) shows the default (conformance); /accessibility#color-contrast
// deep-links to the contrast report, and so on — shareable and back/forward
// friendly.

export type AccessibilitySection =
  "conformance" | "color-contrast" | "statement" | "downloads"

// Ordered for both the drawer nav and back/forward-friendly deep links. The
// hash IS the section id, so no separate mapping is needed. `navLabelKey` is a
// short form for the narrow drawer rail so long labels don't truncate.
export const ACCESSIBILITY_SECTIONS: {
  id: AccessibilitySection
  navLabelKey: string
}[] = [
  {
    id: "color-contrast",
    navLabelKey: "accessibility.nav.contrast",
  },
  {
    id: "conformance",
    navLabelKey: "accessibility.nav.vpat",
  },
  {
    id: "downloads",
    navLabelKey: "accessibility.nav.downloads",
  },
  {
    id: "statement",
    navLabelKey: "accessibility.nav.statement",
  },
]

export const DEFAULT_ACCESSIBILITY_SECTION: AccessibilitySection = "conformance"

const VALID = new Set<string>(ACCESSIBILITY_SECTIONS.map((s) => s.id))

// Resolve a raw location hash (with or without the leading "#") to a section,
// falling back to the default for an empty/unknown hash.
export function sectionFromHash(
  hash: string | undefined,
): AccessibilitySection {
  const id = (hash ?? "").replace(/^#/, "")
  return VALID.has(id)
    ? (id as AccessibilitySection)
    : DEFAULT_ACCESSIBILITY_SECTION
}
