import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import type { CollectScoresPhase } from "./useTriggerScoreCollection"

// Drops the reads a finished classroom sweep invalidated, so the page
// re-derives from fresh data: the gradebook (scores.json), the last-run stamp,
// and the org repo list. Lives here rather than in the page because
// `useQueryClient`/`githubKeys` stay out of `pages/` (AGENTS.md).
//
// `timeout` is only this client giving up on the poll — the run itself usually
// lands, so refresh there too rather than leaving the page on stale counts.
//
// The org repo list is included because `pushed_at` is frozen at page load:
// without the re-read, a push that landed before the collect's stamp would be
// invisible and the staleness badge would clear against a list the sweep
// already left behind.
const useInvalidateAfterCollect = (
  org: string,
  classroom: string,
  phase: CollectScoresPhase,
) => {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (phase !== "completed" && phase !== "timeout") return
    queryClient.invalidateQueries({
      queryKey: githubKeys.jsonFile(
        org,
        CONFIG_REPO,
        `${classroom}/scores.json`,
      ),
    })
    queryClient.invalidateQueries({
      queryKey: githubKeys.lastCollectScoresRun(org),
    })
    queryClient.invalidateQueries({ queryKey: githubKeys.orgRepos(org) })
  }, [phase, classroom, org, queryClient])
}

export default useInvalidateAfterCollect
