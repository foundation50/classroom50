// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

import { Spinner } from "@/components/Spinner"
import { useAnnounce } from "@/hooks/useAnnounce"
import {
  ANNOUNCE_LINGER_MS,
  __resetLiveAnnouncerForTest,
} from "@/lib/liveAnnouncer"
import { LiveAnnouncer } from "./LiveAnnouncer"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const Announce = ({ text }: { text: string | null }) => {
  useAnnounce(text)
  return null
}

const live = () => screen.getByRole("status")

beforeEach(() => {
  vi.useFakeTimers()
  __resetLiveAnnouncerForTest()
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  cleanup()
})

describe("LiveAnnouncer", () => {
  it("is present and empty before anything announces", () => {
    render(<LiveAnnouncer />)
    expect(live().getAttribute("aria-live")).toBe("polite")
    expect(live().textContent).toBe("")
  })

  it("announces a mounted Spinner and clears after the last one leaves", () => {
    const { rerender } = render(
      <>
        <LiveAnnouncer />
        <Spinner />
      </>,
    )
    expect(live().textContent).toBe("common.loading")
    // The spinner itself is decorative; the region owns the text.
    expect(document.querySelectorAll("[role='status']")).toHaveLength(1)

    rerender(<LiveAnnouncer />)
    expect(live().textContent).toBe("common.loading")
    act(() => vi.advanceTimersByTime(ANNOUNCE_LINGER_MS))
    expect(live().textContent).toBe("")
  })

  it("announces once for several spinners with the same label", () => {
    const { rerender } = render(
      <>
        <LiveAnnouncer />
        <Spinner />
        <Spinner />
        <Spinner label="Loading rows" />
      </>,
    )
    expect(live().textContent).toBe("Loading rows")

    rerender(
      <>
        <LiveAnnouncer />
        <Spinner />
      </>,
    )
    // One of the same-label spinners remains: the text falls back to it.
    expect(live().textContent).toBe("common.loading")
  })

  it("does not re-announce a same-text remount inside the linger", () => {
    const { rerender } = render(
      <>
        <LiveAnnouncer />
        <Spinner />
      </>,
    )
    const region = live()
    let changes = 0
    const observer = new MutationObserver(() => {
      changes += 1
    })
    observer.observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    })

    rerender(<LiveAnnouncer />)
    act(() => vi.advanceTimersByTime(ANNOUNCE_LINGER_MS / 2))
    rerender(
      <>
        <LiveAnnouncer />
        <Spinner />
      </>,
    )
    act(() => vi.advanceTimersByTime(ANNOUNCE_LINGER_MS))
    expect(live().textContent).toBe("common.loading")
    expect(changes).toBe(0)
    observer.disconnect()
  })

  it("follows a caller's text as it changes and withdraws on empty", () => {
    const { rerender } = render(
      <>
        <LiveAnnouncer />
        <Announce text="Syncing" />
      </>,
    )
    expect(live().textContent).toBe("Syncing")
    rerender(
      <>
        <LiveAnnouncer />
        <Announce text="Synced" />
      </>,
    )
    expect(live().textContent).toBe("Synced")
    rerender(
      <>
        <LiveAnnouncer />
        <Announce text={null} />
      </>,
    )
    act(() => vi.advanceTimersByTime(ANNOUNCE_LINGER_MS))
    expect(live().textContent).toBe("")
  })
})
