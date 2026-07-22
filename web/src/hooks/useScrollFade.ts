import { useCallback, useEffect, useState } from "react"

// Drives the `scroll-fade-y` mask: sets data-fade-top / data-fade-bottom on the
// element to whichever edge still has hidden content, so the fade only appears
// where there's more to scroll to. Attributes are written straight to the DOM
// (no state) to avoid a re-render on every scroll frame.
export function useScrollFade<T extends HTMLElement>() {
  // Track the node in state (not a ref) so the effect re-subscribes when the
  // element remounts — e.g. a conditionally-rendered list that appears after a
  // loading/empty phase. A ref wouldn't retrigger the effect, leaking listeners
  // on the old node and leaving the new one unbound.
  const [element, setElement] = useState<T | null>(null)

  const update = useCallback((el: T) => {
    const { scrollTop, scrollHeight, clientHeight } = el
    // 1px slack absorbs sub-pixel rounding at the extremes.
    const atTop = scrollTop <= 1
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1
    el.dataset.fadeTop = String(!atTop)
    el.dataset.fadeBottom = String(!atBottom && scrollHeight > clientHeight)
  }, [])

  useEffect(() => {
    if (!element) return
    const recompute = () => update(element)
    recompute()
    element.addEventListener("scroll", recompute, { passive: true })
    // Observe the container and its children: the container catches viewport
    // resizes, the children catch content growing after mount (e.g. async row
    // badges) that changes scrollHeight without resizing the capped box.
    const observer = new ResizeObserver(recompute)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    const mutations = new MutationObserver(() => {
      for (const child of element.children) observer.observe(child)
      recompute()
    })
    mutations.observe(element, { childList: true })
    return () => {
      element.removeEventListener("scroll", recompute)
      observer.disconnect()
      mutations.disconnect()
    }
  }, [element, update])

  return setElement
}

export default useScrollFade
