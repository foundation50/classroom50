// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { clearActivity, recordError } from "@/lib/activity/activityStore"

// Stub the surrounding chrome + data hooks so the test focuses on the page's
// merge/render logic. The GitHub client is null (persistent queries disabled),
// so only the session source contributes — exactly the unit under test here.
vi.mock("@/components/RequireTeacher", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/PageShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useParams: () => ({ org: "acme" }),
  }
})
vi.mock("@/hooks/useDocumentTitle", () => ({ useDocumentTitle: () => {} }))
vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k }),
  }
})
vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => null,
  useGitHubClient: () => null,
}))
// useGetOrgPlanDetails runs a useQuery under the hood; the generic useQuery
// mock below makes it inert (returns { data: [] }), so no plan is threaded —
// exactly the non-owner "unknown plan" path, which is fine for this unit.
// With a null client both persistent queries are disabled; make useQuery inert
// so the page renders from the session store alone.
vi.mock("@tanstack/react-query", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-query")>()
  return {
    ...actual,
    useQuery: () => ({
      data: [],
      isLoading: false,
      isError: false,
      isFetching: false,
    }),
  }
})

import OrgActivityPage from "./OrgActivityPage"

afterEach(() => {
  cleanup()
  clearActivity()
})

describe("OrgActivityPage", () => {
  it("shows the empty state when the org has no activity", () => {
    render(<OrgActivityPage />)
    expect(screen.getByText("orgActivity.empty.title")).toBeTruthy()
  })

  it("renders a session error entry for the org", () => {
    recordError(new Error("Create classroom failed"), { org: "acme" })
    render(<OrgActivityPage />)
    expect(screen.getByText("Create classroom failed")).toBeTruthy()
  })

  it("does not show another org's activity", () => {
    recordError(new Error("other org failure"), { org: "different" })
    render(<OrgActivityPage />)
    expect(screen.queryByText("other org failure")).toBeNull()
    expect(screen.getByText("orgActivity.empty.title")).toBeTruthy()
  })

  it("filters entries by the search box", async () => {
    const { default: userEvent } = await import("@testing-library/user-event")
    recordError(new Error("alpha failure"), { org: "acme" })
    recordError(new Error("beta failure"), { org: "acme" })
    render(<OrgActivityPage />)
    expect(screen.getByText("alpha failure")).toBeTruthy()

    const search = screen.getByLabelText("orgActivity.searchLabel")
    await userEvent.type(search, "beta")

    expect(screen.queryByText("alpha failure")).toBeNull()
    expect(screen.getByText("beta failure")).toBeTruthy()
  })
})
