import { AlertIcon, CopyIcon } from "@/components/ui/icons"
import { useEffect, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"

import { AnimatedAlert, Button, Modal, ModalIcon } from "@/components/ui"

// Shared chrome for the two reuse modals — close button, header, error/warning
// alerts, Cancel/Reuse footer — so each supplies only its title, description,
// and direction-specific selectors. The modal owns the <dialog> ref (the reuse
// hook needs it); the shell just opens it on mount.
export const ReuseModalShell = ({
  dialogRef,
  title,
  description,
  isPending,
  warning,
  errorMessage,
  canSubmit,
  showSubmit,
  onSubmit,
  onClose,
  children,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>
  title: string
  description: ReactNode
  isPending: boolean
  warning: string | null
  errorMessage: string | null
  canSubmit: boolean
  // Hide the Reuse button when there's nothing to submit into/from, or after a
  // grant warning turns the flow into a "Done" acknowledgement.
  showSubmit: boolean
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
}) => {
  // Mounted only while reuse is active (parent gates + remounts), so open once.
  useEffect(() => {
    dialogRef.current?.showModal()
  }, [dialogRef])

  const closeDialog = () => dialogRef.current?.close()
  const { t } = useTranslation()

  return (
    <Modal
      dialogRef={dialogRef}
      onClose={onClose}
      closeDisabled={isPending}
      title={title}
      subtitle={description}
      headerVisual={
        <ModalIcon>
          <CopyIcon className="size-4" aria-hidden="true" />
        </ModalIcon>
      }
      footer={
        <>
          <Button variant="ghost" disabled={isPending} onClick={closeDialog}>
            {warning ? t("common.done") : t("common.cancel")}
          </Button>
          {showSubmit && !warning ? (
            <Button
              variant="primary"
              disabled={!canSubmit}
              loading={isPending}
              loadingLabel={t("components.modals.reuseShell.copying")}
              onClick={onSubmit}
            >
              {isPending ? (
                t("components.modals.reuseShell.copying")
              ) : (
                <>
                  <CopyIcon aria-hidden="true" className="size-4" />{" "}
                  {t("components.modals.reuseShell.reuseAssignment")}
                </>
              )}
            </Button>
          ) : null}
        </>
      }
    >
      {children}

      <AnimatedAlert
        tone="error"
        show={!!errorMessage}
        className="mt-4 text-sm"
      >
        {errorMessage}
      </AnimatedAlert>

      <AnimatedAlert
        tone="warning"
        show={!!warning}
        className="mt-4 items-start text-sm"
      >
        <AlertIcon aria-hidden="true" className="size-4 shrink-0" />
        <span>{warning}</span>
      </AnimatedAlert>
    </Modal>
  )
}

export default ReuseModalShell

// Slug-field helper text. `loading`/`error`/`slugOverBudget`/`slugTaken` take
// priority in order; otherwise preview the normalized form or fall back to
// `uniqueHint`. `classroomLabel`/`uniqueHint` carry each modal's wording.
export const reuseSlugStatus = ({
  t,
  loading,
  error,
  slugTaken,
  slugReserved,
  slugOverBudget,
  slugBudget,
  slugTouched,
  normalizedSlug,
  displayedSlug,
  classroomLabel,
  uniqueHint,
}: {
  t: TFunction
  loading: boolean
  error: boolean
  slugTaken: boolean
  slugReserved: boolean
  slugOverBudget: boolean
  slugBudget: number
  slugTouched: boolean
  normalizedSlug: string
  displayedSlug: string
  classroomLabel: string
  uniqueHint: string
}): string => {
  if (loading) return t("components.modals.reuseShell.slug.checking")
  if (error) return t("components.modals.reuseShell.slug.checkError")
  if (slugOverBudget)
    // A budget below the 2-char slug minimum means NO slug can fit (a legacy
    // over-long classroom) — point at a different classroom, not a shorter slug.
    return slugBudget < 2
      ? t("components.modals.reuseShell.slug.noRoom", {
          classroom: classroomLabel,
        })
      : t("components.modals.reuseShell.slug.overBudget", {
          length: normalizedSlug.length,
          budget: slugBudget,
          classroom: classroomLabel,
        })
  if (slugTaken)
    return t("components.modals.reuseShell.slug.taken", {
      slug: normalizedSlug,
      classroom: classroomLabel,
    })
  if (slugReserved)
    return t("components.modals.reuseShell.slug.reserved", {
      slug: normalizedSlug,
      classroom: classroomLabel,
    })
  if (slugTouched && normalizedSlug !== displayedSlug)
    return t("components.modals.reuseShell.slug.willBeSaved", {
      slug: normalizedSlug,
    })
  return uniqueHint
}
