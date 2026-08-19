// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import type { DeviceAuthState } from "./types"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

const startWebFlow = vi.fn()
const startDeviceFlow = vi.fn()
const authState: {
  startWebFlow: typeof startWebFlow
  startDeviceFlow: typeof startDeviceFlow
  screen: string
  device: DeviceAuthState | null
  deviceStatus: null
} = {
  startWebFlow,
  startDeviceFlow,
  screen: "config",
  device: null,
  deviceStatus: null,
}
vi.mock("./useGithubAuth", () => ({
  useGithubAuth: () => authState,
}))

import { ElevatedAccessModal } from "./ElevatedAccessModal"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  authState.screen = "config"
  authState.device = null
})

describe("ElevatedAccessModal (#655)", () => {
  it("offers the browser flow, requesting elevated scope", () => {
    render(<ElevatedAccessModal open onClose={() => {}} />)
    screen.getByText("auth.elevated.browserButton").click()
    expect(startWebFlow).toHaveBeenCalledWith({ elevated: true })
  })

  it("offers the device flow, requesting elevated scope", () => {
    render(<ElevatedAccessModal open onClose={() => {}} />)
    screen.getByText("auth.elevated.deviceButton").click()
    expect(startDeviceFlow).toHaveBeenCalledWith({ elevated: true })
  })

  it("re-auths at base scope when elevated is false (revoke)", () => {
    render(<ElevatedAccessModal open elevated={false} onClose={() => {}} />)
    expect(screen.getByText("auth.elevated.revokeTitle")).toBeTruthy()
    screen.getByText("auth.elevated.browserButton").click()
    expect(startWebFlow).toHaveBeenCalledWith({ elevated: false })
  })

  it("shows the device prompt inline once a device code is issued", () => {
    authState.screen = "device-prompt"
    authState.device = {
      userCode: "WXYZ-1234",
      verificationUri: "https://github.com/login/device",
      deviceCode: "dc",
      expiresAt: Date.now() + 60_000,
      intervalSeconds: 5,
      attempts: 0,
      nextPollAt: Date.now() + 5_000,
      progress: 0,
    }
    render(<ElevatedAccessModal open onClose={() => {}} />)
    // The device code renders, and the choice buttons are gone.
    expect(screen.getByText("WXYZ-1234")).toBeTruthy()
    expect(screen.queryByText("auth.elevated.browserButton")).toBeNull()
  })
})
