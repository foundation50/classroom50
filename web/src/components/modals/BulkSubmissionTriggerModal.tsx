import { useTranslation } from "react-i18next"
import { GitBranchIcon } from "@/components/ui/icons"

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
import {
  updateShimSubmissionMode,
  type ShimUpdateOutcome,
} from "@/domain/assignments/submissionTrigger"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { REPO_WRITE_CONCURRENCY } from "@/github-core/queries"
import { studentRepoName } from "@/util/studentRepo"
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

// The shared outcomes plus the shim writer's own verdicts.
type Outcome =
  | FanOutOutcome
  | { owner: string; status: ShimUpdateOutcome["status"]; detail?: string }

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
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk

  const total = owners.length
  const displayFor = ownerDisplayName(students)
  const modeLabel = t(
    submissionMode === "tag"
      ? "assignments.form.submissionMode.choices.tag"
      : "assignments.form.submissionMode.choices.everyPush",
  )

  const run = async () => {
    if (total === 0) return
    if (!bulk.begin(total)) return
    // A confirmed missing workflow scope stops the rest: every remaining repo
    // would fail identically.
    let missingScope = false

    const { outcomes } = await runBulkFanOut<Outcome>({
      owners,
      // Each iteration is a 3-step git-data WRITE (tree + commit + ref) into
      // a different repo. GitHub's secondary-rate-limit guidance is to avoid
      // concurrent content writes (the CLI retrofit loop is serial for the
      // same reason), unlike the sibling bulk modals' single PATCH/PUT calls,
      // which safely share the read limit.
      concurrency: REPO_WRITE_CONCURRENCY,
      shouldStop: () => missingScope,
      isMounted: bulk.isMounted,
      onProgress: (processed, owner) =>
        bulk.setProgress({ processed, total, message: displayFor(owner) }),
      t,
      perOwner: async (owner) => {
        const repo = studentRepoName(classroom, assignment, owner)
        const outcome = await updateShimSubmissionMode({
          client,
          org,
          repo,
          mode: submissionMode,
          tags: submissionTags,
        })
        if (outcome.status === "missingWorkflowScope") missingScope = true
        return {
          owner,
          status: outcome.status,
          detail:
            outcome.status === "unrecognized" ? outcome.reason : undefined,
        }
      },
    })
    if (!bulk.isMounted()) return

    const updated = outcomes.filter((o) => o.status === "updated")
    const current = outcomes.filter((o) => o.status === "current")
    const notAccepted = outcomes.filter((o) => o.status === "notAccepted")
    const unrecognized = outcomes.filter((o) => o.status === "unrecognized")
    const deferred = outcomes.filter((o) => o.status === "deferred")
    const scope = outcomes.filter((o) => o.status === "missingWorkflowScope")
    const failed = outcomes.filter((o) => o.status === "failed")

    const section = (titleKey: string, rows: Outcome[], detail?: string) =>
      outcomeSection(t, titleKey, rows, displayFor, detail)

    bulk.complete(
      {
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
          ...section(
            "submissions.bulkTrigger.unrecognizedSection",
            unrecognized,
          ),
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
      },
      failed.length || scope.length || deferred.length ? "error" : "complete",
    )
  }

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
        <BulkPhaseFooter
          phase={phase}
          busy={busy}
          showApply={total > 0}
          applyLabel={t("submissions.bulkTrigger.apply")}
          onApply={() => void run()}
          onClose={onClose}
        />
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
              <div className="flex flex-col gap-1">
                <span>
                  {t("submissions.bulkTrigger.warningLead", { count: total })}
                </span>
                <ul className="ms-4 list-disc space-y-0.5">
                  <li>{t("submissions.bulkTrigger.warningPoint1")}</li>
                  <li>{t("submissions.bulkTrigger.warningPoint2")}</li>
                  <li>{t("submissions.bulkTrigger.warningPoint3")}</li>
                </ul>
              </div>
            </Alert>
          )}
        </div>
      )}

      {busy && (
        <BulkProgressBlock
          workingLabel={t("submissions.bulkTrigger.working")}
          progress={progress}
          caption={t("submissions.bulkTrigger.progress", {
            processed: progress.processed,
            total: progress.total,
          })}
        />
      )}

      <BulkResultBody phase={phase} result={result}>
        <Alert tone="info" className="text-sm">
          {t("submissions.bulkTrigger.repullReminder")}
        </Alert>
      </BulkResultBody>
    </Modal>
  )
}

export default BulkSubmissionTriggerModal
