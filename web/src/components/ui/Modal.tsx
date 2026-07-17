import { X } from "lucide-react"
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"
import { useTranslation } from "react-i18next"

import { Button } from "./Button"
import { cx } from "./cx"

// The canonical dialog. Wraps the native `<dialog className="modal">` idiom the
// app uses everywhere: it owns the `modal-box` (sized via `size`), the top-right
// close X, the click-outside `modal-backdrop`, and the open/close sync. Two
// control modes:
//   - controlled: pass `open` + `onClose` (the common case). The effect calls
//     showModal()/close() to match `open`.
//   - ref-driven: pass a `dialogRef` you open imperatively (e.g. a hook that
//     needs the element). `open` may be omitted.
// `onClose` fires on the native dialog close (Esc, backdrop, close button).

export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl"

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
}

export type ModalProps = {
  open?: boolean
  onClose?: () => void
  size?: ModalSize
  // Hide the built-in top-right close X (some modals render their own header
  // affordance or must block dismissal while submitting).
  hideCloseButton?: boolean
  // Block dismissal while a submit is in flight: disables the close X + backdrop
  // close, vetoes Esc (see the onCancel guard below), and holds the dialog open
  // against a controlled `open=false` transition (see the open-sync effect).
  closeDisabled?: boolean
  "aria-labelledby"?: string
  "aria-label"?: string
  // Extra classes for the modal-box.
  boxClassName?: string
  dialogRef?: RefObject<HTMLDialogElement | null>
  ref?: Ref<HTMLDialogElement>
  children?: ReactNode
}

export function Modal({
  open,
  onClose,
  size = "lg",
  hideCloseButton = false,
  closeDisabled = false,
  boxClassName,
  dialogRef,
  ref,
  children,
  ...aria
}: ModalProps) {
  const { t } = useTranslation()
  const internalRef = useRef<HTMLDialogElement | null>(null)
  const closeId = useId()

  // Keep the native dialog in sync with `open` (controlled mode). Skipped when
  // the caller drives the dialog through `dialogRef` and never passes `open`.
  // Don't close while `closeDisabled` — a parent may flip open=false mid-submit.
  useEffect(() => {
    if (open === undefined) return
    const dialog = dialogRef?.current ?? internalRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open && !closeDisabled) dialog.close()
  }, [open, dialogRef, closeDisabled])

  const setRefs = (node: HTMLDialogElement | null) => {
    internalRef.current = node
    if (dialogRef) dialogRef.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) (ref as { current: HTMLDialogElement | null }).current = node
  }

  return (
    <dialog
      ref={setRefs}
      className="modal"
      onClose={() => onClose?.()}
      onCancel={(event) => {
        // Esc triggers `cancel` before `close`. When dismissal is blocked
        // (e.g. a submit is in flight), veto it so the dialog stays open —
        // matching the hand-rolled modals' Esc guard.
        if (closeDisabled) event.preventDefault()
      }}
      {...aria}
    >
      <div className={cx("modal-box", SIZE_CLASS[size], boxClassName)}>
        {!hideCloseButton && (
          <form method="dialog">
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              shape="circle"
              className="absolute end-3 top-3"
              aria-label={t("common.close")}
              disabled={closeDisabled}
              key={closeId}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </form>
        )}
        {children}
      </div>

      <form method="dialog" className="modal-backdrop">
        <button disabled={closeDisabled}>{t("common.close")}</button>
      </form>
    </dialog>
  )
}

export default Modal
