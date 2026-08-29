// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Match on stable i18n keys rather than English copy.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

// The form reads the org from the route and the existing classrooms from a
// GitHub query; both are irrelevant to the slug-validation logic under test, so
// stub them. `mockClasses` lets each test control the taken-slug set.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useParams: () => ({ org: "cs50" }),
  }
})

let mockClasses: { name: string; path: string; type: string }[] = []
vi.mock("@/hooks/useGetClasses", () => ({
  default: () => ({ classes: mockClasses, isLoading: false }),
}))

import CreateClassroomForm from "./CreateClassroomForm"

afterEach(() => {
  cleanup()
  mockClasses = []
})

const slugInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>("#slug")!
const submit = () =>
  screen.getByRole("button", { name: "classes.form.createButton" })

describe("CreateClassroomForm slug validation", () => {
  it("opts out of browser-native validation so the app validator runs", async () => {
    // Without noValidate the `required` inputs fire native bubbles on an
    // empty submit and the TanStack submit validator never runs (Primer:
    // never use browser-native validation UI).
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const { container } = render(<CreateClassroomForm onSubmit={onSubmit} />)

    const form = container.querySelector("form")!
    expect(form.noValidate).toBe(true)

    // An empty submit reaches the app validator: blocked with app copy.
    await user.click(submit())
    expect(onSubmit).not.toHaveBeenCalled()
    expect((await screen.findAllByText(/validation\./)).length).toBeGreaterThan(
      0,
    )
  })

  it("rejects a slug over the 100-char cap and does not submit", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const { container } = render(<CreateClassroomForm onSubmit={onSubmit} />)

    await user.type(
      container.querySelector<HTMLInputElement>("#name")!,
      "Class",
    )
    // Overwrite the auto-derived slug with a 101-char value.
    await user.clear(slugInput(container))
    await user.type(slugInput(container), "a".repeat(101))
    await user.click(submit())

    expect(onSubmit).not.toHaveBeenCalled()
    expect(
      await screen.findByText("validation.classroomSlugInvalid"),
    ).not.toBeNull()
  })

  // Creation-time budget cap (#691): a pattern-valid slug past 40 chars is
  // rejected — it prefixes every student repo name in the classroom.
  it("rejects a slug over the 40-char creation cap and does not submit", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const { container } = render(<CreateClassroomForm onSubmit={onSubmit} />)

    await user.type(
      container.querySelector<HTMLInputElement>("#name")!,
      "Class",
    )
    await user.clear(slugInput(container))
    await user.type(slugInput(container), "a".repeat(41))
    await user.click(submit())

    expect(onSubmit).not.toHaveBeenCalled()
    expect(
      await screen.findByText("validation.classroomSlugTooLong"),
    ).not.toBeNull()
  })

  // The cap warning is live: it shows while typing a manual override, before
  // any submit, and clears once the slug is back within the cap.
  it("warns live when a manual slug exceeds the creation cap", async () => {
    const user = userEvent.setup()
    const { container } = render(<CreateClassroomForm onSubmit={vi.fn()} />)

    await user.click(slugInput(container))
    await user.paste("a".repeat(41))
    expect(screen.getByText("validation.classroomSlugTooLong")).not.toBeNull()

    await user.type(slugInput(container), "{backspace}")
    expect(screen.queryByText("validation.classroomSlugTooLong")).toBeNull()
  })

  // Collisions warn live too, comparing the SLUGIFIED value case-insensitively
  // against existing classrooms.
  it("warns live when a manual slug collides with an existing classroom", async () => {
    mockClasses = [{ name: "cs-50", path: "cs-50", type: "dir" }]
    const user = userEvent.setup()
    const { container } = render(<CreateClassroomForm onSubmit={vi.fn()} />)

    await user.click(slugInput(container))
    await user.paste("CS 50")
    expect(screen.getByText("validation.classroomSlugTaken")).not.toBeNull()

    await user.type(slugInput(container), "x")
    expect(screen.queryByText("validation.classroomSlugTaken")).toBeNull()
  })

  // Regression guard: the collision check must compare the SLUGIFIED value, not
  // the raw input. A raw "CS 50" slugifies to "cs-50"; if the check compared the
  // raw string it would miss an existing "cs-50" and overwrite its roster/scores.
  it("flags a raw input that slugifies onto an existing classroom as taken", async () => {
    mockClasses = [{ name: "cs-50", path: "cs-50", type: "dir" }]
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const { container } = render(<CreateClassroomForm onSubmit={onSubmit} />)

    // Type a name (auto-derives a slug), then overwrite the slug with a raw
    // value that slugifies onto the existing "cs-50".
    await user.type(
      container.querySelector<HTMLInputElement>("#name")!,
      "Class",
    )
    await user.clear(slugInput(container))
    await user.type(slugInput(container), "CS 50")
    await user.click(submit())

    expect(onSubmit).not.toHaveBeenCalled()
    expect(
      await screen.findByText("validation.classroomSlugTaken"),
    ).not.toBeNull()
  })

  it("submits the slugified value for a valid, non-colliding slug", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<CreateClassroomForm onSubmit={onSubmit} />)

    await user.type(
      container.querySelector<HTMLInputElement>("#name")!,
      "Intro CS",
    )
    await user.click(submit())

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].slug).toBe("intro-cs")
  })

  // The auto-derived slug is pre-fixed rather than left to fail at submit:
  // trimmed to the 40-char creation cap and suffixed past existing classrooms.
  it("auto-derives a slug trimmed to the creation cap", async () => {
    const user = userEvent.setup()
    const { container } = render(<CreateClassroomForm onSubmit={vi.fn()} />)

    await user.type(
      container.querySelector<HTMLInputElement>("#name")!,
      "Introduction to Computer Science and Programming",
    )
    const derived = slugInput(container).value
    expect(derived.length).toBeLessThanOrEqual(40)
    expect(derived).toBe("introduction-to-computer-science-and-pro")
  })

  it("auto-derives a suffixed slug when the name collides with an existing classroom", async () => {
    mockClasses = [{ name: "intro-cs", path: "intro-cs", type: "dir" }]
    const user = userEvent.setup()
    const { container } = render(<CreateClassroomForm onSubmit={vi.fn()} />)

    await user.type(
      container.querySelector<HTMLInputElement>("#name")!,
      "Intro CS",
    )
    expect(slugInput(container).value).toBe("intro-cs-2")
  })
})
