import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, Pencil, X } from "lucide-react"

import { Badge, Button, Input, Spinner } from "@/components/ui"
import { scoreTone } from "@/pages/submissions/dashboard"
import { useSetScoreOverride } from "@/hooks/mutations/useSetScoreOverride"

export type ManualGradeContext = {
  org: string
  classroom: string
  assignment: string
  assignmentType: "individual" | "group"
  // The assignment's configured max points (>= 1) for a manual assignment.
  maxPoints: number
  // Group crediting for a new entry (the credited members of the group repo).
  memberUsernames?: string[]
}

// The inline score editor for a MANUAL-mode assignment (or a teacher override).
// A small state machine in the score cell:
//   idle    -> shows the current score badge (or an "Add grade" affordance) with
//              an edit button
//   editing -> a number input with Save / Cancel; Enter saves, Esc cancels
//   saving  -> input disabled + spinner
//   error   -> inline role="alert" message + the value kept for a retry
// Validation mirrors the form: integer, 0..maxPoints, non-empty to save. An
// un-scored row renders empty (never a defaulted 0) and stays "ungraded".
export function ManualGradeCell({
  owner,
  score,
  max,
  hasGrade,
  thresholdFraction,
  ctx,
}: {
  owner: string
  // Current score / max (from the collected/override row). Ignored for display
  // when hasGrade is false.
  score: number
  max: number
  // Whether a grade has actually been recorded for this owner. False = the
  // ungraded empty state (show "Add grade", not 0).
  hasGrade: boolean
  thresholdFraction: number | null
  ctx: ManualGradeContext
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  // The draft value while editing, as a string so an empty field is
  // representable (distinct from 0).
  const [draft, setDraft] = useState("")
  const mutation = useSetScoreOverride()

  const startEditing = () => {
    setDraft(hasGrade ? String(score) : "")
    mutation.reset()
    setEditing(true)
  }

  const cancel = () => {
    setEditing(false)
    setDraft("")
    mutation.reset()
  }

  const parsed = Number(draft)
  const validationError =
    draft.trim() === ""
      ? t("submissions.manualGrade.required")
      : !Number.isInteger(parsed) || parsed < 0 || parsed > ctx.maxPoints
        ? t("submissions.manualGrade.range", { max: ctx.maxPoints })
        : null

  const save = () => {
    if (validationError) return
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
        onSuccess: () => {
          setEditing(false)
          setDraft("")
        },
      },
    )
  }

  if (editing) {
    const saving = mutation.isPending
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={ctx.maxPoints}
            step={1}
            className="w-20"
            autoFocus
            disabled={saving}
            aria-label={t("submissions.manualGrade.inputLabel", {
              name: owner,
            })}
            aria-describedby={
              validationError ? `manual-grade-error-${owner}` : undefined
            }
            aria-invalid={validationError ? true : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                save()
              } else if (e.key === "Escape") {
                e.preventDefault()
                cancel()
              }
            }}
          />
          <span className="text-sm text-base-content/60 whitespace-nowrap">
            / {ctx.maxPoints}
          </span>
          {saving ? (
            <Spinner size="xs" />
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                shape="square"
                aria-label={t("common.save")}
                disabled={Boolean(validationError)}
                onClick={save}
              >
                <Check className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                shape="square"
                aria-label={t("common.cancel")}
                onClick={cancel}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
        {validationError && !saving ? (
          <p
            id={`manual-grade-error-${owner}`}
            role="alert"
            className="text-xs text-error"
          >
            {validationError}
          </p>
        ) : null}
        {mutation.isError ? (
          <p role="alert" className="text-xs text-error">
            {t("submissions.manualGrade.saveError")}
          </p>
        ) : null}
      </div>
    )
  }

  // Idle: the current grade (or an "Add grade" ghost for an ungraded row), plus
  // an edit affordance.
  const tone = scoreTone(score, max, thresholdFraction)
  return (
    <div className="flex items-center gap-1.5">
      {hasGrade ? (
        tone.ghost ? (
          <Badge ghost>
            {score}/{max}
          </Badge>
        ) : (
          <Badge tone={tone.tone}>
            {score}/{max}
          </Badge>
        )
      ) : (
        <span className="text-sm text-base-content/50">
          {t("submissions.manualGrade.notGraded")}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        shape="square"
        aria-label={
          hasGrade
            ? t("submissions.manualGrade.editLabel", { name: owner })
            : t("submissions.manualGrade.addLabel", { name: owner })
        }
        title={
          hasGrade
            ? t("submissions.manualGrade.edit")
            : t("submissions.manualGrade.add")
        }
        onClick={startEditing}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

export default ManualGradeCell
