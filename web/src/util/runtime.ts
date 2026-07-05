// Authoring helpers for the language-toolchain and apt fields of an
// assignment's `runtime` block (python/node/java/go versions + extra Ubuntu
// packages). Patterns and rules mirror the CLI's ValidateRuntime (runtime.go)
// and the assignments-v1 schema so a bad value is caught in the form, not by a
// rejected commit.

// The four setup-X toolchains the autograder provisions, ordered for display.
// Keys match the wire fields on `runtime` and the CLI's RuntimeRef.
export const RUNTIME_LANGUAGES = ["python", "node", "java", "go"] as const

export type RuntimeLanguage = (typeof RUNTIME_LANGUAGES)[number]

// Identical to the CLI's LanguageVersionPattern (permissive but injection-safe:
// "3.12", "20", "1.23.4", "latest").
const LANGUAGE_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,32}$/

// Identical to the CLI's AptPackagePattern (lowercase Debian package name).
const APT_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,63}$/

// Human labels + placeholders for the version inputs (defaults the runner uses
// when a field is omitted, so they double as sensible placeholders).
export const RUNTIME_LANGUAGE_META: Record<
  RuntimeLanguage,
  { label: string; placeholder: string }
> = {
  python: { label: "Python", placeholder: "3.12" },
  node: { label: "Node.js", placeholder: "20" },
  java: { label: "Java", placeholder: "21" },
  go: { label: "Go", placeholder: "1.23" },
}

// Split apt packages on commas/whitespace; tolerates an array. Order preserved.
export function parseAptPackages(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : raw.split(/[\s,]+/)
  return parts.map((p) => p.trim()).filter(Boolean)
}

// Join stored apt packages into a single-line input value for editing.
export function aptPackagesToText(packages: string[] | undefined): string {
  return (packages ?? []).join(", ")
}

// Mirror the CLI's per-field language-version check. Returns an error message,
// or undefined when valid. An empty value is valid (field omitted → default).
export function validateLanguageVersion(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (!LANGUAGE_VERSION_PATTERN.test(trimmed)) {
    return "Use letters, numbers, and . _ + - only (e.g. 3.12, 20, 1.23.4)."
  }
  return undefined
}

// Mirror the CLI's per-package apt check. Returns an error message, or
// undefined when valid. An empty list is valid.
export function validateAptPackages(packages: string[]): string | undefined {
  for (const pkg of packages) {
    if (!APT_PACKAGE_PATTERN.test(pkg)) {
      return `Invalid package "${pkg}" — lowercase Debian package name (a-z, 0-9, . + -).`
    }
  }
  return undefined
}
