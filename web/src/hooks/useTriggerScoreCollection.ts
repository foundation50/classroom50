import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { useTranslation } from "react-i18next"
import { triggerScoreCollection } from "@/github-core/mutations"
import { COLLECT_SCORES_WORKFLOW } from "@/github-core/workflows"
import { getCollectScoresRunAfterId, githubKeys } from "@/github-core/queries"
import { useGitHubOperation, type OperationPhase } from "./useGitHubOperation"

export type CollectScoresPhase = OperationPhase

// A classroom sweep walks every assignment, so it runs far longer than the
// single-assignment collect the 10-minute default was tuned for. Track it
// against the workflow's own job cap instead (collect-scores.yaml,
// `timeout-minutes: 30`) — otherwise a healthy sweep trips the client timeout,
// which drops the tracked dispatch and re-enables the button while the run is
// still going, inviting a duplicate queued behind it.
const SWEEP_TIMEOUT_MS = 30 * 60 * 1000

// Narrows a dispatched collection: `classroom` alone sweeps every assignment in
// that classroom (the assignments page), `classroom` + `assignment` collects one
// (the submissions page); omitted collects org-wide.
export type CollectScoresScope = { classroom: string; assignment?: string }

/**
 * Triggers collect-scores and tracks the run via useGitHubOperation; also
 * registers the dispatch with the activity banner. Pass `scope` to collect a
 * single classroom, or one assignment within it, instead of the whole org.
 */
const useTriggerScoreCollection = (
  org: string | undefined,
  scope?: CollectScoresScope,
) => {
  const client = useGitHubClient()
  const { register } = useActionActivityRegistry()
  const { t } = useTranslation()

  // Scope-suffixed keys so an assignment page's tracked run never bleeds into
  // another page's (or the classroom-wide / org-wide) collect tracker across
  // remounts. A classroom sweep stops one segment short of an assignment scope,
  // so the two never share a key.
  const scopeSuffix = scope
    ? `:${scope.classroom}${scope.assignment ? `:${scope.assignment}` : ""}`
    : ""
  const { trigger, phase, run, error } = useGitHubOperation({
    timeoutMs: scope && !scope.assignment ? SWEEP_TIMEOUT_MS : undefined,
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
