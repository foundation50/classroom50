// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { GitHubRepo } from "@/github-core/types"

const acceptAssignment = vi.fn()

vi.mock("@/domain/assignments", () => ({
  acceptAssignment: (...args: unknown[]) => acceptAssignment(...args),
}))
vi.mock("@/hooks/usePagesAssignments", () => ({
  default: () => ({
    data: [
      {
        slug: "hello-python",
        name: "Hello Python",
        mode: "individual",
        autograder: "default",
      },
    ],
    isLoading: false,
  }),
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
vi.mock("@/hooks/mutations/useAcceptAndVerifyMembership", () => ({
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
vi.mock("@/components/modals/GroupCollaboratorsModal", () => ({
  GroupCollaboratorsModal: () => null,
}))
vi.mock("canvas-confetti", () => ({ default: vi.fn() }))

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
      org: "acme",
      classroom: "cs101",
      assignment: "hello-python",
    }),
    useSearch: () => ({ k: "test-secret" }),
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  }
})

import AcceptAssignmentPage from "./AcceptAssignmentPage"

const acceptedRepo: GitHubRepo = {
  id: 1,
  name: "cs101-hello-python-student",
  full_name: "acme/cs101-hello-python-student",
  private: true,
  default_branch: "main",
  ssh_url: "git@github.com:acme/cs101-hello-python-student.git",
  html_url: "https://github.com/acme/cs101-hello-python-student",
  permissions: {
    admin: false,
    maintain: false,
    push: true,
    pull: true,
  },
}

const orgReposKey = ["github", "org-repos", "acme"] as const

const renderPage = (client: QueryClient) =>
  render(
    <QueryClientProvider client={client}>
      <AcceptAssignmentPage />
    </QueryClientProvider>,
  )

beforeEach(() => {
  acceptAssignment.mockReset()
})

afterEach(cleanup)

describe("AcceptAssignmentPage repository cache", () => {
  it.each(["created", "already-accepted"] as const)(
    "refreshes an inactive organization-repository query after %s",
    async (status) => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity },
          mutations: { retry: false },
        },
      })
      let resolveRefresh!: (repos: GitHubRepo[]) => void
      const refresh = new Promise<GitHubRepo[]>((resolve) => {
        resolveRefresh = resolve
      })
      const listRepos = vi
        .fn<() => Promise<GitHubRepo[]>>()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(() => refresh)

      await client.prefetchQuery({
        queryKey: orgReposKey,
        queryFn: listRepos,
      })
      expect(
        client
          .getQueryCache()
          .find({
            queryKey: orgReposKey,
            exact: true,
          })
          ?.getObserversCount(),
      ).toBe(0)
      acceptAssignment.mockResolvedValue({
        status,
        repo: acceptedRepo,
        cloneCommand: "gh repo clone acme/repo",
      })

      renderPage(client)
      fireEvent.click(
        screen.getByRole("button", { name: "accept.acceptButton" }),
      )

      await waitFor(() => expect(acceptAssignment).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(listRepos).toHaveBeenCalledTimes(2))
      expect(screen.queryByText("accept.openRepository")).not.toBeNull()

      resolveRefresh([acceptedRepo])
      await waitFor(() =>
        expect(client.getQueryData(orgReposKey)).toEqual([acceptedRepo]),
      )
    },
  )
})
