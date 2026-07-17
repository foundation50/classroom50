import { useSyncExternalStore } from "react"

import {
  getGitHubHealthSnapshot,
  subscribeGitHubHealth,
  HEALTHY_GITHUB_HEALTH,
  type GitHubHealth,
} from "./githubHealthStore"

// Live GitHub-health signal for the UI. The server snapshot is always healthy
// so nothing renders an outage state during SSR/tests-without-a-store.
export function useGitHubHealth(): GitHubHealth {
  return useSyncExternalStore(
    subscribeGitHubHealth,
    getGitHubHealthSnapshot,
    () => HEALTHY_GITHUB_HEALTH,
  )
}
