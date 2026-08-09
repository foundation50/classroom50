// Release identity for the built web app, from compile-time constants injected
// by Vite (see vite.config.ts). Centralised so nothing reads the `__APP_*__`
// globals directly.

export interface AppVersion {
  /** Semver from package.json, or the `web-v*` release tag when built in CI. */
  version: string
  /**
   * Commit the build came from. Length varies: full 40-char `github.sha` in CI,
   * 12-char short hash from the local git fallback. Use `shortCommit()` for
   * display; `commitUrl()` links the raw value (GitHub resolves any prefix).
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

// Opens a new issue pre-filled with the accessibility report template
// (.github/ISSUE_TEMPLATE/2_accessibility_report.yml) — the feedback path on the
// public /accessibility page, so we link to a structured report rather than a
// hand-maintained discussion thread.
export const ACCESSIBILITY_ISSUE_URL = `${ISSUES_URL}/new?template=2_accessibility_report.yml`

export const DISCUSSIONS_URL = `${REPO_URL}/discussions`

export const WIKI_URL = `${REPO_URL}/wiki`

/** e.g., "1.0.0 (a1b2c3d4e5f6)" — for footers, logs, and bug reports. */
export function formatAppVersion(v: AppVersion = appVersion): string {
  return `${v.version} (${v.commit})`
}

/**
 * Commit truncated for display. The stored `commit` length varies by build (see
 * AppVersion.commit), so every display site truncates to one width here.
 */
export function shortCommit(v: AppVersion = appVersion): string {
  return v.commit.slice(0, 7)
}

/** Direct link to the exact commit this build was produced from. */
export function commitUrl(v: AppVersion = appVersion): string {
  return `${REPO_URL}/commit/${v.commit}`
}

/**
 * Build timestamp as a human-friendly UTC string, e.g. "Aug 6, 2026, 02:03 UTC"
 * — the ISO `buildDate` is precise but hard to read at a glance. Falls back to
 * the raw value if it isn't a parseable date.
 */
export function formatBuildDate(v: AppVersion = appVersion): string {
  const parsed = new Date(v.buildDate)
  if (Number.isNaN(parsed.getTime())) return v.buildDate
  const date = parsed.toLocaleString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  return `${date} UTC`
}

/**
 * Link to the GitHub Release for this build's `web-v<version>` tag. Returns null
 * for untagged/dev builds (version at package.json's placeholder or non-release),
 * where no release page exists.
 */
export function releaseUrl(v: AppVersion = appVersion): string | null {
  // A real release is a semver like 1.2.3[-rc.1]; the dev placeholder (0.0.0)
  // and non-semver have no published release page.
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v.version) || v.version === "0.0.0") {
    return null
  }
  return `${REPO_URL}/releases/tag/web-v${v.version}`
}
