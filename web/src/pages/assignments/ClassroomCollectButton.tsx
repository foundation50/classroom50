import { SyncIcon } from "@/components/ui/icons"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"
import { ConfirmModal } from "@/components/modals"
import { SubmissionFreshnessLine } from "@/components/SubmissionFreshnessLine"
import { useToast } from "@/context/notifications/NotificationProvider"
import { GitHubAPIError } from "@/github-core/errors"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useGetLastCollectScoresRun from "@/hooks/useGetLastCollectScoresRun"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import useGetScores from "@/hooks/useGetScores"
import useInvalidateAfterCollect from "@/hooks/useInvalidateAfterCollect"
import useTriggerScoreCollection from "@/hooks/useTriggerScoreCollection"
import {
  classroomSnapshotIsStale,
  latestCollectedAt,
} from "@/pages/submissions/dashboard"
import { formatRelativeToNow } from "@/util/formatDate"
import { errorText } from "@/types/localizedMessage"

// Classroom-wide "Collect all", presented as the assignments toolbar's
// freshness widget — a passive "Submission data collected x ago" line, an
// "Out of date" badge when the snapshot has fallen behind, and the action.
// Mirrors the submissions page's DataFreshness pairing so the button carries
// its own context: the table's submission counts come from the scores.json
// snapshot this button rebuilds. The line and the badge reuse the shared
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
  const collect = useTriggerScoreCollection(org, { classroom })
  const busy = collect.phase === "dispatching" || collect.phase === "running"
  // A sweep is a heavier dispatch than the per-assignment collect (it walks
  // every assignment, and Actions minutes scale with the classroom), so the
  // click confirms before dispatching instead of firing straight away.
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Classroom-level freshness: the newest per-bucket collected_at stamp — any
  // collect that walked this classroom moved at least one. scores.json is
  // already in the query cache (the assignments table reads it for submission
  // counts), so this line costs no extra fetch. A stamped file never borrows
  // the org-wide run timestamp (that run may have swept a different
  // classroom); a wholly unstamped file predates the stamping collector, when
  // every run was org-wide, so the run fallback is sound there — the same
  // precedence the submissions page's effectiveCollectedAt applies per bucket.
  const {
    data: scoresData,
    isLoading: scoresLoading,
    error: scoresError,
  } = useGetScores(org, classroom)
  // A missing scores.json 404s — that IS the never-collected state, and the
  // badge may speak to it. Any other failure (rate limit, network) answered
  // nothing, so claiming "Out of date" from it would be a false claim.
  const scoresReadFailed =
    scoresError != null &&
    !(scoresError instanceof GitHubAPIError && scoresError.isNotFound)
  const { data: lastRun } = useGetLastCollectScoresRun(org)
  const bucketStamps = Object.values(scoresData?.collectedAt ?? {})
  const newestStamp = bucketStamps.reduce<string | null>(
    latestCollectedAt,
    null,
  )
  // A just-finished tracked sweep outranks the lagging completed-run query
  // (phase "completed" means conclusion success — see useGitHubOperation),
  // mirroring the submissions page's trackedCompletedAt: without it, a legacy
  // unstamped file's badge would relight off the PRIOR run the invalidated
  // refetch can still return right after a successful collect.
  const trackedCompletedAt =
    collect.phase === "completed" ? (collect.run?.created_at ?? null) : null
  const lastCollectedAt = latestCollectedAt(
    newestStamp ??
      (scoresData &&
      bucketStamps.length === 0 &&
      lastRun?.status === "completed"
        ? lastRun.created_at
        : null),
    trackedCompletedAt,
  )
  const lastCollectedLabel = lastCollectedAt
    ? formatRelativeToNow(new Date(lastCollectedAt))
    : null

  // Classroom-wide staleness, the same signal the submissions page shows per
  // assignment: a repo pushed after the collect that last walked ITS bucket.
  // Both reads are already in the query cache on this page — the table renders
  // from the same assignment list and holds the same `orgRepos` query key — so
  // this adds no request; deliberately left ungated for that reason, since one
  // ungated observer (the table's) decides the fetch for every observer
  // anyway. While either read is unavailable no badge shows, which is the same
  // quiet default the submissions page falls back to.
  const { data: assignmentsData } = useGetClassroomAssignments(org, classroom)
  const assignments = useMemo(
    () => assignmentsData?.assignments ?? [],
    [assignmentsData],
  )
  // Every slug in the classroom — the sibling-slug guard needs the COMPLETE
  // list, or "hw1" starts absorbing "hw1-bonus"'s repos.
  const assignmentSlugs = useMemo(
    () => assignments.map((a) => a.slug),
    [assignments],
  )
  // ...but only the collectable ones are asked whether they are behind. A bare
  // empty_repo assignment is skipped by collect_scores.py outright, so its
  // bucket is never written and never stamped, while its student repos exist
  // and carry a push from accept time. Measured against a stamp that can never
  // arrive it would read as stale forever — a badge no collect could clear.
  // (no_autograder is NOT excluded: the collector does write its bucket, from
  // detected submissions rather than grades, so it stamps like any other.
  // Known edge: a pre-#694 collector never stamps no_autograder buckets, so on
  // such an org the badge latches for them until the workflows are updated —
  // accepted, because the skeleton-drift banner is already telling that org's
  // teachers to update, and updating is the actual fix.)
  const collectableSlugs = useMemo(
    () => assignments.filter((a) => a.empty_repo !== true).map((a) => a.slug),
    [assignments],
  )
  const { data: orgRepos } = useGetOrgRepos(org)
  const stale = useMemo(
    () =>
      // Gated on the scores read for the same reason the collected line is:
      // before scores.json lands every bucket looks unstamped, and claiming
      // "Out of date" in that window is the false claim the silent line
      // avoids. A failed (non-404) read gets the same silence — it answered
      // nothing, so there is nothing truthful to claim.
      !scoresLoading &&
      !scoresReadFailed &&
      classroomSnapshotIsStale({
        repos: orgRepos,
        classroom,
        measuredSlugs: collectableSlugs,
        collectedAt: scoresData?.collectedAt,
        runCollectedAt: lastCollectedAt,
        allSlugs: assignmentSlugs,
      }),
    [
      scoresLoading,
      scoresReadFailed,
      orgRepos,
      classroom,
      collectableSlugs,
      assignmentSlugs,
      scoresData?.collectedAt,
      lastCollectedAt,
    ],
  )

  // A finished sweep rewrote this classroom's scores.json, so drop the reads it
  // invalidated (gradebook, last-run stamp, org repo list) — the table's counts
  // and the badge re-derive on the refetch. Note the org-repo re-read unfreezes
  // `pushed_at` from page load; it cannot see a push the sweep itself missed
  // (the collector stamps after its walk), so a push landing mid-sweep reads as
  // collected until the next push or collect.
  useInvalidateAfterCollect(org, classroom, collect.phase)

  useEffect(() => {
    if (collect.phase !== "failed" || collect.failure !== "dispatch") return
    // Kept as a toast: the dispatch is fire-and-forget and this button can
    // unmount (route change) before the failure lands; the keyed toast is
    // the one surface guaranteed to survive.
    notify({
      tone: "error",
      key: `collect-scores:${classroom}`,
      message:
        collect.error instanceof Error
          ? `${t("submissions.collect.statusFailedWithReason", {
              reason: errorText(t, collect.error),
            })} ${t("submissions.collect.statusFailedHint")}`
          : `${t("submissions.collect.statusFailed")} ${t(
              "submissions.collect.statusFailedHint",
            )}`,
    })
  }, [collect.phase, collect.failure, collect.error, classroom, notify, t])

  return (
    <>
      <SubmissionFreshnessLine
        lastCollectedLabel={lastCollectedLabel}
        stale={stale}
        // Silent while scores.json loads so the line doesn't flash "not
        // collected yet" before the cached snapshot arrives.
        showCollectedLine={!scoresLoading}
      >
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
      </SubmissionFreshnessLine>

      {/* Sibling, not child: the strip is a role="status" live region, and a
          dialog nested inside it gets re-announced as a status update. */}
      <ConfirmModal
        open={confirmOpen}
        title={t("assignments.collect.confirmTitle")}
        description={t("assignments.collect.confirmBody")}
        confirmLabel={t("assignments.collect.confirmAction")}
        cancelLabel={t("common.cancel")}
        dangerous={false}
        needsConfirm={false}
        onConfirm={async () => {
          collect.collect()
        }}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  )
}

export default ClassroomCollectButton
