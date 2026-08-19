// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { DeviceAuthState } from "./types"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

// The router's location is base-relative (the router owns `basepath`), unlike
// window.location. Return a path with a search string so the selector is proven
// to build both halves.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useRouterState: ({
      select,
    }: {
      select: (s: {
        location: { pathname: string; searchStr: string }
      }) => string
    }) =>
      select({ location: { pathname: "/acme/settings", searchStr: "?x=1" } }),
  }
})

const startWebFlow = vi.fn()
const startDeviceFlow = vi.fn()
const cancelDeviceFlow = vi.fn()
const markDeviceCodeCopied = vi.fn()
const markVerificationOpened = vi.fn()
const authState: {
  startWebFlow: typeof startWebFlow
  startDeviceFlow: typeof startDeviceFlow
  cancelDeviceFlow: typeof cancelDeviceFlow
  markDeviceCodeCopied: typeof markDeviceCodeCopied
  markVerificationOpened: typeof markVerificationOpened
  screen: string
  device: DeviceAuthState | null
  deviceStatus: null
  error: string | null
  isRequestingDeviceCode: boolean
} = {
  startWebFlow,
  startDeviceFlow,
  cancelDeviceFlow,
  markDeviceCodeCopied,
  markVerificationOpened,
  screen: "config",
  device: null,
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
  elevated: true,
}

describe("ElevatedAccessModal (#655)", () => {
  it("offers the browser flow, requesting elevated scope and a return path", () => {
    render(<ElevatedAccessModal open onClose={() => {}} />)
    screen.getByText("auth.elevated.browserButton").click()
    expect(startWebFlow).toHaveBeenCalledWith(
      expect.objectContaining({ elevated: true }),
    )
  })

  it("returns to a base-relative path, not window.location", () => {
    // `returnTo` is replayed through router.history.push, which prepends the
    // basepath — so a window.location.pathname value would double it on the
    // GitHub Pages deploy.
    render(<ElevatedAccessModal open onClose={() => {}} />)
    screen.getByText("auth.elevated.browserButton").click()
    expect(startWebFlow).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: "/acme/settings?x=1" }),
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
    render(<ElevatedAccessModal open onClose={() => {}} />)
    expect(screen.getByText("WXYZ-1234")).toBeTruthy()
    expect(screen.queryByText("auth.elevated.browserButton")).toBeNull()
  })

  it("ignores a pending device flow started for the other direction", () => {
    // A base-scope flow must not render under the "request elevated" label.
    authState.screen = "device-prompt"
    authState.device = { ...aDevice, elevated: false }
    render(<ElevatedAccessModal open elevated onClose={() => {}} />)
    expect(screen.queryByText("WXYZ-1234")).toBeNull()
    expect(screen.getByText("auth.elevated.browserButton")).toBeTruthy()
  })

  it("aborts the device poll when the prompt is cancelled", async () => {
    const onClose = vi.fn()
    const view = render(<ElevatedAccessModal open onClose={onClose} />)

    // Start the flow from this dialog, so it owns the poll it later cancels.
    await userEvent.click(screen.getByText("auth.elevated.deviceButton"))
    authState.screen = "device-prompt"
    authState.device = aDevice
    view.rerender(<ElevatedAccessModal open onClose={onClose} />)

    await userEvent.click(screen.getByText("common.cancel"))
    expect(cancelDeviceFlow).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("does not cancel a device flow it never started", async () => {
    // A flow begun elsewhere (the login card) must survive this dialog closing.
    authState.screen = "device-prompt"
    authState.device = aDevice
    const onClose = vi.fn()
    render(<ElevatedAccessModal open onClose={onClose} />)
    await userEvent.click(screen.getByText("common.cancel"))
    expect(cancelDeviceFlow).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("releases an in-flight flow when the dialog unmounts", async () => {
    const view = render(<ElevatedAccessModal open onClose={() => {}} />)
    await userEvent.click(screen.getByText("auth.elevated.deviceButton"))
    // Navigating away never runs the dismiss handler.
    view.unmount()
    expect(cancelDeviceFlow).toHaveBeenCalled()
  })

  it("stays open after starting a device flow, before the code arrives", async () => {
    // The pre-start state (signed in, no device yet) looks identical to the
    // post-success state, so a naive success watcher closes the dialog the
    // instant the user picks the device path.
    const onClose = vi.fn()
    render(<ElevatedAccessModal open onClose={onClose} />)
    await userEvent.click(screen.getByText("auth.elevated.deviceButton"))
    expect(startDeviceFlow).toHaveBeenCalledWith({ elevated: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it("closes once a device flow it started completes", () => {
    const onClose = vi.fn()
    authState.screen = "device-prompt"
    authState.device = aDevice
    const view = render(<ElevatedAccessModal open onClose={onClose} />)
    expect(screen.getByText("WXYZ-1234")).toBeTruthy()

    // completeSignIn clears the device and returns to "authed".
    authState.screen = "authed"
    authState.device = null
    view.rerender(<ElevatedAccessModal open onClose={onClose} />)
    expect(onClose).toHaveBeenCalled()
  })

  it("surfaces an auth error instead of leaving the dialog unchanged", () => {
    authState.error = "proxy unreachable"
    render(<ElevatedAccessModal open onClose={() => {}} />)
    expect(screen.getByText("proxy unreachable")).toBeTruthy()
  })
})
