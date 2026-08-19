// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import type { ReactNode } from "react"

// Assert on stable i18n keys, not English copy.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useNavigate: () => () => Promise.resolve(),
  }
})

// The gate hook is the unit under test's switch; drive it per-case.
const hasDeleteRepo = vi.fn<() => boolean>()
vi.mock("@/context/github/GitHubProvider", () => ({
  useHasDeleteRepoScope: () => hasDeleteRepo(),
}))

const startWebFlow = vi.fn()
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ startWebFlow }),
}))

// Teardown mutations aren't exercised by these render-time assertions; stub them
// to inert pending-false mutations so the section mounts without a QueryClient.
vi.mock("@/hooks/mutations/usePlanTeardown", () => ({
  usePlanTeardown: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/hooks/mutations/useExecuteTeardown", () => ({
  useExecuteTeardown: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

// SettingsSection wraps children in card chrome; render children directly.
vi.mock("./SettingsSection", () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

import TeardownSection from "./TeardownSection"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("TeardownSection scope gate (#655)", () => {
  it("renders the teardown button when delete_repo is granted", () => {
    hasDeleteRepo.mockReturnValue(true)
    render(<TeardownSection org="acme" />)
    expect(screen.getByText("orgSettings.teardown.button")).toBeTruthy()
    expect(screen.queryByText("orgSettings.teardown.needsElevation")).toBeNull()
  })

  it("renders the elevation prompt (not the teardown button) when delete_repo is absent", () => {
    hasDeleteRepo.mockReturnValue(false)
    render(<TeardownSection org="acme" />)
    expect(screen.getByText("orgSettings.teardown.needsElevation")).toBeTruthy()
    expect(screen.getByText("orgSettings.teardown.grantButton")).toBeTruthy()
    expect(screen.queryByText("orgSettings.teardown.button")).toBeNull()
  })

  it("requests elevated permissions one-shot when the prompt button is clicked", () => {
    hasDeleteRepo.mockReturnValue(false)
    render(<TeardownSection org="acme" />)
    screen.getByText("orgSettings.teardown.grantButton").click()
    expect(startWebFlow).toHaveBeenCalledWith({ elevated: true })
  })
})
