import { XIcon } from "./icons"
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"

import { Button } from "./Button"
import { cx } from "./cx"
import { logger } from "@/lib/logger"
import { Heading } from "./Heading"

// The canonical dialog. Wraps the native `<dialog className="modal">` idiom the
// app uses everywhere: it owns the `modal-box` (sized via `size`), the top-right
// close X, the click-outside `modal-backdrop`, and the open/close sync. Two
// control modes:
//   - controlled: pass `open` + `onClose` (the common case). The effect calls
//     showModal()/close() to match `open`.
//   - ref-driven: pass a `dialogRef` you open imperatively (e.g., a hook that
//     needs the element). `open` may be omitted.
// `onClose` fires on the native dialog close (Esc, backdrop, close button).
//
// Anatomy follows Primer's Dialog (primer.style/product/components/dialog):
// header (title + optional subtitle + close X), body (`children` — the
// modal-box itself scrolls), and a right-aligned `footer` action row. Passing
// `title` wires aria-labelledby automatically; `subtitle` wires
// aria-describedby. Prefer these slots over hand-rolling a header/footer.
// Body content whose buttons are wired to state the `footer` prop can't reach
// (a form instance, a phase-local handler) renders them through
// <ModalFooterPortal> into the same canonical row instead.
//
// Close-animation invariant: the dialog keeps painting through its ~200ms
// fade-out, so callers must not mutate content at close — reset transient
// state when OPENING, retain cleared row data through the fade, and gate
// open-only content with useLingeringOpen.

// The footer container element, provided per Modal instance so
// ModalFooterPortal can target the canonical action row. `undefined` (the
// default) means no Modal ancestor at all; `null` means inside a Modal whose
// footer ref hasn't settled yet (first render) — only the former is a bug.
const ModalFooterContext = createContext<HTMLDivElement | null | undefined>(
  undefined,
)

export type ModalSize =
  "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl"

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
}

export type ModalProps = {
  open?: boolean
  onClose?: () => void
  size?: ModalSize
  // Header slot: rendered as the dialog's h3 title and auto-wired to
  // aria-labelledby. Callers with a `title` must not pass aria props by hand.
  title?: ReactNode
  // Rendered below the title in smaller, lower-contrast type; auto-wired to
  // aria-describedby (Primer Dialog subtitle).
  subtitle?: ReactNode
  // Leading visual for the header (an icon chip). Decorative — mark icons
  // aria-hidden.
  headerVisual?: ReactNode
  // Footer action row, rendered inside the canonical `modal-action`
  // (right-aligned). Convention: ghost Cancel/Close left, primary/confirm
  // rightmost; destructive confirms use variant="error".
  footer?: ReactNode
  // Confirmation dialogs interrupting the user should pass "alertdialog".
  role?: "dialog" | "alertdialog"
  // Hide the built-in top-right close X (some modals render their own header
  // affordance or must block dismissal while submitting).
  hideCloseButton?: boolean
  // Block dismissal while a submit is in flight: disables the close X + backdrop
  // close, vetoes Esc (see the onCancel guard below), and holds the dialog open
  // against a controlled `open=false` transition (see the open-sync effect).
  closeDisabled?: boolean
  // Legacy escape hatches — prefer `title`, which wires labeling automatically.
  "aria-labelledby"?: string
  "aria-label"?: string
  // Forwarded to the dialog element. Lets a caller repurpose keys (e.g. Enter)
  // without hand-rolling a wrapper the a11y lint would flag.
  onKeyDown?: React.KeyboardEventHandler<HTMLDialogElement>
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
  title,
  subtitle,
  headerVisual,
  footer,
  role,
  hideCloseButton = false,
  closeDisabled = false,
  boxClassName,
  dialogRef,
  ref,
  onKeyDown,
  children,
  ...aria
}: ModalProps) {
  const { t } = useTranslation()
  const internalRef = useRef<HTMLDialogElement | null>(null)
  const closeId = useId()
  const titleId = useId()
  const subtitleId = useId()
  // The footer container as state (not a ref) so ModalFooterPortal consumers
  // re-render once the element exists.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null)

  const labelledBy =
    aria["aria-labelledby"] ?? (title !== undefined ? titleId : undefined)
  const describedBy = subtitle !== undefined ? subtitleId : undefined

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
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        // Esc triggers `cancel` before `close`. When dismissal is blocked
        // (e.g., a submit is in flight), veto it so the dialog stays open.
        if (closeDisabled) event.preventDefault()
      }}
      role={role}
      aria-label={aria["aria-label"]}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
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
              <XIcon className="size-4" aria-hidden="true" />
            </Button>
          </form>
        )}
        {title !== undefined && (
          <div
            className={cx(
              // Full-bleed header divider: -mx-6/ps-6 counteract the modal-box
              // padding; pe-14 keeps the title clear of the close X. A lone
              // title centers against the header visual; with a subtitle the
              // block top-aligns.
              "-mx-6 flex gap-4 border-b border-base-300 ps-6 pb-4",
              subtitle !== undefined ? "items-start" : "items-center",
              hideCloseButton ? "pe-6" : "pe-14",
            )}
          >
            {headerVisual}
            <div className="min-w-0 flex-1">
              <Heading as="h3" id={titleId}>
                {title}
              </Heading>
              {subtitle !== undefined && (
                // A div, not <p>: ConfirmModal forwards arbitrary description
                // nodes here, and block content inside <p> is invalid HTML the
                // parser splits apart.
                <div
                  id={subtitleId}
                  className="mt-1 text-sm text-base-content/70"
                >
                  {subtitle}
                </div>
              )}
            </div>
          </div>
        )}
        <ModalFooterContext.Provider value={footerEl}>
          {children}
        </ModalFooterContext.Provider>
        {/* Always mounted so ModalFooterPortal can target it; empty:hidden
            keeps the row (and its top margin) from painting when neither the
            prop nor a portal fills it. */}
        <div ref={setFooterEl} className="modal-action empty:hidden">
          {footer}
        </div>
      </div>

      {/* DaisyUI's click-outside-to-close backdrop. The button is a mouse
          affordance only — keep it out of the tab order (Esc and the top-right
          close X are the keyboard paths) so focus can't tab onto the backdrop
          "behind" the modal box, which reads as leaving the dialog. */}
      <form method="dialog" className="modal-backdrop">
        <button tabIndex={-1} aria-hidden="true" disabled={closeDisabled}>
          {t("common.close")}
        </button>
      </form>
    </dialog>
  )
}

export default Modal

// Renders body-owned action buttons into the Modal's canonical footer row.
// For content whose buttons need state the `footer` prop can't reach (a form
// instance, a phase-local handler); renders nothing outside a Modal. Portal
// content lands AFTER any `footer` prop content in the same row — a host that
// combines both must put its primary action in the portal, or the prop's
// button would sit right of it and break the primary-rightmost convention.
export function ModalFooterPortal({ children }: { children: ReactNode }) {
  const container = useContext(ModalFooterContext)
  if (container === undefined) {
    if (import.meta.env.DEV) {
      logger.warn(
        "ModalFooterPortal rendered outside a Modal: its children are dropped.",
      )
    }
    return null
  }
  // Inside a Modal but the footer ref hasn't settled yet (first render);
  // the ref-callback state flush re-renders us into the container pre-paint.
  if (container === null) return null
  return createPortal(children, container)
}

// Single source for the header icon chip used as `headerVisual` — callers must
// not hand-roll the size/tone recipe.
export type ModalIconTone = "primary" | "warning" | "error"

const MODAL_ICON_TONE_CLASS: Record<ModalIconTone, string> = {
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/10 text-warning",
  error: "bg-error/10 text-error",
}

export function ModalIcon({
  tone = "primary",
  children,
}: {
  tone?: ModalIconTone
  children?: ReactNode
}) {
  return (
    <div
      className={cx(
        "flex size-11 shrink-0 items-center justify-center rounded-box",
        MODAL_ICON_TONE_CLASS[tone],
      )}
    >
      {children}
    </div>
  )
}
