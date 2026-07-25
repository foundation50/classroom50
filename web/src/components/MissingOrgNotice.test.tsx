// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

const startWebFlow = vi.fn()
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ startWebFlow }),
}))

import MissingOrgNotice from "./MissingOrgNotice"

const grantLink = () =>
  screen.getByText("orgs.missingNotice.manageOauth").closest("a")

const disclosure = () =>
  document.querySelector("details") as HTMLDetailsElement | null

// The grant CTA is a real anchor; happy-dom would otherwise try to navigate to
// github.com when a test clicks it.
const blockNavigation = (e: Event) => {
  if ((e.target as HTMLElement | null)?.closest("a")) e.preventDefault()
}

beforeEach(() => {
  startWebFlow.mockReset()
  document.addEventListener("click", blockNavigation)
})

afterEach(() => {
  document.removeEventListener("click", blockNavigation)
  cleanup()
})

describe("MissingOrgNotice", () => {
  it("links the app's own GitHub authorization page in a new tab", () => {
    render(<MissingOrgNotice refreshing={false} onRefresh={vi.fn()} />)

    const link = grantLink()
    expect(link?.getAttribute("href")).toContain(
      "https://github.com/settings/connections/applications",
    )
    expect(link?.getAttribute("target")).toBe("_blank")
  })

  it("stays collapsed by default and opens on request", () => {
    const { unmount } = render(
      <MissingOrgNotice refreshing={false} onRefresh={vi.fn()} />,
    )
    expect(disclosure()?.open).toBe(false)
    unmount()

    render(
      <MissingOrgNotice refreshing={false} onRefresh={vi.fn()} defaultOpen />,
    )
    expect(disclosure()?.open).toBe(true)
  })

  it("spells out the grant steps", () => {
    render(
      <MissingOrgNotice refreshing={false} onRefresh={vi.fn()} defaultOpen />,
    )

    expect(screen.getByText("orgs.missingNotice.steps.grant")).toBeTruthy()
    expect(screen.getByText("orgs.missingNotice.steps.approve")).toBeTruthy()
    expect(screen.getByText("orgs.missingNotice.steps.refresh")).toBeTruthy()
  })

  it("expands and collapses on a single click", () => {
    render(<MissingOrgNotice refreshing={false} onRefresh={vi.fn()} />)
    const summary = screen.getByText("orgs.missingNotice.title")

    // React owns `open`, so the native toggle must be suppressed — sharing that
    // state with the element is what makes a closed disclosure need two clicks.
    // fireEvent returns false when preventDefault was called.
    expect(fireEvent.click(summary)).toBe(false)
    expect(screen.getByText("orgs.missingNotice.steps.grant")).toBeTruthy()
    expect(disclosure()?.open).toBe(true)

    fireEvent.click(summary)
    expect(disclosure()?.open).toBe(false)
  })

  it("refreshes without letting the click toggle the disclosure", () => {
    const onRefresh = vi.fn()
    render(<MissingOrgNotice refreshing={false} onRefresh={onRefresh} />)

    // The refresh control sits inside <summary>, so the click's default action
    // (toggling the disclosure) has to be suppressed. fireEvent returns false
    // when preventDefault was called.
    const defaultAllowed = fireEvent.click(
      screen.getByText("orgs.missingNotice.refresh"),
    )
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(defaultAllowed).toBe(false)
  })

  it("refreshes once when the teacher returns from the grant page", () => {
    const onRefresh = vi.fn()
    render(
      <MissingOrgNotice refreshing={false} onRefresh={onRefresh} defaultOpen />,
    )

    document.dispatchEvent(new Event("visibilitychange"))
    expect(onRefresh).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("orgs.missingNotice.manageOauth"))
    document.dispatchEvent(new Event("visibilitychange"))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new Event("visibilitychange"))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("offers re-authorization for a token that predates the membership", () => {
    render(
      <MissingOrgNotice refreshing={false} onRefresh={vi.fn()} defaultOpen />,
    )

    fireEvent.click(screen.getByText("auth.reauthorize"))
    expect(startWebFlow).toHaveBeenCalledTimes(1)
  })
})
