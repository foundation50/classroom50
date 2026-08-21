import { useEffect, type RefObject } from "react"

// Dismiss an open overlay when a pointer goes down outside it.
//
// Pointer-down rather than click: a click fires after the overlay's own
// blur/refocus handling, which is late enough to reopen what it just closed.
export function useDismissOnOutsidePointerDown(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && ref.current?.contains(target)) return
      onDismiss()
    }

    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [ref, open, onDismiss])
}

export default useDismissOnOutsidePointerDown
