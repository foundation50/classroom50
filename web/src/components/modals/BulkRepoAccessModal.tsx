import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ShieldCheckIcon } from "@/components/ui/icons"

import {
  Alert,
  fieldLabelClass,
  Modal,
  ModalIcon,
  Select,
} from "@/components/ui"
import {
  BulkPhaseFooter,
  BulkProgressBlock,
  BulkResultBody,
} from "@/components/bulk/resultView"
import { partitionOutcomes } from "@/components/bulk/fanOut"
import { runBulkRepoAccess } from "@/components/bulk/repoAccessFanOut"
import { useBulkRun } from "@/components/bulk/useBulkRun"
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
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk

  const [permission, setPermission] = useState<RepoPermission>("push")
  // The form state resets with the run state, on open (see useBulkRun).
  useEffect(() => {
    if (open) setPermission("push")
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login

  const permissionLabel = (level: RepoPermission) =>
    t(`assignments.form.studentPermission.levels.${level}`)

  const run = async () => {
    if (total === 0) return
    if (!bulk.begin(total)) return

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
      isMounted: bulk.isMounted,
      onProgress: (processed) =>
        bulk.setProgress({ processed, total, message: "" }),
    })
    if (!bulk.isMounted()) return

    const { succeeded, deferred, failed } = partitionOutcomes(outcomes)

    bulk.complete(
      {
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
                    detail: o.detail,
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
      },
      failed.length || deferred.length ? "error" : "complete",
    )
  }

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
        <BulkPhaseFooter
          phase={phase}
          busy={busy}
          showApply={total > 0}
          applyLabel={t("submissions.bulkAccess.apply")}
          onApply={() => void run()}
          onClose={onClose}
        />
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
                <span className={fieldLabelClass}>
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
        <BulkProgressBlock
          workingLabel={t("submissions.bulkAccess.working")}
          indeterminateUntilFirst
          progress={progress}
          caption={
            progress.processed > 0
              ? t("submissions.bulkAccess.progress", {
                  processed: progress.processed,
                  total: progress.total,
                })
              : t("submissions.bulkAccess.working")
          }
        />
      )}

      <BulkResultBody phase={phase} result={result} />
    </Modal>
  )
}

export default BulkRepoAccessModal
