// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { GitHubRepo } from "@/github-core/types"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

const getOrgRepos = vi.fn()

vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: (...args: unknown[]) => getOrgRepos(...args),
}))
vi.mock("@/hooks/useDotClassroom50", () => ({
  default: () => ({}),
}))
vi.mock("@/hooks/useStudentClassrooms", () => ({
  useClassroomSecret: () => ({
    secret: undefined,
    pagesBaseUrl: undefined,
    isLoading: false,
    isError: false,
  }),
}))
vi.mock("@/hooks/usePagesAssignments", () => ({
  default: () => ({ assignment: undefined }),
}))

import { OrgRepos } from "./OrgRepos"

type Permissions = NonNullable<GitHubRepo["permissions"]>

const rolePermissions = {
  read: {
    admin: false,
    maintain: false,
    push: false,
    pull: true,
  },
  write: {
    admin: false,
    maintain: false,
    push: true,
    pull: true,
  },
  maintain: {
    admin: false,
    maintain: true,
    push: true,
    pull: true,
  },
  admin: {
    admin: true,
    maintain: true,
    push: true,
    pull: true,
  },
} satisfies Record<"read" | "write" | "maintain" | "admin", Permissions>

let nextId = 1

const repo = (
  name: string,
  role: keyof typeof rolePermissions,
): GitHubRepo => ({
  id: nextId++,
  name,
  full_name: `acme/${name}`,
  private: true,
  default_branch: "main",
  ssh_url: `git@github.com:acme/${name}.git`,
  html_url: `https://github.com/acme/${name}`,
  permissions: rolePermissions[role],
})

beforeEach(() => {
  nextId = 1
  getOrgRepos.mockReset()
})

afterEach(cleanup)

describe("OrgRepos", () => {
  it("shows write-or-higher repos only for the selected classroom", () => {
    getOrgRepos.mockReturnValue({
      data: [
        repo("cs-a1-writer", "write"),
        repo("cs-a2-maintainer", "maintain"),
        repo("cs-a3-admin", "admin"),
        repo("cs-a4-reader", "read"),
        repo("cs101-a1-sibling", "admin"),
      ],
    })

    render(<OrgRepos org="acme" classroom="cs" />)

    expect(screen.getByRole("heading", { name: "cs-a1-writer" })).toBeTruthy()
    expect(
      screen.getByRole("heading", { name: "cs-a2-maintainer" }),
    ).toBeTruthy()
    expect(screen.getByRole("heading", { name: "cs-a3-admin" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "cs-a4-reader" })).toBeNull()
    expect(
      screen.queryByRole("heading", { name: "cs101-a1-sibling" }),
    ).toBeNull()
  })

  it("lists the newest repo first even though the listing arrives oldest first", () => {
    getOrgRepos.mockReturnValue({
      data: [
        { ...repo("cs-a1-first", "write"), created_at: "2026-01-01T00:00:00Z" },
        {
          ...repo("cs-a2-second", "write"),
          created_at: "2026-02-01T00:00:00Z",
        },
        { ...repo("cs-a3-third", "write"), created_at: "2026-03-01T00:00:00Z" },
      ],
    })

    render(<OrgRepos org="acme" classroom="cs" />)

    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["cs-a3-third", "cs-a2-second", "cs-a1-first"])
  })
})
