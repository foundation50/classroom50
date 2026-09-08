import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { GlobeIcon } from "@/components/ui/icons"

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
import { partitionOutcomes, runBulkFanOut } from "@/components/bulk/fanOut"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import useSetRepoVisibility from "@/hooks/mutations/useSetRepoVisibility"
import { studentRepoName } from "@/util/studentRepo"
import { getName } from "@/util/students"
import type { RepoVisibility, Student } from "@/types/classroom"

type BulkRepoVisibilityModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  // Accepted students; each login is the owner segment of their own repo.
  owners: string[]
  students?: Student[]
}

// The visibility choice. "keep" (the default) leaves every repo untouched, so
// Apply stays disabled until the teacher deliberately picks a direction.
type VisibilityChoice = "keep" | RepoVisibility

// Whole-assignment repo-visibility editor (issue #766): make every accepted
// student's repo public (peer review / portfolio / showcase) or private again,
// in one bounded fan-out. Going public shows the exposure warning before Apply
// — student work can carry names/emails not meant to be public. Sibling of
// BulkRepoFeaturesModal.
export function BulkRepoVisibilityModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  owners,
  students = [],
}: BulkRepoVisibilityModalProps) {
  const { t } = useTranslation()
  const setVisibilityMutation = useSetRepoVisibility()
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk

  const [choice, setChoice] = useState<VisibilityChoice>("keep")
  // The form state resets with the run state, on open (see useBulkRun).
  useEffect(() => {
    if (open) setChoice("keep")
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login
  const nothingSelected = choice === "keep"

  const run = async () => {
    if (total === 0 || nothingSelected) return
    const visibility = choice
    if (!bulk.begin(total)) return

    const { outcomes, rateLimited } = await runBulkFanOut({
      owners,
      isMounted: bulk.isMounted,
      onProgress: (processed, owner) =>
        bulk.setProgress({ processed, total, message: displayFor(owner) }),
      t,
      perOwner: async (owner) => {
        const repo = studentRepoName(classroom, assignment, owner)
        await setVisibilityMutation.mutateAsync({ org, repo, visibility })
      },
    })
    if (!bulk.isMounted()) return

    const { succeeded, deferred, failed } = partitionOutcomes(outcomes)

    bulk.complete(
      {
        headline: rateLimited
          ? t("submissions.bulkVisibility.resultHeadlineThrottled", {
              count: succeeded.length,
              total,
            })
          : t("submissions.bulkVisibility.resultHeadline", {
              count: succeeded.length,
              total,
            }),
        sections: [
          ...(failed.length
            ? [
                {
                  title: t("submissions.bulkVisibility.failedSection", {
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
                  title: t("submissions.bulkVisibility.deferredSection", {
                    count: deferred.length,
                  }),
                  rows: deferred.map((o) => ({
                    key: o.owner,
                    label: displayFor(o.owner),
                    detail: t("submissions.bulkVisibility.deferredDetail"),
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
      title={t("submissions.bulkVisibility.title")}
      subtitle={t("submissions.bulkVisibility.subtitle", { count: total })}
      headerVisual={
        <ModalIcon>
          <GlobeIcon className="size-4" aria-hidden="true" />
        </ModalIcon>
      }
      footer={
        <BulkPhaseFooter
          phase={phase}
          busy={busy}
          showApply={total > 0}
          applyDisabled={nothingSelected}
          applyLabel={t("submissions.bulkVisibility.apply")}
          onApply={() => void run()}
          onClose={onClose}
        />
      }
    >
      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          {total === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.bulkVisibility.noRepos")}
            </Alert>
          ) : (
            <>
              <label className="flex flex-col gap-1.5 sm:max-w-xs">
                <span className={fieldLabelClass}>
                  {t("submissions.bulkVisibility.choiceLabel")}
                </span>
                <Select
                  className="w-full"
                  value={choice}
                  onChange={(e) =>
                    setChoice(e.target.value as VisibilityChoice)
                  }
                >
                  <option value="keep">
                    {t("submissions.bulkVisibility.keep")}
                  </option>
                  <option value="public">
                    {t("assignments.form.repoVisibility.levels.public")}
                  </option>
                  <option value="private">
                    {t("assignments.form.repoVisibility.levels.private")}
                  </option>
                </Select>
              </label>
              {/* The exposure warning renders BEFORE Apply whenever public is
                  picked, so the teacher confirms with the consequences in
                  view (the issue's required confirmation). */}
              {choice === "public" ? (
                <Alert tone="warning" className="text-sm">
                  {t("submissions.bulkVisibility.publicWarning", {
                    count: total,
                  })}
                </Alert>
              ) : (
                <Alert tone="info" className="text-sm">
                  {t("submissions.bulkVisibility.info", { count: total })}
                </Alert>
              )}
            </>
          )}
        </div>
      )}

      {busy && (
        <BulkProgressBlock
          workingLabel={t("submissions.bulkVisibility.working")}
          progress={progress}
          caption={t("submissions.bulkVisibility.progress", {
            processed: progress.processed,
            total: progress.total,
          })}
        />
      )}

      <BulkResultBody phase={phase} result={result} />
    </Modal>
  )
}

export default BulkRepoVisibilityModal
