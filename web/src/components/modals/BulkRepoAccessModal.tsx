import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
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

const describeFailure = (reason: unknown): string | undefined => {
  if (reason instanceof GitHubAPIError) {
    if (reason.isRateLimited) return "rate limited"
    if (reason.status === 403) return "forbidden"
    if (reason.status === 404) return "repo or user not found"
    return `HTTP ${reason.status}`
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

  const run = async () => {
    if (runningRef.current || total === 0) return
    runningRef.current = true
    setPhase("working")
    setResult(null)
    let processed = 0
    setProgress({ processed: 0, total, message: "" })

    const outcomes = await mapWithConcurrency(
      owners,
      REPO_READ_CONCURRENCY,
      async (owner) => {
        const repo = studentRepoName(classroom, assignment, owner)
        try {
          await addCollaboratorMutation.mutateAsync({
            org,
            repo,
            username: owner,
            permission,
          })
          return { owner, ok: true as const }
        } catch (err) {
          return { owner, ok: false as const, detail: describeFailure(err) }
        } finally {
          processed += 1
          setProgress({
            processed,
            total,
            message: displayFor(owner),
          })
        }
      },
    )

    const succeeded = outcomes.filter((o) => o.ok)
    const failed = outcomes.filter((o) => !o.ok)

    setResult({
      headline: t("submissions.bulkAccess.resultHeadline", {
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
      ],
    })
    setPhase(failed.length ? "error" : "complete")
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
