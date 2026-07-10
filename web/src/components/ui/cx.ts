// Join class fragments, dropping falsy ones, so primitives can compose their
// canonical DaisyUI recipe with conditional modifiers and a trailing
// `className` escape hatch without leaving stray double spaces. Deliberately
// tiny (no clsx/tailwind-merge dependency) — the app already builds classes
// with template strings; this just centralizes the falsy-drop + trim.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ").trim()
}

// True when `className` already sets a utility in the given family (e.g. `w-`,
// `gap-`), so a primitive can drop its default rather than emit both — cx can't
// merge Tailwind classes and same-property source order is unspecified.
export function hasUtility(
  prefix: string,
  className: string | null | undefined,
): boolean {
  return className ? new RegExp(`(?:^|\\s)${prefix}`).test(className) : false
}
