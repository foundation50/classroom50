import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  Alert,
  Button,
  FormField,
  Input,
  Modal,
  Spinner,
} from "@/components/ui"
import { ScoreBadge } from "@/pages/submissions/ScoreBadge"
import { useSetScoreOverride } from "@/hooks/mutations/useSetScoreOverride"

// The write context an override edit needs, independent of the row's current
// value. Mirrors the fields editScoreOverride consumes.
export type ScoreOverrideContext = {
  org: string
  classroom: string
  assignment: string
  assignmentType: "individual" | "group"
  // The max points for the score input. Manual assignments pass the configured
  // grading.max_points; a graded autograded row passes its own max-score. Absent
  // when the max isn't known yet (a pending autograded row with no collected
  // score) — the teacher then enters both the score and the max in the modal.
  maxPoints?: number
  // Group crediting for a NEW entry (the credited members of the group repo).
  // Individual entries omit it and are credited to `owner`.
  memberUsernames?: string[]
  // Distinguishes the copy/behavior: a manual-mode assignment vs. overriding an
  // autograded result (which preserves and can revert to the autograded score).
  mode: "manual" | "auto"
}

// The page-level capability the table receives: whether score override is
// available and how to compute the max. Manual assignments carry a configured
// `maxPoints`; autograded assignments omit it and the table uses each row's own
// `max-score`. Omitted entirely for a viewer who can't write or an assignment
// that isn't gradable.
export type ScoreOverrideCapability = {
  org: string
  classroom: string
  assignment: string
  assignmentType: "individual" | "group"
  mode: "manual" | "auto"
  // Manual mode only: the configured total points. Absent for autograded
  // assignments (per-row max-score is used instead).
  maxPoints?: number
}

// The modal editor for a teacher score override — used for manual-mode grading
// and for overriding an autograded score. Reuses the single write path
// (useSetScoreOverride): Save upserts an override:true entry; Clear override
// removes it (restoring the autograded score on the next collect). Validation
// mirrors the assignment form: integer, 0..maxPoints, non-empty to save.
export function ScoreOverrideModal({
  open,
  onClose,
  owner,
  displayName,
  hasGrade,
  score,
  overridden,
  autogradedScore,
  autogradedMax,
  thresholdFraction,
  ctx,
}: {
  open: boolean
  onClose: () => void
  owner: string
  // Human-friendly name for labels/copy; falls back to the owner login.
  displayName?: string
  // Whether a grade has actually been recorded (false = ungraded empty state).
  hasGrade: boolean
  // The current effective score, used to seed the input (ignored when
  // !hasGrade). The max shown/validated against is ctx.maxPoints.
  score: number
  // The row carries a teacher override — enables the Clear override action.
  overridden: boolean
  // The autograded score/max preserved beneath an override (revert target).
  autogradedScore?: number
  autogradedMax?: number
  thresholdFraction: number | null
  ctx: ScoreOverrideContext
}) {
  const { t } = useTranslation()
  const name = displayName?.trim() || owner
  // The parent mounts a fresh modal per open (keyed by owner, rendered only
  // while a row is selected), so the initial draft is seeded here rather than
  // in an effect — no stale value carries across opens.
  const [draft, setDraft] = useState(hasGrade ? String(score) : "")
  // When the max isn't known (a pending autograded row), the teacher enters it
  // alongside the score. Otherwise ctx.maxPoints is authoritative and this
  // input isn't shown.
  const maxEditable = typeof ctx.maxPoints !== "number"
  const [maxDraft, setMaxDraft] = useState("")
  const mutation = useSetScoreOverride()
  // A synchronous latch so two submits in the SAME tick (before mutation
  // .isPending flips on the next render) can't both fire mutate.
  const inFlightRef = useRef(false)

  const saving = mutation.isPending

  // The effective max the score validates against: the entered one when the
  // teacher supplies it, else the context max. `null` = no usable max yet.
  const parsedMax = maxEditable ? Number(maxDraft) : ctx.maxPoints
  const maxError =
    maxEditable && maxDraft.trim() === ""
      ? t("submissions.scoreOverride.maxRequired")
      : maxEditable && (!Number.isInteger(parsedMax) || (parsedMax ?? 0) < 1)
        ? t("submissions.scoreOverride.maxRange")
        : null
  const effectiveMax =
    typeof parsedMax === "number" &&
    Number.isInteger(parsedMax) &&
    parsedMax > 0
      ? parsedMax
      : null

  const parsed = Number(draft)
  const validationError =
    draft.trim() === ""
      ? t("submissions.scoreOverride.required")
      : effectiveMax === null
        ? // Score can't be validated until a valid max exists; the max input
          // carries its own error, so don't double-report here.
          null
        : !Number.isInteger(parsed) || parsed < 0 || parsed > effectiveMax
          ? t("submissions.scoreOverride.range", { max: effectiveMax })
          : null

  // A save is blocked while either input is invalid (or the max is missing).
  const saveBlocked =
    Boolean(validationError) || Boolean(maxError) || effectiveMax === null

  const save = () => {
    if (saveBlocked || effectiveMax === null) return
    if (inFlightRef.current || mutation.isPending) return
    inFlightRef.current = true
    mutation.mutate(
      {
        org: ctx.org,
        classroom: ctx.classroom,
        assignment: ctx.assignment,
        owner,
        assignmentType: ctx.assignmentType,
        memberUsernames: ctx.memberUsernames,
        score: parsed,
        maxPoints: effectiveMax,
      },
      {
        onSuccess: () => onClose(),
        onSettled: () => {
          inFlightRef.current = false
        },
      },
    )
  }

  const clear = () => {
    if (inFlightRef.current || mutation.isPending) return
    inFlightRef.current = true
    mutation.mutate(
      {
        org: ctx.org,
        classroom: ctx.classroom,
        assignment: ctx.assignment,
        owner,
        assignmentType: ctx.assignmentType,
        clear: true,
      },
      {
        onSuccess: () => onClose(),
        onSettled: () => {
          inFlightRef.current = false
        },
      },
    )
  }

  const title = overridden
    ? t("submissions.scoreOverride.titleOverride")
    : hasGrade
      ? t("submissions.scoreOverride.titleEdit")
      : t("submissions.scoreOverride.titleAdd")

  const description =
    ctx.mode === "auto"
      ? t("submissions.scoreOverride.descriptionAuto", { name })
      : t("submissions.scoreOverride.descriptionManual", { name })

  // The preserved autograded value shown as the revert target — only when an
  // override is in place (a fresh, not-yet-overridden autograded row shows its
  // score in the input already, so a separate block would just duplicate it).
  const showAutograded =
    ctx.mode === "auto" &&
    overridden &&
    typeof autogradedScore === "number" &&
    typeof autogradedMax === "number"

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={saving}
      size="md"
      title={title}
      subtitle={description}
      footer={
        <>
          {/* Destructive Clear sits apart on the start side; Cancel/Save keep
              the standard end-aligned order. */}
          <div className="me-auto">
            {overridden ? (
              <Button
                type="button"
                variant="error"
                size="sm"
                disabled={saving}
                aria-label={t("submissions.scoreOverride.clearLabel", { name })}
                onClick={clear}
              >
                {t("submissions.scoreOverride.clear")}
              </Button>
            ) : null}
          </div>
          {saving ? <Spinner size="xs" className="self-center" /> : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={saving || saveBlocked}
            onClick={save}
          >
            {t("submissions.scoreOverride.save")}
          </Button>
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-4">
        {showAutograded ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-base-content/60">
              {t("submissions.scoreOverride.currentAutograded")}
            </span>
            <ScoreBadge
              score={autogradedScore}
              max={autogradedMax}
              thresholdFraction={thresholdFraction}
              size="sm"
            />
          </div>
        ) : null}

        <FormField
          label={t("submissions.scoreOverride.inputLabel")}
          error={
            validationError && draft.trim() !== "" ? validationError : undefined
          }
        >
          {({ id, describedById, invalid }) => (
            <div className="flex items-center gap-1.5">
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={0}
                max={effectiveMax ?? undefined}
                step={1}
                className="w-24"
                autoFocus
                disabled={saving}
                aria-describedby={describedById}
                aria-invalid={invalid || undefined}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    save()
                  }
                }}
              />
              <span className="text-sm text-base-content/60 whitespace-nowrap">
                / {maxEditable ? (effectiveMax ?? "—") : ctx.maxPoints}
              </span>
            </div>
          )}
        </FormField>

        {maxEditable ? (
          <FormField
            label={t("submissions.scoreOverride.maxLabel")}
            error={maxError && maxDraft.trim() !== "" ? maxError : undefined}
            hint={t("submissions.scoreOverride.maxHint")}
          >
            {({ id, describedById, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                className="w-24"
                disabled={saving}
                aria-describedby={describedById}
                aria-invalid={invalid || undefined}
                value={maxDraft}
                onChange={(e) => setMaxDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    save()
                  }
                }}
              />
            )}
          </FormField>
        ) : null}

        {mutation.isError ? (
          <Alert tone="error" className="text-sm">
            {mutation.variables?.clear
              ? t("submissions.scoreOverride.clearError")
              : t("submissions.scoreOverride.saveError")}
          </Alert>
        ) : null}
      </div>
    </Modal>
  )
}

export default ScoreOverrideModal
