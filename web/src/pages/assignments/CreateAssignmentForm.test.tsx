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

// Open an "Advanced settings" disclosure. The disclosures are controlled
// buttons whose bodies unmount when collapsed (so height can animate), so a
// test that asserts on an advanced field has to open it first. `which` picks by
// document order: Repository Setup's renders before the autograder's.
const openAdvanced = async (
  user: ReturnType<typeof userEvent.setup>,
  which: "repository" | "autograder",
) => {
  const toggles = screen.getAllByText("assignments.form.advanced")
  const toggle = which === "repository" ? toggles[0] : toggles.at(-1)
  if (!toggle) throw new Error(`${which} advanced disclosure not found`)
  await user.click(toggle)
}

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

  it("create: auto-fills a unique slug when the name's slug is taken", async () => {
    const user = userEvent.setup()
    const { container } = renderForm(
      <CreateAssignmentForm takenSlugs={["loops"]} onSubmit={() => {}} />,
    )
    await user.type(nameInput(container), "Loops")
    // The plain slug "loops" collides, so the auto-fill suffixes it.
    expect(slugInput(container).value).toBe("loops-2")
  })

  // #691: a manual slug over the classroom's composed repo-name budget warns
  // as-you-type, before any submit; shrinking back within budget clears it.
  it("create: warns live when a manual slug exceeds the classroom's budget", async () => {
    const user = userEvent.setup()
    const { container } = renderForm(
      <CreateAssignmentForm classroom="cs" onSubmit={() => {}} />,
    )
    // "cs" leaves a 57-char budget (59 - 2); 58 exceeds it.
    await user.click(slugInput(container))
    await user.paste("s".repeat(58))
    expect(
      screen.getByText("assignments.form.validation.slugOverBudget"),
    ).not.toBeNull()
    await user.type(slugInput(container), "{backspace}")
    expect(
      screen.queryByText("assignments.form.validation.slugOverBudget"),
    ).toBeNull()
  })

  // Collisions warn live too, case-insensitively against the taken set.
  it("create: warns live when a manual slug collides with an existing assignment", async () => {
    const user = userEvent.setup()
    const { container } = renderForm(
      <CreateAssignmentForm takenSlugs={["loops"]} onSubmit={() => {}} />,
    )
    await user.click(slugInput(container))
    await user.paste("Loops")
    expect(screen.getByText("validation.assignmentSlugTaken")).not.toBeNull()
    await user.type(slugInput(container), "x")
    expect(screen.queryByText("validation.assignmentSlugTaken")).toBeNull()
  })

  it("create: blurring an emptied slug restores a unique name-derived default", async () => {
    const user = userEvent.setup()
    const { container } = renderForm(
      <CreateAssignmentForm takenSlugs={["loops"]} onSubmit={() => {}} />,
    )
    await user.type(nameInput(container), "Loops")
    await user.clear(slugInput(container))
    await user.tab()
    expect(slugInput(container).value).toBe("loops-2")
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

  it("edit: locks the assignment-type radios (switching invalidates submissions)", () => {
    const { container } = renderForm(
      <CreateAssignmentForm
        edit
        defaultValues={assignmentToFormValues(baseAssignment)}
        onSubmit={() => {}}
      />,
    )
    const modeRadios =
      container.querySelectorAll<HTMLInputElement>('input[name="mode"]')
    expect(modeRadios.length).toBe(2)
    modeRadios.forEach((radio) => expect(radio.disabled).toBe(true))
    expect(screen.getByText("assignments.form.typeLockedHelp")).not.toBeNull()
  })

  it("create: leaves the assignment-type radios editable", () => {
    const { container } = renderForm(
      <CreateAssignmentForm onSubmit={() => {}} />,
    )
    const modeRadios =
      container.querySelectorAll<HTMLInputElement>('input[name="mode"]')
    expect(modeRadios.length).toBe(2)
    modeRadios.forEach((radio) => expect(radio.disabled).toBe(false))
    expect(screen.queryByText("assignments.form.typeLockedHelp")).toBeNull()
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
            autograding_state: "built-in",
            ...defaultValues,
          }}
          onSubmit={() => {}}
        />
      </QueryClientProvider>,
    )

  it("renders the textarea for an ordinary assignment", async () => {
    const user = userEvent.setup()
    const { container } = renderForm()
    await openAdvanced(user, "autograder")
    expect(container.querySelector("#release_assets")).not.toBeNull()
  })

  it("hides the textarea for empty_repo even with stale text", () => {
    const { container } = renderForm({
      empty_repo: true,
      release_assets: "../bad.pdf",
    })
    // A bare repo has no built-in autograder, so there's no advanced pane to
    // open and the field can't be reached at all.
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

    // Open the disclosure that owns the setup timeout (two "Advanced settings"
    // disclosures exist: Repository Setup's and the autograder's).
    await openAdvanced(user, "autograder")

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
            autograding_state: "built-in",
          }}
          onSubmit={onSubmit}
        />
      </QueryClientProvider>,
    )

    await openAdvanced(user, "autograder")

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

// The edit form re-baselines to the saved values after a successful save (the
// Discard affordance keys on pristineness); Save itself stays enabled per
// Primer's saving guidance.
describe("edit form save/discard lifecycle", () => {
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

  it("keeps Save enabled while pristine and after a successful save", async () => {
    // Primer saving guidance: never disable the save button for an unchanged
    // form. The unchanged submit itself is a no-op (covered below) — the
    // enabled button is about focusability, not about re-running the save.
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    renderForm(onSubmit)

    const name = screen.getByRole("textbox", {
      name: "assignments.form.name",
    })
    expect(saveButton().disabled).toBe(false)

    await user.type(name, " updated")
    expect(saveButton().disabled).toBe(false)

    await user.click(saveButton())
    expect(onSubmit).toHaveBeenCalledTimes(1)

    // Still enabled after the save re-baselines.
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false))
  })

  it("makes an unchanged submit a no-op with feedback, never a re-run", async () => {
    // The regression this pins: saving an untouched assignment settings form
    // must not re-trigger the publish workflow.
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    renderForm(onSubmit)

    await user.click(saveButton())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText("assignments.form.noChangesToSave")).toBeTruthy()

    // Editing clears the notice and a real change submits once.
    const name = screen.getByRole("textbox", {
      name: "assignments.form.name",
    })
    await user.type(name, " updated")
    expect(screen.queryByText("assignments.form.noChangesToSave")).toBeNull()
    await user.click(saveButton())
    expect(onSubmit).toHaveBeenCalledTimes(1)
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

  it("Discard changes reverts edits and hides once pristine", async () => {
    const user = userEvent.setup()
    renderForm(vi.fn())

    const discardButton = () =>
      screen.queryByRole("button", {
        name: "assignments.form.discardChanges",
      })
    const name = screen.getByRole("textbox", {
      name: "assignments.form.name",
    }) as HTMLInputElement

    // Pristine: no Discard affordance.
    expect(discardButton()).toBeNull()

    await user.type(name, " updated")
    expect(discardButton()).not.toBeNull()

    await user.click(discardButton()!)
    // Reverts to the stored name and the affordance disappears again.
    expect(name.value).toBe(baseAssignment.name)
    expect(discardButton()).toBeNull()
    // Save stays enabled on the pristine form (Primer saving guidance).
    expect(saveButton().disabled).toBe(false)
  })

  it("Discard changes re-syncs the schedule pickers with the restored dates", async () => {
    const user = userEvent.setup()
    const withDue: Assignment = {
      ...baseAssignment,
      due: "2026-09-01T23:59:00Z",
    }
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          edit
          defaultValues={assignmentToFormValues(withDue)}
          onSubmit={vi.fn()}
        />
      </QueryClientProvider>,
    )
    const dueToggle = () =>
      container.querySelector<HTMLInputElement>("#due_date-enabled")!
    // Stored due date -> picker starts shown.
    expect(dueToggle().checked).toBe(true)

    // Turn the picker off (clears due_date), making the form dirty.
    await user.click(dueToggle())
    expect(dueToggle().checked).toBe(false)

    // Discard restores the stored due date AND re-shows its picker.
    await user.click(
      screen.getByRole("button", {
        name: "assignments.form.discardChanges",
      }),
    )
    expect(dueToggle().checked).toBe(true)
    expect(screen.getByLabelText("assignments.form.dueDate")).not.toBeNull()
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
            autograding_state: "built-in",
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

  it("hosted runner keeps language + apt fields enabled", async () => {
    const user = userEvent.setup()
    const { container } = renderForm({ runs_on: "ubuntu-latest" })
    await openAdvanced(user, "autograder")
    expect(pythonInput(container).disabled).toBe(false)
    expect(aptInput(container).disabled).toBe(false)
    expect(
      screen.queryByText("assignments.form.runtime.selfHostedDisabled"),
    ).toBeNull()
  })

  it("self-hosted runner disables language + apt fields and shows the note", async () => {
    const user = userEvent.setup()
    const { container } = renderForm({ runs_on: "self-hosted, linux, x64" })
    await openAdvanced(user, "autograder")
    expect(pythonInput(container).disabled).toBe(true)
    expect(aptInput(container).disabled).toBe(true)
    expect(
      screen.getByText("assignments.form.runtime.selfHostedDisabled"),
    ).not.toBeNull()
  })
})

// The autograding selector: "No built-in autograder" first + default; built-in
// requires an initialized repo (README or template) and is disabled while the
// repo is uninitialized; the none<->built-in choice is editable on edit
// (with a caveat), so the built-in autograder radios stay enabled.
describe("grading drives the autograding config", () => {
  const renderForm = (
    props: {
      edit?: boolean
      defaultValues?: Partial<CreateAssignmentFormValues>
      hasAcceptedStudents?: boolean
    } = {},
  ) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          edit={props.edit}
          defaultValues={props.defaultValues}
          hasAcceptedStudents={props.hasAcceptedStudents}
          onSubmit={() => {}}
        />
      </QueryClientProvider>,
    )

  it("create default is 'off' (not graded): no autograding config at all", () => {
    const { container } = renderForm()
    // The grading select defaults to "off".
    const grading =
      container.querySelector<HTMLSelectElement>("#grading_choice")
    expect(grading?.value).toBe("off")
    // The autograder config is folded into this section and only rendered when
    // Autograded: no built-in radios, no advanced fields, and no note.
    expect(container.querySelector("#release_assets")).toBeNull()
    expect(
      container.querySelector('input[name="autograding_state"]'),
    ).toBeNull()
  })

  it("Manual grading also hides the autograding config", () => {
    const { container } = renderForm({
      defaultValues: { grading_choice: "manual", grading_max_points: 50 },
    })
    expect(container.querySelector("#release_assets")).toBeNull()
    expect(
      container.querySelector('input[name="autograding_state"]'),
    ).toBeNull()
  })

  it("Autograded shows the built-in toggle; config stays hidden until built-in is selected", async () => {
    const user = userEvent.setup()
    renderForm({
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "auto",
      },
    })
    // Autograded reveals the built-in-autograder radios.
    expect(
      screen.getByRole("radio", {
        name: /assignments\.form\.autograding\.choices\.none\.label/,
      }),
    ).not.toBeNull()
    // With autograding_state seeded to "none" (not built-in), the built-in
    // config (the tests list + advanced pane) is hidden.
    expect(screen.queryByText("assignments.autograder.heading")).toBeNull()

    // Selecting "Use the built-in autograder" reveals the config.
    await user.click(
      screen.getByRole("radio", {
        name: /assignments\.form\.autograding\.choices\.built-in\.label/,
      }),
    )
    expect(screen.getByText("assignments.autograder.heading")).not.toBeNull()
  })

  it("Autograded + built-in preselected reveals the autograding config", () => {
    renderForm({
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "auto",
        autograding_state: "built-in",
      },
    })
    expect(screen.getByText("assignments.autograder.heading")).not.toBeNull()
  })

  it("seeds the built-in autograder when grading switches into Autograded", async () => {
    const user = userEvent.setup()
    const { container } = renderForm({
      defaultValues: { repo_source: "none", add_readme: true },
    })
    // Starts Not graded: no autograder config.
    expect(
      container.querySelector('input[name="autograding_state"]'),
    ).toBeNull()
    // Switch grading to Autograded — built-in is seeded as the default, so the
    // config (the tests list) appears without an extra click.
    const grading =
      container.querySelector<HTMLSelectElement>("#grading_choice")!
    await user.selectOptions(grading, "auto")
    const builtIn = screen.getByRole<HTMLInputElement>("radio", {
      name: /assignments\.form\.autograding\.choices\.built-in\.label/,
    })
    expect(builtIn.checked).toBe(true)
    expect(screen.getByText("assignments.autograder.heading")).not.toBeNull()
  })

  it("keeps a deliberate 'none' across a grading round-trip", async () => {
    // Seeding is a first-entry default, not an override: once the teacher picks
    // teacher-supplied CI, leaving Autograded and coming back must not silently
    // re-seed the built-in autograder.
    const user = userEvent.setup()
    const { container } = renderForm({
      defaultValues: { repo_source: "none", add_readme: true },
    })
    const grading =
      container.querySelector<HTMLSelectElement>("#grading_choice")!
    await user.selectOptions(grading, "auto")
    // Deliberately switch off the built-in autograder.
    await user.click(
      screen.getByRole("radio", {
        name: /assignments\.form\.autograding\.choices\.none\.label/,
      }),
    )
    expect(screen.queryByText("assignments.autograder.heading")).toBeNull()
    // Round-trip the grading choice.
    await user.selectOptions(grading, "manual")
    await user.selectOptions(grading, "auto")
    expect(
      screen.getByRole<HTMLInputElement>("radio", {
        name: /assignments\.form\.autograding\.choices\.none\.label/,
      }).checked,
    ).toBe(true)
    expect(screen.queryByText("assignments.autograder.heading")).toBeNull()
  })

  it("leaves a stored built-in choice untouched when re-entering Autograded", async () => {
    const user = userEvent.setup()
    const { container } = renderForm({
      edit: true,
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "manual",
        autograding_state: "built-in",
      },
    })
    const grading =
      container.querySelector<HTMLSelectElement>("#grading_choice")!
    await user.selectOptions(grading, "auto")
    expect(
      screen.getByRole<HTMLInputElement>("radio", {
        name: /assignments\.form\.autograding\.choices\.built-in\.label/,
      }).checked,
    ).toBe(true)
  })

  it("keeps the built-in autograder radios editable on edit", () => {
    // On edit the built-in choice maps to no_autograder/init_shim. It's now
    // mutable — the radios render enabled (the caveat is conditional; see the
    // dedicated caveat tests below).
    const { container } = renderForm({
      edit: true,
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "auto",
        autograding_state: "built-in",
      },
    })
    const radios = container.querySelectorAll<HTMLInputElement>(
      'input[name="autograding_state"]',
    )
    expect(radios.length).toBe(2)
    radios.forEach((radio) => expect(radio.disabled).toBe(false))
  })

  it("hides the built-in-autograder caveat until the choice changes, even with accepters", async () => {
    const user = userEvent.setup()
    renderForm({
      edit: true,
      hasAcceptedStudents: true,
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "auto",
        autograding_state: "none",
      },
    })
    // Unchanged: no caveat, even though students have accepted.
    expect(
      screen.queryByText("assignments.form.autograding.editHelp"),
    ).toBeNull()
    // Flipping the choice surfaces the caveat.
    await user.click(
      screen.getByRole("radio", {
        name: /assignments\.form\.autograding\.choices\.built-in\.label/,
      }),
    )
    expect(
      screen.getByText("assignments.form.autograding.editHelp"),
    ).not.toBeNull()
  })

  it("hides the built-in-autograder caveat on a change when no students have accepted", async () => {
    const user = userEvent.setup()
    renderForm({
      edit: true,
      hasAcceptedStudents: false,
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "auto",
        autograding_state: "none",
      },
    })
    await user.click(
      screen.getByRole("radio", {
        name: /assignments\.form\.autograding\.choices\.built-in\.label/,
      }),
    )
    expect(
      screen.queryByText("assignments.form.autograding.editHelp"),
    ).toBeNull()
  })

  it("shows the repo-source caveat only after a change when students have accepted", async () => {
    const user = userEvent.setup()
    const { container } = renderForm({
      edit: true,
      hasAcceptedStudents: true,
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "auto",
        autograding_state: "none",
      },
    })
    // Unchanged: no caveat despite accepters.
    expect(
      screen.queryByText("assignments.form.repoSource.editHelp"),
    ).toBeNull()
    // Flipping the source to template surfaces the caveat.
    const templateRadio = container.querySelector<HTMLInputElement>(
      "#repo_source-template",
    )!
    await user.click(templateRadio)
    expect(
      screen.getByText("assignments.form.repoSource.editHelp"),
    ).not.toBeNull()
  })

  it("hides the repo-source caveat on a change when no students have accepted", async () => {
    const user = userEvent.setup()
    const { container } = renderForm({
      edit: true,
      hasAcceptedStudents: false,
      defaultValues: {
        repo_source: "none",
        add_readme: true,
        grading_choice: "auto",
        autograding_state: "none",
      },
    })
    const templateRadio = container.querySelector<HTMLInputElement>(
      "#repo_source-template",
    )!
    await user.click(templateRadio)
    expect(
      screen.queryByText("assignments.form.repoSource.editHelp"),
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
  // any assignment) and, when Autograded, folds in the autograder config. The
  // former standalone Autograding section is gone, so there are four cards.
  const baseSectionTitleKeys = [
    "assignments.form.detailsSection",
    "assignments.form.repositorySetupSection",
    "assignments.form.submissionSection",
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

  it("shows the submission mode regardless of the grading mode; tags follow the mode", () => {
    // Grading applies to any assignment, and the submission MODE is how the app
    // identifies submissions — independent of grading and repo shape — so it
    // renders even when not autograded. The tags field is shown only for the
    // "tagged commit" mode (set it here to reveal it).
    renderForm({
      defaultValues: {
        grading_choice: "manual",
        grading_max_points: 50,
        submission_mode: "tag",
      },
    })
    expect(
      screen.getByText("assignments.form.submissionSection"),
    ).not.toBeNull()
    expect(screen.getByText("assignments.form.grading.label")).not.toBeNull()
    expect(
      screen.getByText("assignments.form.submissionMode.label"),
    ).not.toBeNull()
    // Tag mode reveals the milestone-tags field, even without a built-in
    // autograder (it's the app's detection definition, not shim-only).
    expect(
      screen.getByText("assignments.form.submissionTags.label"),
    ).not.toBeNull()
  })

  it("shows the submission mode for a bare (empty) repo; tags follow the mode", () => {
    // A bare repo has no shim, but the mode still drives how the submissions
    // page counts pushes/tags, so it renders. Tags show only in "tag" mode.
    renderForm({
      defaultValues: {
        repo_source: "none",
        add_readme: false,
        grading_choice: "off",
        submission_mode: "tag",
      },
    })
    expect(
      screen.getByText("assignments.form.submissionMode.label"),
    ).not.toBeNull()
    expect(
      screen.getByText("assignments.form.submissionTags.label"),
    ).not.toBeNull()
  })

  it("hides submission tags in every-push mode and shows them in tag mode", () => {
    const { rerender } = renderForm({
      defaultValues: { submission_mode: "every-push" },
    })
    // every-push: mode control visible, tags field hidden.
    expect(
      screen.getByText("assignments.form.submissionMode.label"),
    ).not.toBeNull()
    expect(
      screen.queryByText("assignments.form.submissionTags.label"),
    ).toBeNull()
    // Switching to "A tagged commit" reveals the tags field.
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAssignmentForm
          defaultValues={{ submission_mode: "tag" }}
          onSubmit={() => {}}
        />
      </QueryClientProvider>,
    )
    expect(
      screen.getByText("assignments.form.submissionTags.label"),
    ).not.toBeNull()
  })

  it("keeps the advanced repository fields reachable in the disclosure", async () => {
    // The rarer repo controls moved inside the Advanced settings disclosure;
    // opening it must reveal them, so a regression that dropped them from the
    // collapsible is caught here.
    const user = userEvent.setup()
    const { container } = renderForm({
      defaultValues: { repo_source: "template", template_repo: "org/tmpl" },
    })
    expect(container.querySelector("#copy_about")).toBeNull()
    await openAdvanced(user, "repository")
    expect(container.querySelector("#copy_about")).not.toBeNull()
    expect(container.querySelector("#copy_topics")).not.toBeNull()
    expect(container.querySelector("#student_permission")).not.toBeNull()
    expect(container.querySelector("#repo_feature_issues")).not.toBeNull()
  })

  it("shows no per-section Reset control on a fresh create form", () => {
    renderForm({})
    // Nothing is configured yet, so no section offers a reset.
    expect(
      screen.queryAllByRole("button", {
        name: "assignments.form.resetSection",
      }).length,
    ).toBe(0)
  })

  it("create: a configured section shows a Reset that restores its defaults", async () => {
    const user = userEvent.setup()
    const { container } = renderForm({})
    const nameInput = container.querySelector<HTMLInputElement>("#name")!
    await user.type(nameInput, "Homework 1")
    // Details is now configured -> a Reset control appears.
    const reset = screen.getAllByRole("button", {
      name: "assignments.form.resetSection",
    })
    expect(reset.length).toBeGreaterThan(0)
    await user.click(reset[0])
    // The name is back to its default and the reset control is gone again.
    expect(nameInput.value).toBe("")
    expect(
      screen.queryAllByRole("button", {
        name: "assignments.form.resetSection",
      }).length,
    ).toBe(0)
  })

  it("edit: never renders a per-section Reset control", () => {
    renderForm({
      edit: true,
      defaultValues: assignmentToFormValues(baseAssignment),
    })
    expect(
      screen.queryAllByRole("button", {
        name: "assignments.form.resetSection",
      }).length,
    ).toBe(0)
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
})

describe("validation error highlighting and scroll-to-first-error", () => {
  const renderForm = (ui: ReactElement) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        {ui}
      </QueryClientProvider>,
    )

  it("submitting with an empty required name marks the field invalid", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    const { container } = renderForm(
      <CreateAssignmentForm onSubmit={onSubmit} />,
    )
    // Name is required and empty on a fresh create form.
    await user.click(
      screen.getByRole("button", { name: "assignments.form.createButton" }),
    )
    expect(onSubmit).not.toHaveBeenCalled()
    // The role="alert" message renders once validation runs.
    expect(
      await screen.findByText("assignments.form.validation.nameRequired"),
    ).not.toBeNull()
    const nameInput = container.querySelector<HTMLInputElement>("#name")!
    expect(nameInput.getAttribute("aria-invalid")).toBe("true")
  })

  it("scrolls the first invalid field into view on a failed submit", async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    const focus = vi.fn()
    // happy-dom doesn't implement scrollIntoView; stub it on the prototype.
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView,
    )
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(focus)

    renderForm(<CreateAssignmentForm onSubmit={vi.fn()} />)
    await user.click(
      screen.getByRole("button", { name: "assignments.form.createButton" }),
    )
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    expect(focus).toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  it("does not scroll when the form is valid", async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView,
    )
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { container } = renderForm(
      <CreateAssignmentForm
        takenSlugs={[]}
        defaultValues={{ name: "Homework 1", slug: "homework-1" }}
        onSubmit={onSubmit}
      />,
    )
    // Sanity: no validation alert on a filled valid form.
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull()
    await user.click(
      screen.getByRole("button", { name: "assignments.form.createButton" }),
    )
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(scrollIntoView).not.toHaveBeenCalled()

    vi.restoreAllMocks()
  })
})
