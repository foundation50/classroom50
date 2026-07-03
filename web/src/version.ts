// Release identity for the built web app, sourced from compile-time constants
// injected by Vite (see vite.config.ts). Centralised here so nothing reads the
// `__APP_*__` globals directly.

export interface AppVersion {
  /** Semver from package.json, or the `web-v*` release tag when built in CI. */
  version: string
  /**
   * Commit the build was produced from. Length varies by build: the full
   * 40-char `github.sha` in CI, a 12-char short hash from the local git
   * fallback. Use `shortCommit()` for display; `commitUrl()` links the raw
   * value (GitHub resolves any prefix length).
   */
  commit: string
  /** ISO-8601 UTC build timestamp. */
  buildDate: string
}

export const appVersion: AppVersion = {
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  buildDate: __APP_BUILD_DATE__,
}

export const REPO_URL = "https://github.com/foundation50/classroom50"

export const ISSUES_URL = `${REPO_URL}/issues`

export const DISCUSSIONS_URL = `${REPO_URL}/discussions`

export const WIKI_URL = `${REPO_URL}/wiki`

/** e.g. "1.0.0 (a1b2c3d4e5f6)" — for footers, logs, and bug reports. */
export function formatAppVersion(v: AppVersion = appVersion): string {
  return `${v.version} (${v.commit})`
}

/**
 * Commit truncated for display. The stored `commit` length varies by build
 * (see AppVersion.commit), so every display site truncates to a single width
 * here rather than duplicating a slice literal.
 */
export function shortCommit(v: AppVersion = appVersion): string {
  return v.commit.slice(0, 7)
}

/** Direct link to the exact commit this build was produced from. */
export function commitUrl(v: AppVersion = appVersion): string {
  return `${REPO_URL}/commit/${v.commit}`
}

/**
 * Link to the GitHub Release for this build's `web-v<version>` tag. Returns
 * null for untagged/dev builds (version still at package.json's placeholder or
 * a non-release value), where no release page exists to link to.
 */
export function releaseUrl(v: AppVersion = appVersion): string | null {
  // A real release is a semver like 1.2.3[-rc.1]; the dev placeholder (0.0.0)
  // and anything non-semver has no published release page.
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v.version) || v.version === "0.0.0") {
    return null
  }
  return `${REPO_URL}/releases/tag/web-v${v.version}`
}
