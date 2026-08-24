// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const notify = vi.fn()
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify, dismiss: vi.fn() }),
}))

const collect = vi.fn()
const hookArgs: unknown[][] = []
let phase = "idle"
let error: unknown = null
vi.mock("@/hooks/useTriggerScoreCollection", () => ({
  default: (...args: unknown[]) => {
    hookArgs.push(args)
    return { collect, phase, run: null, error }
  },
}))

import { ClassroomCollectButton } from "./ClassroomCollectButton"

// One client + spy per test, handed back inferred so the recorded filters keep
// their types.
const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const invalidate = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return {
    wrapper,
    invalidate,
    invalidatedKeys: () =>
      invalidate.mock.calls.map((call) => call[0]?.queryKey),
  }
}

const button = () => screen.getByRole("button")

beforeEach(() => {
  collect.mockReset()
  notify.mockReset()
  hookArgs.length = 0
  phase = "idle"
  error = null
})

afterEach(cleanup)

describe("ClassroomCollectButton", () => {
  it("dispatches a classroom-wide collect (no assignment in the scope)", () => {
    const { wrapper } = setup()
    render(<ClassroomCollectButton org="acme" classroom="cs50" />, { wrapper })
    fireEvent.click(button())

    expect(collect).toHaveBeenCalledTimes(1)
    expect(hookArgs[0]).toEqual(["acme", { classroom: "cs50" }])
  })

  it("explains itself and does not dispatch while the roster is empty", () => {
    const { wrapper } = setup()
    render(<ClassroomCollectButton org="acme" classroom="cs50" emptyRoster />, {
      wrapper,
    })

    expect((button() as HTMLButtonElement).disabled).toBe(true)
    expect(button().getAttribute("title")).toBe(
      "submissions.collect.titleEmptyRoster",
    )
    fireEvent.click(button())
    expect(collect).not.toHaveBeenCalled()
  })

  it("drops the cached gradebook when the run completes", () => {
    phase = "running"
    const { wrapper, invalidate, invalidatedKeys } = setup()
    const { rerender } = render(
      <ClassroomCollectButton org="acme" classroom="cs50" />,
      { wrapper },
    )
    expect(invalidate).not.toHaveBeenCalled()

    phase = "completed"
    rerender(<ClassroomCollectButton org="acme" classroom="cs50" />)

    expect(invalidatedKeys()).toContainEqual(
      expect.arrayContaining(["json-file", "acme", "cs50/scores.json"]),
    )
    expect(invalidatedKeys()).toContainEqual(
      expect.arrayContaining(["last-collect-scores-run", "acme"]),
    )
  })

  // The poll giving up says nothing about the run, which usually lands — so the
  // stale reads go either way.
  it("drops the cached gradebook when the poll times out", () => {
    phase = "running"
    const { wrapper, invalidatedKeys } = setup()
    const { rerender } = render(
      <ClassroomCollectButton org="acme" classroom="cs50" />,
      { wrapper },
    )

    phase = "timeout"
    rerender(<ClassroomCollectButton org="acme" classroom="cs50" />)

    expect(invalidatedKeys()).toContainEqual(
      expect.arrayContaining(["json-file", "acme", "cs50/scores.json"]),
    )
  })

  // A rejected dispatch never registers with the Actions banner (registration
  // rides the mutation's success), so this toast is its only surface.
  it("reports a dispatch that never landed", () => {
    phase = "dispatching"
    const { wrapper } = setup()
    const { rerender } = render(
      <ClassroomCollectButton org="acme" classroom="cs50" />,
      { wrapper },
    )

    phase = "failed"
    error = new Error("Resource not accessible by personal access token")
    rerender(<ClassroomCollectButton org="acme" classroom="cs50" />)

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error", key: "collect-scores:cs50" }),
    )
  })
})
