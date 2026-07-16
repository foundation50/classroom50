// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

const register = vi.fn<(...args: unknown[]) => string>(() => "id")

vi.mock("@/context/actions/ActionActivityProvider", () => ({
  useActionActivityRegistry: () => ({ register }),
}))

import { useTrackPublishDeploy } from "./useTrackPublishDeploy"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useTrackPublishDeploy", () => {
  it("registers a SHA-anchored op with the pre-translated label", () => {
    const { result } = renderHook(() => useTrackPublishDeploy())

    result.current("acme", "sha-123", "Publishing cs101")

    expect(register).toHaveBeenCalledWith({
      org: "acme",
      label: "Publishing cs101",
      anchor: { kind: "sha", sha: "sha-123" },
    })
  })

  it("no-ops when there is no commit SHA (no deploy was triggered)", () => {
    const { result } = renderHook(() => useTrackPublishDeploy())

    result.current("acme", undefined, "Publishing cs101")

    expect(register).not.toHaveBeenCalled()
  })

  it("no-ops when org is empty", () => {
    const { result } = renderHook(() => useTrackPublishDeploy())

    result.current("", "sha-123", "Publishing cs101")

    expect(register).not.toHaveBeenCalled()
  })
})
