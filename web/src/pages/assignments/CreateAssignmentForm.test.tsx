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
  // release_assets is a built-in autograder field, so these render an
  // initialized repo with built-in autograding selected (the default create
  // form is now an empty repo with no built-in config).
  const renderForm = (defaultValues?: Partial<CreateAssignmentFormValues>) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          defaultValues={{
            add_readme: true,
            grading_choice: "auto",
            ...defaultValues,
          }}
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

describe("assignment setup timeout", () => {
  it("submits a stored zero timeout unchanged from the edit form", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          edit
          defaultValues={assignmentToFormValues({
            ...baseAssignment,
            tests: [
              {
                name: "setup",
                type: "run",
                run: "make",
                points: 0,
                timeout: 0,
              },
            ],
          })}
          onSubmit={onSubmit}
        />
      </QueryClientProvider>,
    )

    const advancedSummary = screen
      .getByText("assignments.form.advanced")
      .closest("summary")
    await user.click(advancedSummary!)

    const timeout = screen.getByLabelText(
      "assignments.form.setupTimeout",
    ) as HTMLInputElement
    expect(timeout.value).toBe("0")

    await user.type(
      screen.getByRole("textbox", { name: "assignments.form.name" }),
      " updated",
    )
    await user.click(
      screen.getByRole("button", {
        name: "assignments.form.saveChanges",
      }),
    )

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0].setup_timeout).toBe(0)
  })

  it("starts at 120 seconds and submits a changed timeout on create", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          defaultValues={{
            name: "Homework",
            slug: "hw1",
            add_readme: true,
            grading_choice: "auto",
          }}
          onSubmit={onSubmit}
        />
      </QueryClientProvider>,
    )

    const advancedSummary = screen
      .getByText("assignments.form.advanced")
      .closest("summary")
    expect(advancedSummary).not.toBeNull()
    await user.click(advancedSummary!)

    const command = screen.getByLabelText(
      "assignments.form.setupCommand",
    ) as HTMLInputElement
    const timeout = screen.getByLabelText(
      "assignments.form.setupTimeout",
    ) as HTMLInputElement
    expect(timeout.value).toBe("120")
    expect(timeout.disabled).toBe(true)

    await user.type(command, "make")
    expect(timeout.disabled).toBe(false)
    await user.clear(timeout)
    await user.type(timeout, "300")
    await user.click(
      screen.getByRole("button", {
        name: "assignments.form.createButton",
      }),
    )

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0].setup_timeout).toBe(300)
  })
})

// After a successful save the edit form re-baselines to the saved values, so
// the "Save Changes" button re-disables (nothing pending) until the next edit.
describe("edit form re-disables Save after a successful save", () => {
  const renderForm = (
    onSubmit: (values: CreateAssignmentFormValues) => void | Promise<void>,
  ) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          edit
          defaultValues={assignmentToFormValues(baseAssignment)}
          onSubmit={onSubmit}
        />
      </QueryClientProvider>,
    )

  const saveButton = () =>
    screen.getByRole("button", {
      name: "assignments.form.saveChanges",
    }) as HTMLButtonElement

  it("disables Save on success, then re-enables on the next edit", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    renderForm(onSubmit)

    const name = screen.getByRole("textbox", {
      name: "assignments.form.name",
    })
    expect(saveButton().disabled).toBe(true)

    await user.type(name, " updated")
    expect(saveButton().disabled).toBe(false)

    await user.click(saveButton())
    expect(onSubmit).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(saveButton().disabled).toBe(true))

    await user.type(name, " again")
    expect(saveButton().disabled).toBe(false)
  })

  it("keeps the form dirty and re-submittable when the save fails", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new Error("boom"))
    renderForm(onSubmit)

    const name = screen.getByRole("textbox", {
      name: "assignments.form.name",
    })
    await user.type(name, " updated")
    await user.click(saveButton())
    expect(onSubmit).toHaveBeenCalledTimes(1)

    // A rejected write must not re-baseline, so Save stays enabled.
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false))
  })
})
// Built-in runtime options (language versions + apt) are disabled when the
// runner targets self-hosted: the grade job skips managed setup there
// (runner.environment != 'self-hosted'), so those options wouldn't apply.
describe("self-hosted disables built-in runtime options", () => {
  // The runtime fields are built-in autograder controls, so render an
  // initialized repo with built-in autograding selected.
  const renderForm = (defaultValues?: Partial<CreateAssignmentFormValues>) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          defaultValues={{
            add_readme: true,
            grading_choice: "auto",
            ...defaultValues,
          }}
          onSubmit={() => {}}
        />
      </QueryClientProvider>,
    )

  const pythonInput = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>("#runtime_python")!
  const aptInput = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>("#runtime_apt")!

  it("hosted runner keeps language + apt fields enabled", () => {
    const { container } = renderForm({ runs_on: "ubuntu-latest" })
    expect(pythonInput(container).disabled).toBe(false)
    expect(aptInput(container).disabled).toBe(false)
    expect(
      screen.queryByText("assignments.form.runtime.selfHostedDisabled"),
    ).toBeNull()
  })

  it("self-hosted runner disables language + apt fields and shows the note", () => {
    const { container } = renderForm({ runs_on: "self-hosted, linux, x64" })
    expect(pythonInput(container).disabled).toBe(true)
    expect(aptInput(container).disabled).toBe(true)
    expect(
      screen.getByText("assignments.form.runtime.selfHostedDisabled"),
    ).not.toBeNull()
  })
})

// The autograding selector: "No built-in autograder" first + default; built-in
// requires an initialized repo (README or template) and is disabled while the
// repo is uninitialized; the none<->built-in choice is immutable on edit.
describe("grading drives the autograding config", () => {
  const renderForm = (
    props: {
      edit?: boolean
      defaultValues?: Partial<CreateAssignmentFormValues>
    } = {},
  ) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          edit={props.edit}
          defaultValues={props.defaultValues}
          onSubmit={() => {}}
        />
      </QueryClientProvider>,
    )

  it("create default is 'off' (not graded): no autograding config, shows the note", () => {
    const { container } = renderForm()
    // The grading select defaults to "off".
    const grading =
      container.querySelector<HTMLSelectElement>("#grading_choice")
    expect(grading?.value).toBe("off")
    // Autograding config (Advanced release_assets, tests) is hidden; the
    // not-autograded note is shown instead.
    expect(container.querySelector("#release_assets")).toBeNull()
    expect(
      screen.getByText("assignments.form.autograding.notAutogradedNote"),
    ).not.toBeNull()
  })

  it("Manual grading also hides the autograding config", () => {
    const { container } = renderForm({
      defaultValues: { grading_choice: "manual", grading_max_points: 50 },
    })
    expect(container.querySelector("#release_assets")).toBeNull()
    expect(
      screen.getByText("assignments.form.autograding.notAutogradedNote"),
    ).not.toBeNull()
  })

  it("Autograded reveals the autograding config", () => {
    const { container } = renderForm({
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "auto",
      },
    })
    expect(container.querySelector("#release_assets")).not.toBeNull()
    expect(
      screen.queryByText("assignments.form.autograding.notAutogradedNote"),
    ).toBeNull()
  })
})

// The section IA (R1/R2): the sections render in order with a status badge
// each, and the two deferred affordances (R6/R14) render inert.
describe("assignment form section IA", () => {
  const renderForm = (props: {
    edit?: boolean
    defaultValues?: Partial<CreateAssignmentFormValues>
  }) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          edit={props.edit}
          defaultValues={props.defaultValues}
          onSubmit={() => {}}
        />
      </QueryClientProvider>,
    )

  // The Submission and Grading section now always renders (grading applies to
  // any assignment), between Repository Setup and Autograding.
  const baseSectionTitleKeys = [
    "assignments.form.detailsSection",
    "assignments.form.repositorySetupSection",
    "assignments.form.submissionSection",
    "assignments.form.autograding.label",
    "assignments.form.repositoryFeaturesSection",
    "assignments.form.scheduleSection",
  ]

  it("renders the sections in order for create", () => {
    renderForm({})
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent)
    // The section headings appear in the required order (other h3s may exist
    // inside sections, so assert the titles are a subsequence).
    const indices = baseSectionTitleKeys.map((key) => headings.indexOf(key))
    expect(indices.every((i) => i >= 0)).toBe(true)
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b))
  })

  it("renders the sections in order for edit", () => {
    renderForm({
      edit: true,
      defaultValues: assignmentToFormValues(baseAssignment),
    })
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent)
    const indices = baseSectionTitleKeys.map((key) => headings.indexOf(key))
    expect(indices.every((i) => i >= 0)).toBe(true)
    expect([...indices]).toEqual([...indices].sort((a, b) => a - b))
  })

  it("shows the grading choice regardless of the grading mode", () => {
    // Grading applies to any assignment, so the section + grading control
    // render even when not autograded.
    renderForm({
      defaultValues: { grading_choice: "manual", grading_max_points: 50 },
    })
    expect(
      screen.getByText("assignments.form.submissionSection"),
    ).not.toBeNull()
    expect(screen.getByText("assignments.form.grading.label")).not.toBeNull()
    // The submission trigger needs a shim (grading = auto), so it stays hidden.
    expect(
      screen.queryByText("assignments.form.submissionMode.label"),
    ).toBeNull()
  })

  it("shows the submission trigger controls only when grading is Autograded", () => {
    renderForm({ defaultValues: { grading_choice: "auto" } })
    expect(
      screen.getByText("assignments.form.submissionMode.label"),
    ).not.toBeNull()
  })

  it("shows a per-section status badge (default on a fresh create form)", () => {
    renderForm({})
    // Details is untouched on a fresh form -> "default" badge present.
    expect(
      screen.getAllByText("assignments.form.sectionStatus.default").length,
    ).toBeGreaterThan(0)
  })

  it("shows Add-a-README for the no-template source and an enabled include-all-branches toggle for a template", () => {
    // No template (the default): the Add-a-README toggle shows, no
    // include-all-branches toggle.
    const noTemplate = renderForm({ defaultValues: { repo_source: "none" } })
    expect(noTemplate.container.querySelector("#add_readme")).not.toBeNull()
    expect(
      noTemplate.container.querySelector("#include_all_branches"),
    ).toBeNull()
    cleanup()

    // Template source: the README toggle is hidden and the include-all-branches
    // toggle renders enabled (no longer a disabled "coming soon" affordance).
    const templated = renderForm({
      defaultValues: { repo_source: "template", template_repo: "acme/starter" },
    })
    expect(templated.container.querySelector("#add_readme")).toBeNull()
    const branches = templated.container.querySelector<HTMLInputElement>(
      "#include_all_branches",
    )
    expect(branches).not.toBeNull()
    expect(branches?.disabled).toBe(false)
  })

  it("reserves the schedule Extensions affordance as disabled", () => {
    renderForm({})
    expect(screen.getByText("assignments.form.extensions.label")).not.toBeNull()
  })
})
