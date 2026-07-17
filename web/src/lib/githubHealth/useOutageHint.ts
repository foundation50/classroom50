import { isDefiniteOutageError } from "./githubHealthStore"
import { useGitHubHealth } from "./useGitHubHealth"

export type OutageHint = {
  // True only when the error (unwrapped along `.cause`) is a positively-
  // identified outage — a 5xx or a network failure. Never a definitive 4xx,
  // rate limit, abort, or a friendly wrapper with no outage cause. Safe to show
  // to a user without a false-positive risk, so it does NOT require `suspected`.
  isOutage: (error: unknown) => boolean
  // The app's background suspicion (>= 3 outage-shaped failures in the window).
  // Use to gate passive/advisory hints where a single blip shouldn't fire; a
  // definitive operation failure the user is staring at can rely on `isOutage`
  // alone.
  suspected: boolean
  // Authoritative githubstatus.com summary when probed; null otherwise. Pass to
  // GitHubStatusNote so a confirmed outage shows the specific status.
  statusDescription: string | null
}

// Outage-hint inputs for a call site. One source so every surface classifies
// consistently — a background advisory can gate on `suspected && isOutage(err)`,
// while a foreground operation failure can hint on `isOutage(err)` alone.
export function useOutageHint(): OutageHint {
  const { suspected, statusDescription } = useGitHubHealth()
  return { isOutage: isDefiniteOutageError, suspected, statusDescription }
}
