// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react"
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
  location,
}: {
  onForm: (form: ReturnType<typeof useAssignmentForm>) => void
  location?: { org: string; classroom: string; slug: string }
}) => {
  const form = useAssignmentForm(
    undefined,
    () => {},
    ((k: string) => k) as never,
  )
  onForm(form)
  return <AutogradingTestsPane form={form} {...location} />
}

const renderPane = (location?: {
  org: string
  classroom: string
  slug: string
}) => {
  let form!: ReturnType<typeof useAssignmentForm>
  render(<Harness onForm={(f) => (form = f)} location={location} />)
  return () => form.state.values.tests
}

describe("AutogradingTestsPane teacher-only files modal", () => {
  const openModal = async () => {
    await userEvent
      .setup()
      .click(screen.getByText("assignments.autograder.teacherFiles.button"))
  }

  it("links to GitHub's upload page for the bundle folder in edit mode", async () => {
    renderPane({ org: "acme", classroom: "cs50", slug: "hello" })
    await openModal()
    const link = await screen.findByText(
      "assignments.autograder.teacherFiles.openUpload",
    )
    const anchor = link.closest("a")
    expect(anchor?.getAttribute("href")).toBe(
      "https://github.com/acme/classroom50/upload/main/cs50/autograders/hello",
    )
    expect(anchor?.getAttribute("target")).toBe("_blank")
    expect(
      screen.getByText("assignments.autograder.teacherFiles.howTo"),
    ).toBeTruthy()
  })

  it("only asks the teacher to create the assignment first when it isn't saved", async () => {
    renderPane({ org: "acme", classroom: "cs50", slug: "" })
    await openModal()
    expect(
      await screen.findByText("assignments.autograder.teacherFiles.unsaved"),
    ).toBeTruthy()
    // None of the guide is actionable yet, so none of it renders.
    expect(
      screen.queryByText("assignments.autograder.teacherFiles.openUpload"),
    ).toBeNull()
    expect(
      screen.queryByText("assignments.autograder.teacherFiles.howTo"),
    ).toBeNull()
    expect(
      screen.queryByText("assignments.autograder.teacherFiles.readableTitle"),
    ).toBeNull()
  })
})

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
  // own "Add test" button shares its label, so scope the lookup to the footer
  // of the open dialog (the teacher-files modal stays mounted while closed).
  const commitButton = () => {
    const action = document.querySelector("dialog[open] .modal-action")
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

    // Field errors are describedby text, not live regions (Primer) — assert
    // the error copy renders.
    expect(screen.getByText("Run command is required.")).toBeTruthy()
    expect(tests()).toHaveLength(0)
  })
})

describe("AutogradingTestsPane number fields (#1002)", () => {
  const openEditor = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByText("assignments.autograder.addTest"))
  }
  const pointsInput = () =>
    screen.getByLabelText("assignments.autograder.points") as HTMLInputElement

  it("an emptied points field stays empty instead of snapping to 0", async () => {
    const user = userEvent.setup()
    renderPane()
    await openEditor(user)

    const input = pointsInput()
    expect(input.value).toBe("10")
    // Select-all + Backspace: the browser reports "" and the model must not
    // become 0, or React writes "0" back and the next digit renders as "05".
    fireEvent.change(input, { target: { value: "" } })
    expect(input.value).toBe("")

    fireEvent.change(input, { target: { value: "5" } })
    expect(input.value).toBe("5")
  })

  it("a half-typed entry the browser reports as badInput is left alone", async () => {
    const user = userEvent.setup()
    renderPane()
    await openEditor(user)

    const input = pointsInput()
    // Firefox lets "12a" through and Chrome lets "1e" through; both read "" with
    // validity.badInput set. Coercing that to 0 clobbered the user's text.
    Object.defineProperty(input, "validity", {
      value: { badInput: true, valid: false },
      configurable: true,
    })
    fireEvent.change(input, { target: { value: "" } })
    expect(input.value).toBe("")
  })

  it("a half-typed exit code is kept as invalid rather than dropped as unset", async () => {
    const user = userEvent.setup()
    renderPane()
    await openEditor(user)

    await user.click(
      screen.getByLabelText("assignments.autograder.type.run.label"),
    )
    await user.type(
      screen.getByLabelText("assignments.autograder.testName"),
      "Exits",
    )
    await user.type(
      screen.getByLabelText("assignments.autograder.runCommand"),
      "./run",
    )
    const exitCode = screen.getByLabelText(
      "assignments.autograder.exitCode",
    ) as HTMLInputElement
    fireEvent.change(exitCode, { target: { value: "1" } })
    // Chrome: "1e" reads "" with badInput set (a React change fires because
    // the value moved off "1").
    Object.defineProperty(exitCode, "validity", {
      value: { badInput: true, valid: false },
      configurable: true,
    })
    fireEvent.change(exitCode, { target: { value: "" } })

    // Storing "" (unset) would have let the commit through silently; the
    // partial entry must surface as a validation error instead.
    const action = document.querySelector("dialog[open] .modal-action")
    const commit = Array.from(action?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "assignments.autograder.addTest",
    )
    if (!commit) throw new Error("commit button not found")
    await user.click(commit)
    expect(
      screen.getByText("Exit code must be a whole number between 0 and 255."),
    ).toBeTruthy()
  })

  it("an emptied timeout snaps back to 0 (runner default) on blur", async () => {
    const user = userEvent.setup()
    renderPane()
    await openEditor(user)

    const input = screen.getByLabelText(
      "assignments.autograder.timeout",
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: "" } })
    expect(input.value).toBe("")
    fireEvent.blur(input)
    expect(input.value).toBe("0")
  })
})

describe("AutogradingTestsPane Enter handling (#1003)", () => {
  const fillValidDraft = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByText("assignments.autograder.addTest"))
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
  }

  it("Enter commits from a text input, but not while an IME is composing", async () => {
    const user = userEvent.setup()
    const tests = renderPane()
    await fillValidDraft(user)
    const name = screen.getByLabelText("assignments.autograder.testName")

    fireEvent.keyDown(name, { key: "Enter", isComposing: true })
    expect(tests()).toHaveLength(0)

    fireEvent.keyDown(name, { key: "Enter" })
    await waitFor(() => expect(tests()).toHaveLength(1))
  })

  it("Enter on a select or radio keeps its native meaning", async () => {
    const user = userEvent.setup()
    const tests = renderPane()
    await fillValidDraft(user)

    fireEvent.keyDown(
      screen.getByLabelText("assignments.autograder.comparison"),
      { key: "Enter" },
    )
    fireEvent.keyDown(
      screen.getByLabelText("assignments.autograder.type.io.label"),
      { key: "Enter" },
    )
    expect(tests()).toHaveLength(0)
  })
})
