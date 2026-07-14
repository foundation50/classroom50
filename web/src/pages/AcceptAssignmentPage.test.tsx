// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const pagesAssignmentsMock = vi.fn()
const refetchAssignments = vi.fn()

vi.mock("@/hooks/usePagesAssignments", () => ({
  default: (org?: string, classroom?: string, secret?: string) =>
    pagesAssignmentsMock(org, classroom, secret),
}))

vi.mock("@/hooks/useGetRepo", () => ({
  default: () => ({ data: null, isLoading: false }),
}))

vi.mock("@/hooks/useGetOwnOrgMembership", () => ({
  default: () => ({
    data: { state: "active" },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

vi.mock("@/hooks/useAcceptAndVerifyMembership", () => ({
  useAcceptAndVerifyMembership: () => ({
    isActive: true,
    isError: false,
    error: null,
    retry: vi.fn(),
  }),
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({
    user: { id: 1, login: "student", name: "Test Student" },
  }),
}))

vi.mock("@/hooks/useDocumentTitle", () => ({
  useDocumentTitle: () => undefined,
}))

vi.mock("@/components/LanguageDialog", () => ({
  LanguageDialog: () => null,
}))

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
    useParams: () => ({
      org: "VNU-HUS",
      classroom: "classroom50-pilot-2026",
      assignment: "hello-python",
    }),
    useSearch: () => ({ k: "dkybs3e9" }),
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  }
})

import AcceptAssignmentPage from "./AcceptAssignmentPage"

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AcceptAssignmentPage />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  pagesAssignmentsMock.mockReset()
  refetchAssignments.mockReset()
})

describe("AcceptAssignmentPage assignment manifest states", () => {
  it("shows a retryable load error instead of misreporting a missing assignment", () => {
    pagesAssignmentsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: false,
      isFetching: false,
      error: new TypeError("Failed to fetch"),
      refetch: refetchAssignments,
    })

    renderPage()

    expect(screen.queryByText("accept.loadError.title")).not.toBeNull()
    expect(screen.queryByText("accept.notFound.title")).toBeNull()

    fireEvent.click(
      screen.getByRole("button", { name: "accept.loadError.retry" }),
    )
    expect(refetchAssignments).toHaveBeenCalledTimes(1)
    expect(pagesAssignmentsMock).toHaveBeenCalledWith(
      "VNU-HUS",
      "classroom50-pilot-2026",
      "dkybs3e9",
    )
  })

  it("keeps not-found for a successfully loaded manifest without the slug", () => {
    pagesAssignmentsMock.mockReturnValue({
      data: [{ slug: "different-assignment" }],
      isLoading: false,
      isPending: false,
      isFetching: false,
      error: null,
      refetch: refetchAssignments,
    })

    renderPage()

    expect(screen.queryByText("accept.notFound.title")).not.toBeNull()
    expect(screen.queryByText("accept.loadError.title")).toBeNull()
  })

  it("keeps usable cached data when only a background refetch failed", () => {
    pagesAssignmentsMock.mockReturnValue({
      data: [
        {
          slug: "hello-python",
          name: "Hello Python",
          mode: "individual",
        },
      ],
      isLoading: false,
      isPending: false,
      isFetching: false,
      error: new TypeError("Background refetch failed"),
      refetch: refetchAssignments,
    })

    renderPage()

    expect(screen.queryByText("Hello Python")).not.toBeNull()
    expect(screen.queryByText("accept.loadError.title")).toBeNull()
    expect(screen.queryByText("accept.notFound.title")).toBeNull()
  })

  it("keeps a paused initial query pending instead of reporting not-found", () => {
    pagesAssignmentsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: true,
      isFetching: false,
      error: null,
      refetch: refetchAssignments,
    })

    renderPage()

    expect(screen.queryByText("accept.loadingAssignment")).not.toBeNull()
    expect(screen.queryByText("accept.loadError.title")).toBeNull()
    expect(screen.queryByText("accept.notFound.title")).toBeNull()
  })
})
