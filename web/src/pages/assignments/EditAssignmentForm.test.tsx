// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mutateAsync = vi.fn().mockResolvedValue({})
vi.mock("@/hooks/mutations/useEditAssignment", () => ({
  useEditAssignment: () => ({ isPending: false, mutateAsync }),
}))
vi.mock("@/hooks/useTrackPublishDeploy", () => ({
  useTrackPublishDeploy: () => vi.fn(),
}))
// Acceptance is derived from the org repo list + roster; the count of existing
// repos gates the provisioning-change confirmation. `acceptedRepoNames` lets a
// test set that count without wiring GitHub reads.
let acceptedRepoNames: string[] = []
vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: () => ({ data: [] }),
}))
vi.mock("@/hooks/useGetStudents", () => ({
  default: () => ({ students: [] }),
}))
vi.mock("@/pages/submissions/dashboard", () => ({
  assignmentRepoNames: () => acceptedRepoNames,
}))
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})
vi.mock("./CreateAssignmentForm", () => ({
  assignmentToFormValues: (value: unknown) => value,
  formValuesToRepoFeatures: () => undefined,
  default: ({
    onSubmit,
  }: {
    onSubmit: (value: Record<string, unknown>) => void
  }) => (
    <button
      type="button"
      onClick={() => {
        // The real CreateAssignmentForm swallows an onSubmit rejection (a
        // cancelled confirm leaves the form dirty); mirror that here so the
        // cancel path doesn't surface as an unhandled rejection in the test.
        void Promise.resolve(
          onSubmit({
            name: "Homework",
            mode: "individual",
            template_repo: "",
            description: "",
            due_date: "",
            max_group_size: 2,
            feedback_pr: true,
            empty_repo: false,
            repo_source: "none",
            add_readme: true,
            autograding_state: "none",
            grading_choice: "auto",
            runs_on: "",
            container_image: "",
            container_user: "",
            runtime_python: "",
            runtime_node: "",
            runtime_java: "",
            runtime_go: "",
            runtime_rust: "",
            runtime_apt: "",
            setup_command: "make",
            setup_timeout: 300,
            allowed_files: "",
            release_assets: "plots/chart.png",
            pass_threshold_enabled: false,
            pass_threshold: 0,
            tests: [],
          }),
        ).catch(() => {})
      }}
    >
      submit
    </button>
  ),
}))

import EditAssignmentForm from "./EditAssignmentForm"

beforeEach(() => {
  mutateAsync.mockClear()
  acceptedRepoNames = []
})
afterEach(cleanup)

it("passes grading form fields through the edit boundary", () => {
  render(
    <EditAssignmentForm
      org="acme"
      classroom="cs101"
      assignment="hw1"
      defaultData={{
        slug: "hw1",
        name: "Homework",
        mode: "individual",
        autograder: "default",
      }}
      onSuccess={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "submit" }))
  expect(mutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      setup_timeout: 300,
      release_assets: "plots/chart.png",
    }),
    expect.any(Object),
  )
})

it("saves a provisioning change directly when no students have accepted", () => {
  // Stored auto assignment; the submit flips grading to manual. With zero
  // accepted repos, no confirmation gates the write.
  acceptedRepoNames = []
  render(
    <EditAssignmentForm
      org="acme"
      classroom="cs101"
      assignment="hw1"
      defaultData={{
        slug: "hw1",
        name: "Homework",
        mode: "individual",
        autograder: "default",
      }}
      onSuccess={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "submit" }))
  expect(mutateAsync).toHaveBeenCalledTimes(1)
  // The confirmation dialog was never opened (no showModal()).
  expect(document.querySelector("dialog[open]")).toBeNull()
})

it("confirms before saving a provisioning change when students have accepted", async () => {
  // Two existing repos; the stored assignment is manual-graded but the submit
  // sends the default auto grading — a provisioning-class change that must
  // prompt first, and the write only fires after the teacher confirms.
  acceptedRepoNames = ["cs101-hw1-alice", "cs101-hw1-bob"]
  render(
    <EditAssignmentForm
      org="acme"
      classroom="cs101"
      assignment="hw1"
      defaultData={{
        slug: "hw1",
        name: "Homework",
        mode: "individual",
        autograder: "default",
        grading: { mode: "manual", max_points: 50 },
      }}
      onSuccess={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "submit" }))
  // The write is deferred behind the confirmation modal (now open).
  expect(mutateAsync).not.toHaveBeenCalled()
  expect(document.querySelector("dialog[open]")).not.toBeNull()
  fireEvent.click(
    screen.getByRole("button", {
      name: "assignmentSettings.provisioningConfirm.confirm",
    }),
  )
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
})

it("does not write when the provisioning-change confirmation is cancelled", () => {
  acceptedRepoNames = ["cs101-hw1-alice"]
  render(
    <EditAssignmentForm
      org="acme"
      classroom="cs101"
      assignment="hw1"
      defaultData={{
        slug: "hw1",
        name: "Homework",
        mode: "individual",
        autograder: "default",
        grading: { mode: "manual", max_points: 50 },
      }}
      onSuccess={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "submit" }))
  expect(document.querySelector("dialog[open]")).not.toBeNull()
  fireEvent.click(
    screen.getByRole("button", {
      name: "assignmentSettings.provisioningConfirm.cancel",
    }),
  )
  expect(mutateAsync).not.toHaveBeenCalled()
})

it("saves directly (no confirm) when accepted but no provisioning setting changed", () => {
  // Two accepted repos, but the edit changes nothing provisioning-class (stored
  // auto, submit stays auto), so the write proceeds without a prompt.
  acceptedRepoNames = ["cs101-hw1-alice", "cs101-hw1-bob"]
  render(
    <EditAssignmentForm
      org="acme"
      classroom="cs101"
      assignment="hw1"
      defaultData={{
        slug: "hw1",
        name: "Homework",
        mode: "individual",
        autograder: "default",
      }}
      onSuccess={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "submit" }))
  expect(mutateAsync).toHaveBeenCalledTimes(1)
  // No provisioning-class change, so the dialog was never opened.
  expect(document.querySelector("dialog[open]")).toBeNull()
})
