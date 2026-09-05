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
          state: { status: m.status },
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

const BG = { keepTabOpen: true, backgroundPass: true }
const live = () => screen.getByRole("status")
const pill = () => document.querySelector(".bg-warning")

let rerender: (ui: ReactNode) => void = () => {}

const mount = () => {
  rerender = render(<BackgroundPassTag />).rerender
}

const setCache = (next: Fake[]) => {
  act(() => {
    cache = next
    rerender(<BackgroundPassTag />)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  cache = []
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  cleanup()
})

describe("BackgroundPassTag", () => {
  it("always renders the live region, empty while idle", () => {
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

    act(() => vi.advanceTimersByTime(5000))
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
