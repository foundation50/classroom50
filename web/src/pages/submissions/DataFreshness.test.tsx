// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

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
  updatedLabel: "2 minutes ago",
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

  it("static mode: static chip + snapshot updated line", () => {
    render(<DataFreshness mode="static" {...base} />)
    expect(screen.getByText("submissions.freshness.staticChip")).not.toBeNull()
    expect(
      screen.getByText("submissions.freshness.staticUpdated:2 minutes ago"),
    ).not.toBeNull()
  })

  it("live mode: live chip + names both sources (presence now, scores from last collection)", () => {
    render(<DataFreshness mode="live" {...base} />)
    expect(screen.getByText("submissions.freshness.liveChip")).not.toBeNull()
    expect(
      screen.getByText("submissions.freshness.liveScores:18 hours ago"),
    ).not.toBeNull()
  })

  it("live mode with no collection yet: not-collected line", () => {
    render(<DataFreshness mode="live" {...base} lastCollectedLabel={null} />)
    expect(
      screen.getByText("submissions.freshness.liveNoScores"),
    ).not.toBeNull()
  })

  it("surfaces the degraded-read warning only in live mode when repos failed", () => {
    const { rerender } = render(
      <DataFreshness mode="live" {...base} errorCount={3} />,
    )
    expect(screen.getByText("submissions.live.incomplete:3")).not.toBeNull()
    // Static mode never shows the live incomplete warning, even with a stray count.
    rerender(<DataFreshness mode="static" {...base} errorCount={3} />)
    expect(screen.queryByText("submissions.live.incomplete:3")).toBeNull()
  })

  it("disables refresh while fetching", () => {
    render(<DataFreshness mode="static" {...base} fetching />)
    const btn = screen.getByLabelText("submissions.refresh")
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
})
