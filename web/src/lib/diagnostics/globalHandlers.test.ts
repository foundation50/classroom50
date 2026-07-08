// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The install guard is module-level, so each test re-imports a fresh module
// graph to exercise a clean install.
async function freshModules() {
  vi.resetModules()
  const store = await import("@/lib/activity/activityStore")
  const handlers = await import("./globalHandlers")
  store.clearActivity()
  return { store, handlers }
}

let addSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  addSpy = vi.spyOn(window, "addEventListener")
})
afterEach(() => vi.restoreAllMocks())

describe("installDiagnosticsHandlers", () => {
  it("records an entry for a global error event", async () => {
    const { store, handlers } = await freshModules()
    handlers.installDiagnosticsHandlers()

    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("kaboom"),
        message: "kaboom",
      }),
    )

    const recent = store.readActivity()
    expect(recent).toHaveLength(1)
    expect(recent[0].label).toBe("kaboom")
  })

  it("falls back to the event message when error is null (cross-origin)", async () => {
    const { store, handlers } = await freshModules()
    handlers.installDiagnosticsHandlers()

    window.dispatchEvent(new ErrorEvent("error", { message: "opaque" }))

    expect(store.readActivity()[0].label).toBe("opaque")
  })

  it("records the reason for an unhandled rejection", async () => {
    const { store, handlers } = await freshModules()
    handlers.installDiagnosticsHandlers()

    // Construct the event directly; a real rejection would log noise.
    const event = new Event("unhandledrejection") as PromiseRejectionEvent
    Object.defineProperty(event, "reason", { value: new Error("rejected") })
    window.dispatchEvent(event)

    expect(store.readActivity()[0].label).toBe("rejected")
  })

  it("registers listeners only once across repeated calls", async () => {
    const { handlers } = await freshModules()

    handlers.installDiagnosticsHandlers()
    handlers.installDiagnosticsHandlers()
    handlers.installDiagnosticsHandlers()

    const errorRegistrations = addSpy.mock.calls.filter(
      ([type]: [string, ...unknown[]]) => type === "error",
    )
    expect(errorRegistrations).toHaveLength(1)
  })
})
