// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { StrictMode } from "react"
import { act, renderHook } from "@testing-library/react"

import { useCopyToClipboard } from "./useCopyToClipboard"

const writeText = vi.fn<(text: string) => Promise<void>>()

Object.defineProperty(navigator, "clipboard", {
  value: { writeText },
  configurable: true,
})

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
})

describe("useCopyToClipboard", () => {
  it("flips copied on success and auto-resets after resetMs", async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useCopyToClipboard("hello", 1500))

      await act(() => result.current.copy())
      expect(writeText).toHaveBeenCalledWith("hello")
      expect(result.current.copied).toBe(true)

      act(() => vi.advanceTimersByTime(1500))
      expect(result.current.copied).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: StrictMode's dev-only mount→cleanup→mount runs on the same
  // instance, so a cleanup-only mounted flag stays false after the paired
  // invocation and every later copy() silently skips setCopied — the clipboard
  // still received the text, so it "worked" everywhere except the feedback UI,
  // and only in development.
  it("still reports copied after a StrictMode double-mount", async () => {
    const { result } = renderHook(() => useCopyToClipboard("hello"), {
      wrapper: StrictMode,
    })

    await act(() => result.current.copy())

    expect(writeText).toHaveBeenCalledWith("hello")
    expect(result.current.copied).toBe(true)
  })

  it("leaves copied false when the clipboard write rejects", async () => {
    writeText.mockRejectedValue(new Error("denied"))
    const { result } = renderHook(() => useCopyToClipboard("hello"))

    await act(() => result.current.copy())

    expect(result.current.copied).toBe(false)
  })

  it("does not set state after a real unmount mid-write", async () => {
    let release!: () => void
    writeText.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const { result, unmount } = renderHook(() => useCopyToClipboard("hello"))

    const pending = result.current.copy()
    unmount()
    release()
    // Resolving after unmount must not throw or warn (mountedRef guard).
    await act(() => pending)

    expect(result.current.copied).toBe(false)
  })
})
