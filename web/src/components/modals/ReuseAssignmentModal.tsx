import { useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import useGetClasses from "@/hooks/useGetClasses"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import type { Assignment } from "@/types/classroom"
import { useReuseAssignment } from "@/hooks/useReuseAssignment"
import {
  ReuseModalShell,
  reuseSlugStatus,
} from "@/components/modals/ReuseModalShell"

// Reuse ("Duplicate") an assignment into any classroom in the same org —
// our equivalent of GitHub Classroom's "Reuse assignment", including into the
// assignment's own classroom. v1 is in-org only: the target picker lists
// classrooms under classroom50/, never a different org (a private template can
// only be team-granted within its org).
export const ReuseAssignmentModal = ({
  org,
  classroom,
  assignment,
  onClose,
}: {
  org: string
  // The assignment's own classroom — labeled "(this classroom)" in the picker.
  classroom: string
  assignment: Assignment
  onClose: () => void
}) => {
  const { classes } = useGetClasses(org)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const { t } = useTranslation()

  // Any classroom in the org, including this assignment's own — reusing into
  // the same classroom is a valid way to duplicate an assignment.
  const targets = useMemo(() => classes, [classes])

  const [targetClassroom, setTargetClassroom] = useState("")

  // Preload the chosen target's assignments to auto-suffix/validate the slug
  // (lazy: only once a target is picked).
  const {
    data: targetData,
    isLoading: targetLoading,
    isError: targetError,
  } = useGetClassroomAssignments(org, targetClassroom || undefined, {
    enabled: Boolean(targetClassroom),
  })
  const takenSlugs = useMemo(
    () => (targetData?.assignments ?? []).map((a) => a.slug),
    [targetData],
  )

  const reuse = useReuseAssignment({
    org,
    targetClassroom,
    source: assignment,
    takenSlugs,
    takenLoading: targetLoading,
    closeDialog: () => dialogRef.current?.close(),
  })

  const handlePickTarget = (value: string) => {
    setTargetClassroom(value)
    reuse.resetSlug()
  }

  return (
    <ReuseModalShell
      dialogRef={dialogRef}
      title={t("components.modals.reuseAssignment.title")}
      description={
        <>
          {t("components.modals.reuseAssignment.description_prefix")}{" "}
          <span className="font-semibold text-base-content">
            {assignment.name || assignment.slug}
          </span>{" "}
          {t("components.modals.reuseAssignment.description_suffix", { org })}
        </>
      }
      isPending={reuse.isPending}
      warning={reuse.warning}
      errorMessage={reuse.errorMessage}
      canSubmit={reuse.canSubmit}
      showSubmit={targets.length > 0}
      onSubmit={reuse.submit}
      onClose={onClose}
    >
      {targets.length === 0 ? (
        <div className="mt-6 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
          {t("components.modals.reuseAssignment.noTargets", { org })}
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <label className="form-control w-full">
            <span className="label-text mb-1 font-medium">
              {t("components.modals.reuseAssignment.targetClassroom")}
            </span>
            <select
              className="select select-bordered w-full"
              value={targetClassroom}
              disabled={reuse.isPending}
              onChange={(e) => handlePickTarget(e.target.value)}
            >
              <option value="" disabled>
                {t("components.modals.reuseAssignment.chooseClassroom")}
              </option>
              {targets.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name === classroom
                    ? t(
                        "components.modals.reuseAssignment.thisClassroomOption",
                        {
                          classroom: c.name,
                        },
                      )
                    : c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="form-control w-full">
            <span className="label-text mb-1 font-medium">
              {t("components.modals.reuseAssignment.slugLabel")}
            </span>
            <input
              type="text"
              className={`input input-bordered w-full font-mono ${
                reuse.slugTaken ? "input-error" : ""
              }`}
              value={reuse.displayedSlug}
              disabled={reuse.isPending || !targetClassroom || targetLoading}
              onChange={(e) => reuse.onSlugChange(e.target.value)}
              onBlur={reuse.onSlugBlur}
            />
            <span
              className={`label-text-alt mt-1 ${
                reuse.slugTaken ? "text-error" : "text-base-content/70"
              }`}
            >
              {!targetClassroom
                ? t("components.modals.reuseAssignment.chooseClassroomFirst")
                : reuseSlugStatus({
                    t,
                    loading: targetLoading,
                    error: targetError,
                    slugTaken: reuse.slugTaken,
                    slugTouched: reuse.slugTouched,
                    normalizedSlug: reuse.normalizedSlug,
                    displayedSlug: reuse.displayedSlug,
                    classroomLabel: targetClassroom,
                    uniqueHint: t(
                      "components.modals.reuseAssignment.uniqueHint",
                    ),
                  })}
            </span>
          </label>
        </div>
      )}
    </ReuseModalShell>
  )
}

export default ReuseAssignmentModal
