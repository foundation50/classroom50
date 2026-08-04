// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// i18n -> key passthrough with param interpolation for the title assertion.
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

import { DeployEnvBadge } from "./DeployEnvBadge"

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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
    expect(screen.getByText("nav.envDev")).toBeTruthy()
  })

  it("shows the Preview label on the preview host", () => {
    vi.stubEnv("DEV", false)
    vi.stubGlobal("location", new URL("https://preview.classroom50.org/"))
    render(<DeployEnvBadge />)
    expect(screen.getByText("nav.envPreview")).toBeTruthy()
  })

  it("carries an explanatory title tooltip (reads on the collapsed rail too)", () => {
    render(<DeployEnvBadge />)
    expect(screen.getByText("nav.envDev").getAttribute("title")).toContain(
      "nav.envIndicator",
    )
  })
})
