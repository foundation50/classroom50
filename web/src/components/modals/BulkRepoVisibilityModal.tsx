import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { GlobeIcon } from "@/components/ui/icons"

import { Alert, Modal, ModalIcon, Select } from "@/components/ui"
import {
  BulkPhaseFooter,
  BulkProgressBlock,
  BulkResultSection,
  type BulkPhase,
  type BulkProgress,
  type BulkResultView,
} from "@/components/bulk/resultView"
import useSetRepoVisibility from "@/hooks/mutations/useSetRepoVisibility"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { mapWithConcurrency } from "@/util/concurrency"
import { studentRepoName } from "@/util/studentRepo"
import { getName } from "@/util/students"
import { describeGitHubApiFailure } from "@/components/modals/collaboratorHelpers"
import { GitHubAPIError } from "@/github-core/errors"
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

// Map a rejected write to a localized reason for the result table. Reuses the
// shared groupCollaborators failure vocabulary (rate-limit/403/404) like the
// sibling BulkRepoFeaturesModal, then falls back to the HTTP status / raw
// message.
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
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      runningRef.current = false
    }
  }, [])

  const [choice, setChoice] = useState<VisibilityChoice>("keep")
  const [phase, setPhase] = useState<BulkPhase>("idle")
  const [progress, setProgress] = useState<BulkProgress>({
    processed: 0,
    total: 0,
    message: "",
  })
  const [result, setResult] = useState<BulkResultView | null>(null)

  // Reset on open, never at close — see the close-animation note in ui/Modal.
  useEffect(() => {
    if (!open) return
    runningRef.current = false
    setChoice("keep")
    setPhase("idle")
    setResult(null)
    setProgress({ processed: 0, total: 0, message: "" })
  }, [open])

  const total = owners.length
  const displayFor = (login: string) => getName(login, students) || login
  const nothingSelected = choice === "keep"

  type Outcome =
    | { owner: string; status: "ok" }
    | { owner: string; status: "deferred" }
    | { owner: string; status: "failed"; detail?: string }

  const run = async () => {
    if (runningRef.current || total === 0 || nothingSelected) return
    const visibility = choice
    runningRef.current = true
    setPhase("working")
    setResult(null)
    let processed = 0
    setProgress({ processed: 0, total, message: "" })
    // Stop launching NEW writes on a secondary-rate-limit; report the rest as
    // deferred (mirrors BulkRepoFeaturesModal).
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
          await setVisibilityMutation.mutateAsync({ org, repo, visibility })
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

    setResult({
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
                  detail: "detail" in o ? o.detail : undefined,
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
    })
    setPhase(failed.length || deferred.length ? "error" : "complete")
    runningRef.current = false
  }

  const busy = phase === "working"

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
                <span className="label font-bold">
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
              {/* The issue-mandated confirmation: the exposure warning renders
                  BEFORE Apply whenever public is picked, so the teacher
                  confirms with the consequences in view. */}
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

export default BulkRepoVisibilityModal
