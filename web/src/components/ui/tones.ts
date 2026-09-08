import type { BadgeTone } from "@/types/badgeTone"

// The two tinted recipes that aren't a Badge or an Alert, each written once so
// a page can't hand-copy it (AGENTS.md: one recipe, one source).

// A soft tint of a semantic token with a matching border and readable
// foreground: the inline note and the setup summary callouts.
export type SoftTintTone = "success" | "warning" | "error" | "neutral"
export const softTintToneClass: Record<SoftTintTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  error: "border-error/30 bg-error/10 text-error",
  neutral: "border-base-300 bg-base-200 text-base-content/80",
}

// A borderless tinted chip or row: the activity timeline's status chip and the
// Actions banner's expanded rows. Static map (not a template string) so
// Tailwind's content scanner keeps every class.
export const chipToneClass: Record<BadgeTone, string> = {
  error: "bg-error/10 text-error",
  warning: "bg-warning/10 text-warning",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
  primary: "bg-primary/10 text-primary",
  secondary: "bg-secondary/10 text-secondary",
  neutral: "bg-base-300 text-base-content",
}
