// Authoring helpers for the language-toolchain and apt fields of an
// assignment's `runtime` block (python/node/java/go versions + extra Ubuntu
// packages). Patterns and rules mirror the CLI's ValidateRuntime (runtime.go)
// and the assignments-v1 schema so a bad value is caught in the form, not by a
// rejected commit.

// The four setup-X toolchains the autograder provisions, ordered for display.
// Keys match the wire fields on `runtime` and the CLI's RuntimeRef.
export const RUNTIME_LANGUAGES = ["python", "node", "java", "go"] as const

export type RuntimeLanguage = (typeof RUNTIME_LANGUAGES)[number]

// Every sub-key the closed `runtime` object may carry, matching the schema's
// runtime.properties, the Go RuntimeRef fields, and Assignment['runtime']. The
// runtime block is a CLOSED contract (schema additionalProperties:false; the
// CLI decodes it strictly with no Extra), so this set is the web's half of the
// lockstep invariant — a schema-parity test asserts it stays byte-for-byte
// equal to the schema, so a new sub-key can't ship on one side alone.
export const RUNTIME_WIRE_KEYS = [
  "runs-on",
  "container",
  ...RUNTIME_LANGUAGES,
  "apt",
] as const

// Identical to the CLI's LanguageVersionPattern (permissive but injection-safe:
// "3.12", "20", "1.23.4", "latest").
export const LANGUAGE_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,32}$/

// Identical to the CLI's AptPackagePattern (lowercase Debian package name).
export const APT_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,63}$/

// Identical to the CLI's ContainerImagePattern / ContainerUserPattern: permissive
// but injection-safe. Image flows into Actions' `container:`; user flows into
// `container.options: --user <value>`, so both are anti-injection gated.
export const CONTAINER_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/
export const CONTAINER_USER_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$/

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

// Mirror the CLI's ValidateContainer image check. Returns an error message, or
// undefined when valid. An empty value is valid (no image → not container mode).
export function validateContainerImage(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (!CONTAINER_IMAGE_PATTERN.test(trimmed)) {
    return "Use a public image reference (letters, numbers, and . _ : / @ + - only, e.g. ubuntu:24.04)."
  }
  return undefined
}

// Mirror the CLI's ValidateContainer user check. Returns an error message, or
// undefined when valid. An empty value is valid (user omitted).
export function validateContainerUser(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (!CONTAINER_USER_PATTERN.test(trimmed)) {
    return 'Use a `docker run --user` value (e.g. "root", "0", "1000:1000").'
  }
  return undefined
}

// Recognized GitHub-hosted macOS/Windows runner labels can't host a Linux
// container (Actions runs containers on Ubuntu hosts only). Mirrors the CLI's
// isNonUbuntuHostedLabel — a bare "macos"/"windows" or a custom/self-hosted
// label passes (the teacher owns OS matching). Used to reject a container +
// macOS/Windows runs-on combination the CLI would refuse.
export function isNonUbuntuHostedLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase()
  return normalized.startsWith("macos-") || normalized.startsWith("windows-")
}
