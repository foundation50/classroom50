// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

import type { Assignment } from "@/types/classroom"

// Capture the enabled flags each underlying reader is called with, and return
// canned data, so we can assert the role→source gating without real fetches.
const configSpy = vi.fn()
let configData: { assignments: Assignment[] } | undefined
vi.mock("@/hooks/useGetClassAssignments", () => ({
  default: (
    _org: unknown,
    _classroom: unknown,
    options?: { enabled?: boolean },
  ) => {
    configSpy(options)
    return { data: configData, isLoading: false, isError: false }
  },
}))

const pagesSpy = vi.fn()
let pagesAssignment: Assignment | undefined
vi.mock("@/hooks/usePagesAssignments", () => ({
  default: (
    _org: unknown,
    _classroom: unknown,
    _secret: unknown,
    options?: { enabled?: boolean; assignmentSlug?: string },
  ) => {
    pagesSpy(options)
    return {
      data: undefined,
      isLoading: false,
      isError: false,
      assignment: pagesAssignment,
    }
  },
}))

import { useSubmissionAssignment } from "./useSubmissionAssignment"

const assignment = (slug: string): Assignment =>
  ({ slug, name: slug, mode: "individual" }) as Assignment

beforeEach(() => {
  configSpy.mockReset()
  pagesSpy.mockReset()
  configData = undefined
  pagesAssignment = undefined
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("useSubmissionAssignment", () => {
  it("reads the config repo (Pages disabled) for the staff source", () => {
    configData = { assignments: [assignment("hw1"), assignment("hw2")] }
    const { result } = renderHook(() =>
      useSubmissionAssignment("acme", "cs101", "hw2", { source: "config" }),
    )
    expect(result.current.assignment?.slug).toBe("hw2")
    // Config enabled, Pages disabled — the inactive source costs no request.
    expect(configSpy).toHaveBeenCalledWith({ enabled: true })
    expect(pagesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    )
  })

  it("reads Pages (config disabled) for the student source and threads the slug", () => {
    pagesAssignment = assignment("hw1")
    const { result } = renderHook(() =>
      useSubmissionAssignment("acme", "cs101", "hw1", {
        source: "pages",
        secret: "s3cr3t",
      }),
    )
    expect(result.current.assignment?.slug).toBe("hw1")
    expect(configSpy).toHaveBeenCalledWith({ enabled: false })
    expect(pagesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, assignmentSlug: "hw1" }),
    )
  })

  it("returns undefined when the slug isn't present", () => {
    configData = { assignments: [assignment("hw1")] }
    const { result } = renderHook(() =>
      useSubmissionAssignment("acme", "cs101", "missing", { source: "config" }),
    )
    expect(result.current.assignment).toBeUndefined()
  })
})
