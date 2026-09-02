// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type PropsWithChildren } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

const register = vi.fn()
vi.mock("@/context/actions/ActionActivityProvider", () => ({
  useActionActivityRegistry: () => ({ register }),
}))

const getRunAnnotations = vi.fn()
vi.mock("@/github-core/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/github-core/queries")>()
  return {
    ...actual,
    getRunAnnotations: (...args: unknown[]) => getRunAnnotations(...args),
  }
})

// The tracker primitive is driven by the test: each render reads the phase and
// run the test placed here, so the hook's derived state can be pinned.
type FakeOperation = {
  phase: string
  failure: "dispatch" | "run" | null
  run: { id: number; html_url: string } | undefined
  error: unknown
}
let operation: FakeOperation
let capturedConfig: {
  storageKey: string | null
  resetKey: string
  onDispatched?: (s: { sinceRunId: number | null }) => void
}
const trigger = vi.fn()
vi.mock("@/hooks/useGitHubOperation", () => ({
  useGitHubOperation: (config: typeof capturedConfig) => {
    capturedConfig = config
    return { trigger, ...operation }
  },
}))

import useTestServiceToken from "./useTestServiceToken"

const wrapper = ({ children }: PropsWithChildren) =>
  createElement(
    QueryClientProvider,
    {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    },
    children,
  )

const idle: FakeOperation = {
  phase: "idle",
  failure: null,
  run: undefined,
  error: null,
}

describe("useTestServiceToken", () => {
  it("keys tracking per org and registers the run with the banner", () => {
    operation = idle
    renderHook(() => useTestServiceToken("acme"), { wrapper })

    expect(capturedConfig.storageKey).toBe("cl50:probe-token:acme")
    expect(capturedConfig.resetKey).toBe("acme")

    capturedConfig.onDispatched?.({ sinceRunId: 41 })
    expect(register).toHaveBeenCalledWith({
      org: "acme",
      label: "actionsBanner.workflow.probeToken",
      anchor: {
        kind: "sinceRunId",
        workflow: "probe-token.yaml",
        sinceRunId: 41,
      },
    })
  })

  it("disables tracking without an org", () => {
    operation = idle
    renderHook(() => useTestServiceToken(undefined), { wrapper })
    expect(capturedConfig.storageKey).toBeNull()
  })

  it("refuses a second dispatch while one is in flight", () => {
    operation = { ...idle, phase: "running" }
    const { result } = renderHook(() => useTestServiceToken("acme"), {
      wrapper,
    })
    expect(result.current.inFlight).toBe(true)
    result.current.test()
    expect(trigger).not.toHaveBeenCalled()

    operation = idle
    const second = renderHook(() => useTestServiceToken("acme"), { wrapper })
    second.result.current.test()
    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it("reads the run's annotations only once it has concluded", async () => {
    getRunAnnotations.mockResolvedValue([
      { level: "failure", message: "probe FAILED" },
    ])
    operation = {
      phase: "running",
      failure: null,
      run: {
        id: 77,
        html_url: "https://github.com/acme/classroom50/actions/runs/77",
      },
      error: null,
    }
    const running = renderHook(() => useTestServiceToken("acme"), { wrapper })
    expect(running.result.current.annotations).toBeUndefined()
    expect(getRunAnnotations).not.toHaveBeenCalled()

    operation = { ...operation, phase: "failed", failure: "run" }
    const failed = renderHook(() => useTestServiceToken("acme"), { wrapper })
    await waitFor(() =>
      expect(failed.result.current.annotations).toEqual([
        { level: "failure", message: "probe FAILED" },
      ]),
    )
    expect(getRunAnnotations).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      77,
      expect.anything(),
    )
  })

  it("does not read annotations for a rejected dispatch", () => {
    getRunAnnotations.mockClear()
    operation = {
      phase: "failed",
      failure: "dispatch",
      run: undefined,
      error: new Error("nope"),
    }
    const { result } = renderHook(() => useTestServiceToken("acme"), {
      wrapper,
    })
    expect(result.current.annotations).toBeUndefined()
    expect(getRunAnnotations).not.toHaveBeenCalled()
  })

  it("does not read annotations for a run that passed", async () => {
    // A green run's only annotation is a "passed" notice the result never
    // shows, so the read (jobs list plus one call per job) is skipped.
    getRunAnnotations.mockClear()
    operation = {
      phase: "completed",
      failure: null,
      run: {
        id: 79,
        html_url: "https://github.com/acme/classroom50/actions/runs/79",
      },
      error: null,
    }
    const { result } = renderHook(() => useTestServiceToken("acme"), {
      wrapper,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current.annotations).toBeUndefined()
    expect(getRunAnnotations).not.toHaveBeenCalled()
  })

  it("falls back to [] when the annotations read fails, so the run link still shows", async () => {
    getRunAnnotations.mockRejectedValue(new Error("403"))
    operation = {
      phase: "failed",
      failure: "run",
      run: {
        id: 78,
        html_url: "https://github.com/acme/classroom50/actions/runs/78",
      },
      error: null,
    }
    const { result } = renderHook(() => useTestServiceToken("acme"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.annotations).toEqual([]))
  })
})
