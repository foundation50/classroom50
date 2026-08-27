import { useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { FormField, Input, Select } from "@/components/ui"
import {
  BulkProgressBlock,
  BulkResultSection,
} from "@/components/bulk/resultView"
import {
  ReuseModalShell,
  reuseSlugStatus,
} from "@/components/modals/ReuseModalShell"
import useGetClasses from "@/hooks/useGetClasses"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import { useBulkReuseAssignments } from "@/hooks/mutations/useBulkAssignmentActions"
import {
  planBulkReuseSlugs,
  type BulkReuseSlugPlan,
} from "@/util/bulkReuseSlugs"
import { slugify } from "@/util/slug"
import type { Assignment } from "@/types/classroom"

// Copy a selection of assignments into another classroom in the same org — the
// plural form of ReuseAssignmentModal, and deliberately its twin: same shell,
// same header, same Cancel/Reuse footer, same editable slug field, so the bulk
// flow reads as the same operation rather than a second one that happens to
// copy.
//
// Picking the target reveals one slug field per selected assignment, prefilled
// with the slug the copy would take (auto-suffixed where the source slug is
// already used in the target, or by an earlier row in this same run). The
// teacher can overwrite any of them before starting — the same field the
// single-assignment reuse offers, once per selection, so copying into a
// classroom that already holds these assignments is a visible decision rather
// than a report after the fact. See util/bulkReuseSlugs.
//
// The shell already models the three states this needs. `isPending` disables
// the close button and Cancel, which matters more here than in the single
// case: the copies are sequential writes, and dismissing mid-run would leave a
// half-populated classroom with no report of what landed. Setting `warning`
// after the run flips the footer to a single "Done" — the shell's existing
// acknowledgement state — so the result stays on screen until dismissed.
//
// Sequential by necessity: every copy is a read-modify-write of the TARGET
// classroom's assignments.json on the config repo's default branch, so two at
// once would collide on the same git ref. That is why the per-assignment report
// exists — a single "done" would hide which of twelve copies actually landed.
// No target picked yet: nothing to resolve, and nothing valid to submit.
const EMPTY_PLAN: BulkReuseSlugPlan = { rows: [], budget: 0, valid: false }

export function BulkReuseAssignmentsModal({
  org,
  sources,
  onClose,
}: {
  org: string
  sources: Assignment[]
  // Called when the dialog is dismissed. The caller does NOT clear the
  // selection on it: the sources are untouched by a copy, and clearing would
  // unmount this modal from the table head cell that hosts it.
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const { classes, isLoading: classesLoading } = useGetClasses(org)
  const [target, setTarget] = useState("")
  // Raw input text by source slug, for the rows the teacher has edited. Rows
  // absent here follow the auto-resolved slug, so they keep re-resolving as
  // the target's assignments load or a neighbouring row is retyped.
  const [slugEdits, setSlugEdits] = useState<Record<string, string>>({})
  const reuse = useBulkReuseAssignments(org)

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

  // Only once a target exists: without one there is no budget and no taken-set
  // to resolve against, and the form the rows feed is not rendered.
  const plan = useMemo(
    () =>
      target
        ? planBulkReuseSlugs({
            sources,
            targetClassroom: target,
            targetAssignments,
            edits: slugEdits,
          })
        : EMPTY_PLAN,
    [sources, target, targetAssignments, slugEdits],
  )

  const finished = !reuse.running && reuse.outcomes.length > 0
  const copied = reuse.outcomes.filter((o) => !o.error)
  const failed = reuse.outcomes.filter((o) => o.error)
  // Only the ones whose slug had to move: the teacher confirmed it in the
  // form, but a run of twelve is worth restating.
  const renamed = copied.filter((o) => o.targetSlug !== o.slug)

  // A finished run becomes the shell's acknowledgement state, so the footer is
  // one "Done" and the report below stays put.
  const summary = finished
    ? `${t("assignments.bulk.reuseDone", { count: copied.length })}${
        failed.length > 0
          ? ` ${t("assignments.bulk.reuseFailed", { count: failed.length })}`
          : ""
      }`
    : null

  // Re-arm every auto-resolved slug: the previous target's collisions say
  // nothing about the new one's.
  const pickTarget = (value: string) => {
    setTarget(value)
    setSlugEdits({})
  }

  const formDisabled = reuse.running || finished

  return (
    <ReuseModalShell
      dialogRef={dialogRef}
      title={t("assignments.bulk.reuseTitle", { count: sources.length })}
      description={t("assignments.bulk.reuseBody")}
      isPending={reuse.running}
      warning={summary}
      // A failed read of the target's assignments would leave the taken-slug
      // set empty, so a colliding copy would fail server-side instead of
      // showing up as a collision in the form. Say so and block the run.
      errorMessage={targetError ? t("assignments.bulk.reuseTargetError") : null}
      showSubmit={classesLoading || classes.length > 0}
      // EMPTY_PLAN is invalid, so "no target picked" is already covered.
      canSubmit={!targetLoading && !targetError && plan.valid}
      onSubmit={() =>
        void reuse.run(
          plan.rows.map((r) => ({
            source: r.source,
            targetSlug: r.targetSlug,
          })),
          target,
        )
      }
      onClose={onClose}
    >
      {!classesLoading && classes.length === 0 ? (
        // Nothing to copy into. The shell already hides its submit button in
        // this state; say why rather than leaving a lone Cancel.
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
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}

      {target && !targetError && !finished && (
        // Scrolls rather than growing: a selection of twenty would otherwise
        // push the footer off the viewport.
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
                      // reuseSlugStatus picks the "no slug fits at all"
                      // wording itself once the budget is below the 2-char
                      // minimum.
                      slugOverBudget: row.issue === "overBudget",
                      slugBudget: plan.budget,
                      slugTouched: row.edited,
                      normalizedSlug: row.targetSlug,
                      displayedSlug: row.value,
                      classroomLabel: target,
                      uniqueHint: t(
                        "components.modals.reuseAssignment.uniqueHint",
                      ),
                    })
            return (
              <FormField
                key={row.source.slug}
                // daisyUI puts `white-space: nowrap` ON `.label`, which the
                // modal box's inherited reset cannot override — and this is
                // the one label in the app carrying a teacher-authored name,
                // so a long one runs past the dialog's edge. The span
                // overrides it for its own text; `break-words` is inherited
                // from the box and covers an unbroken name.
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
                    // Show what will actually be written, the same commit the
                    // single-assignment field makes on blur. Only for a row
                    // the teacher typed in: committing an untouched one would
                    // freeze its auto-resolved slug, so a later row could no
                    // longer resolve around it.
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

      {reuse.running && (
        // The shared bulk progress block (spinner + bar + caption), so a
        // sequential reuse reads like every other bulk run in the app.
        // Indeterminate until the first copy lands: the first write is the
        // slow one, and a bar pinned at 0% looks stuck.
        <BulkProgressBlock
          workingLabel={t("assignments.bulk.reuseWorking")}
          progress={{
            processed: reuse.processed,
            total: reuse.total,
            message: "",
          }}
          indeterminateUntilFirst
          caption={`${t("assignments.bulk.reuseProgress", {
            processed: reuse.processed,
            total: reuse.total,
          })} ${t("assignments.bulk.reuseKeepOpen")}`}
        />
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
