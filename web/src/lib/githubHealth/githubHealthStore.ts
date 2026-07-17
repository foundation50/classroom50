import { GitHubAPIError } from "@/github-core/errors"
import {
  fetchGitHubStatusIndicator,
  type GitHubStatusIndicator,
} from "./githubStatusApi"

// Heuristic GitHub-outage detector. GitHub itself has no push signal to the
// browser, so we infer trouble from what the app actually experiences: repeated
// outage-shaped API failures in a short window. That local signal *triggers*
// suspicion; an authoritative githubstatus.com probe then confirms/enriches it.
//
// The detector is a module-level store (not React state) so both the authed
// banner and the unauthed bootstrap screen read one source via useSyncExternalStore,
// mirroring useOnlineStatus.

// Cross at least this many outage-shaped failures within WINDOW_MS to suspect
// an outage. A single blip must never trip it.
const FAILURE_THRESHOLD = 3
const WINDOW_MS = 30_000
// Cache a status probe result this long so a burst of failures never hammers
// githubstatus.com — one probe per suspicion episode is enough.
const PROBE_CACHE_MS = 60_000

export type GitHubHealth = {
  // >= FAILURE_THRESHOLD outage-shaped failures within WINDOW_MS, uncleared.
  suspected: boolean
  // Authoritative githubstatus.com indicator once probed; null until then.
  statusIndicator: GitHubStatusIndicator | null
  // Human-readable githubstatus.com summary (e.g. "Partially Degraded
  // Service"); null when unprobed / probe failed.
  statusDescription: string | null
}

const HEALTHY: GitHubHealth = {
  suspected: false,
  statusIndicator: null,
  statusDescription: null,
}

export { HEALTHY as HEALTHY_GITHUB_HEALTH }

let state: GitHubHealth = HEALTHY
let failureTimestamps: number[] = []
let lastProbeAt: number | null = null
let probeInFlight = false
// Bumped whenever suspicion is freshly entered or cleared, so a probe from a
// prior outage episode can't apply its stale result to a later one (or block
// the later one's own probe) during rapid outage/recovery flapping.
let episodeId = 0

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function setState(next: GitHubHealth) {
  // Keep the reference stable when nothing changed so useSyncExternalStore
  // subscribers bail out of a re-render (recordGitHubSuccess fires on every OK
  // response — the steady state must not churn).
  if (
    state.suspected === next.suspected &&
    state.statusIndicator === next.statusIndicator &&
    state.statusDescription === next.statusDescription
  ) {
    return
  }
  state = next
  emit()
}

// The single outage classifier, used both to feed the suspicion detector and to
// gate user-facing hints. True ONLY when the error (after unwrapping `.cause`)
// is a positively-identified outage — a 5xx GitHubAPIError, a network-failure
// TypeError, or a non-abort timeout DOMException. Everything else is false:
// a definitive 4xx, a rate limit, a caller/navigation abort, a friendly wrapper
// with no outage cause (e.g. a TemplateAccessError — an instructor-action
// problem), and any unrecognized local throw. Positive-identification only is
// what keeps both the detector and the hint free of false positives — a bad
// template / not-a-member / SSO gate / local app bug must never read as "GitHub
// is down".
//
// Errors are unwrapped along `.cause` first: some flows rethrow a friendly
// wrapper (e.g. AcceptStepError) that preserves the original GitHubAPIError as
// its cause, and the classification must key off that original, not the wrapper.
export function isDefiniteOutageError(error: unknown): boolean {
  const unwrapped = outageRelevantError(error)
  if (unwrapped instanceof GitHubAPIError)
    return isServerFaultApiError(unwrapped)
  // A genuine network failure — the fetch never got a response. A timeout is a
  // (non-abort) DOMException; a caller/navigation abort is not a fault.
  if (unwrapped instanceof DOMException) return unwrapped.name !== "AbortError"
  // The browser's "fetch never reached the server" throw is a TypeError, but so
  // is any `x.y`-on-undefined app bug — so require the network shape, else a
  // local code bug would falsely read as "GitHub is down" (and hide its real
  // message). `TypeError.cause` is not reliably set by the fetch path, so key
  // off the message the platform uses ("Failed to fetch" / "NetworkError" /
  // "Load failed" across engines).
  return (
    unwrapped instanceof TypeError && isNetworkFailureMessage(unwrapped.message)
  )
}

// The one server-fault rule: a 5xx GitHubAPIError that isn't a rate limit.
//
// Deliberate trade-off (accepted, not a gap): a definitive 4xx is never an
// outage even during a real incident. GitHub's edge can return 403/404 for
// endpoints that would normally 200 while degraded, so those failures won't trip
// the hint and the user may hit a "not-a-member"/"blocked" dead-end. We accept
// that false-negative because 403/404 are overwhelmingly legitimate user state
// (not-a-member, org restriction, SSO gate); counting them would reintroduce the
// false-positive class this classifier exists to prevent. Corroborating a 4xx
// burst with the githubstatus.com probe was considered and rejected as too risky
// for the payoff.
function isServerFaultApiError(error: GitHubAPIError): boolean {
  if (error.isRateLimited) return false
  return error.status >= 500
}

// Browsers throw a bare `TypeError` for a failed fetch, with an engine-specific
// message: Chromium "Failed to fetch", Firefox "NetworkError when attempting to
// fetch resource", Safari "Load failed". Match those so a non-network TypeError
// (an ordinary app bug) is never mistaken for an outage.
function isNetworkFailureMessage(message: string): boolean {
  return /failed to fetch|networkerror|network request failed|load failed/i.test(
    message,
  )
}

// Follow the `.cause` chain to the error that actually carries the outage
// signal. Bounded so a self-referential cause can't loop. Returns the deepest
// GitHubAPIError/DOMException/TypeError if one exists in the chain, else the
// original error.
function outageRelevantError(error: unknown): unknown {
  let current = error
  for (let hops = 0; hops < 8; hops++) {
    if (
      current instanceof GitHubAPIError ||
      current instanceof DOMException ||
      current instanceof TypeError
    ) {
      return current
    }
    const cause: unknown =
      current instanceof Error ? (current.cause as unknown) : undefined
    if (cause === undefined || cause === null || cause === current) break
    current = cause
  }
  return current
}

async function probeStatus(now: number) {
  if (probeInFlight) return
  // Gate only against a *prior* probe — the first probe of an episode always
  // runs (lastProbeAt === null).
  if (lastProbeAt !== null && now - lastProbeAt < PROBE_CACHE_MS) return
  probeInFlight = true
  lastProbeAt = now
  const probedEpisode = episodeId
  try {
    const result = await fetchGitHubStatusIndicator()
    // A probe that resolves after its episode ended (suspicion cleared, or a
    // fresh episode began during recovery flapping) must not resurrect the
    // banner or write a stale indicator onto the new episode.
    if (!state.suspected || episodeId !== probedEpisode) return
    if (!result || result.indicator === "none") {
      // GitHub reports healthy (or the probe was inconclusive): keep the
      // locally-suspected state with the generic message — the user is still
      // hitting failures even if the global status is green (e.g. a proxy or
      // GitHub edge issue that the status page doesn't reflect).
      return
    }
    setState({
      suspected: true,
      statusIndicator: result.indicator,
      statusDescription: result.description,
    })
  } finally {
    // Only the probe that still owns the current episode clears the in-flight
    // flag; a superseded probe leaves the new episode's flag (set when it
    // re-armed) untouched, so the new episode can still run its own probe.
    if (episodeId === probedEpisode) probeInFlight = false
  }
}

// Record an API failure. Only a positively-identified outage (5xx, network
// failure, or timeout — see isDefiniteOutageError) counts toward suspicion, so a
// definitive 4xx / rate limit, a caller abort, or an ordinary local app error
// (a thrown plain Error/string that reaches React Query's global onError) never
// trips the banner. Under-counting a genuinely ambiguous failure is the safe
// direction here: suspicion drives user-visible surfaces, so a false "GitHub is
// down" is worse than a missed one, and any success immediately clears it.
export function recordGitHubFailure(
  error: unknown,
  now: number = Date.now(),
): void {
  if (!isDefiniteOutageError(error)) return

  failureTimestamps = failureTimestamps.filter((t) => now - t < WINDOW_MS)
  failureTimestamps.push(now)

  if (failureTimestamps.length >= FAILURE_THRESHOLD && !state.suspected) {
    // Fresh episode: bump the epoch and re-arm the probe so this episode gets
    // its own guaranteed first probe, independent of any probe still in flight
    // from a just-ended episode (whose stale result the epoch guard discards).
    episodeId++
    lastProbeAt = null
    probeInFlight = false
    setState({ ...HEALTHY, suspected: true })
  }
  if (state.suspected) {
    void probeStatus(now)
  }
}

// Record a successful GitHub response. Any success is evidence GitHub is
// reachable, so it clears the failure window and any suspicion.
export function recordGitHubSuccess(): void {
  if (failureTimestamps.length > 0) failureTimestamps = []
  if (state.suspected) {
    setState(HEALTHY)
    // End the episode: bump the epoch so an in-flight probe from this episode
    // discards its result instead of writing it onto a later suspicion, and
    // re-arm so a distinct outage that trips within PROBE_CACHE_MS of this
    // recovery still gets its guaranteed first probe.
    episodeId++
    lastProbeAt = null
    probeInFlight = false
  }
}

export function subscribeGitHubHealth(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getGitHubHealthSnapshot(): GitHubHealth {
  return state
}

// Test-only reset so the module-level store doesn't leak between cases.
export function __resetGitHubHealthForTest(): void {
  state = HEALTHY
  failureTimestamps = []
  lastProbeAt = null
  probeInFlight = false
  episodeId = 0
}
