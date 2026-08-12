// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

// Capture the args each single-repo reader is called with, to assert the
// active-mode gating (the inactive mode's reader gets undefined args).
const releasesSpy = vi.fn()
vi.mock("@/hooks/useGetSubmissionReleases", () => ({
  default: (...args: unknown[]) => {
    releasesSpy(...args)
    return { data: [], isLoading: false, isError: false, error: null }
  },
}))

const taggedSpy = vi.fn()
let taggedError = false
vi.mock("@/hooks/useGetMyTaggedSubmissions", () => ({
  default: (...args: unknown[]) => {
    taggedSpy(...args)
    return { data: [], isError: taggedError }
  },
}))

const pushSpy = vi.fn()
let pushError = false
vi.mock("@/hooks/useGetMyPushSubmissions", () => ({
  default: (...args: unknown[]) => {
    pushSpy(...args)
    return { data: [], isError: pushError }
  },
}))

import { useMySubmissions } from "./useMySubmissions"

beforeEach(() => {
  releasesSpy.mockReset()
  taggedSpy.mockReset()
  pushSpy.mockReset()
  taggedError = false
  pushError = false
})

afterEach(() => vi.clearAllMocks())

describe("useMySubmissions", () => {
  it("enables the tag reader and disables the push reader in tag mode", () => {
    renderHook(() =>
      useMySubmissions("acme", "cs101", "hw1", "alice", {
        mode: "tag",
        submissionTags: ["phase1"],
      }),
    )
    // Releases always read (both modes carry grades).
    expect(releasesSpy).toHaveBeenCalledWith("acme", "cs101", "hw1", "alice")
    // Tag reader active with real args; push reader disabled (all undefined).
    expect(taggedSpy).toHaveBeenCalledWith("acme", "cs101", "hw1", "alice", [
      "phase1",
    ])
    expect(pushSpy).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it("enables the push reader and disables the tag reader in every-push mode", () => {
    renderHook(() =>
      useMySubmissions("acme", "cs101", "hw1", "alice", {
        mode: "every-push",
      }),
    )
    expect(pushSpy).toHaveBeenCalledWith("acme", "cs101", "hw1", "alice")
    expect(taggedSpy).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it("folds only the ACTIVE mode's read error into submissionListError", () => {
    // Tag error is ignored in every-push mode...
    taggedError = true
    pushError = false
    const everyPush = renderHook(() =>
      useMySubmissions("acme", "cs101", "hw1", "alice", { mode: "every-push" }),
    )
    expect(everyPush.result.current.submissionListError).toBe(false)

    // ...and the push error is ignored in tag mode.
    taggedError = false
    pushError = true
    const tag = renderHook(() =>
      useMySubmissions("acme", "cs101", "hw1", "alice", { mode: "tag" }),
    )
    expect(tag.result.current.submissionListError).toBe(false)

    // The active mode's error surfaces.
    pushError = true
    const active = renderHook(() =>
      useMySubmissions("acme", "cs101", "hw1", "alice", { mode: "every-push" }),
    )
    expect(active.result.current.submissionListError).toBe(true)
  })
})
