// Base path stripped of its trailing slash (GitHub Pages serves the app under a
// subpath; local/dev is "/"). Kept as a module const so the pathname check and
// the sign-out hard-redirect fallback share one source of truth.
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "")

// Public routes that must NOT bounce to /login when the session ends: the auth
// screens plus the public accessibility report (readable by an ADA/VPAT
// reviewer without a GitHub login — see routes/accessibility.tsx). Everything
// else (incl. the app home "/") is authed. When a session ends mid-flight the
// router keeps the authed route mounted for a frame — the subtree re-renders
// against a now-null GitHub client and useGitHubClient() throws — so App renders
// a redirect state instead (see sessionEndedOnAuthedRoute).
export function isAuthedPath(pathname: string): boolean {
  const path =
    BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length)
      : pathname
  return (
    path !== "/login" &&
    path !== "/auth" &&
    path !== "/auth/" &&
    path !== "/accessibility" &&
    path !== "/accessibility/"
  )
}
