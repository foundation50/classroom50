import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveAppEnv } from "./appEnv"

// Vitest runs with import.meta.env.DEV === true, so the host-based branches are
// only reachable by stubbing DEV false first.
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("resolveAppEnv", () => {
  it("dev server wins over host", () => {
    vi.stubEnv("DEV", true)
    expect(resolveAppEnv("classroom50.org")).toBe("development")
    expect(resolveAppEnv("preview.classroom50.org")).toBe("development")
  })

  it("preview host => preview", () => {
    vi.stubEnv("DEV", false)
    expect(resolveAppEnv("preview.classroom50.org")).toBe("preview")
  })

  it("production host => production", () => {
    vi.stubEnv("DEV", false)
    expect(resolveAppEnv("classroom50.org")).toBe("production")
  })

  it("any other host in a non-dev build => production (never mislabels)", () => {
    vi.stubEnv("DEV", false)
    expect(resolveAppEnv("localhost")).toBe("production")
    expect(resolveAppEnv("")).toBe("production")
  })
})
