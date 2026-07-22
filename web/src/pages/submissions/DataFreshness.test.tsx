// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// t returns the key (plus the interpolated `when` when present) so assertions
// can distinguish the provenance lines without the full pack.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { when?: string }) =>
        opts?.when ? `${key}:${opts.when}` : key,
    }),
  }
})

import { DataFreshness } from "./DataFreshness"

afterEach(cleanup)

const base = {
  lastCollectedLabel: "18 hours ago",
  stale: false,
  collecting: false,
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

  it("leads with 'Collected {when}' (the true data age, not the fetch time)", () => {
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

  it("shows the warning 'Sync submissions now' button when out of sync, else 'Refresh'", () => {
    const { rerender } = render(<DataFreshness {...base} stale={false} />)
    expect(screen.getByText("submissions.freshness.refresh")).not.toBeNull()
    expect(screen.queryByText("submissions.freshness.sync")).toBeNull()
    rerender(<DataFreshness {...base} stale />)
    expect(screen.getByText("submissions.freshness.sync")).not.toBeNull()
    expect(screen.queryByText("submissions.freshness.refresh")).toBeNull()
  })

  it("triggers collect when the button is clicked (in sync or out of sync)", async () => {
    const onRefresh = vi.fn()
    const { rerender } = render(
      <DataFreshness {...base} onRefresh={onRefresh} />,
    )
    await userEvent.click(screen.getByText("submissions.freshness.refresh"))
    rerender(<DataFreshness {...base} stale onRefresh={onRefresh} />)
    await userEvent.click(screen.getByText("submissions.freshness.sync"))
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })

  it("disables the button and shows 'Collecting…' while a collect is in flight", () => {
    render(<DataFreshness {...base} stale collecting />)
    const btn = screen.getByText("submissions.freshness.refreshing")
    expect((btn.closest("button") as HTMLButtonElement).disabled).toBe(true)
  })

  it("omits the button entirely when no onRefresh is provided", () => {
    render(<DataFreshness {...base} stale onRefresh={undefined} />)
    expect(screen.queryByText("submissions.freshness.sync")).toBeNull()
    expect(screen.queryByText("submissions.freshness.refresh")).toBeNull()
    expect(screen.queryByText("submissions.freshness.refreshing")).toBeNull()
  })

  it("shows a degraded-read warning when some repos couldn't be read", () => {
    const { rerender } = render(<DataFreshness {...base} errorCount={0} />)
    expect(screen.queryByText(/submissions\.live\.incomplete/)).toBeNull()
    rerender(<DataFreshness {...base} errorCount={3} />)
    expect(screen.getByText(/submissions\.live\.incomplete/)).not.toBeNull()
  })
})
