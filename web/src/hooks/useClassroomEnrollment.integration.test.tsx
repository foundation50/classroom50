// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { GitHubAPIError } from "@/github-core/errors"

// Same team-membership harness shape as useClassroomRole's integration test:
// each per-role team responder is switchable so we can compose enrollment
// verdicts. `<classroom>` (no suffix) is the students team.
type Resp = "active" | "404" | "500"
let teacherResp: Resp = "404"
let instructorResp: Resp = "404"
let htaResp: Resp = "404"
let taResp: Resp = "404"
let studentResp: Resp = "404"
// Optional latch so a test can hold a probe in flight and assert the loading
// gate before it settles.
let studentGate: Promise<void> | null = null

const err = (status: number, url: string) =>
  new GitHubAPIError({
    status,
    url,
    message: `boom ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })

const respond = (url: string, r: Resp) => {
  if (r === "active") return Promise.resolve({ state: "active" })
  return Promise.reject(err(r === "404" ? 404 : 500, url))
}

const request = vi.fn(async (url: string) => {
  if (url.includes("-teacher/memberships/")) return respond(url, teacherResp)
  if (url.includes("-instructor/memberships/"))
    return respond(url, instructorResp)
  if (url.includes("-hta/memberships/")) return respond(url, htaResp)
  if (url.includes("-ta/memberships/")) return respond(url, taResp)
  if (url.includes("/memberships/")) {
    if (studentGate) await studentGate
    return respond(url, studentResp)
  }
  return Promise.resolve({})
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))
vi.mock("@/context/roleView/RoleViewProvider", () => ({
  useRoleView: () => ({ viewAs: null, setViewAs: () => {} }),
}))

// Imported AFTER the mocks so the hook picks up the mocked client.
import { useClassroomEnrollment } from "./useClassroomEnrollment"

const wrapper = ({ children }: PropsWithChildren) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } },
  })
  return createElement(QueryClientProvider, { client }, children)
}

const renderEnrollment = (username: string | undefined = "u") =>
  renderHook(() => useClassroomEnrollment("acme", "cs101", username), {
    wrapper,
  })

beforeEach(() => {
  teacherResp = "404"
  instructorResp = "404"
  htaResp = "404"
  taResp = "404"
  studentResp = "404"
  studentGate = null
  request.mockClear()
})

describe("useClassroomEnrollment", () => {
  it("enrolled when the student-team membership is active", async () => {
    studentResp = "active"
    const { result } = renderEnrollment()
    await waitFor(() => expect(result.current.verdict).toBe("enrolled"))
    expect(result.current.isLoading).toBe(false)
  })

  it("enrolled (staff bypass) when a staff-team membership is active", async () => {
    taResp = "active"
    const { result } = renderEnrollment()
    await waitFor(() => expect(result.current.verdict).toBe("enrolled"))
  })

  it("not-enrolled once all reads settle as definitive non-member", async () => {
    const { result } = renderEnrollment()
    await waitFor(() => {
      expect(result.current.verdict).toBe("not-enrolled")
      expect(result.current.isLoading).toBe(false)
    })
  })

  it("holds isLoading (no flash) while the student read is in flight, then flips to not-enrolled", async () => {
    // The anti-flash guarantee: until the probe settles, isLoading is true so
    // the page shows the spinner rather than the accept card. It must NOT
    // report a premature not-enrolled verdict during the in-flight window.
    let release!: () => void
    studentGate = new Promise<void>((res) => {
      release = res
    })
    const { result } = renderEnrollment()

    await waitFor(() => expect(result.current.isLoading).toBe(true))
    expect(result.current.verdict).not.toBe("not-enrolled")

    release()
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
      expect(result.current.verdict).toBe("not-enrolled")
    })
  })

  it("fails open to unresolved (not not-enrolled) when the student read errors non-404", async () => {
    studentResp = "500"
    const { result } = renderEnrollment()
    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false)
        expect(result.current.verdict).toBe("unresolved")
      },
      { timeout: 5000 },
    )
  })

  it("does not pin isLoading when disabled (no username)", async () => {
    const { result } = renderEnrollment(undefined)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })
})
