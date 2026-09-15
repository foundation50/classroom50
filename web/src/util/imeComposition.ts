import type { KeyboardEvent } from "react"

// Whether a keydown belongs to an IME composition (Japanese, Chinese, Korean).
// Committing a candidate with Enter fires `keydown` with `key === "Enter"` and
// `isComposing` set (Firefox), or `keyCode` 229 (older engines, some Android
// keyboards); an Enter-to-act handler must ignore both or it acts on a
// half-composed value.
export const isComposingKey = (event: KeyboardEvent): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229
