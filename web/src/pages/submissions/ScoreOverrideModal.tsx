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
  // grading.max_points; autograded rows pass the row's own max-score.
  maxPoints: number
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
  max,
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
  // The current effective score / max (ignored for display when !hasGrade).
  score: number
  max: number
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
  const mutation = useSetScoreOverride()
  // A synchronous latch so two submits in the SAME tick (before mutation
  // .isPending flips on the next render) can't both fire mutate.
  const inFlightRef = useRef(false)

  const saving = mutation.isPending

  const parsed = Number(draft)
  const validationError =
    draft.trim() === ""
      ? t("submissions.scoreOverride.required")
      : !Number.isInteger(parsed) || parsed < 0 || parsed > ctx.maxPoints
        ? t("submissions.scoreOverride.range", { max: ctx.maxPoints })
        : null

  const save = () => {
    if (validationError) return
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
        maxPoints: ctx.maxPoints,
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

  const titleId = `score-override-title-${owner}`
  const title = overridden
    ? t("submissions.scoreOverride.titleOverride")
    : hasGrade
      ? t("submissions.scoreOverride.titleEdit")
      : t("submissions.scoreOverride.titleAdd")

  const description =
    ctx.mode === "auto"
      ? t("submissions.scoreOverride.descriptionAuto", { name })
      : t("submissions.scoreOverride.descriptionManual", { name })

  // The autograded value to surface as the revert target: the preserved
  // history beneath the override, else (a fresh autograded row not yet
  // overridden) the current score.
  const revertScore = autogradedScore ?? (overridden ? undefined : score)
  const revertMax = autogradedMax ?? (overridden ? undefined : max)
  const showAutograded =
    ctx.mode === "auto" &&
    typeof revertScore === "number" &&
    typeof revertMax === "number"

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={saving}
      size="sm"
      aria-labelledby={titleId}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 id={titleId} className="text-lg font-bold">
            {title}
          </h3>
          <p className="text-sm text-base-content/70">{description}</p>
        </div>

        {showAutograded ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-base-content/60">
              {t("submissions.scoreOverride.currentAutograded")}
            </span>
            <ScoreBadge
              score={revertScore as number}
              max={revertMax as number}
              thresholdFraction={thresholdFraction}
              size="sm"
            />
          </div>
        ) : null}

        <FormField
          label={t("submissions.scoreOverride.inputLabel", { name })}
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
                max={ctx.maxPoints}
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
                / {ctx.maxPoints}
              </span>
            </div>
          )}
        </FormField>

        {overridden && showAutograded ? (
          <p className="text-xs text-base-content/60">
            {t("submissions.scoreOverride.revertHint", {
              score: revertScore as number,
              max: revertMax as number,
            })}
          </p>
        ) : null}

        {mutation.isError ? (
          <Alert tone="error" className="text-sm">
            {mutation.variables?.clear
              ? t("submissions.scoreOverride.clearError")
              : t("submissions.scoreOverride.saveError")}
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <div>
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
          <div className="flex items-center gap-2">
            {saving ? <Spinner size="xs" /> : null}
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
              disabled={saving || Boolean(validationError)}
              onClick={save}
            >
              {t("submissions.scoreOverride.save")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export default ScoreOverrideModal
