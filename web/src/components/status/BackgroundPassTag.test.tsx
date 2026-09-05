// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import type {
  Mutation,
  MutationFilters,
  MutationState,
} from "@tanstack/react-query"

// A fake mutation cache the tag's own predicate and selector run against.
type Fake = {
  mutationId: number
  meta?: Record<string, unknown>
  status: MutationState["status"]
  isPaused?: boolean
}
type StateOptions = {
  filters?: MutationFilters
  select?: (mutation: Mutation) => unknown
}
let cache: Fake[] = []
vi.mock("@tanstack/react-query", () => ({
  useMutationState: (options: StateOptions) =>
    cache
      .filter((m) =>
        options.filters!.predicate!({
          options: { meta: m.meta },
        } as unknown as Mutation),
      )
      .map((m) =>
        options.select!({
          mutationId: m.mutationId,
          state: { status: m.status, isPaused: m.isPaused ?? false },
        } as unknown as Mutation),
      ),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: (props: Record<string, unknown>) => <div {...props} />,
  },
}))

import { BackgroundPassTag } from "./BackgroundPassTag"
import { LiveAnnouncer } from "./LiveAnnouncer"
import {
  ANNOUNCE_LINGER_MS,
  __resetLiveAnnouncerForTest,
} from "@/lib/liveAnnouncer"

const BG = { keepTabOpen: true, backgroundPass: true }
const live = () => screen.getByRole("status")
const pill = () => document.querySelector(".bg-warning")

let rerender: (ui: ReactNode) => void = () => {}

// The tag announces through the app-wide LiveAnnouncer, so tests mount both.
const tree = () => (
  <>
    <LiveAnnouncer />
    <BackgroundPassTag />
  </>
)
const mount = () => {
  rerender = render(tree()).rerender
}

const setCache = (next: Fake[]) => {
  act(() => {
    cache = next
    rerender(tree())
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  cache = []
  __resetLiveAnnouncerForTest()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  cleanup()
})

describe("BackgroundPassTag", () => {
  it("renders nothing into the live region while idle", () => {
    mount()
    expect(live().textContent).toBe("")
    expect(pill()).toBeNull()
  })

  it("reveals after a full second, then announces syncing and synced", () => {
    mount()
    setCache([{ mutationId: 1, meta: BG, status: "pending" }])
    act(() => vi.advanceTimersByTime(900))
    expect(pill()).toBeNull()
    expect(live().textContent).toBe("")

    act(() => vi.advanceTimersByTime(100))
    expect(pill()?.textContent).toBe("backgroundPass.syncing")
    expect(pill()?.closest("[aria-hidden='true']")).not.toBeNull()
    expect(live().textContent).toBe("backgroundPass.syncing")
    const spinner = pill()?.querySelector(".loading-spinner")
    expect(spinner?.getAttribute("aria-hidden")).toBe("true")
    expect(spinner?.classList.contains("indicator-appear")).toBe(false)

    setCache([{ mutationId: 1, meta: BG, status: "success" }])
    expect(live().textContent).toBe("backgroundPass.synced")
    act(() => vi.advanceTimersByTime(200))
    expect(pill()).toBeNull()

    // The tag withdraws its text after its own linger; the announcer then
    // clears the region after its own.
    act(() => vi.advanceTimersByTime(5000))
    act(() => vi.advanceTimersByTime(ANNOUNCE_LINGER_MS))
    expect(live().textContent).toBe("")
  })

  it("announces a failed pass truthfully", () => {
    mount()
    setCache([{ mutationId: 1, meta: BG, status: "pending" }])
    act(() => vi.advanceTimersByTime(1000))
    setCache([{ mutationId: 1, meta: BG, status: "error" }])
    expect(live().textContent).toBe("backgroundPass.failed")
  })

  it("judges only the passes it showed, not stale settled ones", () => {
    mount()
    setCache([
      { mutationId: 1, meta: BG, status: "error" },
      { mutationId: 2, meta: BG, status: "pending" },
    ])
    act(() => vi.advanceTimersByTime(1000))
    setCache([
      { mutationId: 1, meta: BG, status: "error" },
      { mutationId: 2, meta: BG, status: "success" },
    ])
    expect(live().textContent).toBe("backgroundPass.synced")
  })

  it("stays silent for a pass that finishes inside the reveal delay", () => {
    mount()
    setCache([{ mutationId: 1, meta: BG, status: "pending" }])
    act(() => vi.advanceTimersByTime(500))
    setCache([{ mutationId: 1, meta: BG, status: "success" }])
    act(() => vi.advanceTimersByTime(2000))
    expect(pill()).toBeNull()
    expect(live().textContent).toBe("")
  })

  it("ignores a pass that failed before the reveal when judging the next one", () => {
    mount()
    setCache([{ mutationId: 1, meta: BG, status: "pending" }])
    act(() => vi.advanceTimersByTime(500))
    // Settled passes stay in the mutation cache; this one was never shown.
    setCache([
      { mutationId: 1, meta: BG, status: "error" },
      { mutationId: 2, meta: BG, status: "pending" },
    ])
    act(() => vi.advanceTimersByTime(1000))
    expect(live().textContent).toBe("backgroundPass.syncing")

    setCache([
      { mutationId: 1, meta: BG, status: "error" },
      { mutationId: 2, meta: BG, status: "success" },
    ])
    expect(live().textContent).toBe("backgroundPass.synced")
  })

  it("re-announces syncing for a pass that resumes inside the hide delay", () => {
    mount()
    setCache([{ mutationId: 1, meta: BG, status: "pending" }])
    act(() => vi.advanceTimersByTime(1000))
    setCache([{ mutationId: 1, meta: BG, status: "success" }])
    expect(live().textContent).toBe("backgroundPass.synced")

    // Inside the 180ms hide delay: the pill never left, so the live region
    // must follow it back to "syncing" and the old linger must not clear it.
    act(() => vi.advanceTimersByTime(100))
    setCache([
      { mutationId: 1, meta: BG, status: "success" },
      { mutationId: 2, meta: BG, status: "pending" },
    ])
    expect(pill()).not.toBeNull()
    expect(live().textContent).toBe("backgroundPass.syncing")
    act(() => vi.advanceTimersByTime(5000))
    expect(live().textContent).toBe("backgroundPass.syncing")

    setCache([
      { mutationId: 1, meta: BG, status: "success" },
      { mutationId: 2, meta: BG, status: "error" },
    ])
    expect(live().textContent).toBe("backgroundPass.failed")
    // The tag withdraws its text after its own linger; the announcer then
    // clears the region after its own.
    act(() => vi.advanceTimersByTime(5000))
    act(() => vi.advanceTimersByTime(ANNOUNCE_LINGER_MS))
    expect(live().textContent).toBe("")
  })

  it("does not show a paused pass, which has not started", () => {
    mount()
    setCache([{ mutationId: 1, meta: BG, status: "pending", isPaused: true }])
    act(() => vi.advanceTimersByTime(2000))
    expect(pill()).toBeNull()
    expect(live().textContent).toBe("")
  })

  it("ignores user-started writes, flagged or not", () => {
    mount()
    setCache([
      { mutationId: 1, meta: { keepTabOpen: true }, status: "pending" },
      { mutationId: 2, status: "pending" },
    ])
    act(() => vi.advanceTimersByTime(2000))
    expect(pill()).toBeNull()
    expect(live().textContent).toBe("")
  })
})
