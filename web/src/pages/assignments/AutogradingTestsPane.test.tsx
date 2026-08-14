// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Match on stable i18n keys rather than English copy; keep the rest of
// react-i18next real so transitive setup still loads.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
    Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  }
})

import AutogradingTestsPane, { draftsEqual } from "./AutogradingTestsPane"
import { useAssignmentForm } from "./assignmentFormModel"
import { emptyTestDraft } from "@/util/assignmentTests"

afterEach(cleanup)

// happy-dom lacks the native <dialog> showModal/close; stub them so the pane's
// imperative open/close doesn't throw.
beforeAll(() => {
  const proto = globalThis.HTMLDialogElement?.prototype
  if (!proto) return
  proto.showModal = function (this: HTMLDialogElement) {
    this.open = true
  }
  proto.close = function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event("close"))
  }
})

// A live form is required for the pane (it reads/writes form.tests). Build one
// with the real useAssignmentForm so commit routing exercises the actual
// TanStack array API, then expose the form instance for assertions.
const Harness = ({
  onForm,
}: {
  onForm: (form: ReturnType<typeof useAssignmentForm>) => void
}) => {
  const form = useAssignmentForm(
    undefined,
    () => {},
    ((k: string) => k) as never,
  )
  onForm(form)
  return <AutogradingTestsPane form={form} />
}

const renderPane = () => {
  let form!: ReturnType<typeof useAssignmentForm>
  render(<Harness onForm={(f) => (form = f)} />)
  return () => form.state.values.tests
}

describe("draftsEqual", () => {
  it("is true for two fresh empty drafts", () => {
    expect(draftsEqual(emptyTestDraft(), emptyTestDraft())).toBe(true)
  })

  it("is false when any single field differs", () => {
    expect(
      draftsEqual(emptyTestDraft(), { ...emptyTestDraft(), name: "x" }),
    ).toBe(false)
    expect(
      draftsEqual(emptyTestDraft(), { ...emptyTestDraft(), points: 5 }),
    ).toBe(false)
    expect(
      draftsEqual(emptyTestDraft(), { ...emptyTestDraft(), type: "run" }),
    ).toBe(false)
  })

  it("is true for equal-but-distinct objects", () => {
    const a = emptyTestDraft()
    const b = { ...a }
    expect(draftsEqual(a, b)).toBe(true)
  })
})

describe("AutogradingTestsPane editor commit gating", () => {
  const openEditor = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByText("assignments.autograder.addTest"))
  }

  // The list collapses by default when there are no tests, so a test asserting
  // on the table's contents has to open it first.
  const expandList = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByText("assignments.autograder.heading"))
  }

  // The commit button lives in the modal's `.modal-action` footer; the pane's
  // own "Add test" button shares its label, so scope the lookup to the footer.
  const commitButton = () => {
    const action = document.querySelector(".modal-action")
    if (!action) throw new Error("modal not open")
    const buttons = Array.from(action.querySelectorAll("button"))
    const commit = buttons.find(
      (b) =>
        b.textContent === "assignments.autograder.addTest" ||
        b.textContent === "common.save",
    )
    if (!commit) throw new Error("commit button not found")
    return commit as HTMLButtonElement
  }

  it("clicking Add test does not create an entry until commit", async () => {
    const user = userEvent.setup()
    const tests = renderPane()

    await expandList(user)
    expect(screen.getByText("assignments.autograder.empty")).toBeTruthy()
    await openEditor(user)

    // Editor is open, but nothing committed yet.
    expect(tests()).toHaveLength(0)
    expect(screen.getByText("assignments.autograder.empty")).toBeTruthy()
  })

  it("starts collapsed with no tests and auto-expands on a committed test", async () => {
    const user = userEvent.setup()
    const tests = renderPane()

    // Collapsed: the table (and its empty state) isn't rendered, but the
    // summary line still reports what's configured.
    expect(screen.queryByText("assignments.autograder.empty")).toBeNull()
    expect(screen.getByText("assignments.autograder.summary")).toBeTruthy()

    await openEditor(user)
    await user.type(
      screen.getByLabelText("assignments.autograder.testName"),
      "Prints hello",
    )
    await user.type(
      screen.getByLabelText("assignments.autograder.runCommand"),
      "./hello",
    )
    await user.type(
      screen.getByLabelText("assignments.autograder.expectedOutput"),
      "hello",
    )
    await user.click(commitButton())

    // The committed test is visible without a manual expand.
    await waitFor(() => expect(tests()).toHaveLength(1))
    expect(screen.getByText("Prints hello")).toBeTruthy()
  })

  it("Cancel discards the draft, leaving the list empty", async () => {
    const user = userEvent.setup()
    const tests = renderPane()

    await openEditor(user)
    await user.type(
      screen.getByLabelText("assignments.autograder.testName"),
      "Prints hello",
    )
    await user.click(screen.getByText("common.cancel"))

    expect(tests()).toHaveLength(0)
  })

  it("the commit button is disabled until the draft is dirty", async () => {
    const user = userEvent.setup()
    renderPane()
    await openEditor(user)

    const commit = commitButton()
    expect(commit.disabled).toBe(true)

    await user.type(
      screen.getByLabelText("assignments.autograder.testName"),
      "Prints hello",
    )
    expect(commit.disabled).toBe(false)
  })

  it("committing a valid new test appends exactly one entry", async () => {
    const user = userEvent.setup()
    const tests = renderPane()

    await openEditor(user)
    await user.type(
      screen.getByLabelText("assignments.autograder.testName"),
      "Prints hello",
    )
    await user.type(
      screen.getByLabelText("assignments.autograder.runCommand"),
      "./hello",
    )
    // Default io + "included" comparison requires expected output; fill it so
    // the draft passes validateTestDraft on commit.
    await user.type(
      screen.getByLabelText("assignments.autograder.expectedOutput"),
      "hello",
    )
    await user.click(commitButton())

    await waitFor(() => expect(tests()).toHaveLength(1))
    expect(tests()[0]).toMatchObject({ name: "Prints hello", run: "./hello" })
  })

  it("an invalid draft (blank run) surfaces an error and does not commit", async () => {
    const user = userEvent.setup()
    const tests = renderPane()

    await openEditor(user)
    await user.type(
      screen.getByLabelText("assignments.autograder.testName"),
      "Prints hello",
    )
    await user.click(commitButton())

    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0)
    expect(tests()).toHaveLength(0)
  })
})
