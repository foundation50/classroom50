// Which deployment the running app is: the local dev server, the continuously
// deployed preview site, or production. Preview and production build identically
// (same `npm run build`, see .github/workflows/web-deploy*.yaml); the ONLY thing
// that distinguishes them at runtime is the host the artifact is served from, so
// this decides by hostname rather than a build-time flag. That keeps the deploy
// workflows untouched and self-corrects if the preview domain ever moves repos.

export type AppEnv = "development" | "preview" | "production"

const PREVIEW_HOST = "preview.classroom50.org"

// `host` is injected for tests; production callers pass nothing and read the
// live hostname. DEV wins outright: a dev-server build is never a real deploy,
// whatever host it happens to be served on.
export function resolveAppEnv(
  host: string = typeof window === "undefined" ? "" : window.location.hostname,
): AppEnv {
  if (import.meta.env.DEV) return "development"
  return host === PREVIEW_HOST ? "preview" : "production"
}
