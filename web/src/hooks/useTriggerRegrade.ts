import { useEffect } from "react"
import { useTranslation } from "react-i18next"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { useRegradeCoordinator } from "@/context/regrade/RegradeCoordinator"
import { REGRADE_WORKFLOW, triggerRegrade } from "./github/mutations"
import { getRegradeRunAfterId, githubKeys } from "./github/queries"
import { useGitHubOperation, type OperationPhase } from "./useGitHubOperation"

export type RegradePhase = OperationPhase

// The regrade dispatch is quick; the timeout is generous but shorter than
// collect's since we're only tracking the fan-out kickoff, not grading itself.
const REGRADE_TIMEOUT_MS = 5 * 60 * 1000
const REGRADE_INTERVAL_MS = 4000
const REGRADE_BACKOFF_AFTER_MS = 45 * 1000
const REGRADE_BACKOFF_INTERVAL_MS = 12000

// A regrade target: the whole assignment, or a single repo owner. The storage
// key and the run-tracking query key are scoped to this so two assignments (or
// two students) track independently.
export type RegradeTarget = {
  org: string | undefined
  classroom: string | undefined
  assignment: string | undefined
  owner?: string
}

const targetKey = (t: RegradeTarget) =>
  `${t.org ?? ""}/${t.classroom ?? ""}/${t.assignment ?? ""}/${t.owner ?? "*"}`

const isComplete = (
  t: RegradeTarget,
): t is RegradeTarget & {
  org: string
  classroom: string
  assignment: string
} => Boolean(t.org && t.classroom && t.assignment)

/**
 * Triggers regrade.yaml for an assignment (or one student when `owner` is set)
 * and tracks the run via useGitHubOperation, adding regrade-specific concerns:
 * the page RegradeCoordinator (mutual exclusion) and banner registration.
 *
 * The tracked run only kicks off grading (grading runs async after), so
 * "completed" means grading started, not that scores are ready.
 */
const useTriggerRegrade = (target: RegradeTarget) => {
  const client = useGitHubClient()
  const coordinator = useRegradeCoordinator()
  const { register } = useActionActivityRegistry()
  const { t } = useTranslation()

  const key = targetKey(target)

  const { trigger, phase, run, error } = useGitHubOperation({
    storageKey: isComplete(target) ? `cl50:regrade:${key}` : null,
    queryKey: (sinceRunId) =>
      githubKeys.regradeRun(
        target.org ?? "",
        target.classroom ?? "",
        target.assignment ?? "",
        target.owner ?? null,
        sinceRunId,
      ),
    resetKey: key,
    dispatch: () =>
      triggerRegrade(client, {
        org: target.org,
        classroom: target.classroom,
        assignment: target.assignment,
        owner: target.owner,
      }),
    findRun: (sinceRunId, signal) =>
      getRegradeRunAfterId(client, target.org ?? "", sinceRunId, signal),
    timeoutMs: REGRADE_TIMEOUT_MS,
    intervalMs: REGRADE_INTERVAL_MS,
    backoffAfterMs: REGRADE_BACKOFF_AFTER_MS,
    backoffIntervalMs: REGRADE_BACKOFF_INTERVAL_MS,
    onDispatched: (result) => {
      if (!target.org) return
      register({
        org: target.org,
        label: t("actionsBanner.workflow.regrade"),
        anchor: {
          kind: "sinceRunId",
          workflow: REGRADE_WORKFLOW,
          sinceRunId: result.sinceRunId,
        },
      })
    },
  })

  // Publish in-flight state to the page coordinator so "Regrade all", every
  // per-row tracker, and "Collect now" share one mutual-exclusion signal.
  const inFlight = phase === "dispatching" || phase === "running"
  const { setInFlight } = coordinator
  useEffect(() => {
    setInFlight(key, inFlight)
    return () => setInFlight(key, false)
  }, [setInFlight, key, inFlight])

  return {
    // Refuse a second regrade while any is in flight: trackers bind by monotonic
    // id, which assumes one outstanding dispatch at a time.
    regrade: () => {
      if (inFlight || !coordinator.canDispatch()) return
      trigger()
    },
    phase,
    run,
    error,
    // True while ANY regrade (this one, another row, or "Regrade all") is in
    // flight — callers use it to disable collect/regrade controls page-wide.
    anyRegrading: coordinator.anyInFlight,
  }
}

export default useTriggerRegrade
