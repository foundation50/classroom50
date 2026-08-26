import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ShieldCheckIcon } from "@/components/ui/icons"

import { Alert, Button, Modal, ModalIcon, Select } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import {
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
import { runBulkRepoAccess } from "@/components/bulk/repoAccessFanOut"
import useAddRepoCollaborator from "@/hooks/mutations/useAddRepoCollaborator"
import { getName } from "@/util/students"
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

  // Reset when OPENING, not on close — a close-time reset would swap the
  // result view back to the idle form under the dialog's fade-out.
  useEffect(() => {
    if (!open) return
    runningRef.current = false
    setPermission("push")
    setPhase("idle")
    setResult(null)
    setProgress({ processed: 0, total: 0, message: "" })
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login

  const permissionLabel = (level: RepoPermission) =>
    t(`assignments.form.studentPermission.levels.${level}`)

  const run = async () => {
    if (runningRef.current || total === 0) return
    runningRef.current = true
    setPhase("working")
    setResult(null)
    setProgress({ processed: 0, total, message: "" })

    const { outcomes, rateLimited } = await runBulkRepoAccess({
      owners,
      org,
      classroom,
      assignment,
      permission,
      setCollaborator: (params) => addCollaboratorMutation.mutateAsync(params),
      // Exact match: the enrolled student is an org member, so GitHub honors the
      // direct grant exactly. A higher residual means the requested (typically
      // lower) role was silently ignored — the over-access a lockdown must catch.
      treatRequestedAsFloor: false,
      t,
      isMounted: () => mountedRef.current,
      onProgress: (processed) => {
        if (mountedRef.current) {
          setProgress({ processed, total, message: "" })
        }
      },
    })

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
      title={t("submissions.bulkAccess.title")}
      subtitle={t("submissions.bulkAccess.subtitle", { count: total })}
      headerVisual={
        <ModalIcon>
          <ShieldCheckIcon className="size-4" aria-hidden="true" />
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
                {t("submissions.bulkAccess.apply")}
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
            // Indeterminate until the first repo completes, so a slow write
            // animates instead of sitting at 0%.
            {...(progress.processed > 0 ? { value: pct } : {})}
            max={100}
          />
          <p className="text-sm text-base-content/70">
            {progress.processed > 0
              ? t("submissions.bulkAccess.progress", {
                  processed: progress.processed,
                  total: progress.total,
                })
              : t("submissions.bulkAccess.working")}
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
    </Modal>
  )
}

export default BulkRepoAccessModal
