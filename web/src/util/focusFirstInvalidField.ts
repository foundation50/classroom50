// Focus (and reveal) the first invalid control inside a form after a failed
// submit — Primer's form-validation announcement mechanism: focus movement,
// not live regions, tells AT users what to fix. Controls opt in by carrying
// aria-invalid (FormField wires this).
export function focusFirstInvalidField(root: HTMLElement | null) {
  const target = root?.querySelector<HTMLElement>('[aria-invalid="true"]')
  if (!target) return
  target.scrollIntoView({ behavior: "smooth", block: "center" })
  target.focus({ preventScroll: true })
}
