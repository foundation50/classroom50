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
const cancelDeviceFlow = vi.fn()
const authState: {
  startWebFlow: typeof startWebFlow
  startDeviceFlow: typeof startDeviceFlow
  cancelDeviceFlow: typeof cancelDeviceFlow
  screen: string
  device: DeviceAuthState | null
  deviceElevated: boolean | null
  deviceStatus: null
  error: string | null
  isRequestingDeviceCode: boolean
} = {
  startWebFlow,
  startDeviceFlow,
  cancelDeviceFlow,
  screen: "config",
  device: null,
  deviceElevated: null,
  deviceStatus: null,
  error: null,
  isRequestingDeviceCode: false,
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
  authState.deviceElevated = null
  authState.error = null
  authState.isRequestingDeviceCode = false
})

const aDevice: DeviceAuthState = {
  userCode: "WXYZ-1234",
  verificationUri: "https://github.com/login/device",
  deviceCode: "dc",
  expiresAt: Date.now() + 60_000,
  intervalSeconds: 5,
  attempts: 0,
  nextPollAt: Date.now() + 5_000,
  progress: 0,
}

describe("ElevatedAccessModal (#655)", () => {
  it("offers the browser flow, requesting elevated scope and a return path", () => {
    render(<ElevatedAccessModal open onClose={() => {}} />)
    screen.getByText("auth.elevated.browserButton").click()
    expect(startWebFlow).toHaveBeenCalledWith(
      expect.objectContaining({ elevated: true }),
    )
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
    expect(startWebFlow).toHaveBeenCalledWith(
      expect.objectContaining({ elevated: false }),
    )
  })

  it("shows the device prompt inline once a matching device code is issued", () => {
    authState.screen = "device-prompt"
    authState.device = aDevice
    authState.deviceElevated = true
    render(<ElevatedAccessModal open onClose={() => {}} />)
    expect(screen.getByText("WXYZ-1234")).toBeTruthy()
    expect(screen.queryByText("auth.elevated.browserButton")).toBeNull()
  })

  it("ignores a pending device flow started for the other direction", () => {
    // A base-scope flow must not render under the "request elevated" label.
    authState.screen = "device-prompt"
    authState.device = aDevice
    authState.deviceElevated = false
    render(<ElevatedAccessModal open elevated onClose={() => {}} />)
    expect(screen.queryByText("WXYZ-1234")).toBeNull()
    expect(screen.getByText("auth.elevated.browserButton")).toBeTruthy()
  })

  it("aborts the device poll when the prompt is cancelled", () => {
    authState.screen = "device-prompt"
    authState.device = aDevice
    authState.deviceElevated = true
    const onClose = vi.fn()
    render(<ElevatedAccessModal open onClose={onClose} />)
    screen.getByText("common.cancel").click()
    expect(cancelDeviceFlow).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("surfaces an auth error instead of leaving the dialog unchanged", () => {
    authState.error = "proxy unreachable"
    render(<ElevatedAccessModal open onClose={() => {}} />)
    expect(screen.getByText("proxy unreachable")).toBeTruthy()
  })
})
