import { useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { FormField, Input, Select } from "@/components/ui"
import { BulkResultSection } from "@/components/bulk/resultView"
import {
  ReuseModalShell,
  reuseSlugStatus,
} from "@/components/modals/ReuseModalShell"
import useGetClasses from "@/hooks/useGetClasses"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import useClassroomSummaries, {
  classroomOptionLabels,
} from "@/hooks/useClassroomSummaries"
import { useBulkReuseAssignments } from "@/hooks/mutations/useBulkAssignmentActions"
import {
  planBulkReuseSlugs,
  type BulkReuseSlugPlan,
} from "@/util/bulkReuseSlugs"
import { slugify } from "@/util/slug"
import { getErrorMessage } from "@/github-core/errorMessage"
import { renamedFromSlugs, type Assignment } from "@/types/classroom"

// The plural ReuseAssignmentModal, on the same shell so it reads as the same
// operation. Picking the target reveals one editable slug field per selected
// assignment, prefilled with the slug the copy would take, so a collision is a
// decision up front rather than a report afterwards. Setting the shell's
// `warning` after the run flips the footer to a single "Done" and keeps the
// per-assignment result on screen. Every copy lands in one commit, so there
// is no progress to show: the dialog is pending, then done.

const EMPTY_PLAN: BulkReuseSlugPlan = { rows: [], budget: 0, valid: false }

export function BulkReuseAssignmentsModal({
  org,
  sources,
  onClose,
}: {
  org: string
  sources: Assignment[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const { classes: allClasses, isLoading: classesLoading } = useGetClasses(org)
  const summaries = useClassroomSummaries(org, allClasses)
  // An archived classroom refuses new assignments, so it is not a target.
  const archived = new Set(
    summaries.filter((s) => s.archived).map((s) => s.path),
  )
  const classes = allClasses.filter((c) => !archived.has(c.path))
  const optionLabels = classroomOptionLabels(summaries)
  const [target, setTarget] = useState("")
  // Raw input text by source slug for edited rows; the rest keep re-resolving
  // as the target loads or a neighbouring row is retyped.
  const [slugEdits, setSlugEdits] = useState<Record<string, string>>({})
  const reuse = useBulkReuseAssignments(org)
  // `isPending` reaches the button a render late; a double-click would start
  // two batches, and the loser would report every copy as left out.
  const submittingRef = useRef(false)

  const {
    data: targetData,
    isLoading: targetLoading,
    isError: targetError,
  } = useGetClassroomAssignments(org, target || undefined, {
    enabled: Boolean(target),
  })
  const targetAssignments = useMemo(
    () => targetData?.assignments ?? [],
    [targetData],
  )

  const plan = useMemo(
    () =>
      target
        ? planBulkReuseSlugs({
            sources,
            targetClassroom: target,
            takenSlugs: targetAssignments.map((a) => a.slug),
            reservedSlugs: renamedFromSlugs(targetAssignments),
            edits: slugEdits,
          })
        : EMPTY_PLAN,
    [sources, target, targetAssignments, slugEdits],
  )

  const outcomes = reuse.data?.outcomes ?? []
  const finished = reuse.isSuccess
  const copied = outcomes.filter((o) => !o.error)
  const failed = outcomes.filter((o) => o.error)
  const renamed = copied.filter((o) => o.targetSlug !== o.slug)
  // Copies on one template share one warning: one row each, naming every
  // copy it covers.
  const templateWarned = [
    ...copied
      .filter((o) => o.templateAccessWarning)
      .reduce((groups, o) => {
        const key = o.templateAccessWarning!
        groups.set(key, [...(groups.get(key) ?? []), o.targetSlug ?? o.slug])
        return groups
      }, new Map<string, string[]>()),
  ]

  const summary = finished
    ? [
        t("assignments.bulk.reuseDone", { count: copied.length }),
        failed.length > 0
          ? t("assignments.bulk.reuseFailed", { count: failed.length })
          : null,
      ]
        .filter(Boolean)
        .join(" ")
    : null

  // A new target has its own collisions, so drop the edits.
  const pickTarget = (value: string) => {
    setTarget(value)
    setSlugEdits({})
  }

  const formDisabled = reuse.isPending || finished

  return (
    <ReuseModalShell
      dialogRef={dialogRef}
      title={t("assignments.bulk.reuseTitle", { count: sources.length })}
      description={t("assignments.bulk.reuseBody")}
      isPending={reuse.isPending}
      warning={summary}
      warningTone={
        failed.length > 0 || templateWarned.length > 0 ? "warning" : "success"
      }
      // Without the target's assignments the taken-slug set is empty, so a
      // collision would only surface server-side. Block the run instead. A
      // rejected commit renders inline the same way and leaves the form open.
      errorMessage={
        targetError
          ? t("assignments.bulk.reuseTargetError")
          : reuse.isError
            ? getErrorMessage(reuse.error)
            : null
      }
      showSubmit={classesLoading || classes.length > 0}
      canSubmit={
        !targetLoading && !targetError && plan.valid && !reuse.isPending
      }
      onSubmit={() => {
        if (submittingRef.current || reuse.isPending) return
        submittingRef.current = true
        reuse.mutate(
          {
            items: plan.rows.map((r) => ({
              source: r.source,
              targetSlug: r.targetSlug,
            })),
            targetClassroom: target,
          },
          {
            onSettled: () => {
              submittingRef.current = false
            },
          },
        )
      }}
      onClose={onClose}
    >
      {!classesLoading && classes.length === 0 ? (
        <p className="mt-4 text-sm text-base-content/70">
          {t("assignments.bulk.reuseNoTargets", { org })}
        </p>
      ) : (
        <FormField
          className="mt-4"
          label={t("components.modals.reuseAssignment.targetClassroom")}
        >
          {({ id }) => (
            <Select
              id={id}
              value={target}
              disabled={formDisabled}
              onChange={(event) => pickTarget(event.target.value)}
            >
              <option value="">
                {t("components.modals.reuseAssignment.chooseClassroom")}
              </option>
              {classes.map((c) => (
                <option key={c.name} value={c.name}>
                  {optionLabels.get(c.path) ?? c.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}

      {target && !targetError && !finished && (
        <div className="mt-4 max-h-64 space-y-3 overflow-y-auto pe-1">
          {plan.rows.map((row) => {
            const status =
              row.issue === "duplicate"
                ? t("assignments.bulk.reuseSlugDuplicate")
                : row.issue === "empty"
                  ? t("assignments.bulk.reuseSlugRequired")
                  : reuseSlugStatus({
                      t,
                      loading: targetLoading,
                      error: false,
                      slugTaken: row.issue === "taken",
                      slugReserved: row.issue === "reserved",
                      slugOverBudget: row.issue === "overBudget",
                      slugBudget: plan.budget,
                      slugTouched: row.edited,
                      normalizedSlug: row.targetSlug,
                      displayedSlug: row.value,
                      classroomLabel: optionLabels.get(target) ?? target,
                      uniqueHint: t(
                        "components.modals.reuseAssignment.uniqueHint",
                      ),
                    })
            return (
              <FormField
                key={row.source.slug}
                // daisyUI sets nowrap on `.label` itself, and this label
                // carries a teacher-authored name that may be long.
                label={
                  <span className="whitespace-normal">
                    {t("assignments.bulk.reuseSlugLabel", {
                      assignment: row.source.name || row.source.slug,
                    })}
                  </span>
                }
                error={row.issue ? status : undefined}
                hint={status}
              >
                {({ id, describedById, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedById}
                    invalid={invalid}
                    className="font-mono"
                    value={row.value}
                    disabled={formDisabled || targetLoading}
                    onChange={(event) =>
                      setSlugEdits((prev) => ({
                        ...prev,
                        [row.source.slug]: event.target.value,
                      }))
                    }
                    // Normalize on blur like the single-assignment field, but
                    // only for edited rows: committing an untouched one would
                    // freeze its auto-resolved slug.
                    onBlur={() => {
                      if (!row.edited) return
                      setSlugEdits((prev) => ({
                        ...prev,
                        [row.source.slug]: slugify(row.value),
                      }))
                    }}
                  />
                )}
              </FormField>
            )
          })}
        </div>
      )}

      {finished && (
        <div className="mt-4 flex flex-col gap-3">
          {renamed.length > 0 && (
            <BulkResultSection
              title={t("assignments.bulk.reuseRenamedTitle")}
              rows={renamed.map((o) => ({
                key: o.slug,
                label: o.slug,
                detail: o.targetSlug,
              }))}
            />
          )}
          {templateWarned.length > 0 && (
            <BulkResultSection
              title={t("assignments.bulk.reuseTemplateWarnTitle")}
              rows={templateWarned.map(([warning, slugs]) => ({
                key: `tpl-${slugs.join(",")}`,
                label: slugs.join(", "),
                detail: warning,
              }))}
            />
          )}
          {failed.length > 0 && (
            <BulkResultSection
              title={t("assignments.bulk.reuseFailedTitle")}
              rows={failed.map((o) => ({
                key: o.slug,
                label: o.slug,
                detail: o.error,
              }))}
            />
          )}
        </div>
      )}
    </ReuseModalShell>
  )
}

export default BulkReuseAssignmentsModal
