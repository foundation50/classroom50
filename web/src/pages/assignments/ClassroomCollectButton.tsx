import { useQueryClient } from "@tanstack/react-query"
import { AlertIcon, SyncIcon } from "@primer/octicons-react"
import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button, Modal } from "@/components/ui"
import { useToast } from "@/context/notifications/NotificationProvider"
import { githubKeys } from "@/github-core/queries"
import useGetLastCollectScoresRun from "@/hooks/useGetLastCollectScoresRun"
import useGetScores from "@/hooks/useGetScores"
import useTriggerScoreCollection from "@/hooks/useTriggerScoreCollection"
import { latestCollectedAt } from "@/pages/submissions/dashboard"
import { CONFIG_REPO } from "@/util/configRepo"
import { formatRelativeToNow } from "@/util/formatDate"

// Classroom-wide "Collect all", presented as the assignments toolbar's
// freshness widget — a passive "Submission data synced x ago" line plus the
// action, mirroring the submissions page's DataFreshness pairing so the button
// carries its own context: the table's submission counts come from the
// scores.json snapshot this button rebuilds. The line reuses the shared
// submissions.freshness strings (one wording, no duplicate translation keys).
//
// Dispatches collect-scores with only the `classroom` input, so the workflow
// walks every assignment in this classroom instead of the single-assignment
// scope the submissions page dispatches. Unlike that scope, `classroom` is the
// workflow's long-standing input, so there is no CollectInputsUnsupportedError
// branch to handle here.
//
// Once dispatched, the run's outcome is reported by the app-wide Actions banner
// (the hook registers it), which also survives navigating away mid-sweep — so
// this component only carries the in-flight state and drops the reads the sweep
// invalidated. A dispatch that never lands is the exception: registration
// happens on the mutation's success, so a rejected POST (no config-repo write,
// no classroom50 repo) has no banner row and would otherwise just un-spin the
// button silently. That one case gets a toast, reusing the submissions page's
// wording for the same failure — keyed off `failure`, since the hook reports a
// run that concluded non-success as "failed" too and the banner already has it.
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
  // A sweep is a heavier dispatch than the per-assignment collect (it walks
  // every assignment, and Actions minutes scale with the classroom), so the
  // click confirms before dispatching instead of firing straight away.
  const [confirmOpen, setConfirmOpen] = useState(false)
  const confirmTitleId = useId()

  // Classroom-level freshness: the newest per-bucket collected_at stamp — any
  // collect that walked this classroom moved at least one. scores.json is
  // already in the query cache (the assignments table reads it for submission
  // counts), so this line costs no extra fetch. A stamped file never borrows
  // the org-wide run timestamp (that run may have swept a different
  // classroom); a wholly unstamped file predates the stamping collector, when
  // every run was org-wide, so the run fallback is sound there — the same
  // precedence the submissions page's effectiveCollectedAt applies per bucket.
  const { data: scoresData, isLoading: scoresLoading } = useGetScores(
    org,
    classroom,
  )
  const { data: lastRun } = useGetLastCollectScoresRun(org)
  const bucketStamps = Object.values(scoresData?.collectedAt ?? {})
  const newestStamp = bucketStamps.reduce<string | null>(
    latestCollectedAt,
    null,
  )
  const lastCollectedAt =
    newestStamp ??
    (scoresData && bucketStamps.length === 0 && lastRun?.status === "completed"
      ? lastRun.created_at
      : null)
  const lastCollectedLabel = lastCollectedAt
    ? formatRelativeToNow(new Date(lastCollectedAt))
    : null

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
    if (collect.phase !== "failed" || collect.failure !== "dispatch") return
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
  }, [collect.phase, collect.failure, collect.error, classroom, notify, t])

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {/* Silent while scores.json loads so the line doesn't flash "not synced
          yet" before the cached snapshot arrives. */}
      {!scoresLoading && (
        <span role="status" className="text-sm text-base-content/70">
          {lastCollectedLabel
            ? t("submissions.freshness.collected", {
                when: lastCollectedLabel,
              })
            : t("submissions.freshness.neverCollected")}
        </span>
      )}
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
        onClick={() => setConfirmOpen(true)}
      >
        {busy ? (
          t("submissions.collect.active")
        ) : (
          <>
            <SyncIcon aria-hidden="true" className="size-4" />
            {t("assignments.collect.label")}
          </>
        )}
      </Button>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        size="lg"
        aria-labelledby={confirmTitleId}
      >
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-box bg-warning/10 text-warning">
            <AlertIcon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id={confirmTitleId} className="text-lg font-bold">
              {t("assignments.collect.confirmTitle")}
            </h3>
            <p className="mt-3 text-sm text-base-content/80">
              {t("assignments.collect.confirmBody")}
            </p>
          </div>
        </div>

        <div className="modal-action">
          <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmOpen(false)
              collect.collect()
            }}
          >
            {t("assignments.collect.confirmAction")}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

export default ClassroomCollectButton
