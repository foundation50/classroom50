// Join class fragments, dropping falsy ones, so primitives can compose their
// canonical DaisyUI recipe with conditional modifiers and a trailing
// `className` escape hatch without leaving stray double spaces. Deliberately
// tiny (no clsx/tailwind-merge dependency) — the app already builds classes
// with template strings; this just centralizes the falsy-drop + trim.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ").trim()
}
