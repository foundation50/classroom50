import { useTranslation } from "react-i18next"
import { GlobeIcon } from "@/components/ui/icons"

import { Alert, Modal, ModalIcon } from "@/components/ui"
import {
  BulkPhaseFooter,
  BulkProgressBlock,
  BulkResultBody,
} from "@/components/bulk/resultView"
import {
  failedAndDeferredSections,
  ownerDisplayName,
  partitionOutcomes,
  runBulkFanOut,
  type FanOutOutcome,
} from "@/components/bulk/fanOut"
import { useBulkRun } from "@/components/bulk/useBulkRun"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { getRepo } from "@/github-core/repoReads"
import { REPO_WRITE_CONCURRENCY } from "@/github-core/queries"
import useSetRepoPages, {
  PAGES_REFUSAL_KEYS,
} from "@/hooks/mutations/useSetRepoPages"
import { studentRepoName } from "@/util/studentRepo"
import { pagesCreateBody } from "@/util/repoPages"
import type { AssignmentPages, Student } from "@/types/classroom"

type BulkRepoPagesModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  assignment: string
  // The assignment's Pages block; the menu disables the action when absent.
  pages: AssignmentPages
  // Accepted students; each login is the owner segment of their own repo.
  owners: string[]
  students?: Student[]
}

// Whole-assignment GitHub Pages enable (issue #919): configure the
// assignment's site on every accepted repo in one bounded fan-out. The
// retrofit path for repos accepted before the setting existed, or whose
// accept-time enable was refused. A repo that already has a site counts as
// done (409); a refusal is a failure row carrying the classified reason.
// Sibling of BulkRepoVisibilityModal.
export function BulkRepoPagesModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  pages,
  owners,
  students = [],
}: BulkRepoPagesModalProps) {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const setPagesMutation = useSetRepoPages()
  const bulk = useBulkRun(open)
  const { phase, progress, result, busy } = bulk

  const total = owners.length
  const displayFor = ownerDisplayName(students)
  // A branch source with no named branch publishes each repo's own default
  // branch, which only a per-repo read knows.
  const needsDefaultBranch = pages.source === "branch" && !pages.branch

  const run = async () => {
    if (total === 0) return
    if (!bulk.begin(total)) return

    const { outcomes, rateLimited } = await runBulkFanOut<FanOutOutcome>({
      owners,
      concurrency: REPO_WRITE_CONCURRENCY,
      isMounted: bulk.isMounted,
      onProgress: (processed, owner) =>
        bulk.setProgress({ processed, total, message: displayFor(owner) }),
      t,
      perOwner: async (owner) => {
        const repo = studentRepoName(classroom, assignment, owner)
        let defaultBranch = ""
        if (needsDefaultBranch) {
          const live = await getRepo(client, org, repo)
          defaultBranch = live?.default_branch ?? ""
          if (!defaultBranch) {
            return {
              owner,
              status: "failed",
              detail: t("submissions.rowPages.refused.branch", { repo }),
            }
          }
        }
        const body = pagesCreateBody(pages, defaultBranch)
        if (!body) {
          return {
            owner,
            status: "failed",
            detail: t(PAGES_REFUSAL_KEYS.unknown, { repo }),
          }
        }
        // A rate limit is rethrown by enableRepoPages, so it reaches
        // runBulkFanOut's stop-and-defer instead of being reported per repo.
        const outcome = await setPagesMutation.mutateAsync({ org, repo, body })
        if (outcome.enabled) return
        return {
          owner,
          status: "failed",
          detail: t(PAGES_REFUSAL_KEYS[outcome.reason], { repo }),
        }
      },
    })
    if (!bulk.isMounted()) return

    const { succeeded, deferred, failed } = partitionOutcomes(outcomes)

    bulk.complete(
      {
        headline: rateLimited
          ? t("submissions.bulkPages.resultHeadlineThrottled", {
              count: succeeded.length,
              total,
            })
          : t("submissions.bulkPages.resultHeadline", {
              count: succeeded.length,
              total,
            }),
        sections: failedAndDeferredSections(
          t,
          {
            failed: "submissions.bulkPages.failedSection",
            deferred: "submissions.bulkPages.deferredSection",
            deferredDetail: "submissions.bulkPages.deferredDetail",
          },
          { failed, deferred },
          displayFor,
        ),
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
      title={t("submissions.bulkPages.title")}
      subtitle={t("submissions.bulkPages.subtitle", { count: total })}
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
          applyLabel={t("submissions.bulkPages.apply")}
          onApply={() => void run()}
          onClose={onClose}
        />
      }
    >
      {phase === "idle" && (
        <div className="mt-4 flex flex-col gap-4">
          {total === 0 ? (
            <Alert tone="info" className="text-sm">
              {t("submissions.bulkPages.noRepos")}
            </Alert>
          ) : (
            <Alert tone="info" className="text-sm">
              {t(
                pages.source === "workflow"
                  ? "submissions.bulkPages.infoWorkflow"
                  : "submissions.bulkPages.infoBranch",
                { count: total },
              )}
            </Alert>
          )}
        </div>
      )}

      {busy && (
        <BulkProgressBlock
          workingLabel={t("submissions.bulkPages.working")}
          progress={progress}
          caption={t("submissions.bulkPages.progress", {
            processed: progress.processed,
            total: progress.total,
          })}
        />
      )}

      <BulkResultBody phase={phase} result={result} />
    </Modal>
  )
}

export default BulkRepoPagesModal
