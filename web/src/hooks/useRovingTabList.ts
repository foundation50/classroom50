import { useRef } from "react"
import type { KeyboardEvent } from "react"

// Roving-tabindex keyboard wiring for a manual-activation `role="tablist"`
// (ARIA APG tabs pattern): arrow keys move focus between tabs (wrapping,
// direction-aware for RTL), Home/End jump to the ends, and only the active
// tab sits in the page tab order. Activation stays on click/Enter/Space —
// the native button behavior — so arrowing through tabs never loads panels
// the user didn't ask for. Returns a per-tab props factory to spread onto
// each `role="tab"` button.
export function useRovingTabList(count: number, activeIndex: number) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const handleKeyDown = (index: number) => (e: KeyboardEvent) => {
    const last = count - 1
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl"
    const forward = rtl ? "ArrowLeft" : "ArrowRight"
    const backward = rtl ? "ArrowRight" : "ArrowLeft"
    let next: number | null = null
    if (e.key === forward || e.key === "ArrowDown") {
      next = index === last ? 0 : index + 1
    } else if (e.key === backward || e.key === "ArrowUp") {
      next = index === 0 ? last : index - 1
    } else if (e.key === "Home") {
      next = 0
    } else if (e.key === "End") {
      next = last
    }
    if (next === null) return
    e.preventDefault()
    refs.current[next]?.focus()
  }

  return (index: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      refs.current[index] = el
    },
    tabIndex: index === activeIndex ? 0 : -1,
    onKeyDown: handleKeyDown(index),
  })
}

export default useRovingTabList
