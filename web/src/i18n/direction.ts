// Text direction for the active language. Users can sideload arbitrary BCP-47
// codes (see customLocale.ts), so RTL detection matches on the primary subtag
// ("ar-EG" -> "ar") rather than exact codes.

// Primary subtags rendered right-to-left. Duplicated in the anti-flash script
// in index.html (which runs before this module loads) — keep the two in sync.
export const RTL_LANGS = new Set(["ar", "he", "fa", "ur"])

// Whether a BCP-47 code is a right-to-left language, by primary subtag.
export function isRtlLang(code: string): boolean {
  const primary = code.toLowerCase().split("-")[0] ?? ""
  return RTL_LANGS.has(primary)
}

// Reflect the active language on <html>: `dir` drives layout mirroring and
// `lang` drives hyphenation, screen readers, and font selection.
export function applyDocumentDirection(code: string): void {
  document.documentElement.dir = isRtlLang(code) ? "rtl" : "ltr"
  document.documentElement.lang = code
}
