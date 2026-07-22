// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactElement } from "react"

// Match on stable i18n keys rather than English copy; keep the rest of
// react-i18next real so transitive setup still loads.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

// TemplateField needs a GitHubAuthProvider; it's irrelevant to the due-date
// toggle under test, so stub it out to keep the render provider-free.
vi.mock("./TemplateField", () => ({
  TemplateField: () => null,
}))

import CreateAssignmentForm, {
  assignmentToFormValues,
} from "./CreateAssignmentForm"
import type { CreateAssignmentFormValues } from "./assignmentFormModel"
import { utcIsoToDatetimeLocalValue } from "./formFieldHelpers"
import * as formFieldHelpers from "./formFieldHelpers"
import type { Assignment } from "@/types/classroom"

afterEach(cleanup)

const baseAssignment: Assignment = {
  slug: "hw1",
  name: "Homework 1",
  mode: "individual",
  autograder: "default",
  feedback_pr: true,
}

// #195: the form's due-date default is `utcIsoToDatetimeLocalValue(due)`. These
// tests pin the exact expressions that default is built from — the field default
// lives inside the non-exported useAssignmentForm, so proving the pieces is more
// precise (and far less brittle) than rendering the whole form.
describe("assignment due-date default (issue #195)", () => {
  it("Create mode: an absent stored due yields an empty field, not today+7", () => {
    // Create passes `defaultValues` undefined, so the default reduces to
    // utcIsoToDatetimeLocalValue(undefined). No fallback to a week from now.
    expect(utcIsoToDatetimeLocalValue(undefined)).toBe("")
  })

  it("Edit mode: an assignment with no stored due maps to an empty field", () => {
    const values = assignmentToFormValues(baseAssignment)
    expect(values.due_date).toBe("")
  })

  it("Edit mode: an assignment with a stored due keeps that value", () => {
    const withDue: Assignment = {
      ...baseAssignment,
      due: "2026-09-01T23:59:00Z",
    }
    const values = assignmentToFormValues(withDue)
    // The stored UTC instant round-trips to a local datetime-local string; the
    // exact wall-clock depends on the runner's zone, so assert it's the same
    // conversion the form uses (non-empty and matching the helper) rather than a
    // fixed string.
    expect(values.due_date).toBe(utcIsoToDatetimeLocalValue(withDue.due))
    expect(values.due_date).not.toBe("")
  })

  it("no longer exposes a sevenDaysFromNow prefill helper", () => {
    expect(
      (formFieldHelpers as Record<string, unknown>).sevenDaysFromNow,
    ).toBeUndefined()
  })

  // The "Set a due date" checkbox seeds its checked state from whether a due
  // date is present: an assignment with a stored due opens with the picker
  // shown; a new or no-due assignment opens unchecked (opt-in). This mirrors the
  // Boolean(due_date) seed in CreateAssignmentForm.
  it("derives the due-date checkbox seed from presence of a due value", () => {
    expect(Boolean(assignmentToFormValues(baseAssignment).due_date)).toBe(false)
    const withDue: Assignment = {
      ...baseAssignment,
      due: "2026-09-01T23:59:00Z",
    }
    expect(Boolean(assignmentToFormValues(withDue).due_date)).toBe(true)
  })
})

// End-to-end (rendered) coverage of the opt-in toggle: proves the toggle wiring
// actually drives what the write path receives, not just the helper defaults
// above. The submit-path omit is unit-tested at the mutation layer; these guard
// the form -> onSubmit boundary so a broken toggle can't silently regress #195.
describe("Set a due date toggle (issue #195)", () => {
  const withDue: Partial<Assignment> = {
    ...baseAssignment,
    due: "2026-09-01T23:59:00Z",
  }

  // The Advanced Settings pane mounts RunnerField (a useQuery), so a
  // QueryClient must be in context even though no query fires without an org.
  const renderForm = (ui: ReactElement) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        {ui}
      </QueryClientProvider>,
    )

  it("edit-with-due opens checked and shows the picker", () => {
    const { container } = renderForm(
      <CreateAssignmentForm
        edit
        defaultValues={assignmentToFormValues(withDue as Assignment)}
        onSubmit={() => {}}
      />,
    )
    const toggle =
      container.querySelector<HTMLInputElement>("#due_date-enabled")
    expect(toggle?.checked).toBe(true)
    // The datetime-local picker is revealed with the stored value.
    expect(screen.getByLabelText("assignments.form.dueDate")).not.toBeNull()
  })

  it("create opens unchecked with no picker (opt-in)", () => {
    const { container } = renderForm(
      <CreateAssignmentForm onSubmit={() => {}} />,
    )
    const toggle =
      container.querySelector<HTMLInputElement>("#due_date-enabled")
    expect(toggle?.checked).toBe(false)
    expect(screen.queryByLabelText("assignments.form.dueDate")).toBeNull()
  })

  it("unchecking the toggle submits an empty due_date (the #195 opt-out)", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const { container } = renderForm(
      <CreateAssignmentForm
        edit
        defaultValues={assignmentToFormValues(withDue as Assignment)}
        onSubmit={onSubmit}
      />,
    )

    const toggle =
      container.querySelector<HTMLInputElement>("#due_date-enabled")
    await user.click(toggle!)
    // Unchecking hides the picker and clears the value.
    expect(screen.queryByLabelText("assignments.form.dueDate")).toBeNull()

    await user.click(
      screen.getByRole("button", { name: "assignments.form.saveChanges" }),
    )

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0].due_date).toBe("")
  })
})

// The slug field: auto-fills from the name in create mode until the teacher
// edits it, re-arms when they clear it, and is shown read-only in edit mode.
describe("assignment slug field", () => {
  const renderForm = (ui: ReactElement) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        {ui}
      </QueryClientProvider>,
    )

  const slugInput = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>("#slug")!
  const nameInput = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>("#name")!

  it("create: auto-fills the slug from the name", async () => {
    const user = userEvent.setup()
    const { container } = renderForm(
      <CreateAssignmentForm onSubmit={() => {}} />,
    )
    await user.type(nameInput(container), "Loops Assignment")
    expect(slugInput(container).value).toBe("loops-assignment")
  })

  it("create: editing the slug stops auto-fill from the name", async () => {
    const user = userEvent.setup()
    const { container } = renderForm(
      <CreateAssignmentForm onSubmit={() => {}} />,
    )
    await user.type(slugInput(container), "custom")
    await user.type(nameInput(container), "Loops Assignment")
    // A deliberate slug isn't clobbered by later name edits.
    expect(slugInput(container).value).toBe("custom")
  })

  it("create: clearing the slug resumes auto-fill from the name", async () => {
    const user = userEvent.setup()
    const { container } = renderForm(
      <CreateAssignmentForm onSubmit={() => {}} />,
    )
    // Latch off with a manual slug, then clear it to re-arm sync.
    await user.type(slugInput(container), "custom")
    await user.clear(slugInput(container))
    await user.type(nameInput(container), "Loops Assignment")
    expect(slugInput(container).value).toBe("loops-assignment")
  })

  it("create: blurring an emptied slug restores the name-derived default", async () => {
    const user = userEvent.setup()
    const { container } = renderForm(
      <CreateAssignmentForm onSubmit={() => {}} />,
    )
    await user.type(nameInput(container), "Loops Assignment")
    // Override the auto-filled slug, then clear it and focus away.
    await user.clear(slugInput(container))
    await user.type(slugInput(container), "custom")
    await user.clear(slugInput(container))
    await user.tab()
    expect(slugInput(container).value).toBe("loops-assignment")
  })

  it("edit: shows the stored slug read-only", () => {
    const { container } = renderForm(
      <CreateAssignmentForm
        edit
        defaultValues={assignmentToFormValues(baseAssignment)}
        onSubmit={() => {}}
      />,
    )
    const slug = slugInput(container)
    expect(slug.value).toBe("hw1")
    expect(slug.disabled).toBe(true)
  })
})

describe("submission release files visibility", () => {
  const renderForm = (defaultValues?: Partial<CreateAssignmentFormValues>) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          defaultValues={defaultValues}
          onSubmit={() => {}}
        />
      </QueryClientProvider>,
    )

  it("renders the textarea for an ordinary assignment", () => {
    const { container } = renderForm()
    expect(container.querySelector("#release_assets")).not.toBeNull()
  })

  it("hides the textarea for empty_repo even with stale text", () => {
    const { container } = renderForm({
      empty_repo: true,
      release_assets: "../bad.pdf",
    })
    expect(container.querySelector("#release_assets")).toBeNull()
  })
})
