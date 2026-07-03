// Release identity for the built web app, sourced from compile-time constants
// injected by Vite (see vite.config.ts). Centralised here so nothing reads the
// `__APP_*__` globals directly.

export interface AppVersion {
  /** Semver from package.json, or the `web-v*` release tag when built in CI. */
  version: string
  /** Short (12-char) commit the build was produced from. */
  commit: string
  /** ISO-8601 UTC build timestamp. */
  buildDate: string
}

export const appVersion: AppVersion = {
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  buildDate: __APP_BUILD_DATE__,
}

/** e.g. "1.0.0 (a1b2c3d4e5f6)" — for footers, logs, and bug reports. */
export function formatAppVersion(v: AppVersion = appVersion): string {
  return `${v.version} (${v.commit})`
}
