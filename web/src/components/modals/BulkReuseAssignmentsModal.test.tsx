// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock("@/hooks/useGetClasses", () => {
  const classes = [
    { name: "cs101", path: "cs101" },
    { name: "cs102", path: "cs102" },
  ]
  const hook = () => ({ classes, isLoading: false })
  return { default: hook, useGetClasses: hook }
})

// classroom.json names for the picker; cs102 has none, so its slug shows.
vi.mock("@/hooks/useClassroomSummaries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useClassroomSummaries")>()
  const names: Record<string, string> = { cs101: "Intro to CS" }
  const hook = (_org: string, dirs: { path: string }[]) =>
    dirs.map((d) => ({
      path: d.path,
      name: names[d.path],
      archived: false,
      loading: false,
    }))
  return { ...actual, default: hook, useClassroomSummaries: hook }
})

vi.mock("@/hooks/useGetClassAssignments", () => {
  // hw1 is already an assignment in the target classroom.
  const query = () => ({
    data: { assignments: [{ slug: "hw1", name: "Homework 1" }] },
    isLoading: false,
    isError: false,
  })
  return { default: query, useGetClassroomAssignments: query }
})

// Mutable so a test can hand the modal a finished run's outcomes.
const run = vi.fn()
const reset = vi.fn()
const reuseState = {
  running: false,
  processed: 0,
  total: 0,
  outcomes: [] as {
    slug: string
    targetSlug?: string
    error?: string
    deferred?: boolean
  }[],
}

import { BulkReuseAssignmentsModal } from "./BulkReuseAssignmentsModal"
import type { BulkReuseRun } from "@/hooks/mutations/useBulkAssignmentActions"
import type { Assignment } from "@/types/classroom"

const sources = [
  { slug: "hw1", name: "Homework 1" },
  { slug: "hw2", name: "Homework 2" },
] as Assignment[]

const setup = (onClose = vi.fn()) => {
  render(
    <BulkReuseAssignmentsModal
      org="acme"
      sources={sources}
      reuse={{ ...reuseState, run, reset } as unknown as BulkReuseRun}
      onClose={onClose}
    />,
  )
  return {
    onClose,
    // The shell's footer: "Cancel" while idle, "Done" once finished.
    dismiss: () =>
      screen.getByRole("button", { name: /common\.(cancel|done)/ }),
    pickTarget: () =>
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "cs101" },
      }),
    slugInputs: () => screen.queryAllByRole("textbox") as HTMLInputElement[],
    submit: () =>
      screen.getByRole("button", {
        name: /components.modals.reuseShell.reuseAssignment/,
      }),
  }
}

afterEach(() => {
  cleanup()
  run.mockReset()
  reuseState.outcomes = []
  reuseState.running = false
  reuseState.processed = 0
  reuseState.total = 0
})

describe("BulkReuseAssignmentsModal", () => {
  it("lists targets by display name, slug only where there is none", () => {
    setup()
    const labels = screen
      .getAllByRole("option")
      .map((o) => o.textContent)
      .filter((l) => l !== "components.modals.reuseAssignment.chooseClassroom")
    expect(labels).toEqual(["Intro to CS", "cs102"])
  })

  it("shows no slug fields until a target is chosen", () => {
    const { slugInputs, pickTarget } = setup()
    expect(slugInputs()).toHaveLength(0)
    pickTarget()
    expect(slugInputs()).toHaveLength(2)
  })

  it("prefills each field with the slug the copy would take", () => {
    const { pickTarget, slugInputs } = setup()
    pickTarget()
    // hw1 is taken in cs101, hw2 is free.
    expect(slugInputs().map((i) => i.value)).toEqual(["hw1-2", "hw2"])
  })

  it("copies under the slugs shown in the form", () => {
    const { pickTarget, slugInputs, submit } = setup()
    pickTarget()
    fireEvent.change(slugInputs()[1], { target: { value: "hw2-neu" } })
    fireEvent.click(submit())
    expect(run).toHaveBeenCalledWith(
      [
        { source: sources[0], targetSlug: "hw1-2" },
        { source: sources[1], targetSlug: "hw2-neu" },
      ],
      "cs101",
    )
  })

  it("blocks the run while a slug collides with the target", () => {
    const { pickTarget, slugInputs, submit } = setup()
    pickTarget()
    fireEvent.change(slugInputs()[0], { target: { value: "hw1" } })
    expect(submit()).toHaveProperty("disabled", true)
    expect(
      screen.getByText("components.modals.reuseShell.slug.taken"),
    ).toBeTruthy()
  })

  it("blocks the run while two copies claim the same slug", () => {
    const { pickTarget, slugInputs, submit } = setup()
    pickTarget()
    fireEvent.change(slugInputs()[1], { target: { value: "hw1-2" } })
    expect(submit()).toHaveProperty("disabled", true)
    expect(screen.getByText("assignments.bulk.reuseSlugDuplicate")).toBeTruthy()
  })

  it("leaves an untouched row free to re-resolve after a blur", () => {
    const { pickTarget, slugInputs, submit } = setup()
    pickTarget()
    // Blurring hw2's untouched field must not freeze its auto slug: hw1 taking
    // "hw2" below has to push hw2 along.
    fireEvent.blur(slugInputs()[1])
    fireEvent.change(slugInputs()[0], { target: { value: "hw2" } })
    expect(slugInputs().map((i) => i.value)).toEqual(["hw2", "hw2-2"])
    expect(submit()).toHaveProperty("disabled", false)
  })

  it("reports dismissal without asking the caller to clear anything", () => {
    reuseState.outcomes = [{ slug: "hw1", targetSlug: "hw1-2" }]
    const { dismiss, onClose } = setup()
    fireEvent.click(dismiss())
    expect(onClose).toHaveBeenCalledWith()
  })

  it("shows the shared progress block while copying", () => {
    reuseState.running = true
    reuseState.processed = 1
    reuseState.total = 3
    const { pickTarget } = setup()
    pickTarget()

    expect(screen.getByRole("progressbar")).toBeTruthy()
    expect(screen.getByText(/assignments\.bulk\.reuseProgress/)).toBeTruthy()
  })

  it("normalizes a typed slug on blur", () => {
    const { pickTarget, slugInputs } = setup()
    pickTarget()
    fireEvent.change(slugInputs()[1], { target: { value: "Hausaufgabe Zwei" } })
    fireEvent.blur(slugInputs()[1])
    expect(slugInputs()[1].value).toBe("hausaufgabe-zwei")
  })

  it("lists copies that were not attempted apart from the failures", () => {
    reuseState.outcomes = [
      { slug: "hw1", targetSlug: "hw1" },
      { slug: "hw2", deferred: true },
    ]
    setup()

    expect(screen.getByText("assignments.bulk.reuseDeferredTitle")).toBeTruthy()
    expect(screen.getByText(/assignments\.bulk\.reuseDeferred$/)).toBeTruthy()
    expect(screen.queryByText("assignments.bulk.reuseFailedTitle")).toBeNull()
  })
})
