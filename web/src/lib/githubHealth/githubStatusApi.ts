import { logger } from "@/lib/logger"

const log = logger.scope("github:status")

// githubstatus.com's public Statuspage summary. `indicator` escalates
// none -> minor -> major -> critical; `description` is the human summary
// (e.g. "Partially Degraded Service"). CORS-open (access-control-allow-origin: *).
const STATUS_SUMMARY_URL = "https://www.githubstatus.com/api/v2/status.json"
const PROBE_TIMEOUT_MS = 5_000

export type GitHubStatusIndicator = "none" | "minor" | "major" | "critical"

export type GitHubStatusResult = {
  indicator: GitHubStatusIndicator
  description: string
}

const INDICATORS: readonly GitHubStatusIndicator[] = [
  "none",
  "minor",
  "major",
  "critical",
]

function isIndicator(value: unknown): value is GitHubStatusIndicator {
  return (
    typeof value === "string" &&
    (INDICATORS as readonly string[]).includes(value)
  )
}

// Fetch githubstatus.com's current indicator. Best-effort and non-fatal: a
// probe failure (network, timeout, unexpected shape) resolves to null so the
// caller falls back to the generic "trouble reaching GitHub" message rather
// than blocking on the status page's own availability.
export async function fetchGitHubStatusIndicator(): Promise<GitHubStatusResult | null> {
  try {
    const res = await fetch(STATUS_SUMMARY_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    })
    if (!res.ok) {
      log.debug("status probe non-ok", { status: res.status })
      return null
    }
    const body: unknown = await res.json()
    const status =
      typeof body === "object" && body !== null && "status" in body
        ? (body as { status: unknown }).status
        : null
    if (typeof status !== "object" || status === null) return null
    const indicator = (status as { indicator?: unknown }).indicator
    const description = (status as { description?: unknown }).description
    if (!isIndicator(indicator)) return null
    return {
      indicator,
      description: typeof description === "string" ? description : "",
    }
  } catch {
    log.debug("status probe failed")
    return null
  }
}
