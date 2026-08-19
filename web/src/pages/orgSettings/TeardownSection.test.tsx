// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { TeardownPlan } from "@/domain/teardown"

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

// The modal owns the web/device choice; here we only assert TeardownSection
// opens it. Its flow is covered by ElevatedAccessModal's own test.
vi.mock("@/auth/ElevatedAccessModal", () => ({
  ElevatedAccessModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="elevated-modal" /> : null,
}))

// Teardown mutations aren't exercised by these render-time assertions; stub them
// to inert pending-false mutations so the section mounts without a QueryClient.
// `planResult` / `executeError` let the abort-reporting cases drive them.
const planResult = vi.fn<() => TeardownPlan>(() => ({
  org: "acme",
  repoNames: ["classroom50"],
  teams: [],
}))
const executeError = vi.fn<() => unknown>(() => null)
vi.mock("@/hooks/mutations/usePlanTeardown", () => ({
  usePlanTeardown: () => ({
    mutate: (
      _v: undefined,
      cbs?: { onSuccess?: (p: TeardownPlan) => void },
    ) => {
      cbs?.onSuccess?.(planResult())
    },
    isPending: false,
  }),
}))
vi.mock("@/hooks/mutations/useExecuteTeardown", () => ({
  useExecuteTeardown: () => ({
    mutateAsync: () => {
      const err = executeError()
      return err ? Promise.reject(err) : Promise.resolve(undefined)
    },
    isPending: false,
  }),
}))

// SettingsSection wraps children in card chrome; render children directly.
vi.mock("./SettingsSection", () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

import TeardownSection from "./TeardownSection"
import { TeardownForbiddenError, TeardownScopeError } from "@/domain/teardown"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  executeError.mockReturnValue(null)
})

describe("TeardownSection scope gate (#655)", () => {
  it("renders the teardown button when delete_repo is granted", () => {
    hasDeleteRepo.mockReturnValue(true)
    render(<TeardownSection org="acme" />)
    expect(screen.getByText("orgSettings.teardown.button")).toBeTruthy()
    expect(
      screen.queryByText("orgSettings.teardown.insufficientPermission"),
    ).toBeNull()
  })

  it("renders the elevation prompt (not the teardown button) when delete_repo is absent", () => {
    hasDeleteRepo.mockReturnValue(false)
    render(<TeardownSection org="acme" />)
    expect(
      screen.getByText("orgSettings.teardown.insufficientPermission"),
    ).toBeTruthy()
    expect(screen.getByText("orgSettings.teardown.grantButton")).toBeTruthy()
    expect(screen.queryByText("orgSettings.teardown.button")).toBeNull()
  })

  it("opens the elevated-access modal when the prompt button is clicked", async () => {
    hasDeleteRepo.mockReturnValue(false)
    render(<TeardownSection org="acme" />)
    expect(screen.queryByTestId("elevated-modal")).toBeNull()
    await userEvent.click(screen.getByText("orgSettings.teardown.grantButton"))
    expect(screen.getByTestId("elevated-modal")).toBeTruthy()
  })
})

// An abort that already deleted repositories carries the only record of that
// permanent data loss. The confirmation modal's inline error dies with the modal,
// so the message has to be hoisted to the section callout — for every abort kind,
// not just the one that offers elevation.
describe("TeardownSection abort reporting", () => {
  async function runTeardown() {
    hasDeleteRepo.mockReturnValue(true)
    render(<TeardownSection org="acme" />)
    await userEvent.click(screen.getByText("orgSettings.teardown.button"))
    // ConfirmModal is two-stage: acknowledge, then type the org name.
    await userEvent.click(
      screen.getByText("components.confirmModal.yesContinue"),
    )
    await userEvent.type(
      screen.getByLabelText("components.confirmModal.typeAriaLabel"),
      "orgSettings.teardown.confirmText",
    )
    await userEvent.click(screen.getByText("orgSettings.teardown.confirmLabel"))
  }

  it("hoists a partial-progress SSO abort, without offering elevation", async () => {
    executeError.mockReturnValue(
      new TeardownForbiddenError("sso", ["cs101-hw1-alice"], []),
    )
    await runTeardown()

    expect(
      screen.getByText("orgSettings.teardown.ssoRequiredPartial"),
    ).toBeTruthy()
    // Elevation cannot clear an SSO gate, so don't send the teacher through it.
    expect(screen.queryByText("orgSettings.teardown.grantButton")).toBeNull()
  })

  it("hoists the scope wall and offers elevation", async () => {
    executeError.mockReturnValue(new TeardownScopeError([], []))
    await runTeardown()

    expect(
      screen.getByText("orgSettings.teardown.needsDeleteScope"),
    ).toBeTruthy()
    expect(screen.getByText("orgSettings.teardown.grantButton")).toBeTruthy()
  })
})
