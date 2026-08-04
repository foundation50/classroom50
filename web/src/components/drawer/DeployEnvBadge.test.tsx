// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// i18n -> key passthrough with param interpolation for the aria-label assertion.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
    }),
  }
})

const collapseMock = vi.fn(() => ({ collapsed: false, toggle: () => {} }))
vi.mock("./collapseContext", () => ({
  useSidebarCollapse: () => collapseMock(),
}))

import { DeployEnvBadge } from "./DeployEnvBadge"

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  collapseMock.mockReturnValue({ collapsed: false, toggle: () => {} })
})

describe("DeployEnvBadge", () => {
  it("renders nothing in production", () => {
    vi.stubEnv("DEV", false)
    vi.stubGlobal("location", new URL("https://classroom50.org/"))
    const { container } = render(<DeployEnvBadge />)
    expect(container.innerHTML).toBe("")
  })

  it("shows the Dev label on the dev server", () => {
    // Vitest runs with import.meta.env.DEV === true.
    render(<DeployEnvBadge />)
    expect(screen.getByRole("status").textContent).toBe("nav.envDev")
  })

  it("shows the Preview label on the preview host", () => {
    vi.stubEnv("DEV", false)
    vi.stubGlobal("location", new URL("https://preview.classroom50.org/"))
    render(<DeployEnvBadge />)
    expect(screen.getByRole("status").textContent).toBe("nav.envPreview")
  })

  it("collapsed: label moves to the aria-label, not visible text", () => {
    collapseMock.mockReturnValue({ collapsed: true, toggle: () => {} })
    render(<DeployEnvBadge />)
    const badge = screen.getByRole("status")
    expect(badge.textContent).toBe("")
    expect(badge.getAttribute("aria-label")).toContain("nav.envIndicator")
  })
})
