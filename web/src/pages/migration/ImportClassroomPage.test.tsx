// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

// The page reads `?from=` through the route api and clears it via navigate —
// asynchronously. The mock pins `from` to a constant to model the WORST case:
// the URL never updates. The page-level pick guard must make Back stick anyway.
const navigate = vi.fn()
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    getRouteApi: () => ({ useSearch: () => ({ from: "stresstest50" }) }),
    useNavigate: () => navigate,
    useParams: () => ({ org: "acme" }),
    Link: ({ children }: { children?: React.ReactNode }) => (
      <span>{children}</span>
    ),
  }
})

vi.mock("@/hooks/useOrgClassroom50Status", () => ({
  useOrgClassroom50Status: () => ({
    isLoading: false,
    isError: false,
    data: "ready",
    refetch: vi.fn(),
  }),
}))

// The steps are stubbed: this test targets only the wizard's phase wiring —
// specifically that a `?from=` deep link auto-advances ONCE and Back sticks.
vi.mock("./SelectSourceStep", () => ({
  SelectSourceStep: ({
    preselectOrg,
    onPick,
  }: {
    preselectOrg?: string
    onPick: (c: unknown) => void
  }) => (
    <div>
      <span>{`select-step preselect:${preselectOrg ?? "none"}`}</span>
      <button
        type="button"
        onClick={() =>
          onPick({
            id: 7,
            name: "CS50",
            archived: false,
            url: "",
            orgLogin: "stresstest50",
          })
        }
      >
        pick
      </button>
    </div>
  ),
}))

vi.mock("./ConfirmStep", () => ({
  ConfirmStep: ({ onBack }: { onBack: () => void }) => (
    <div>
      <span>confirm-step</span>
      <button type="button" onClick={onBack}>
        back
      </button>
    </div>
  ),
}))

import { ImportClassroomPage } from "./ImportClassroomPage"

afterEach(cleanup)

describe("ImportClassroomPage deep-link auto-advance", () => {
  it("consumes ?from= once so Back returns to select and stays (regression: it re-picked and bounced to confirm)", async () => {
    const user = userEvent.setup()
    render(<ImportClassroomPage />)

    // The deep link reaches the select step on first mount…
    expect(screen.getByText("select-step preselect:stresstest50")).toBeTruthy()

    // …the (auto-)pick advances to confirm…
    await user.click(screen.getByText("pick"))
    expect(screen.getByText("confirm-step")).toBeTruthy()

    // …and Back lands on select WITHOUT the preselect, even though the URL
    // still carries ?from= — so the step can't auto-pick and bounce back.
    await user.click(screen.getByText("back"))
    expect(screen.getByText("select-step preselect:none")).toBeTruthy()
    expect(screen.queryByText("confirm-step")).toBeNull()
  })
})
