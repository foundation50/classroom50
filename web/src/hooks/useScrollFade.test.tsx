// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"

import { useScrollFade } from "./useScrollFade"

// happy-dom has no layout engine, so scroll metrics are stubbed per element and
// ResizeObserver is mocked to a no-op we can ignore (the scroll path covers the
// same update()).
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
    value: metrics.scrollHeight,
  })
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  })
}

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
    vi.stubGlobal(
      "ResizeObserver",
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
})
