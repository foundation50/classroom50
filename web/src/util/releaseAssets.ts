export const RELEASE_ASSETS_CAP = 50
const RELEASE_ASSETS_MAX_PATH_BYTES = 8 * 1024

export type ReleaseAssetsValidationError =
  | { kind: "too-many"; message: string; count: number; max: number }
  | { kind: "too-large"; message: string; bytes: number; max: number }
  | { kind: "invalid-path"; message: string; path: string }
  | { kind: "invalid-basename"; message: string; basename: string }
  | { kind: "duplicate-path"; message: string; path: string }
  | { kind: "duplicate-basename"; message: string; basename: string }

// eslint-disable-next-line no-control-regex
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/u
const surrogatePattern = /[\uD800-\uDFFF]/u
const drivePattern = /^[A-Za-z]:/u
const safeBasenamePattern =
  /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9_-])?$/u
const utf8Encoder = new TextEncoder()

const asciiFold = (value: string): string =>
  value.replace(/[A-Z]/gu, (char) =>
    String.fromCharCode(char.charCodeAt(0) + 0x20),
  )

export function parseReleaseAssets(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/\r$/u, ""))
    .filter((line) => line.trim() !== "")
}

export function releaseAssetsToText(
  paths: readonly string[] | null | undefined,
): string {
  return (paths ?? []).join("\n")
}

export function validateReleaseAssets(
  paths: readonly string[],
): ReleaseAssetsValidationError | undefined {
  if (paths.length > RELEASE_ASSETS_CAP) {
    return {
      kind: "too-many",
      message: `Too many release files (${paths.length}); maximum is ${RELEASE_ASSETS_CAP}.`,
      count: paths.length,
      max: RELEASE_ASSETS_CAP,
    }
  }

  const totalPathBytes = paths.reduce(
    (total, path) => total + utf8Encoder.encode(path).byteLength,
    0,
  )
  if (totalPathBytes > RELEASE_ASSETS_MAX_PATH_BYTES) {
    return {
      kind: "too-large",
      message: `Release file paths total ${totalPathBytes} UTF-8 bytes; maximum is ${RELEASE_ASSETS_MAX_PATH_BYTES}.`,
      bytes: totalPathBytes,
      max: RELEASE_ASSETS_MAX_PATH_BYTES,
    }
  }

  const seenPaths = new Set<string>()
  const basenames = new Set<string>()
  for (const configuredPath of paths) {
    const segments = configuredPath.split("/")
    if (
      configuredPath.trim() === "" ||
      configuredPath.startsWith("/") ||
      drivePattern.test(configuredPath) ||
      configuredPath.includes("\\") ||
      controlPattern.test(configuredPath) ||
      surrogatePattern.test(configuredPath) ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
      asciiFold(segments[0] ?? "") === ".git"
    ) {
      return {
        kind: "invalid-path",
        message: `Invalid exact workspace-relative path: ${JSON.stringify(configuredPath)}.`,
        path: configuredPath,
      }
    }

    const basename = segments.at(-1) ?? ""
    const foldedBasename = asciiFold(basename)
    if (
      !safeBasenamePattern.test(basename) ||
      basename.includes("..") ||
      foldedBasename === "result.json" ||
      foldedBasename === "release-body.md"
    ) {
      return {
        kind: "invalid-basename",
        message: `Release filename is not safe or is reserved: ${JSON.stringify(basename)}.`,
        basename,
      }
    }
    // Dual path + basename dedup, mirroring the Go/Python/workflow validators.
    if (seenPaths.has(configuredPath)) {
      return {
        kind: "duplicate-path",
        message: `Release file path is configured more than once: ${JSON.stringify(configuredPath)}.`,
        path: configuredPath,
      }
    }
    if (basenames.has(basename)) {
      return {
        kind: "duplicate-basename",
        message: `Release filename is configured more than once: ${JSON.stringify(basename)}.`,
        basename,
      }
    }
    seenPaths.add(configuredPath)
    basenames.add(basename)
  }
  return undefined
}
