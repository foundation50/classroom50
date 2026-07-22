// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"

import { useScrollFade } from "./useScrollFade"

// happy-dom has no layout engine, so scroll metrics are stubbed per element.
// ResizeObserver / MutationObserver are mocked so tests can drive their
// callbacks and assert teardown.
function stubMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  })
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    writable: true,
    value: metrics.scrollHeight,
  })
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    writable: true,
    value: metrics.clientHeight,
  })
}

// Capture observer instances so tests can fire callbacks and assert disconnect.
const resizeInstances: {
  cb: ResizeObserverCallback
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}[] = []

function Harness({
  metrics,
}: {
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }
}) {
  const ref = useScrollFade<HTMLDivElement>()
  return (
    <div
      data-testid="list"
      ref={(el) => {
        if (el) stubMetrics(el, metrics)
        ref(el)
      }}
    />
  )
}

describe("useScrollFade", () => {
  beforeEach(() => {
    resizeInstances.length = 0
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: ResizeObserverCallback
        observe = vi.fn()
        disconnect = vi.fn()
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb
          resizeInstances.push({
            cb,
            observe: this.observe,
            disconnect: this.disconnect,
          })
        }
      },
    )
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("fades only the bottom when scrolled to the top of an overflowing list", () => {
    const { getByTestId } = render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }}
      />,
    )
    const el = getByTestId("list")
    expect(el.dataset.fadeTop).toBe("false")
    expect(el.dataset.fadeBottom).toBe("true")
  })

  it("fades only the top when scrolled to the bottom", () => {
    const { getByTestId } = render(
      <Harness
        metrics={{ scrollTop: 200, scrollHeight: 400, clientHeight: 200 }}
      />,
    )
    const el = getByTestId("list")
    expect(el.dataset.fadeTop).toBe("true")
    expect(el.dataset.fadeBottom).toBe("false")
  })

  it("fades both edges when scrolled to the middle", () => {
    const { getByTestId } = render(
      <Harness
        metrics={{ scrollTop: 100, scrollHeight: 400, clientHeight: 200 }}
      />,
    )
    const el = getByTestId("list")
    expect(el.dataset.fadeTop).toBe("true")
    expect(el.dataset.fadeBottom).toBe("true")
  })

  it("fades neither edge when content fits without scrolling", () => {
    const { getByTestId } = render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }}
      />,
    )
    const el = getByTestId("list")
    expect(el.dataset.fadeTop).toBe("false")
    expect(el.dataset.fadeBottom).toBe("false")
  })

  it("recomputes edges on scroll", () => {
    const { getByTestId } = render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }}
      />,
    )
    const el = getByTestId("list")
    expect(el.dataset.fadeTop).toBe("false")

    act(() => {
      ;(el as unknown as { scrollTop: number }).scrollTop = 200
      el.dispatchEvent(new Event("scroll"))
    })
    expect(el.dataset.fadeTop).toBe("true")
    expect(el.dataset.fadeBottom).toBe("false")
  })

  it("recomputes when the ResizeObserver fires (content grows after mount)", () => {
    const { getByTestId } = render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }}
      />,
    )
    const el = getByTestId("list")
    expect(el.dataset.fadeBottom).toBe("false")

    act(() => {
      // Content grew past the capped box after async data arrived.
      ;(el as unknown as { scrollHeight: number }).scrollHeight = 400
      resizeInstances[0].cb([], resizeInstances[0] as unknown as ResizeObserver)
    })
    expect(el.dataset.fadeBottom).toBe("true")
  })

  it("disconnects observers and removes the scroll listener on unmount", () => {
    const { getByTestId, unmount } = render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 400, clientHeight: 200 }}
      />,
    )
    const el = getByTestId("list")
    const removeSpy = vi.spyOn(el, "removeEventListener")
    const { disconnect } = resizeInstances[0]

    unmount()

    expect(disconnect).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalledWith("scroll", expect.any(Function))
  })
})
