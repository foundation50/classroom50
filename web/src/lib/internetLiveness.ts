import { logger } from "@/lib/logger"

const log = logger.scope("net:liveness")

// Independent "is the internet reachable" probe, deliberately GitHub-agnostic.
// It answers a different question than the GitHub-health detector: "does this
// device have a working connection to the wider internet at all", so we can
// tell a genuinely-offline device (show the offline banner) apart from a device
// that is online but can't reach GitHub (show the GitHub-outage banner). Mixing
// the two is what made a GitHub incident read as "You're offline".
const PROBE_TIMEOUT_MS = 4_000

// Reputable, independently-operated anycast endpoints. We race several and
// treat ANY success as proof of connectivity, so one provider being blocked (a
// corporate proxy, an ad/tracker blocklist catching gstatic, a regional
// Cloudflare hiccup) can't produce a false "offline". None is GitHub, on
// purpose — GitHub's own reachability is the GitHub-health detector's job.
//
// `no-cors` requests yield an opaque response we can't read, but that's fine: a
// probe only needs the fetch to *resolve* (the network round-trip succeeded)
// rather than throw. cloudflare-dns.com is CORS-open, so it can stay a normal
// request. cache: "no-store" keeps every probe a real network round-trip.
const PROBE_TARGETS: readonly { url: string; mode: RequestMode }[] = [
  // Cloudflare edge liveness (tiny plaintext body at cdn-cgi/trace).
  { url: "https://cloudflare.com/cdn-cgi/trace", mode: "no-cors" },
  // Cloudflare DNS-over-HTTPS: CORS-open and doubles as a DNS-resolves check.
  {
    url: "https://cloudflare-dns.com/dns-query?name=cloudflare.com&type=A",
    mode: "cors",
  },
  // Google's standard connectivity-check endpoint (returns HTTP 204).
  { url: "https://www.gstatic.com/generate_204", mode: "no-cors" },
]

// True if the device can reach at least one reputable internet endpoint.
//
// Best-effort and fail-open on ambiguity: this gates a user-facing "You're
// offline" banner, and a false offline (claiming no connection when there is
// one) is worse than a missed one — the app's own GitHub reads will still fail
// loudly if GitHub is the problem. So any single probe resolving counts as
// online, and we only report offline when every probe fails or times out.
export async function checkInternetLiveness(): Promise<boolean> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  try {
    // Promise.any resolves on the first fulfilled probe and rejects only when
    // ALL reject, which is exactly the "every endpoint unreachable" signal.
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
