// Whether a row-level mouse event originated inside an interactive element —
// a button, link, or form control — so a whole-row click handler can yield to
// the inner control instead of double-firing (e.g. opening a second modal on
// top of the one the button opened).
export function isInteractiveEventTarget(event: {
  target: EventTarget | null
}): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(
      "button, a, input, select, textarea, [role='button']",
    ) !== null
  )
}
