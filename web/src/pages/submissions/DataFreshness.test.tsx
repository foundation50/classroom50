// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// t returns the key (plus the interpolated `when` when present) so assertions
// can distinguish the live/static/never provenance lines without the full pack.
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
    render(<DataFreshness mode="static" {...base} emptyRepo />)
    expect(screen.getByText("submissions.emptyRepoNote")).not.toBeNull()
    expect(screen.queryByText("submissions.freshness.staticChip")).toBeNull()
  })

  it("static mode: static chip + 'Collected {when}' (the true data age, not the fetch time)", () => {
    render(<DataFreshness mode="static" {...base} />)
    expect(screen.getByText("submissions.freshness.staticChip")).not.toBeNull()
    expect(
      screen.getByText("submissions.freshness.staticCollected:18 hours ago"),
    ).not.toBeNull()
  })

  it("static mode with no collection yet: never-collected line", () => {
    render(<DataFreshness mode="static" {...base} lastCollectedLabel={null} />)
    expect(
      screen.getByText("submissions.freshness.staticNeverCollected"),
    ).not.toBeNull()
  })

  it("live mode: live chip + names both sources (presence now, scores from last collection)", () => {
    render(
      <DataFreshness
        mode="live"
        {...base}
        liveCapable
        onViewModeChange={() => {}}
      />,
    )
    expect(screen.getByText("submissions.freshness.liveChip")).not.toBeNull()
    expect(
      screen.getByText("submissions.freshness.liveScores:18 hours ago"),
    ).not.toBeNull()
  })

  it("live mode with no collection yet: not-collected line", () => {
    render(
      <DataFreshness
        mode="live"
        {...base}
        liveCapable
        onViewModeChange={() => {}}
        lastCollectedLabel={null}
      />,
    )
    expect(
      screen.getByText("submissions.freshness.liveNoScores"),
    ).not.toBeNull()
  })

  it("labels the refresh button by mode (live data vs snapshot)", () => {
    const { rerender } = render(
      <DataFreshness
        mode="live"
        {...base}
        liveCapable
        onViewModeChange={() => {}}
      />,
    )
    expect(
      screen.getByLabelText("submissions.freshness.refreshLive"),
    ).not.toBeNull()
    rerender(<DataFreshness mode="static" {...base} />)
    expect(
      screen.getByLabelText("submissions.freshness.refreshStatic"),
    ).not.toBeNull()
  })

  it("surfaces the degraded-read warning only in live mode when repos failed", () => {
    const { rerender } = render(
      <DataFreshness
        mode="live"
        {...base}
        liveCapable
        onViewModeChange={() => {}}
        errorCount={3}
      />,
    )
    expect(screen.getByText("submissions.live.incomplete:3")).not.toBeNull()
    // Static mode never shows the live incomplete warning, even with a stray count.
    rerender(<DataFreshness mode="static" {...base} errorCount={3} />)
    expect(screen.queryByText("submissions.live.incomplete:3")).toBeNull()
  })

  it("disables refresh while fetching", () => {
    render(<DataFreshness mode="static" {...base} fetching />)
    const btn = screen.getByLabelText("submissions.freshness.refreshStatic")
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it("renders a mode switch and flips the view when live-capable", async () => {
    const onViewModeChange = vi.fn()
    render(
      <DataFreshness
        mode="live"
        {...base}
        liveCapable
        onViewModeChange={onViewModeChange}
      />,
    )
    const toggle = screen.getByRole("checkbox")
    expect((toggle as HTMLInputElement).checked).toBe(true)
    await userEvent.click(toggle)
    expect(onViewModeChange).toHaveBeenCalledWith("static")
  })

  it("shows a non-interactive Static chip when the viewer can't go live", () => {
    render(<DataFreshness mode="static" {...base} liveCapable={false} />)
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.getByText("submissions.freshness.staticChip")).not.toBeNull()
  })
})
