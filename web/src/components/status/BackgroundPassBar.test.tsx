// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import type { Mutation, MutationFilters } from "@tanstack/react-query"

// Feed the bar a fake mutation cache: `useIsMutating` applies the bar's own
// predicate to whatever `metas` holds, so the test checks the binding (which
// mutations count, which color paints) while RouteProgressBar.test covers the
// shared reveal/fade timing.
let metas: Array<Record<string, unknown> | undefined> = []
vi.mock("@tanstack/react-query", () => ({
  useIsMutating: (filters: MutationFilters) =>
    metas.filter((meta) =>
      filters.predicate!({ options: { meta } } as unknown as Mutation),
    ).length,
}))

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: (props: Record<string, unknown>) => <div {...props} />,
  },
  useMotionValue: () => ({ set: () => {} }),
  animate: () => ({ stop: () => {} }),
}))

import { BackgroundPassBar } from "./BackgroundPassBar"

const bar = () => document.querySelector(".bg-info")

let rerender: (ui: ReactNode) => void = () => {}

const mount = () => {
  rerender = render(<BackgroundPassBar />).rerender
}

const setPending = (next: typeof metas) => {
  act(() => {
    metas = next
    rerender(<BackgroundPassBar />)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  metas = []
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  cleanup()
})

describe("BackgroundPassBar", () => {
  it("shows a blue bar while a backgroundPass mutation is pending", () => {
    mount()
    setPending([{ keepTabOpen: true, backgroundPass: true }])
    act(() => vi.advanceTimersByTime(120))
    expect(bar()).not.toBeNull()
    expect(document.querySelector(".bg-primary")).toBeNull()

    setPending([])
    act(() => vi.advanceTimersByTime(200))
    expect(bar()).toBeNull()
  })

  it("ignores user-started writes, flagged or not", () => {
    mount()
    setPending([{ keepTabOpen: true }, undefined])
    act(() => vi.advanceTimersByTime(500))
    expect(bar()).toBeNull()
  })
})
