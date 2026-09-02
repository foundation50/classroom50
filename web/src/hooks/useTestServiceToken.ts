import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useActionActivityRegistry } from "@/context/actions/ActionActivityProvider"
import { triggerProbeToken } from "@/github-core/mutations"
import { PROBE_TOKEN_WORKFLOW } from "@/github-core/workflows"
import {
  getProbeTokenRunAfterId,
  getRunAnnotations,
  githubKeys,
} from "@/github-core/queries"
import { useGitHubOperation } from "./useGitHubOperation"

// The probe is a handful of GETs, so a run that hasn't finished in a few
// minutes is stuck in the Actions queue, not working.
const PROBE_TIMEOUT_MS = 5 * 60 * 1000
const PROBE_INTERVAL_MS = 4000
const PROBE_BACKOFF_AFTER_MS = 45 * 1000
const PROBE_BACKOFF_INTERVAL_MS = 12000

/**
 * Dispatches probe-token.yaml (the read-only service-token health check) and
 * tracks the run via useGitHubOperation, then reads the finished run's
 * annotations, which is where the probe reports which scope checks failed and
 * how to fix them. Registers with the Actions banner like every dispatch.
 */
const useTestServiceToken = (org: string | undefined) => {
  const client = useGitHubClient()
  const { register } = useActionActivityRegistry()
  const { t } = useTranslation()

  const { trigger, phase, failure, run, error, inFlight } = useGitHubOperation({
    storageKey: org ? `cl50:probe-token:${org}` : null,
    queryKey: (sinceRunId) => githubKeys.probeTokenRun(org ?? "", sinceRunId),
    resetKey: org ?? "",
    dispatch: () => triggerProbeToken(client, org),
    findRun: (sinceRunId, signal) =>
      getProbeTokenRunAfterId(client, org ?? "", sinceRunId, signal),
    timeoutMs: PROBE_TIMEOUT_MS,
    intervalMs: PROBE_INTERVAL_MS,
    backoffAfterMs: PROBE_BACKOFF_AFTER_MS,
    backoffIntervalMs: PROBE_BACKOFF_INTERVAL_MS,
    onDispatched: (result) => {
      if (!org) return
      register({
        org,
        label: t("actionsBanner.workflow.probeToken"),
        anchor: {
          kind: "sinceRunId",
          workflow: PROBE_TOKEN_WORKFLOW,
          sinceRunId: result.sinceRunId,
        },
      })
    },
  })

  // Annotations are read only for a run that FAILED: that is where the probe
  // names the checks that did not pass and the fix. A passing run emits only a
  // "passed" notice the result never shows, so its read is skipped.
  const failedRun = phase === "failed" && failure === "run"
  const annotations = useQuery({
    queryKey: githubKeys.runAnnotations(org ?? "", run?.id ?? 0),
    queryFn: ({ signal }) =>
      getRunAnnotations(client, org ?? "", run?.id ?? 0, signal),
    enabled: Boolean(org && run?.id && failedRun),
    staleTime: Infinity,
    // The run link is the fallback, so a failed read isn't worth retrying.
    retry: false,
  })

  return {
    test: () => {
      if (inFlight) return
      trigger()
    },
    phase,
    failure,
    run,
    error,
    inFlight,
    // undefined while loading or unless the run failed; [] when the run
    // emitted nothing (or the annotations read failed, since the run link still
    // gives the teacher the full log).
    annotations: failedRun
      ? annotations.isError
        ? []
        : annotations.data
      : undefined,
  }
}

export default useTestServiceToken
