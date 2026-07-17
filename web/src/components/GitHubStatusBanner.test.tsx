// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react"

const healthMock = vi.fn()
vi.mock("@/lib/githubHealth", () => ({
  useGitHubHealth: () => healthMock(),
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Echo the key (plus any interpolation) so assertions can target keys.
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.status ? `${key}:${String(opts.status)}` : key,
  }),
}))

import { GitHubStatusBanner } from "./GitHubStatusBanner"

const health = (over: Record<string, unknown> = {}) =>
  healthMock.mockReturnValue({
    suspected: false,
    statusIndicator: null,
    statusDescription: null,
    ...over,
  })

afterEach(() => {
  cleanup()
  healthMock.mockReset()
})

describe("GitHubStatusBanner", () => {
  it("renders nothing when GitHub is not suspected", () => {
    health({ suspected: false })
    render(<GitHubStatusBanner />)
    expect(screen.queryByText("githubStatus.title")).toBeNull()
  })

  it("shows the generic body + status link when suspected with no confirmed status", () => {
    health({ suspected: true })
    render(<GitHubStatusBanner />)
    expect(screen.queryByText("githubStatus.title")).not.toBeNull()
    expect(screen.queryByText("githubStatus.bodyGeneric")).not.toBeNull()
    const link = screen.getByText("githubStatus.checkStatusLink")
    expect(link.getAttribute("href")).toBe("https://www.githubstatus.com")
  })

  it("shows the confirmed body with the githubstatus.com description when present", () => {
    health({ suspected: true, statusDescription: "Partially Degraded Service" })
    render(<GitHubStatusBanner />)
    expect(
      screen.queryByText(
        "githubStatus.bodyConfirmed:Partially Degraded Service",
      ),
    ).not.toBeNull()
    expect(screen.queryByText("githubStatus.bodyGeneric")).toBeNull()
  })

  it("hides after dismiss", async () => {
    health({ suspected: true })
    render(<GitHubStatusBanner />)
    fireEvent.click(screen.getByLabelText("components.banner.dismiss"))
    // AppBanner exit-animates via AnimatePresence, so removal isn't synchronous.
    await waitFor(() =>
      expect(screen.queryByText("githubStatus.title")).toBeNull(),
    )
  })
})
