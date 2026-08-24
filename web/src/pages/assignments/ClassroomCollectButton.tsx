import { useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"
import { useToast } from "@/context/notifications/NotificationProvider"
import { githubKeys } from "@/github-core/queries"
import useTriggerScoreCollection from "@/hooks/useTriggerScoreCollection"
import { CONFIG_REPO } from "@/util/configRepo"

// Classroom-wide "Collect all": dispatches collect-scores with only the
// `classroom` input, so the workflow walks every assignment in this classroom
// instead of the single-assignment scope the submissions page dispatches.
// Unlike that scope, `classroom` is the workflow's long-standing input, so
// there is no CollectInputsUnsupportedError branch to handle here.
//
// Once dispatched, the run's outcome is reported by the app-wide Actions banner
// (the hook registers it), which also survives navigating away mid-sweep — so
// this component only carries the in-flight state and drops the reads the sweep
// invalidated. A dispatch that never lands is the exception: registration
// happens on the mutation's success, so a rejected POST (no config-repo write,
// no classroom50 repo) has no banner row and would otherwise just un-spin the
// button silently. That one case gets a toast, reusing the submissions page's
// wording for the same failure.
export function ClassroomCollectButton({
  org,
  classroom,
  emptyRoster = false,
}: {
  org: string
  classroom: string
  // Nothing to collect until someone is enrolled. The dispatch would still
  // succeed, so this is a UX gate, not a correctness one.
  emptyRoster?: boolean
}) {
  const { t } = useTranslation()
  const { notify } = useToast()
  const queryClient = useQueryClient()
  const collect = useTriggerScoreCollection(org, { classroom })
  const busy = collect.phase === "dispatching" || collect.phase === "running"

  // A finished sweep rewrote every bucket in this classroom's scores.json, so
  // drop the cached gradebook and the last-run stamp; the table's submission
  // counts re-derive on the refetch. `timeout` is only this client giving up on
  // the poll — the run itself usually lands, so refresh there too rather than
  // leaving the page on stale counts.
  useEffect(() => {
    if (collect.phase !== "completed" && collect.phase !== "timeout") return
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
  }, [collect.phase, classroom, org, queryClient])

  useEffect(() => {
    if (collect.phase !== "failed") return
    notify({
      tone: "error",
      key: `collect-scores:${classroom}`,
      message:
        collect.error instanceof Error
          ? `${t("submissions.collect.statusFailedWithReason", {
              reason: collect.error.message,
            })} ${t("submissions.collect.statusFailedHint")}`
          : `${t("submissions.collect.statusFailed")} ${t(
              "submissions.collect.statusFailedHint",
            )}`,
    })
  }, [collect.phase, collect.error, classroom, notify, t])

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={busy}
      loadingLabel={t("submissions.collect.active")}
      disabled={emptyRoster}
      title={
        emptyRoster
          ? t("submissions.collect.titleEmptyRoster")
          : t("assignments.collect.title")
      }
      onClick={() => collect.collect()}
    >
      {busy ? (
        t("submissions.collect.active")
      ) : (
        <>
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("assignments.collect.label")}
        </>
      )}
    </Button>
  )
}

export default ClassroomCollectButton
