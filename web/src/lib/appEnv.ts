// Which deployment the app is running as. Preview and production build
// identically, so only the serving host tells them apart — decide by hostname,
// not a build-time flag, which keeps the deploy workflows untouched.

export type AppEnv = "development" | "preview" | "production"

const PREVIEW_HOST = "preview.classroom50.org"

// DEV wins outright: a dev-server build is never a real deploy. `host` is
// injectable for tests.
export function resolveAppEnv(
  host: string = typeof window === "undefined" ? "" : window.location.hostname,
): AppEnv {
  if (import.meta.env.DEV) return "development"
  return host === PREVIEW_HOST ? "preview" : "production"
}
