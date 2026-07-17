import { isOutageShapedError } from "./githubHealthStore"
import { useGitHubHealth } from "./useGitHubHealth"

// Whether an operation-level failure should be presented as a likely GitHub
// outage: the error is outage-shaped (5xx / network / timeout — never a 4xx or
// rate limit) AND the app already suspects an outage (>= 3 such failures in the
// window). Gating on both means a single transient blip still reads as a local
// failure; the outage hint only appears once GitHub degradation is genuinely
// suspected. One source so every write call site opts in consistently.
export function useOutageHint(): (error: unknown) => boolean {
  const { suspected } = useGitHubHealth()
  return (error: unknown) => suspected && isOutageShapedError(error)
}
