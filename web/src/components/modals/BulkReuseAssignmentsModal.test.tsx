// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock("@/hooks/useGetClasses", () => {
  const classes = [{ name: "cs101" }, { name: "cs102" }]
  const hook = () => ({ classes, isLoading: false })
  return { default: hook, useGetClasses: hook }
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
const { run, reuseState } = vi.hoisted(() => ({
  run: vi.fn(),
  reuseState: {
    running: false,
    processed: 0,
    total: 0,
    outcomes: [] as { slug: string; targetSlug?: string; error?: string }[],
  },
}))
vi.mock("@/hooks/mutations/useBulkAssignmentActions", () => ({
  useBulkReuseAssignments: () => ({ ...reuseState, run }),
}))

import { BulkReuseAssignmentsModal } from "./BulkReuseAssignmentsModal"
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
      onClose={onClose}
    />,
  )
  return {
    onClose,
    // The shell's left footer button: "Cancel" while idle, "Done" once the run
    // has something to acknowledge.
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
})

describe("BulkReuseAssignmentsModal", () => {
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
    // Merely visiting hw2's field must not freeze its auto slug — hw1 taking
    // "hw2" below has to push hw2 along, not collide with it.
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

  it("normalizes a typed slug on blur", () => {
    const { pickTarget, slugInputs } = setup()
    pickTarget()
    fireEvent.change(slugInputs()[1], { target: { value: "Hausaufgabe Zwei" } })
    fireEvent.blur(slugInputs()[1])
    expect(slugInputs()[1].value).toBe("hausaufgabe-zwei")
  })
})
