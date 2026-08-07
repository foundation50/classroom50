import { logger } from "@/lib/logger"

const log = logger.scope("net:liveness")

// Independent, GitHub-agnostic "is the wider internet reachable" probe. It lets
// us tell a genuinely-offline device (show the offline banner) apart from a
// device that's online but can't reach GitHub (the GitHub-outage banner's job).
// Conflating the two is what made a GitHub incident read as "You're offline".
const PROBE_TIMEOUT_MS = 4_000

// Reputable, independently-operated anycast endpoints, none of them GitHub. We
// race several so one being blocked (a proxy, an ad-blocklist catching gstatic,
// a regional Cloudflare hiccup) can't produce a false "offline".
//
// `no-cors` yields an opaque response we can't read, but a liveness check only
// needs the fetch to *resolve* — the round-trip succeeded — not to be readable.
const PROBE_TARGETS: readonly { url: string; mode: RequestMode }[] = [
  { url: "https://cloudflare.com/cdn-cgi/trace", mode: "no-cors" },
  // CORS-open, so it can stay a readable request; doubles as a DNS-resolves check.
  {
    url: "https://cloudflare-dns.com/dns-query?name=cloudflare.com&type=A",
    mode: "cors",
  },
  { url: "https://www.gstatic.com/generate_204", mode: "no-cors" },
]

// True if the device can reach at least one endpoint. Fail-open on ambiguity: a
// false "offline" is worse than a missed one (the app's own GitHub reads still
// fail loudly), so only every probe failing or timing out reports offline.
export async function checkInternetLiveness(): Promise<boolean> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  try {
    // Promise.any rejects only when ALL reject — exactly "every endpoint down".
    await Promise.any(
      PROBE_TARGETS.map((target) =>
        fetch(target.url, {
          mode: target.mode,
          cache: "no-store",
          redirect: "follow",
          signal,
        }),
      ),
    )
    return true
  } catch {
    log.debug("internet liveness probe: all endpoints unreachable")
    return false
  }
}
