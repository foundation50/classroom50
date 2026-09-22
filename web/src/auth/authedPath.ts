// Base path stripped of its trailing slash (GitHub Pages serves the app under a
// subpath; local/dev is "/"). Kept as a module const so the pathname check and
// the sign-out hard-redirect fallback share one source of truth.
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "")

// Public pages a visitor can read without a GitHub login: the accessibility
// report (an ADA/VPAT reviewer, see routes/accessibility.tsx) and the privacy
// notice (a visitor must be able to read it and object before signing in, see
// routes/privacy.tsx). The drawer keys its public rails on this list.
export const PUBLIC_PAGE_PATHS = ["/accessibility", "/privacy"] as const
export type PublicPagePath = (typeof PUBLIC_PAGE_PATHS)[number]

// Routes that must NOT bounce to /login when the session ends: the auth screens
// plus the public pages. Everything else, the app home "/" included, is authed.
const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/auth",
  "/auth/",
  ...PUBLIC_PAGE_PATHS.flatMap((path) => [path, `${path}/`]),
])

// When a session ends mid-flight the router keeps the authed route mounted for
// a frame: the subtree re-renders against a now-null GitHub client and
// useGitHubClient() throws, so App renders a redirect state instead (see
// sessionEndedOnAuthedRoute).
export function isAuthedPath(pathname: string): boolean {
  const path =
    BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length)
      : pathname
  return !PUBLIC_PATHS.has(path)
}

// Search for App's eager /login redirect: carry the destination through the
// login round-trip (#71, #748) unless the sign-out was deliberate. "/" is
// skipped — it's the post-login default (mirrors the _authed guard's isRoot).
export function loginRedirectSearch(input: {
  pathname: string
  searchStr: string
  signedOutDeliberately: boolean
}): { redirect: string } | undefined {
  if (input.signedOutDeliberately || input.pathname === "/") return undefined
  return { redirect: input.pathname + input.searchStr }
}
