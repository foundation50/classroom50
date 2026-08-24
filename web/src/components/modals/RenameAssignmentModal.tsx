import { useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { PenLine } from "lucide-react"

import { Alert, Button, FormField, Input, Modal } from "@/components/ui"
import { Spinner } from "@/components/Spinner"
import { BulkResultSection } from "@/components/bulk/resultView"
import { slugBudgetError } from "@/components/assignments/slugBudget"
import useRenameAssignment from "@/hooks/mutations/useRenameAssignment"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import {
  assignmentRepoPrefix,
  type RenameAssignmentInput,
  type RenameAssignmentSummary,
  type RepoRenameOutcome,
} from "@/domain/assignments"
import { renamedFromSlugs, type Assignment } from "@/types/classroom"
import { assignmentSlugBudget } from "@/util/repoNameBudget"
import {
  isValidShortName,
  SHORT_NAME_PATTERN_DESCRIPTION,
} from "@/util/shortName"
import { errorText, resolveLocalizedMessage } from "@/types/localizedMessage"

type RenameAssignmentModalProps = {
  open: boolean
  onClose: () => void
  org: string
  classroom: string
  // Fresh mode: the over-budget assignment (its slug is the OLD slug).
  // Finish mode: the already-renamed assignment (renamed_from is the OLD slug)
  // whose fan-out left stragglers.
  assignment: Assignment
  // The full classroom list, for live collision/reservation checks.
  assignments: Assignment[]
  mode: "fresh" | "finish"
}

// The web half of the one-shot slug rename (#691), the GUI equivalent of
// `gh teacher assignment rename`: pick a new in-budget slug (live-validated),
// then watch the config commit + per-repo fan-out with per-repo results.
// Failures never abort the batch; the assignment stays locked while stragglers
// remain, and "finish rename" re-runs the idempotent heal.
export function RenameAssignmentModal({
  open,
  onClose,
  org,
  classroom,
  assignment,
  assignments,
  mode,
}: RenameAssignmentModalProps) {
  const titleId = useId()
  const { t } = useTranslation()
  const finish = mode === "finish"
  const oldSlug = finish ? (assignment.renamed_from ?? "") : assignment.slug
  const [slugInput, setSlugInput] = useState("")
  const newSlug = finish ? assignment.slug : slugInput.trim()
  const rename = useRenameAssignment()
  const [summary, setSummary] = useState<RenameAssignmentSummary | null>(null)
  const [runError, setRunError] = useState("")

  const { data: orgRepos } = useGetOrgRepos(org)
  const repoCount = useMemo(() => {
    if (!orgRepos) return undefined
    const oldPrefix = assignmentRepoPrefix(classroom, oldSlug)
    return orgRepos.filter((r) => r.name.startsWith(oldPrefix)).length
  }, [orgRepos, classroom, oldSlug])

  // No reset-on-close effect: callers mount the modal conditionally
  // (`open ? <RenameAssignmentModal/> : null`, the ReuseAssignmentModal
  // convention), so closing unmounts it and a reopen starts fresh.

  const budget = assignmentSlugBudget(classroom)
  // Live validation, sharing the create-form recipes so the surfaces can't
  // drift: pattern, then the single-sourced budget recipe, then collisions.
  const slugError = useMemo(() => {
    if (finish || newSlug === "") return ""
    if (!isValidShortName(newSlug)) {
      return t("assignments.form.validation.slugInvalid", {
        description: SHORT_NAME_PATTERN_DESCRIPTION,
      })
    }
    const budgetError = slugBudgetError(t, classroom, newSlug)
    if (budgetError) return budgetError
    if (
      assignments.some((a) => a.slug.toLowerCase() === newSlug.toLowerCase())
    ) {
      return t("assignments.rename.error.slugTaken", {
        slug: newSlug,
        classroom,
      })
    }
    if (
      renamedFromSlugs(assignments).some(
        (s) => s.toLowerCase() === newSlug.toLowerCase(),
      )
    ) {
      return t("assignments.form.validation.slugReserved", { slug: newSlug })
    }
    return ""
  }, [finish, newSlug, classroom, assignments, t])

  const busy = rename.isPending
  const done = summary !== null || runError !== ""
  // The first run pins its input so a "finish rename" re-run heals the SAME
  // rename even after the invalidation refetch swaps the assignment prop to
  // the new slug (which would both re-derive oldSlug wrongly and turn the
  // now-taken new slug into a live validation error).
  const [pinnedInput, setPinnedInput] = useState<RenameAssignmentInput | null>(
    null,
  )
  const canRun =
    finish || pinnedInput !== null || (newSlug !== "" && slugError === "")
  // Synchronous re-entrancy guard (CloseSubmissionModal's runningRef
  // convention): isPending is a render-time snapshot, so a fast double-click
  // could start two overlapping fan-outs before React re-renders.
  const runningRef = useRef(false)

  const run = async () => {
    if (runningRef.current || busy || !canRun) return
    runningRef.current = true
    setRunError("")
    // Clear the previous report so a re-run doesn't render it under the
    // progress bar.
    setSummary(null)
    const input = pinnedInput ?? { org, classroom, oldSlug, newSlug }
    setPinnedInput(input)
    try {
      setSummary(await rename.mutateAsync(input))
    } catch (err) {
      setRunError(errorText(t, err as Error))
    } finally {
      runningRef.current = false
    }
  }

  const progress = rename.progress
  const pct =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={busy}
      size="lg"
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-box bg-warning/10 text-warning">
          <PenLine className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-lg font-bold">
            {finish
              ? t("assignments.rename.finishTitle")
              : t("assignments.rename.title")}
          </h3>
          <p className="mt-1 break-all text-sm text-base-content/70">
            {finish
              ? t("assignments.rename.finishSubtitle", {
                  old: oldSlug,
                  new: newSlug,
                })
              : t("assignments.rename.subtitle", { old: oldSlug })}
          </p>
        </div>
      </div>

      {!busy && !done && (
        <div className="mt-4 flex flex-col gap-4">
          {!finish && (
            <>
              <Alert tone="warning" className="text-sm">
                {t("assignments.rename.warning")}
              </Alert>
              <FormField
                label={t("assignments.rename.newSlugLabel")}
                error={slugError || undefined}
                hint={
                  slugError
                    ? undefined
                    : t("assignments.rename.budgetHint", {
                        budget,
                        length: newSlug.length,
                      })
                }
              >
                {({ id, describedById, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedById}
                    invalid={invalid}
                    value={slugInput}
                    onChange={(e) => setSlugInput(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                )}
              </FormField>
            </>
          )}
          {repoCount !== undefined && (
            <p className="text-sm text-base-content/70">
              {t("assignments.rename.repoCount", { count: repoCount })}
            </p>
          )}
        </div>
      )}

      {busy && (
        <div className="mt-6 flex flex-col items-center gap-3 py-6">
          <Spinner label={t("assignments.rename.working")} />
          <progress
            className="progress progress-primary w-full"
            // Omit `value` until the fan-out reports so the bar animates as an
            // indeterminate track during the config commit.
            {...(progress ? { value: pct } : {})}
            max={100}
          />
          <p className="break-all text-center text-sm text-base-content/70">
            {progress
              ? t("assignments.rename.progress", {
                  processed: progress.processed,
                  total: progress.total,
                  repo: progress.repo,
                })
              : t("assignments.rename.configStep")}
          </p>
        </div>
      )}

      {runError !== "" && (
        <div className="mt-4">
          <Alert tone="error" className="text-sm">
            {runError}
          </Alert>
        </div>
      )}

      {summary && <RenameResult summary={summary} newSlug={newSlug} />}

      <div className="modal-action">
        <Button variant="ghost" disabled={busy} onClick={() => onClose()}>
          {done ? t("common.close") : t("common.cancel")}
        </Button>
        {!busy && !done && (
          <Button
            variant="primary"
            disabled={!canRun}
            onClick={() => void run()}
          >
            {finish
              ? t("assignments.rename.finishApply")
              : t("assignments.rename.apply")}
          </Button>
        )}
        {!busy && summary !== null && summary.failed > 0 && (
          <Button variant="primary" onClick={() => void run()}>
            {t("assignments.rename.finishApply")}
          </Button>
        )}
      </div>
    </Modal>
  )
}

// The per-repo outcome report: headline + labeled sections (failed / skipped /
// healed), the bulk-modal result shape.
const RenameResult = ({
  summary,
  newSlug,
}: {
  summary: RenameAssignmentSummary
  newSlug: string
}) => {
  const { t } = useTranslation()
  const rows = (outcomes: RepoRenameOutcome[]) =>
    summary.results
      .filter((r) => outcomes.includes(r.outcome))
      .map((r) => ({
        key: r.repo,
        label: r.repo,
        detail: r.reason ? resolveLocalizedMessage(t, r.reason) : undefined,
      }))
  const failed = rows(["failed"])
  const skipped = rows(["skippedForeign", "skippedNoMarker"])
  const healed = rows(["markerHealed"])
  const renamed = summary.results.filter((r) => r.outcome === "renamed").length
  const current = summary.results.filter((r) => r.outcome === "current").length

  return (
    <div className="mt-4 flex flex-col gap-4">
      <Alert
        tone={summary.failed > 0 ? "warning" : "success"}
        className="text-sm"
      >
        {/* Keyed off the summary's own mode, not the modal's finish prop: a
            heal re-run launched from the fresh modal is still a resume. */}
        {summary.mode === "resume" && renamed === 0
          ? t("assignments.rename.finishHeadline", {
              healed: healed.length,
              current,
            })
          : t("assignments.rename.resultHeadline", {
              renamed,
              total: summary.results.length,
            })}
      </Alert>
      {failed.length > 0 && (
        <BulkResultSection
          title={t("assignments.rename.failedSection", {
            count: failed.length,
          })}
          rows={failed}
        />
      )}
      {skipped.length > 0 && (
        <BulkResultSection
          title={t("assignments.rename.skippedSection", {
            count: skipped.length,
          })}
          rows={skipped}
        />
      )}
      {healed.length > 0 && (
        <BulkResultSection
          title={t("assignments.rename.healedSection", {
            count: healed.length,
          })}
          rows={healed}
        />
      )}
      {summary.failed > 0 && (
        <Alert tone="info" className="text-sm">
          {t("assignments.rename.lockNote", { slug: newSlug })}
        </Alert>
      )}
      {summary.lockRestoreFailed && (
        <Alert tone="warning" className="text-sm">
          {t("assignments.rename.lockRestoreFailed")}
        </Alert>
      )}
      {summary.mode === "resume" && summary.failed === 0 && (
        <Alert tone="info" className="text-sm">
          {t("assignments.rename.resumeUnlockNote", { slug: newSlug })}
        </Alert>
      )}
    </div>
  )
}

export default RenameAssignmentModal
