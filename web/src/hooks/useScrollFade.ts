import { useCallback, useEffect, useRef } from "react"

// Drives the `scroll-fade-y` mask: sets data-fade-top / data-fade-bottom on the
// element to whichever edge still has hidden content, so the fade only appears
// where there's more to scroll to. Attributes are written straight to the DOM
// (no state) to avoid a re-render on every scroll frame.
export function useScrollFade<T extends HTMLElement>() {
  const elementRef = useRef<T | null>(null)

  const update = useCallback((el: T) => {
    const { scrollTop, scrollHeight, clientHeight } = el
    // 1px slack absorbs sub-pixel rounding at the extremes.
    const atTop = scrollTop <= 1
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1
    el.dataset.fadeTop = String(!atTop)
    el.dataset.fadeBottom = String(!atBottom && scrollHeight > clientHeight)
  }, [])

  const ref = useCallback(
    (el: T | null) => {
      elementRef.current = el
      if (el) update(el)
    },
    [update],
  )

  useEffect(() => {
    const el = elementRef.current
    if (!el) return
    const onScroll = () => update(el)
    el.addEventListener("scroll", onScroll, { passive: true })
    const observer = new ResizeObserver(() => update(el))
    observer.observe(el)
    return () => {
      el.removeEventListener("scroll", onScroll)
      observer.disconnect()
    }
  }, [update])

  return ref
}

export default useScrollFade
