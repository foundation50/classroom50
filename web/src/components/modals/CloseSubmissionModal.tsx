import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { CalendarX } from "lucide-react"

import { Alert, Button, Modal } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import {
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
import useAddRepoCollaborator from "@/hooks/mutations/useAddRepoCollaborator"
import useSetAssignmentClosed from "@/hooks/mutations/useSetAssignmentClosed"
import { describeGitHubApiFailure } from "@/components/modals/collaboratorHelpers"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { permissionSatisfies } from "@/domain/assignments/permissions"
import { mapWithConcurrency } from "@/util/concurrency"
import { studentRepoName } from "@/util/studentRepo"
import { getName } from "@/util/students"
import { GitHubAPIError } from "@/github-core/errors"
import type { RepoPermission, Student } from "@/types/classroom"

type CloseSubmissionModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  // "close" ends the submission window (block new accepts, repos -> read);
  // "reopen" reverses it (allow accepts, repos -> write).
  mode: "close" | "reopen"
  // The accepted students (their own login = their repo's owner segment).
  owners: string[]
  students?: Student[]
}

// A verified write GitHub silently ignored: the PUT returned 204 but the
// student's effective role didn't land on the target. Reported distinctly.
class AccessNotAppliedError extends Error {
  readonly effective: string | undefined
  constructor(effective: string | undefined) {
    super(`access not applied (still ${effective ?? "unchanged"})`)
    this.name = "AccessNotAppliedError"
    this.effective = effective
  }
}

const describeFailure = (reason: unknown, t: TFunction): string | undefined => {
  if (reason instanceof AccessNotAppliedError) {
    return t("components.modals.repoAccess.notApplied", {
      effective: reason.effective ?? "unknown",
    })
  }
  const shared = describeGitHubApiFailure(reason, t)
  if (shared) return shared
  if (reason instanceof GitHubAPIError) {
    return t("components.modals.groupCollaborators.failure.httpStatus", {
      status: reason.status,
    })
  }
  return reason instanceof Error ? reason.message : undefined
}

// Close/reopen the submission window as one action: flip the assignment's
// `closed` flag, then fan out over the accepted set setting each student's role
// on their OWN repo (read on close, write on reopen). Sibling of
// BulkRepoAccessModal — reuses its bounded-fan-out shape, but the permission is
// fixed by `mode` and the flag flip runs first (so new accepts are blocked even
// if the fan-out is partially throttled). Individual assignments only.
export function CloseSubmissionModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  mode,
  owners,
  students = [],
}: CloseSubmissionModalProps) {
  const titleId = useId()
  const { t } = useTranslation()
  const closing = mode === "close"
  const permission: RepoPermission = closing ? "pull" : "push"
  const addCollaboratorMutation = useAddRepoCollaborator()
  const setClosed = useSetAssignmentClosed(org, classroom)
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
  const [flagError, setFlagError] = useState(false)

  useEffect(() => {
    if (!open) {
      runningRef.current = false
      setPhase("idle")
      setResult(null)
      setFlagError(false)
      setProgress({ processed: 0, total: 0, message: "" })
    }
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login

  type Outcome =
    | { owner: string; status: "ok" }
    | { owner: string; status: "deferred" }
    | { owner: string; status: "failed"; detail?: string }

  const run = async () => {
    if (runningRef.current) return
    runningRef.current = true
    setPhase("working")
    setResult(null)
    setFlagError(false)

    // Flip the window flag FIRST: closing must block new accepts even if the
    // per-repo fan-out is later throttled or partially fails. If this write
    // fails, don't touch any repo — surface the error and stop.
    try {
      await setClosed.mutateAsync({
        org,
        classroom,
        slug: assignment,
        closed: closing,
      })
    } catch {
      if (mountedRef.current) {
        setFlagError(true)
        setPhase("error")
      }
      runningRef.current = false
      return
    }

    let processed = 0
    setProgress({ processed: 0, total, message: "" })
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
          const { effective } = await addCollaboratorMutation.mutateAsync({
            org,
            repo,
            username: owner,
            permission,
            verify: true,
          })
          // The owner is the enrolled student (an org member), so GitHub honors
          // the direct grant exactly. A residual higher role means the requested
          // (lower, on close) role was silently ignored — the over-access a
          // lockdown must catch.
          if (
            effective &&
            !permissionSatisfies(
              effective.permission,
              effective.role_name,
              permission,
              false,
            )
          ) {
            throw new AccessNotAppliedError(
              effective.role_name || effective.permission,
            )
          }
          return { owner, status: "ok" }
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

    const succeeded = outcomes.filter((o) => o.status === "ok")
    const deferred = outcomes.filter((o) => o.status === "deferred")
    const failed = outcomes.filter((o) => o.status === "failed")

    const headlineKey = rateLimited
      ? closing
        ? "submissions.closeSubmission.resultHeadlineThrottled"
        : "submissions.closeSubmission.reopenResultHeadlineThrottled"
      : closing
        ? "submissions.closeSubmission.resultHeadline"
        : "submissions.closeSubmission.reopenResultHeadline"

    setResult({
      headline: t(headlineKey, { count: succeeded.length, total }),
      sections: [
        ...(failed.length
          ? [
              {
                title: t("submissions.closeSubmission.failedSection", {
                  count: failed.length,
                }),
                rows: failed.map((o) => ({
                  key: o.owner,
                  label: displayFor(o.owner),
                  detail: "detail" in o ? o.detail : undefined,
                })),
              },
            ]
          : []),
        ...(deferred.length
          ? [
              {
                title: t("submissions.closeSubmission.deferredSection", {
                  count: deferred.length,
                }),
                rows: deferred.map((o) => ({
                  key: o.owner,
                  label: displayFor(o.owner),
                  detail: t("submissions.closeSubmission.deferredDetail"),
                })),
              },
            ]
          : []),
      ],
    })
    setPhase(failed.length || deferred.length ? "error" : "complete")
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
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-warning/10 text-warning">
          <CalendarX className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {closing
              ? t("submissions.closeSubmission.title")
              : t("submissions.closeSubmission.reopenTitle")}
          </h3>
          <p className="mt-1 text-sm text-base-content/70">
            {closing
              ? t("submissions.closeSubmission.subtitle", { count: total })
              : t("submissions.closeSubmission.reopenSubtitle", {
                  count: total,
                })}
          </p>
        </div>
      </div>

      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          {total === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.closeSubmission.noRepos")}
            </Alert>
          ) : (
            <Alert tone="warning" className="text-sm">
              {closing
                ? t("submissions.closeSubmission.warning", { count: total })
                : t("submissions.closeSubmission.reopenWarning", {
                    count: total,
                  })}
            </Alert>
          )}
        </div>
      )}

      {busy && (
        <div className="mt-6 flex flex-col items-center gap-3 py-6">
          <Spinner label={t("submissions.closeSubmission.working")} />
          <progress
            className="progress progress-primary w-full"
            value={pct}
            max={100}
          />
          <p className="text-sm text-base-content/70">
            {t("submissions.closeSubmission.progress", {
              processed: progress.processed,
              total: progress.total,
            })}
          </p>
        </div>
      )}

      {phase === "error" && flagError && (
        <div className="mt-4">
          <Alert tone="error" className="text-sm">
            {t("submissions.closeSubmission.flagError")}
          </Alert>
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
          {result.sections.map((section) => (
            <BulkResultSection
              key={section.title}
              title={section.title}
              rows={section.rows}
            />
          ))}
        </div>
      )}

      <div className="modal-action">
        <Button variant="ghost" disabled={busy} onClick={() => onClose()}>
          {phase === "complete" || phase === "error"
            ? t("common.close")
            : t("common.cancel")}
        </Button>
        {phase === "idle" && (
          <Button variant="primary" onClick={() => void run()}>
            {closing
              ? t("submissions.closeSubmission.apply")
              : t("submissions.closeSubmission.reopenApply")}
          </Button>
        )}
      </div>
    </Modal>
  )
}

export default CloseSubmissionModal
