// Base path stripped of its trailing slash (GitHub Pages serves the app under a
// subpath; local/dev is "/"). Kept as a module const so the pathname check and
// the sign-out hard-redirect fallback share one source of truth.
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "")

// Public auth screens; everything else (incl. the app home "/") is authed and
// must bounce to /login when the session ends. When a session ends mid-flight
// the router keeps the authed route mounted for a frame — the subtree re-renders
// against a now-null GitHub client and useGitHubClient() throws — so App renders
// a redirect state instead (see sessionEndedOnAuthedRoute).
export function isAuthedPath(pathname: string): boolean {
  const path =
    BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length)
      : pathname
  return path !== "/login" && path !== "/auth" && path !== "/auth/"
}
