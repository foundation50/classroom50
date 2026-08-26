import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { PauseIcon, PlayIcon } from "@/components/ui/icons"

import { Alert, Modal, ModalIcon } from "@/components/ui"
import {
  BulkPhaseFooter,
  BulkProgressBlock,
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
import { setAutogradeState } from "@/github-core/mutations"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { mapWithConcurrency } from "@/util/concurrency"
import { studentRepoName } from "@/util/studentRepo"
import { getName } from "@/util/students"
import { describeGitHubApiFailure } from "@/components/modals/collaboratorHelpers"
import { GitHubAPIError } from "@/github-core/errors"
import type { Student } from "@/types/classroom"

type BulkAutogradeStateModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  // "pause" disables the autograde workflow in each repo; "resume" re-enables.
  action: "pause" | "resume"
  // Accepted students; each login is the owner segment of their own repo.
  owners: string[]
  students?: Student[]
}

const describeFailure = (reason: unknown, t: TFunction): string | undefined => {
  const shared = describeGitHubApiFailure(reason, t)
  if (shared) return shared
  if (reason instanceof GitHubAPIError) {
    return t("components.modals.groupCollaborators.failure.httpStatus", {
      status: reason.status,
    })
  }
  return reason instanceof Error ? reason.message : undefined
}

// Bulk pause/resume autograding across the selected accepted repos, in one
// bounded fan-out. Each repo is a single idempotent PUT to GitHub's workflow
// enable/disable endpoint — the shim file is never touched — so unlike the
// submission-trigger retrofit (a 3-step content write per repo) these reuse
// REPO_READ_CONCURRENCY. Sibling of BulkSubmissionTriggerModal.
export function BulkAutogradeStateModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  action,
  owners,
  students = [],
}: BulkAutogradeStateModalProps) {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runningRef.current = false
    }
  }, [])

  const [phase, setPhase] = useState<BulkPhase>("idle")
  const [progress, setProgress] = useState<BulkProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkResultView | null>(null)

  // Reset on open, never at close — see the close-animation note in ui/Modal.
  useEffect(() => {
    if (!open) return
    runningRef.current = false
    setPhase("idle")
    setResult(null)
    setProgress({ processed: 0, total: 0, message: "" })
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login
  const isPause = action === "pause"

  type Outcome = { owner: string } & (
    | { status: "ok" | "notGradable" }
    | { status: "deferred" }
    | { status: "failed"; detail?: string }
  )

  const run = async () => {
    if (runningRef.current || total === 0) return
    runningRef.current = true
    setPhase("working")
    setResult(null)
    let processed = 0
    setProgress({ processed: 0, total, message: "" })
    // Stop launching NEW requests once a secondary rate limit is hit — every
    // remaining repo would fail the same way.
    let rateLimited = false

    const outcomes = await mapWithConcurrency(
      owners,
      REPO_READ_CONCURRENCY,
      async (owner): Promise<Outcome> => {
        if (rateLimited || !mountedRef.current) {
          processed += 1
          if (mountedRef.current) {
            setProgress({ processed, total, message: displayFor(owner) })
          }
          return { owner, status: "deferred" }
        }
        const repo = studentRepoName(classroom, assignment, owner)
        try {
          const outcome = await setAutogradeState({
            client,
            org,
            repo,
            action,
          })
          return { owner, status: outcome.status }
        } catch (err) {
          if (err instanceof GitHubAPIError && err.isRateLimited) {
            rateLimited = true
            return { owner, status: "deferred" }
          }
          return { owner, status: "failed", detail: describeFailure(err, t) }
        } finally {
          processed += 1
          if (mountedRef.current) {
            setProgress({ processed, total, message: displayFor(owner) })
          }
        }
      },
    )

    if (!mountedRef.current) {
      runningRef.current = false
      return
    }

    const ok = outcomes.filter((o) => o.status === "ok")
    const notGradable = outcomes.filter((o) => o.status === "notGradable")
    const deferred = outcomes.filter((o) => o.status === "deferred")
    const failed = outcomes.filter((o) => o.status === "failed")

    const section = (
      titleKey: string,
      rows: Outcome[],
      detailFallback?: string,
    ) =>
      rows.length
        ? [
            {
              title: t(titleKey, { count: rows.length }),
              rows: rows.map((o) => ({
                key: o.owner,
                label: displayFor(o.owner),
                detail:
                  ("detail" in o ? o.detail : undefined) ?? detailFallback,
              })),
            },
          ]
        : []

    setResult({
      headline: t(
        isPause
          ? "submissions.bulkAutograde.pauseResultHeadline"
          : "submissions.bulkAutograde.resumeResultHeadline",
        { done: ok.length, total },
      ),
      sections: [
        ...section("submissions.bulkAutograde.failedSection", failed),
        ...section(
          "submissions.bulkAutograde.deferredSection",
          deferred,
          t("submissions.bulkAutograde.deferredDetail"),
        ),
        ...section(
          "submissions.bulkAutograde.notGradableSection",
          notGradable,
          t("submissions.bulkAutograde.notGradableDetail"),
        ),
      ],
    })
    setPhase(failed.length || deferred.length ? "error" : "complete")
    runningRef.current = false
  }

  const busy = phase === "working"

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      size="lg"
      title={t(
        isPause
          ? "submissions.bulkAutograde.pauseTitle"
          : "submissions.bulkAutograde.resumeTitle",
      )}
      subtitle={t(
        isPause
          ? "submissions.bulkAutograde.pauseSubtitle"
          : "submissions.bulkAutograde.resumeSubtitle",
        { count: total },
      )}
      headerVisual={
        <ModalIcon>
          {isPause ? (
            <PauseIcon className="size-4" aria-hidden="true" />
          ) : (
            <PlayIcon className="size-4" aria-hidden="true" />
          )}
        </ModalIcon>
      }
      footer={
        <BulkPhaseFooter
          phase={phase}
          busy={busy}
          showApply={total > 0}
          applyLabel={t(
            isPause
              ? "submissions.bulkAutograde.pauseApply"
              : "submissions.bulkAutograde.resumeApply",
          )}
          onApply={() => void run()}
          onClose={onClose}
        />
      }
    >
      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          {total === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.bulkAutograde.noRepos")}
            </Alert>
          ) : (
            <Alert tone={isPause ? "warning" : "info"} className="text-sm">
              {t(
                isPause
                  ? "submissions.bulkAutograde.pauseWarning"
                  : "submissions.bulkAutograde.resumeWarning",
                { count: total },
              )}
            </Alert>
          )}
        </div>
      )}

      {busy && (
        <BulkProgressBlock
          workingLabel={t("submissions.bulkAutograde.working")}
          progress={progress}
          caption={t("submissions.bulkAutograde.progress", {
            processed: progress.processed,
            total: progress.total,
          })}
        />
      )}

      {(phase === "complete" || phase === "error") && result && (
        <div className="mt-4 flex flex-col gap-4">
          <Alert
            tone={phase === "error" ? "warning" : "success"}
            className="text-sm"
          >
            {result.headline}
          </Alert>
          {result.sections.map((section) => (
            <BulkResultSection
              key={section.title}
              title={section.title}
              rows={section.rows}
            />
          ))}
        </div>
      )}
    </Modal>
  )
}

export default BulkAutogradeStateModal
