import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { useTranslation } from "react-i18next"
import {
  COLLECT_SCORES_WORKFLOW,
  triggerScoreCollection,
} from "./github/mutations"
import { getCollectScoresRunAfterId, githubKeys } from "./github/queries"
import { useGitHubOperation, type OperationPhase } from "./useGitHubOperation"

export type CollectScoresPhase = OperationPhase

/**
 * Triggers collect-scores and tracks the run via useGitHubOperation; also
 * registers the dispatch with the activity banner.
 */
const useTriggerScoreCollection = (org: string | undefined) => {
  const client = useGitHubClient()
  const { register } = useActionActivityRegistry()
  const { t } = useTranslation()

  const { trigger, phase, run, error } = useGitHubOperation({
    storageKey: org ? `cl50:collect-scores:${org}` : null,
    queryKey: (sinceRunId) =>
      githubKeys.collectScoresRun(org ?? "", sinceRunId),
    resetKey: org ?? "",
    // Org-wide collection, matching the "Last collected" timestamp. Pass a
    // classroom slug to triggerScoreCollection to scope it.
    dispatch: () => triggerScoreCollection(client, org ?? ""),
    findRun: (sinceRunId, signal) =>
      getCollectScoresRunAfterId(client, org ?? "", sinceRunId, signal),
    onDispatched: (result) => {
      if (!org) return
      register({
        org,
        label: t("actionsBanner.workflow.collectScores"),
        anchor: {
          kind: "sinceRunId",
          workflow: COLLECT_SCORES_WORKFLOW,
          sinceRunId: result.sinceRunId,
        },
      })
    },
  })

  return { collect: trigger, phase, run, error }
}

export default useTriggerScoreCollection
