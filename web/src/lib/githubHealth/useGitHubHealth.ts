import { useSyncExternalStore } from "react"

import {
  getGitHubHealthSnapshot,
  subscribeGitHubHealth,
  type GitHubHealth,
} from "./githubHealthStore"

// Live GitHub-health signal for the UI. The server snapshot is always healthy
// so nothing renders an outage state during SSR/tests-without-a-store.
export function useGitHubHealth(): GitHubHealth {
  return useSyncExternalStore(
    subscribeGitHubHealth,
    getGitHubHealthSnapshot,
    () => HEALTHY_SERVER_SNAPSHOT,
  )
}

const HEALTHY_SERVER_SNAPSHOT: GitHubHealth = {
  suspected: false,
  statusIndicator: null,
  statusDescription: null,
}
