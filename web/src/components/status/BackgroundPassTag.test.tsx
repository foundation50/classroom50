// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import type { Mutation, MutationFilters } from "@tanstack/react-query"

// Feed the tag a fake mutation cache: `useIsMutating` applies the tag's own
// predicate to whatever `metas` holds, so the test checks the binding (which
// mutations count, what renders) while RouteProgressBar.test covers the shared
// reveal/fade timing.
let metas: Array<Record<string, unknown> | undefined> = []
vi.mock("@tanstack/react-query", () => ({
  useIsMutating: (filters: MutationFilters) =>
    metas.filter((meta) =>
      filters.predicate!({ options: { meta } } as unknown as Mutation),
    ).length,
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

const tag = () => screen.queryByRole("status")

let rerender: (ui: ReactNode) => void = () => {}

const mount = () => {
  rerender = render(<BackgroundPassTag />).rerender
}

const setPending = (next: typeof metas) => {
  act(() => {
    metas = next
    rerender(<BackgroundPassTag />)
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

describe("BackgroundPassTag", () => {
  it("shows a spinner and the syncing label while a backgroundPass mutation is pending", () => {
    mount()
    setPending([{ keepTabOpen: true, backgroundPass: true }])
    act(() => vi.advanceTimersByTime(120))
    expect(tag()?.textContent).toBe("backgroundPass.syncing")
    expect(tag()?.classList.contains("bg-warning")).toBe(true)
    // Spinner is decorative (the label announces) and skips the anti-flash
    // delay the tag's own reveal already served.
    const spinner = tag()?.querySelector(".loading-spinner")
    expect(spinner?.getAttribute("aria-hidden")).toBe("true")
    expect(spinner?.classList.contains("indicator-appear")).toBe(false)

    setPending([])
    act(() => vi.advanceTimersByTime(200))
    expect(tag()).toBeNull()
  })

  it("ignores user-started writes, flagged or not", () => {
    mount()
    setPending([{ keepTabOpen: true }, undefined])
    act(() => vi.advanceTimersByTime(500))
    expect(tag()).toBeNull()
  })
})
