// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { LoadingSwap } from "./LoadingSwap"

afterEach(cleanup)

describe("LoadingSwap", () => {
  it("wraps children (with aria-busy) by default even when never loading", () => {
    const { container } = render(
      <LoadingSwap loading={false} fallback={<span>load</span>}>
        <span>done</span>
      </LoadingSwap>,
    )
    expect(container.textContent).toContain("done")
    expect(container.querySelector('[aria-busy="false"]')).toBeTruthy()
  })

  it("shows the fallback and marks busy while loading", () => {
    const { container } = render(
      <LoadingSwap loading fallback={<span>load</span>}>
        <span>done</span>
      </LoadingSwap>,
    )
    expect(container.textContent).toContain("load")
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  describe("deferUntilLoaded", () => {
    it("renders children bare (no wrapper, no aria-busy) when never loading", () => {
      const { container } = render(
        <LoadingSwap
          loading={false}
          deferUntilLoaded
          fallback={<span>load</span>}
        >
          <span>done</span>
        </LoadingSwap>,
      )
      expect(container.textContent).toBe("done")
      expect(container.querySelector("[aria-busy]")).toBeNull()
    })

    it("keeps the className on the bare path", () => {
      const { container } = render(
        <LoadingSwap
          loading={false}
          deferUntilLoaded
          className="cell"
          fallback={<span>load</span>}
        >
          <span>done</span>
        </LoadingSwap>,
      )
      expect(container.querySelector(".cell")?.textContent).toBe("done")
    })

    it("latches into the wrapped swap after a false->true->false cycle", () => {
      const { container, rerender } = render(
        <LoadingSwap
          loading={false}
          deferUntilLoaded
          fallback={<span>load</span>}
        >
          <span>done</span>
        </LoadingSwap>,
      )
      expect(container.querySelector("[aria-busy]")).toBeNull()

      rerender(
        <LoadingSwap loading deferUntilLoaded fallback={<span>load</span>}>
          <span>done</span>
        </LoadingSwap>,
      )
      expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()

      rerender(
        <LoadingSwap
          loading={false}
          deferUntilLoaded
          fallback={<span>load</span>}
        >
          <span>done</span>
        </LoadingSwap>,
      )
      // Once it has loaded, the swap stays in the wrapped AnimatePresence path
      // rather than reverting to the bare passthrough — the wrapped path always
      // renders an [aria-busy] node, the bare path renders none — so the resolve
      // can cross-fade. (mode="wait" holds the outgoing fallback until its exit
      // completes, which the test environment doesn't advance, so the resolved
      // child isn't observable synchronously here.)
      expect(container.querySelector("[aria-busy]")).toBeTruthy()
    })
  })
})
