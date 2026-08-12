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
vi.mock("@/hooks/useGetMyTaggedSubmissions", () => ({
  default: (...args: unknown[]) => {
    taggedSpy(...args)
    return { data: [], isError: false }
  },
}))

const pushSpy = vi.fn()
vi.mock("@/hooks/useGetMyPushSubmissions", () => ({
  default: (...args: unknown[]) => {
    pushSpy(...args)
    return { data: [], isError: false }
  },
}))

import { useMySubmissions } from "./useMySubmissions"

beforeEach(() => {
  releasesSpy.mockReset()
  taggedSpy.mockReset()
  pushSpy.mockReset()
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
})
