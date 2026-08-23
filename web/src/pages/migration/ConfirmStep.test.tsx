// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && "selected" in opts && "total" in opts)
          return `${key}:${String(opts.selected)}/${String(opts.total)}`
        if (opts && "count" in opts) return `${key}:${String(opts.count)}`
        return key
      },
    }),
    Trans: ({ i18nKey }: { i18nKey?: string }) => <>{i18nKey}</>,
  }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { children?: React.ReactNode }) => (
      <span>{children}</span>
    ),
  }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

vi.mock("@/hooks/useGitHubResources", () => ({
  useGitHubViewer: () => ({ data: { login: "teacher" } }),
}))

const mutate = vi.fn()
vi.mock("@/hooks/mutations/useMigrateClassroom", () => ({
  useMigrateClassroom: () => ({
    mutate,
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
  }),
}))

const buildPreflight = vi.fn()
vi.mock("@/migration/preflight", () => ({
  buildPreflight: (...args: unknown[]) => buildPreflight(...args),
}))

import { ConfirmStep } from "./ConfirmStep"
import type {
  ClassroomAssignmentDetail,
  ClassroomWithOrg,
  MigrationPreflight,
} from "@/migration/types"

afterEach(cleanup)

function assignment(
  id: number,
  slug: string,
  title: string,
): ClassroomAssignmentDetail {
  return {
    id,
    public_repo: false,
    title,
    type: "individual",
    invite_link: `https://classroom.github.com/a/${slug}`,
    slug,
    deadline: null,
    max_teams: null,
    starter_code_repository: {
      id: id * 10,
      name: slug,
      full_name: `acme/${slug}`,
      private: true,
      default_branch: "main",
    },
  }
}

const plan: MigrationPreflight = {
  classroom: {
    id: 7,
    name: "CS 101",
    archived: false,
    url: "https://classroom.github.com/classrooms/7",
    organization: { id: 1, login: "acme" },
  },
  targetOrg: "acme",
  name: "CS 101",
  shortName: "cs101",
  term: "",
  templateSuffix: "",
  items: [
    {
      assignment: assignment(1, "hw1", "HW One"),
      action: "import",
      targetName: "hw1",
    },
    {
      assignment: assignment(2, "hw2", "HW Two"),
      action: "import",
      targetName: "hw2",
    },
    {
      assignment: assignment(3, "hw3", "HW Three"),
      action: "skip",
      reason: {
        key: "migration.reason.sourceNotTemplate",
        params: { fullName: "acme/hw3" },
      },
      targetName: "hw3",
    },
  ],
  counts: { import: 2, reuse: 0, skip: 1 },
  blockers: [],
}

const source: ClassroomWithOrg = {
  id: 7,
  name: "CS 101",
  archived: false,
  url: "https://classroom.github.com/classrooms/7",
  orgLogin: "acme",
}

async function renderConfirmStep() {
  buildPreflight.mockResolvedValue(plan)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ConfirmStep
        source={source}
        targetOrg="acme"
        onBack={() => {}}
        onComplete={() => {}}
      />
    </QueryClientProvider>,
  )
  await screen.findByText("HW One")
}

// Item checkboxes carry no aria-label; the select-all one does.
function itemCheckboxes(): HTMLInputElement[] {
  return screen
    .getAllByRole("checkbox")
    .filter((el) => !el.getAttribute("aria-label")) as HTMLInputElement[]
}

describe("ConfirmStep selection", () => {
  it("keeps the checkbox after unchecking so a deselection is reversible (regression: it became a static Will-skip badge)", async () => {
    const user = userEvent.setup()
    await renderConfirmStep()

    expect(
      screen.getByText("migration.confirm.selectedOfTotal:2/2"),
    ).toBeTruthy()
    // The plan-skip item renders a badge, not a checkbox.
    expect(itemCheckboxes()).toHaveLength(2)

    await user.click(itemCheckboxes()[0])
    // Still two checkboxes: the unchecked item keeps its toggle.
    expect(itemCheckboxes()).toHaveLength(2)
    expect(itemCheckboxes()[0].checked).toBe(false)
    expect(
      screen.getByText("migration.confirm.selectedOfTotal:1/2"),
    ).toBeTruthy()
    expect(screen.getByText("migration.confirm.importButton:1")).toBeTruthy()

    await user.click(itemCheckboxes()[0])
    expect(itemCheckboxes()[0].checked).toBe(true)
    expect(
      screen.getByText("migration.confirm.selectedOfTotal:2/2"),
    ).toBeTruthy()
    expect(screen.getByText("migration.confirm.importButton:2")).toBeTruthy()
  })

  it("select-all toggles every selectable item and updates the summary", async () => {
    const user = userEvent.setup()
    await renderConfirmStep()

    const selectAll = screen.getByRole("checkbox", {
      name: "migration.confirm.selectAll",
    })
    expect((selectAll as HTMLInputElement).checked).toBe(true)

    await user.click(selectAll)
    await waitFor(() =>
      expect(
        screen.getByText("migration.confirm.selectedOfTotal:0/2"),
      ).toBeTruthy(),
    )
    expect(itemCheckboxes().every((el) => !el.checked)).toBe(true)
    // Nothing selected -> the info alert appears.
    expect(screen.getByText("migration.confirm.noneSelected")).toBeTruthy()

    await user.click(selectAll)
    await waitFor(() =>
      expect(
        screen.getByText("migration.confirm.selectedOfTotal:2/2"),
      ).toBeTruthy(),
    )
    expect(itemCheckboxes().every((el) => el.checked)).toBe(true)
  })
})
