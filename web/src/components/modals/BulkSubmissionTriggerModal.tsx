import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { GitBranchIcon } from "@/components/ui/icons"

import { Alert, Button, Modal, ModalIcon } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import {
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
import {
  updateShimSubmissionMode,
  type ShimUpdateOutcome,
} from "@/domain/assignments/submissionTrigger"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { REPO_WRITE_CONCURRENCY } from "@/github-core/queries"
import { mapWithConcurrency } from "@/util/concurrency"
import { studentRepoName } from "@/util/studentRepo"
import { getName } from "@/util/students"
import { describeGitHubApiFailure } from "@/components/modals/collaboratorHelpers"
import { GitHubAPIError } from "@/github-core/errors"
import type { Student, SubmissionMode } from "@/types/classroom"

type BulkSubmissionTriggerModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  // The assignment's STORED submission_mode — the source of truth the retrofit
  // reconciles repos toward. Mode-setting itself lives on the settings form.
  submissionMode: SubmissionMode
  // The assignment's STORED milestone submission_tags (if any); the rewrite
  // reconciles each shim's tags line to their union with submit/*.
  submissionTags?: string[]
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

// Whole-assignment autograding-trigger retrofit: rewrite each accepted
// student repo's shim to match the assignment's stored submission_mode, in
// one bounded fan-out. The way to reconcile existing repos after the mode is
// changed on the settings page, since the shim is baked at accept time.
// Sibling of BulkRepoFeaturesModal.
export function BulkSubmissionTriggerModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  submissionMode,
  submissionTags,
  owners,
  students = [],
}: BulkSubmissionTriggerModalProps) {
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

  useEffect(() => {
    if (!open) {
      runningRef.current = false
      setPhase("idle")
      setResult(null)
      setProgress({ processed: 0, total: 0, message: "" })
    }
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login
  const modeLabel = t(
    submissionMode === "tag"
      ? "assignments.form.submissionMode.choices.tag"
      : "assignments.form.submissionMode.choices.everyPush",
  )

  type Outcome = { owner: string } & (
    | { status: ShimUpdateOutcome["status"]; detail?: string }
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
    // Stop launching NEW writes on a secondary-rate-limit or a confirmed
    // missing workflow scope (every remaining repo would fail identically).
    let rateLimited = false
    let missingScope = false

    const outcomes = await mapWithConcurrency(
      owners,
      // Each iteration is a 3-step git-data WRITE (tree + commit + ref) into
      // a different repo — GitHub's secondary-rate-limit guidance is to avoid
      // concurrent content writes (the CLI retrofit loop is serial for the
      // same reason), unlike the sibling bulk modals' single PATCH/PUT calls,
      // which safely share REPO_READ_CONCURRENCY.
      REPO_WRITE_CONCURRENCY,
      async (owner): Promise<Outcome> => {
        if (rateLimited || missingScope || !mountedRef.current) {
          processed += 1
          if (mountedRef.current) {
            setProgress({ processed, total, message: displayFor(owner) })
          }
          return { owner, status: "deferred" }
        }
        const repo = studentRepoName(classroom, assignment, owner)
        try {
          const outcome = await updateShimSubmissionMode({
            client,
            org,
            repo,
            mode: submissionMode,
            tags: submissionTags,
          })
          if (outcome.status === "missingWorkflowScope") {
            missingScope = true
            return { owner, status: "missingWorkflowScope" }
          }
          if (outcome.status === "unrecognized") {
            return { owner, status: "unrecognized", detail: outcome.reason }
          }
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

    const updated = outcomes.filter((o) => o.status === "updated")
    const current = outcomes.filter((o) => o.status === "current")
    const notAccepted = outcomes.filter((o) => o.status === "notAccepted")
    const unrecognized = outcomes.filter((o) => o.status === "unrecognized")
    const deferred = outcomes.filter((o) => o.status === "deferred")
    const scope = outcomes.filter((o) => o.status === "missingWorkflowScope")
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
      headline: t("submissions.bulkTrigger.resultHeadline", {
        updated: updated.length,
        current: current.length,
        total,
      }),
      sections: [
        ...section(
          "submissions.bulkTrigger.scopeSection",
          scope,
          t("submissions.bulkTrigger.scopeDetail"),
        ),
        ...section("submissions.bulkTrigger.failedSection", failed),
        ...section("submissions.bulkTrigger.unrecognizedSection", unrecognized),
        ...section(
          "submissions.bulkTrigger.deferredSection",
          deferred,
          t("submissions.bulkTrigger.deferredDetail"),
        ),
        ...section(
          "submissions.bulkTrigger.notAcceptedSection",
          notAccepted,
          t("submissions.bulkTrigger.notAcceptedDetail"),
        ),
      ],
    })
    setPhase(
      failed.length || scope.length || deferred.length ? "error" : "complete",
    )
    runningRef.current = false
  }

  const busy = phase === "working"
  const pct = useMemo(
    () =>
      progress.total > 0
        ? Math.round((progress.processed / progress.total) * 100)
        : 0,
    [progress],
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      size="lg"
      title={t("submissions.bulkTrigger.title")}
      subtitle={t("submissions.bulkTrigger.subtitle", {
        count: total,
        mode: modeLabel,
      })}
      headerVisual={
        <ModalIcon>
          <GitBranchIcon className="size-4" aria-hidden="true" />
        </ModalIcon>
      }
      footer={
        phase === "complete" || phase === "error" ? (
          <Button variant="primary" onClick={() => onClose()}>
            {t("common.done")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => onClose()}>
              {t("common.cancel")}
            </Button>
            {phase === "idle" && total > 0 && (
              <Button variant="primary" onClick={() => void run()}>
                {t("submissions.bulkTrigger.apply")}
              </Button>
            )}
          </>
        )
      }
    >
      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          {total === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.bulkTrigger.noRepos")}
            </Alert>
          ) : (
            <Alert tone="warning" className="text-sm">
              {t("submissions.bulkTrigger.warning", { count: total })}
            </Alert>
          )}
        </div>
      )}

      {busy && (
        <div className="mt-6 flex flex-col items-center gap-3 py-6">
          <Spinner label={t("submissions.bulkTrigger.working")} />
          <progress
            className="progress progress-primary w-full"
            value={pct}
            max={100}
          />
          <p className="text-sm text-base-content/70">
            {t("submissions.bulkTrigger.progress", {
              processed: progress.processed,
              total: progress.total,
            })}
          </p>
        </div>
      )}

      {(phase === "complete" || phase === "error") && result && (
        <div className="mt-4 flex flex-col gap-4">
          <Alert
            tone={phase === "error" ? "warning" : "success"}
            className="text-sm"
          >
            {result.headline}
          </Alert>
          <Alert tone="info" className="text-sm">
            {t("submissions.bulkTrigger.repullReminder")}
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

export default BulkSubmissionTriggerModal
