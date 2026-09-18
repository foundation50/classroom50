import { useEffect, type RefObject } from "react"

// Dismiss an open overlay when Escape is pressed anywhere inside its root (the
// trigger, or the top-layer panel that is still a DOM descendant of it).
// Root-scoped and consumed, so only the innermost overlay goes away and a
// dialog or menu behind it stays open (WCAG 1.4.13, the APG menu-button
// pattern). A native listener, because a div with a JSX keyboard handler reads
// as a fake interactive element to the a11y lint.
export function useDismissOnEscape(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    const root = ref.current
    if (!open || !root) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
    }

    root.addEventListener("keydown", onKeyDown)
    return () => root.removeEventListener("keydown", onKeyDown)
  }, [ref, open, onDismiss])
}

export default useDismissOnEscape
