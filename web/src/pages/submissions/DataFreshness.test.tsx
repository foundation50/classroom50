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

  it("shows the stale hint only when an assignment repo was pushed since collect", () => {
    const { rerender } = render(<DataFreshness {...base} stale={false} />)
    expect(screen.queryByText(/submissions\.freshness\.stale/)).toBeNull()
    rerender(<DataFreshness {...base} stale />)
    expect(screen.getByText(/submissions\.freshness\.stale/)).not.toBeNull()
  })

  it("renders a Refresh submissions button that triggers collect", async () => {
    const onRefresh = vi.fn()
    render(<DataFreshness {...base} onRefresh={onRefresh} />)
    await userEvent.click(screen.getByText("submissions.freshness.refresh"))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("disables the button and shows 'Collecting…' while a collect is in flight", () => {
    render(<DataFreshness {...base} collecting />)
    const btn = screen.getByText("submissions.freshness.refreshing")
    expect((btn.closest("button") as HTMLButtonElement).disabled).toBe(true)
  })

  it("omits the button entirely when no onRefresh is provided", () => {
    render(<DataFreshness {...base} onRefresh={undefined} />)
    expect(screen.queryByText("submissions.freshness.refresh")).toBeNull()
    expect(screen.queryByText("submissions.freshness.refreshing")).toBeNull()
  })
})
