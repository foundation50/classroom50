import { useTranslation } from "react-i18next"
import { PauseIcon, PlayIcon } from "@/components/ui/icons"

import { Alert, Modal, ModalIcon } from "@/components/ui"
import {
  BulkPhaseFooter,
  BulkProgressBlock,
  BulkResultBody,
} from "@/components/bulk/resultView"
import {
  outcomeSection,
  ownerDisplayName,
  runBulkFanOut,
  type FanOutOutcome,
} from "@/components/bulk/fanOut"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import { setAutogradeState } from "@/github-core/mutations"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { studentRepoName } from "@/util/studentRepo"
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

// The shared outcomes plus "not gradable": the repo has no autograde workflow
// to pause or resume, which is a report, not a failure.
type Outcome = FanOutOutcome | { owner: string; status: "notGradable" }

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
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk

  const total = owners.length
  const displayFor = ownerDisplayName(students)
  const isPause = action === "pause"

  const run = async () => {
    if (total === 0) return
    if (!bulk.begin(total)) return

    const { outcomes } = await runBulkFanOut<Outcome>({
      owners,
      isMounted: bulk.isMounted,
      onProgress: (processed, owner) =>
        bulk.setProgress({ processed, total, message: displayFor(owner) }),
      t,
      perOwner: async (owner) => {
        const repo = studentRepoName(classroom, assignment, owner)
        const outcome = await setAutogradeState({ client, org, repo, action })
        return { owner, status: outcome.status }
      },
    })
    if (!bulk.isMounted()) return

    const ok = outcomes.filter((o) => o.status === "ok")
    const notGradable = outcomes.filter((o) => o.status === "notGradable")
    const deferred = outcomes.filter((o) => o.status === "deferred")
    const failed = outcomes.filter((o) => o.status === "failed")

    const section = (titleKey: string, rows: Outcome[], detail?: string) =>
      outcomeSection(t, titleKey, rows, displayFor, detail)

    bulk.complete(
      {
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

      <BulkResultBody phase={phase} result={result} />
    </Modal>
  )
}

export default BulkAutogradeStateModal
