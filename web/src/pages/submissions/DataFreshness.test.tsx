// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// t returns the key (plus the interpolated `when`/`count` when present) so
// assertions can distinguish the provenance/nudge lines without the full pack.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { when?: string; count?: number }) =>
        opts?.when
          ? `${key}:${opts.when}`
          : opts?.count !== undefined
            ? `${key}:${opts.count}`
            : key,
    }),
  }
})

import { DataFreshness } from "./DataFreshness"

afterEach(cleanup)

const base = {
  lastCollectedLabel: "18 hours ago",
  fetching: false,
  errorCount: 0,
  onRefresh: () => {},
}

describe("DataFreshness", () => {
  it("shows the empty-repo note instead of freshness for empty_repo assignments", () => {
    render(<DataFreshness {...base} emptyRepo />)
    expect(screen.getByText("submissions.emptyRepoNote")).not.toBeNull()
    expect(
      screen.queryByText("submissions.freshness.collected:18 hours ago"),
    ).toBeNull()
  })

  it("always leads with 'Collected {when}' (the true data age, not the fetch time)", () => {
    render(<DataFreshness {...base} />)
    expect(
      screen.getByText("submissions.freshness.collected:18 hours ago"),
    ).not.toBeNull()
  })

  it("shows the never-collected line when nothing has been collected", () => {
    render(<DataFreshness {...base} lastCollectedLabel={null} />)
    expect(
      screen.getByText("submissions.freshness.neverCollected"),
    ).not.toBeNull()
  })

  it("TA (not live-capable): only the collected line, no nudge or checking hint", () => {
    render(
      <DataFreshness {...base} liveCapable={false} newCount={3} checking />,
    )
    expect(
      screen.getByText("submissions.freshness.collected:18 hours ago"),
    ).not.toBeNull()
    expect(screen.queryByText(/submissions\.live\.newOnPage/)).toBeNull()
    expect(screen.queryByText(/submissions\.freshness\.checking/)).toBeNull()
  })

  it("owner, fan-out in flight: 'checking…' hint, no count and no Collect", () => {
    render(<DataFreshness {...base} liveCapable checking newCount={0} />)
    expect(screen.getByText(/submissions\.freshness\.checking/)).not.toBeNull()
    expect(screen.queryByText(/submissions\.live\.newOnPage/)).toBeNull()
    expect(screen.queryByText("submissions.live.collectToGrade")).toBeNull()
  })

  it("owner, settled, N new on page: shows the count and a Collect affordance", async () => {
    const onCollect = vi.fn()
    render(
      <DataFreshness
        {...base}
        liveCapable
        newCount={3}
        onCollect={onCollect}
      />,
    )
    expect(screen.getByText(/submissions\.live\.newOnPage:3/)).not.toBeNull()
    await userEvent.click(screen.getByText("submissions.live.collectToGrade"))
    expect(onCollect).toHaveBeenCalledOnce()
  })

  it("owner, settled, 0 new: shows 'up to date', no count and no Collect", () => {
    render(<DataFreshness {...base} liveCapable newCount={0} />)
    expect(screen.getByText(/submissions\.freshness\.upToDate/)).not.toBeNull()
    expect(screen.queryByText(/submissions\.live\.newOnPage/)).toBeNull()
    expect(screen.queryByText("submissions.live.collectToGrade")).toBeNull()
  })

  it("surfaces the degraded-read warning only for a live-capable viewer", () => {
    const { rerender } = render(
      <DataFreshness {...base} liveCapable errorCount={3} />,
    )
    expect(screen.getByText("submissions.live.incomplete:3")).not.toBeNull()
    // A non-capable viewer never sees the live incomplete warning.
    rerender(<DataFreshness {...base} liveCapable={false} errorCount={3} />)
    expect(screen.queryByText("submissions.live.incomplete:3")).toBeNull()
  })

  it("disables refresh while fetching", () => {
    render(<DataFreshness {...base} fetching />)
    const btn = screen.getByLabelText("submissions.freshness.refreshAria")
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
})
