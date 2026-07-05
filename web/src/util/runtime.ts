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

// Human labels, an example version (placeholder), and a suggested-versions
// menu for each toolchain. NOTE: a version string is itself the enable switch —
// the autograde runner runs a language's setup-* action only when its field is
// non-empty (leaving Node/Java/Go blank skips that toolchain). The one
// exception is Python, which the runner defaults to 3.12 on the non-container
// path. `versions` back the themed dropdown, but the input stays free-text, so
// a teacher can still type any custom version the setup-* action accepts.
//
// Version menus list the currently actively-supported (non-EOL) releases as of
// 2026-07, newest first. Sources: Python devguide, nodejs/Release, Adoptium
// Temurin support, go.dev release policy. Verify periodically — support windows
// move. Java lists LTS lines (classroom autograding wants LTS, not the
// short-lived non-LTS feature releases).
export const RUNTIME_LANGUAGE_META: Record<
  RuntimeLanguage,
  { label: string; placeholder: string; versions: string[] }
> = {
  python: {
    label: "Python",
    placeholder: "3.14",
    versions: ["3.14", "3.13", "3.12", "3.11"],
  },
  node: { label: "Node.js", placeholder: "26", versions: ["26", "24", "22"] },
  java: {
    label: "Java",
    placeholder: "25",
    versions: ["25", "21", "17", "11"],
  },
  go: { label: "Go", placeholder: "1.26", versions: ["1.26", "1.25"] },
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
