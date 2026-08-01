import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { ShieldCheck } from "lucide-react"

import { Alert, Button, Modal, Select } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import {
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
import useAddRepoCollaborator from "@/hooks/mutations/useAddRepoCollaborator"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { permissionSatisfies } from "@/domain/assignments/permissions"
import { mapWithConcurrency } from "@/util/concurrency"
import { studentRepoName } from "@/util/studentRepo"
import { getName } from "@/util/students"
import { GitHubAPIError } from "@/github-core/errors"
import type { RepoPermission, Student } from "@/types/classroom"
import { REPO_PERMISSIONS } from "@/types/classroom"

type BulkRepoAccessModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  // The accepted students (their own login = their repo's owner segment).
  owners: string[]
  students?: Student[]
}

// A verified write that GitHub silently ignored: the PUT returned 204 but the
// student's effective role didn't land on the target (the residual admin an
// intended downgrade is meant to remove). Reported distinctly from a hard error.
class AccessNotAppliedError extends Error {
  readonly effective: string | undefined
  constructor(effective: string | undefined) {
    super(`access not applied (still ${effective ?? "unchanged"})`)
    this.name = "AccessNotAppliedError"
    this.effective = effective
  }
}

// Map a rejected write to a localized reason for the result table. Reuses the
// groupCollaborators failure vocabulary so this dialog stays consistent with
// its per-repo sibling (RepoAccessModal) instead of assembling raw English.
const describeFailure = (reason: unknown, t: TFunction): string | undefined => {
  if (reason instanceof AccessNotAppliedError) {
    return t("components.modals.repoAccess.notApplied", {
      effective: reason.effective ?? "unknown",
    })
  }
  if (reason instanceof GitHubAPIError) {
    if (reason.isRateLimited)
      return t("components.modals.groupCollaborators.failure.rateLimited")
    if (reason.status === 403)
      return t("components.modals.groupCollaborators.failure.forbidden")
    if (reason.status === 404)
      return t("components.modals.groupCollaborators.failure.notFound")
    return t("components.modals.groupCollaborators.failure.httpStatus", {
      status: reason.status,
    })
  }
  return reason instanceof Error ? reason.message : undefined
}

// Whole-assignment access editor: set every accepted student's role on their
// OWN individual repo in one bounded fan-out. Sibling of the per-repo
// RepoAccessModal; this one operates over the assignment's full accepted set.
// Individual assignments only (a group repo's membership is founder-managed).
export function BulkRepoAccessModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  owners,
  students = [],
}: BulkRepoAccessModalProps) {
  const titleId = useId()
  const { t } = useTranslation()
  const addCollaboratorMutation = useAddRepoCollaborator()
  const runningRef = useRef(false)
  // Guards setState after unmount and lets an in-flight run stop launching new
  // writes when the modal closes mid-fan-out (there's no per-request cancel
  // token on the mutation, so we skip the remaining owners instead).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runningRef.current = false
    }
  }, [])

  const [permission, setPermission] = useState<RepoPermission>("push")
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
      setPermission("push")
      setPhase("idle")
      setResult(null)
      setProgress({ processed: 0, total: 0, message: "" })
    }
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login

  const permissionLabel = (level: RepoPermission) =>
    t(`assignments.form.studentPermission.levels.${level}`)

  type Outcome =
    | { owner: string; status: "ok" }
    | { owner: string; status: "deferred" }
    | { owner: string; status: "failed"; detail?: string }

  const run = async () => {
    if (runningRef.current || total === 0) return
    runningRef.current = true
    setPhase("working")
    setResult(null)
    let processed = 0
    setProgress({ processed: 0, total, message: "" })

    // Set once we hit a secondary-rate-limit: stop launching NEW writes and
    // report the untouched remainder as deferred rather than hammering GitHub
    // into a deeper throttle (mirrors inviteRosterStudents' throttle handling).
    let rateLimited = false

    const outcomes = await mapWithConcurrency(
      owners,
      REPO_READ_CONCURRENCY,
      async (owner): Promise<Outcome> => {
        // The modal closed/unmounted, or an earlier task tripped the rate
        // limit: don't start another write; mark the rest deferred.
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
          // The owner segment is the enrolled student — an org member, so
          // GitHub honors the direct grant exactly. A higher residual means the
          // requested (typically lower) role was silently ignored, the exact
          // over-access an intended lockdown must catch.
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

    // The modal was closed mid-run: the fan-out finished (or bailed) but there's
    // no live component to show a result on.
    if (!mountedRef.current) {
      runningRef.current = false
      return
    }

    const succeeded = outcomes.filter((o) => o.status === "ok")
    const deferred = outcomes.filter((o) => o.status === "deferred")
    const failed = outcomes.filter((o) => o.status === "failed")

    setResult({
      headline: rateLimited
        ? t("submissions.bulkAccess.resultHeadlineThrottled", {
            count: succeeded.length,
            total,
            level: permissionLabel(permission),
          })
        : t("submissions.bulkAccess.resultHeadline", {
            count: succeeded.length,
            total,
            level: permissionLabel(permission),
          }),
      sections: [
        ...(failed.length
          ? [
              {
                title: t("submissions.bulkAccess.failedSection", {
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
                title: t("submissions.bulkAccess.deferredSection", {
                  count: deferred.length,
                }),
                rows: deferred.map((o) => ({
                  key: o.owner,
                  label: displayFor(o.owner),
                  detail: t("submissions.bulkAccess.deferredDetail"),
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
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {t("submissions.bulkAccess.title")}
          </h3>
          <p className="mt-1 text-sm text-base-content/70">
            {t("submissions.bulkAccess.subtitle", { count: total })}
          </p>
        </div>
      </div>

      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          {total === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.bulkAccess.noRepos")}
            </Alert>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="label font-bold">
                  {t("submissions.bulkAccess.roleLabel")}
                </span>
                <Select
                  className="w-full sm:max-w-xs"
                  value={permission}
                  onChange={(e) =>
                    setPermission(e.target.value as RepoPermission)
                  }
                >
                  {REPO_PERMISSIONS.map((level) => (
                    <option key={level} value={level}>
                      {permissionLabel(level)}
                    </option>
                  ))}
                </Select>
              </label>
              <Alert tone="warning" className="text-sm">
                {t("submissions.bulkAccess.warning", {
                  level: permissionLabel(permission),
                  count: total,
                })}
              </Alert>
            </>
          )}
        </div>
      )}

      {busy && (
        <div className="mt-6 flex flex-col items-center gap-3 py-6">
          <Spinner label={t("submissions.bulkAccess.working")} />
          <progress
            className="progress progress-primary w-full"
            value={pct}
            max={100}
          />
          <p className="text-sm text-base-content/70">
            {t("submissions.bulkAccess.progress", {
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
        {phase === "idle" && total > 0 && (
          <Button variant="primary" onClick={() => void run()}>
            {t("submissions.bulkAccess.apply")}
          </Button>
        )}
      </div>
    </Modal>
  )
}

export default BulkRepoAccessModal
