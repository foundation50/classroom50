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

  it("keeps one 'Collect now' label in both freshness states", () => {
    const { rerender } = render(<DataFreshness {...base} stale={false} />)
    expect(screen.getByText("submissions.collect.label")).not.toBeNull()
    rerender(<DataFreshness {...base} stale />)
    expect(screen.getByText("submissions.collect.label")).not.toBeNull()
  })

  it("flags staleness with the badge, not with a danger-toned button", () => {
    const { rerender } = render(<DataFreshness {...base} stale={false} />)
    expect(screen.queryByText("submissions.freshness.stale")).toBeNull()
    rerender(<DataFreshness {...base} stale />)
    expect(screen.getByText("submissions.freshness.stale")).not.toBeNull()
    const btn = screen
      .getByText("submissions.collect.label")
      .closest("button") as HTMLButtonElement
    expect(btn.className).not.toContain("btn-error")
  })

  it("keeps the button tooltip constant; the badge carries the stale help", () => {
    const { rerender } = render(<DataFreshness {...base} stale={false} />)
    const button = () =>
      screen
        .getByText("submissions.collect.label")
        .closest("button") as HTMLButtonElement
    expect(button().title).toBe("submissions.freshness.collectHelp")
    rerender(<DataFreshness {...base} stale />)
    expect(button().title).toBe("submissions.freshness.collectHelp")
    expect(screen.getByText("submissions.freshness.stale").title).toBe(
      "submissions.freshness.staleHelp",
    )
  })

  it("triggers collect when the button is clicked (in sync or out of sync)", async () => {
    const onRefresh = vi.fn()
    const { rerender } = render(
      <DataFreshness {...base} onRefresh={onRefresh} />,
    )
    await userEvent.click(screen.getByText("submissions.collect.label"))
    rerender(<DataFreshness {...base} stale onRefresh={onRefresh} />)
    await userEvent.click(screen.getByText("submissions.collect.label"))
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })

  it("becomes the progress indicator while a collect is in flight: inert, focusable, 'Collecting…'", async () => {
    const onRefresh = vi.fn()
    render(<DataFreshness {...base} stale collecting onRefresh={onRefresh} />)
    const btn = screen.getByRole("button")
    expect(btn.textContent).toContain("submissions.collect.active")
    // Loading, not disabled: a disabled initiating button drops keyboard
    // focus mid-action (see Button).
    expect((btn as HTMLButtonElement).disabled).toBe(false)
    expect(btn.getAttribute("aria-busy")).toBe("true")
    expect(btn.getAttribute("aria-disabled")).toBe("true")
    await userEvent.click(btn)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("returns to 'Collect now' once the collect settles", () => {
    const { rerender } = render(<DataFreshness {...base} collecting />)
    expect(screen.queryByText("submissions.collect.label")).toBeNull()
    rerender(<DataFreshness {...base} collecting={false} />)
    expect(screen.getByText("submissions.collect.label")).not.toBeNull()
    expect(screen.queryAllByText("submissions.collect.active")).toHaveLength(0)
  })

  it("omits the button entirely when no onRefresh is provided", () => {
    render(<DataFreshness {...base} stale onRefresh={undefined} />)
    expect(screen.queryByText("submissions.collect.label")).toBeNull()
    expect(screen.queryAllByText("submissions.collect.active")).toHaveLength(0)
  })

  it("shows a degraded-read warning when some repos couldn't be read", () => {
    const { rerender } = render(<DataFreshness {...base} errorCount={0} />)
    expect(screen.queryByText(/submissions\.live\.incomplete/)).toBeNull()
    rerender(<DataFreshness {...base} errorCount={3} />)
    expect(screen.getByText(/submissions\.live\.incomplete/)).not.toBeNull()
  })

  // A TA has read-only config-repo access and can't dispatch the collect
  // workflow: the same button re-reads instead, and the note says who can.
  describe("canCollect={false} (a viewer who can't dispatch the workflow)", () => {
    it("relabels the button to Refresh with its own tooltip", () => {
      const onRefresh = vi.fn()
      render(
        <DataFreshness {...base} canCollect={false} onRefresh={onRefresh} />,
      )
      expect(screen.queryByText("submissions.collect.label")).toBeNull()
      const btn = screen
        .getByText("submissions.freshness.refreshLabel")
        .closest("button") as HTMLButtonElement
      expect(btn.title).toBe("submissions.freshness.refreshHelp")
    })

    it("still fires onRefresh on click", async () => {
      const onRefresh = vi.fn()
      render(
        <DataFreshness {...base} canCollect={false} onRefresh={onRefresh} />,
      )
      await userEvent.click(
        screen.getByText("submissions.freshness.refreshLabel"),
      )
      expect(onRefresh).toHaveBeenCalledTimes(1)
    })

    it("explains who can collect, and only for that viewer", () => {
      const { rerender } = render(
        <DataFreshness {...base} canCollect={false} />,
      )
      expect(
        screen.getByText("submissions.freshness.collectRestricted"),
      ).not.toBeNull()
      rerender(<DataFreshness {...base} canCollect />)
      expect(
        screen.queryByText("submissions.freshness.collectRestricted"),
      ).toBeNull()
    })
  })
})
