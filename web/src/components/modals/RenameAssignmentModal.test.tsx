// @vitest-environment happy-dom
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const mutateAsync = vi.fn()
vi.mock("@/hooks/mutations/useRenameAssignment", () => ({
  default: () => ({ mutateAsync, isPending: false, progress: null }),
  useRenameAssignment: () => ({
    mutateAsync,
    isPending: false,
    progress: null,
  }),
}))

const orgRepos = [
  { name: "cs-" + "x".repeat(60) + "-alice", default_branch: "main" },
  { name: "cs-" + "x".repeat(60) + "-bob", default_branch: "main" },
  { name: "cs-other-carol", default_branch: "main" },
]
vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: () => ({ data: orgRepos }),
  useGetOrgRepos: () => ({ data: orgRepos }),
}))

import { RenameAssignmentModal } from "./RenameAssignmentModal"
import type { Assignment } from "@/types/classroom"
import type { RenameAssignmentSummary } from "@/domain/assignments"

// Over budget in classroom "cs": 2 + 60 = 62 > 59.
const OLD = "x".repeat(60)
const overBudget = {
  slug: OLD,
  name: "Homework",
  mode: "individual",
  autograder: "default",
} as Assignment

const assignments: Assignment[] = [
  overBudget,
  { slug: "taken", name: "T", mode: "individual" } as Assignment,
  {
    slug: "renamed",
    name: "R",
    mode: "individual",
    renamed_from: "reserved-old",
  } as Assignment,
]

const summaryOk: RenameAssignmentSummary = {
  mode: "fresh",
  results: [
    { repo: `cs-${OLD}-alice`, newName: "cs-ps3-alice", outcome: "renamed" },
    {
      repo: `cs-${OLD}-bob`,
      newName: "cs-ps3-bob",
      outcome: "skippedForeign",
      reason: { key: "assignments.rename.reason.foreignMarker" },
    },
  ],
  failed: 0,
  lockReleased: true,
  lockRestoreFailed: false,
  prevLocked: false,
}

afterEach(() => {
  cleanup()
  mutateAsync.mockReset()
})

function renderModal(
  over?: Partial<Parameters<typeof RenameAssignmentModal>[0]>,
) {
  return render(
    <RenameAssignmentModal
      open
      onClose={() => {}}
      org="o"
      classroom="cs"
      assignment={overBudget}
      assignments={assignments}
      mode="fresh"
      {...over}
    />,
  )
}

const slugInput = () =>
  screen.getByLabelText("assignments.rename.newSlugLabel", {
    exact: false,
  }) as HTMLInputElement

describe("RenameAssignmentModal (fresh)", () => {
  it("shows the repo count and validates the new slug live", () => {
    renderModal()
    // Two repos share the old-slug prefix; the sibling-classroom repo doesn't.
    expect(screen.getByText("assignments.rename.repoCount")).toBeTruthy()

    const apply = screen.getByRole("button", {
      name: "assignments.rename.apply",
    }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)

    fireEvent.change(slugInput(), { target: { value: "y".repeat(58) } })
    expect(
      screen.getByText("assignments.form.validation.slugOverBudget"),
    ).toBeTruthy()
    expect(apply.disabled).toBe(true)

    fireEvent.change(slugInput(), { target: { value: "taken" } })
    expect(
      screen.getByText("components.modals.reuseShell.slug.taken"),
    ).toBeTruthy()

    fireEvent.change(slugInput(), { target: { value: "reserved-old" } })
    expect(
      screen.getByText("assignments.form.validation.slugReserved"),
    ).toBeTruthy()

    fireEvent.change(slugInput(), { target: { value: OLD } })
    // The old slug is itself over budget (that's why the rename is offered),
    // so re-typing it hits the budget error — the domain still hard-rejects
    // a same-slug rename as a backstop.
    expect(
      screen.getAllByText("assignments.form.validation.slugOverBudget").length,
    ).toBeGreaterThan(0)

    fireEvent.change(slugInput(), { target: { value: "ps3" } })
    expect(apply.disabled).toBe(false)
  })

  it("runs the rename and reports per-repo outcomes", async () => {
    mutateAsync.mockResolvedValue(summaryOk)
    renderModal()
    fireEvent.change(slugInput(), { target: { value: "ps3" } })
    fireEvent.click(
      screen.getByRole("button", { name: "assignments.rename.apply" }),
    )

    await waitFor(() =>
      expect(
        screen.getByText("assignments.rename.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(mutateAsync).toHaveBeenCalledWith({
      org: "o",
      classroom: "cs",
      oldSlug: OLD,
      newSlug: "ps3",
    })
    // The sibling skip is reported with its resolved reason.
    expect(screen.getByText("assignments.rename.skippedSection")).toBeTruthy()
    expect(
      screen.getByText("assignments.rename.reason.foreignMarker"),
    ).toBeTruthy()
    // Everything landed: no stays-locked note, no finish affordance.
    expect(screen.queryByText("assignments.rename.lockNote")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "assignments.rename.finishApply" }),
    ).toBeNull()
  })

  it("offers 'finish rename' and the stays-locked note when repos failed", async () => {
    mutateAsync.mockResolvedValue({
      ...summaryOk,
      results: [
        {
          repo: `cs-${OLD}-alice`,
          newName: "cs-ps3-alice",
          outcome: "failed",
          reason: { key: "assignments.rename.reason.renameConflict" },
        },
      ],
      failed: 1,
      lockReleased: false,
    })
    renderModal()
    fireEvent.change(slugInput(), { target: { value: "ps3" } })
    fireEvent.click(
      screen.getByRole("button", { name: "assignments.rename.apply" }),
    )

    await waitFor(() =>
      expect(screen.getByText("assignments.rename.failedSection")).toBeTruthy(),
    )
    expect(screen.getByText("assignments.rename.lockNote")).toBeTruthy()
    const finishButton = screen.getByRole("button", {
      name: "assignments.rename.finishApply",
    })
    // "Finish rename" re-runs the idempotent heal with the same input.
    mutateAsync.mockClear()
    fireEvent.click(finishButton)
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({
      org: "o",
      classroom: "cs",
      oldSlug: OLD,
      newSlug: "ps3",
    })
  })

  it("surfaces a preflight error without a result report", async () => {
    mutateAsync.mockRejectedValue(
      new Error("assignments.rename.error.slugTaken"),
    )
    renderModal()
    fireEvent.change(slugInput(), { target: { value: "ps3" } })
    fireEvent.click(
      screen.getByRole("button", { name: "assignments.rename.apply" }),
    )
    await waitFor(() =>
      expect(
        screen.getByText("assignments.rename.error.slugTaken", {
          exact: false,
        }),
      ).toBeTruthy(),
    )
    expect(screen.queryByText("assignments.rename.resultHeadline")).toBeNull()
  })
})

describe("RenameAssignmentModal (finish)", () => {
  it("skips the slug input and heals with old/new derived from the entry", async () => {
    mutateAsync.mockResolvedValue({
      ...summaryOk,
      mode: "resume",
      results: [
        {
          repo: "cs-ps3-alice",
          newName: "cs-ps3-alice",
          outcome: "markerHealed",
        },
      ],
    })
    render(
      <RenameAssignmentModal
        open
        onClose={() => {}}
        org="o"
        classroom="cs"
        assignment={
          {
            slug: "ps3",
            name: "Homework",
            mode: "individual",
            renamed_from: OLD,
            locked: true,
          } as Assignment
        }
        assignments={assignments}
        mode="finish"
      />,
    )
    expect(
      screen.queryByLabelText("assignments.rename.newSlugLabel", {
        exact: false,
      }),
    ).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "assignments.rename.finishApply" }),
    )
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({
      org: "o",
      classroom: "cs",
      oldSlug: OLD,
      newSlug: "ps3",
    })
    await waitFor(() =>
      expect(
        screen.getByText("assignments.rename.finishHeadline"),
      ).toBeTruthy(),
    )
    // Resume never guesses the original lock state; the unlock hint shows.
    expect(screen.getByText("assignments.rename.resumeUnlockNote")).toBeTruthy()
  })
})
