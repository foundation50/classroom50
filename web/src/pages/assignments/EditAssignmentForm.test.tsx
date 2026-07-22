// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"

const mutate = vi.fn()
vi.mock("@/hooks/mutations/useEditAssignment", () => ({
  useEditAssignment: () => ({ isPending: false, mutate }),
}))
vi.mock("@/hooks/useTrackPublishDeploy", () => ({
  useTrackPublishDeploy: () => vi.fn(),
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
  default: ({
    onSubmit,
  }: {
    onSubmit: (value: Record<string, unknown>) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onSubmit({
          name: "Homework",
          mode: "individual",
          template_repo: "",
          description: "",
          due_date: "",
          max_group_size: 2,
          feedback_pr: true,
          empty_repo: false,
          runs_on: "",
          container_image: "",
          container_user: "",
          runtime_python: "",
          runtime_node: "",
          runtime_java: "",
          runtime_go: "",
          runtime_rust: "",
          runtime_apt: "",
          setup_command: "",
          allowed_files: "",
          release_assets: "plots/chart.png",
          pass_threshold_enabled: false,
          pass_threshold: 0,
          tests: [],
        })
      }
    >
      submit
    </button>
  ),
}))

import EditAssignmentForm from "./EditAssignmentForm"

beforeEach(() => mutate.mockClear())

it("passes release_assets through the edit boundary", () => {
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
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({ release_assets: "plots/chart.png" }),
    expect.any(Object),
  )
})
