// One boundary for every browser-blocked GitHub call the proxy fronts (OAuth
// token exchange, repo-archive download). Keeping the base URL, route paths,
// and token-safety guard here means a new proxy-backed use case adds one entry,
// and the backend can move off Cloudflare Workers without touching call sites.

// Public value, injected at build time; defaults to the Fifty Foundation worker.
export const GITHUB_PROXY_BASE: string =
  import.meta.env.VITE_GITHUB_PROXY_BASE ??
  "https://classroom50.fifty-foundation.workers.dev"

// Kept in lockstep with the deployed worker's ROUTES map (see cloudflare_worker.js).
export const PROXY_ROUTES = {
  webToken: "/web/token",
  deviceCode: "/device/code",
  deviceToken: "/device/token",
} as const

// Tolerates a trailing slash on the base so an override can't double-slash.
export function proxyUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`
}

export function archivePath(owner: string, repo: string, ref?: string): string {
  // Encode per-segment: a ref legitimately contains `/`.
  const encodedRef = ref ? ref.split("/").map(encodeURIComponent).join("/") : ""
  return (
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball` +
    (encodedRef ? `/${encodedRef}` : "")
  )
}

// Fail closed rather than send the bearer to a non-https origin, which could
// exfiltrate the token. Localhost is exempt for dev against a local worker.
export function assertSafeProxyBase(base: string): void {
  const url = new URL(base)
  const isLocalhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new Error("proxy base must be an https origin")
  }
}
