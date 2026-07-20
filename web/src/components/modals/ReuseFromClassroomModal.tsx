import { useMemo, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"

import useGetClasses from "@/hooks/useGetClasses"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import { useReuseAssignment } from "@/hooks/mutations/useReuseAssignment"
import {
  ReuseModalShell,
  reuseSlugStatus,
} from "@/components/modals/ReuseModalShell"
import { EmphasisLtr, FormField, Input, Select } from "@/components/ui"

// Reuse an assignment FROM any classroom INTO the current one — the "pull"
// counterpart to the per-row "push" reuse on the assignments table. Opened from
// the "New assignment" split button. The source may be the current classroom
// too (a quick way to duplicate). v1 is in-org only: sources are classrooms
// under classroom50/, never a different org.
export const ReuseFromClassroomModal = ({
  org,
  classroom,
  onClose,
}: {
  org: string
  // The destination — the classroom the teacher is currently in.
  classroom: string
  onClose: () => void
}) => {
  const { classes } = useGetClasses(org)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const { t } = useTranslation()

  // Any classroom in the org, including the current one — reusing within the
  // same classroom is a valid way to duplicate an assignment.
  const sources = useMemo(() => classes, [classes])

  const [sourceClassroom, setSourceClassroom] = useState("")
  const [sourceSlug, setSourceSlug] = useState("")

  // Load the chosen source classroom's assignments (lazy: only once picked).
  const {
    data: sourceData,
    isLoading: sourceLoading,
    isError: sourceError,
  } = useGetClassroomAssignments(org, sourceClassroom || undefined, {
    enabled: Boolean(sourceClassroom),
  })
  const sourceAssignments = useMemo(
    () => sourceData?.assignments ?? [],
    [sourceData],
  )

  // Preload the destination's assignments to auto-suffix/validate the slug.
  const {
    data: destData,
    isLoading: destLoading,
    isError: destError,
  } = useGetClassroomAssignments(org, classroom)
  const takenSlugs = useMemo(
    () => (destData?.assignments ?? []).map((a) => a.slug),
    [destData],
  )

  const selectedAssignment = useMemo(
    () => sourceAssignments.find((a) => a.slug === sourceSlug) ?? null,
    [sourceAssignments, sourceSlug],
  )

  const reuse = useReuseAssignment({
    org,
    targetClassroom: classroom,
    source: selectedAssignment,
    takenSlugs,
    takenLoading: destLoading,
    closeDialog: () => dialogRef.current?.close(),
  })

  const handlePickClassroom = (value: string) => {
    setSourceClassroom(value)
    setSourceSlug("")
    reuse.resetSlug()
  }

  const handlePickAssignment = (value: string) => {
    setSourceSlug(value)
    reuse.resetSlug()
  }

  return (
    <ReuseModalShell
      dialogRef={dialogRef}
      title={t("components.modals.reuseFromClassroom.title")}
      description={
        <Trans
          i18nKey="components.modals.reuseFromClassroom.description"
          values={{ org, classroom }}
          components={{
            classroom: <EmphasisLtr className="text-base-content" />,
          }}
        />
      }
      isPending={reuse.isPending}
      warning={reuse.warning}
      errorMessage={reuse.errorMessage}
      canSubmit={reuse.canSubmit}
      showSubmit={sources.length > 0}
      onSubmit={reuse.submit}
      onClose={onClose}
    >
      {sources.length === 0 ? (
        <div className="mt-6 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
          {t("components.modals.reuseFromClassroom.noSources", { org })}
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <FormField
            label={t("components.modals.reuseFromClassroom.sourceClassroom")}
          >
            {({ id, describedById, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedById}
                invalid={invalid}
                value={sourceClassroom}
                disabled={reuse.isPending}
                onChange={(e) => handlePickClassroom(e.target.value)}
              >
                <option value="" disabled>
                  {t("components.modals.reuseFromClassroom.chooseClassroom")}
                </option>
                {sources.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name === classroom
                      ? t(
                          "components.modals.reuseFromClassroom.thisClassroomOption",
                          { classroom: c.name },
                        )
                      : c.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>

          {sourceClassroom ? (
            <FormField
              label={t("components.modals.reuseFromClassroom.assignment")}
              error={
                sourceError
                  ? t("components.modals.reuseFromClassroom.loadError", {
                      classroom: sourceClassroom,
                    })
                  : undefined
              }
            >
              {({ id, describedById, invalid }) => (
                <Select
                  id={id}
                  aria-describedby={describedById}
                  invalid={invalid}
                  value={sourceSlug}
                  disabled={
                    reuse.isPending ||
                    sourceLoading ||
                    sourceAssignments.length === 0
                  }
                  onChange={(e) => handlePickAssignment(e.target.value)}
                >
                  <option value="" disabled>
                    {sourceLoading
                      ? t(
                          "components.modals.reuseFromClassroom.loadingAssignments",
                        )
                      : sourceAssignments.length === 0
                        ? t(
                            "components.modals.reuseFromClassroom.noAssignments",
                          )
                        : t(
                            "components.modals.reuseFromClassroom.chooseAssignment",
                          )}
                  </option>
                  {sourceAssignments.map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {a.name || a.slug}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          ) : null}

          {selectedAssignment
            ? (() => {
                const slugStatus = reuseSlugStatus({
                  t,
                  loading: destLoading,
                  error: destError,
                  slugTaken: reuse.slugTaken,
                  slugTouched: reuse.slugTouched,
                  normalizedSlug: reuse.normalizedSlug,
                  displayedSlug: reuse.displayedSlug,
                  classroomLabel: classroom,
                  uniqueHint: t(
                    "components.modals.reuseFromClassroom.uniqueHint",
                  ),
                })
                return (
                  <FormField
                    label={t("components.modals.reuseFromClassroom.slugLabel", {
                      classroom,
                    })}
                    error={reuse.slugTaken ? slugStatus : undefined}
                    hint={slugStatus}
                  >
                    {({ id, describedById, invalid }) => (
                      <Input
                        id={id}
                        aria-describedby={describedById}
                        invalid={invalid}
                        className="font-mono"
                        value={reuse.displayedSlug}
                        disabled={reuse.isPending || destLoading}
                        onChange={(e) => reuse.onSlugChange(e.target.value)}
                        onBlur={reuse.onSlugBlur}
                      />
                    )}
                  </FormField>
                )
              })()
            : null}
        </div>
      )}
    </ReuseModalShell>
  )
}

export default ReuseFromClassroomModal
