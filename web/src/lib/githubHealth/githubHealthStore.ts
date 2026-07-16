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

// An error that plausibly signals GitHub being down, as opposed to a
// client-side verdict. A GitHubAPIError with a 5xx status is a server fault; a
// non-GitHubAPIError throw is a network failure or timeout (the client throws
// these before onResponse — see client.ts). Definitive statuses (401/403/404)
// and rate limits (429 / 403-with-retry) are the user's own state, never an
// outage, so they must never trip the detector.
export function isOutageShapedError(error: unknown): boolean {
  if (error instanceof GitHubAPIError) {
    if (error.isRateLimited) return false
    return error.status >= 500
  }
  // A bare abort (caller cancel / navigation) is not a fault.
  if (error instanceof DOMException && error.name === "AbortError") return false
  // Anything else reaching a query/mutation error handler is a network/timeout
  // failure (TypeError "Failed to fetch", timeout AbortError is handled above).
  return true
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

// Record an API failure. Only outage-shaped errors count toward suspicion; the
// rest are ignored so a 404/403/rate-limit never reads as an outage.
export function recordGitHubFailure(
  error: unknown,
  now: number = Date.now(),
): void {
  if (!isOutageShapedError(error)) return

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
