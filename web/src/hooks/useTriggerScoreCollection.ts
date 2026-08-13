import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { useTranslation } from "react-i18next"
import { triggerScoreCollection } from "@/github-core/mutations"
import { COLLECT_SCORES_WORKFLOW } from "@/github-core/workflows"
import { getCollectScoresRunAfterId, githubKeys } from "@/github-core/queries"
import { useGitHubOperation, type OperationPhase } from "./useGitHubOperation"

export type CollectScoresPhase = OperationPhase

// Narrows a dispatched collection to one assignment (the assignment
// submissions page); omitted collects org-wide.
export type CollectScoresScope = { classroom: string; assignment: string }

/**
 * Triggers collect-scores and tracks the run via useGitHubOperation; also
 * registers the dispatch with the activity banner. Pass `scope` to collect a
 * single assignment instead of the whole org.
 */
const useTriggerScoreCollection = (
  org: string | undefined,
  scope?: CollectScoresScope,
) => {
  const client = useGitHubClient()
  const { register } = useActionActivityRegistry()
  const { t } = useTranslation()

  // Scope-suffixed keys so an assignment page's tracked run never bleeds into
  // another page's (or the org-wide) collect tracker across remounts.
  const scopeSuffix = scope ? `:${scope.classroom}:${scope.assignment}` : ""
  const { trigger, phase, run, error } = useGitHubOperation({
    storageKey: org ? `cl50:collect-scores:${org}${scopeSuffix}` : null,
    queryKey: (sinceRunId) =>
      githubKeys.collectScoresRun(org ?? "", sinceRunId),
    resetKey: `${org ?? ""}${scopeSuffix}`,
    dispatch: () => triggerScoreCollection(client, org ?? "", scope),
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
