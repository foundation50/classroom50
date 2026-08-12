// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

import { SubmitGuidance } from "./SubmitGuidance"

afterEach(cleanup)

describe("SubmitGuidance", () => {
  it("shows the clone command derived from the repo URL and the submit command", () => {
    render(
      <SubmitGuidance repoHtmlUrl="https://github.com/acme/cs-hw1-student1" />,
    )
    expect(
      screen.getByText("git clone https://github.com/acme/cs-hw1-student1.git"),
    ).toBeTruthy()
    expect(screen.getByText("gh student submit")).toBeTruthy()
  })

  it("renders both copy buttons", () => {
    render(
      <SubmitGuidance repoHtmlUrl="https://github.com/acme/cs-hw1-student1" />,
    )
    expect(
      screen.getByLabelText("submissions.student.submitGuide.copyClone"),
    ).toBeTruthy()
    expect(
      screen.getByLabelText("submissions.student.submitGuide.copySubmit"),
    ).toBeTruthy()
  })

  it("keeps the every-push copy and hides the milestone step by default", () => {
    render(
      <SubmitGuidance repoHtmlUrl="https://github.com/acme/cs-hw1-student1" />,
    )
    expect(
      screen.getByText("submissions.student.submitGuide.intro"),
    ).toBeTruthy()
    expect(
      screen.queryByLabelText("submissions.student.submitGuide.copyMilestone"),
    ).toBeNull()
  })

  it("shows the milestone tag command in tag mode with a configured literal tag", () => {
    render(
      <SubmitGuidance
        repoHtmlUrl="https://github.com/acme/cs-hw1-student1"
        submissionMode="tag"
        submissionTags={["phase1", "v*"]}
      />,
    )
    expect(
      screen.getByText("submissions.student.submitGuide.tagIntro"),
    ).toBeTruthy()
    // The first literal (non-glob) pattern seeds the runnable example command.
    expect(
      screen.getByText("git tag phase1 && git push origin phase1"),
    ).toBeTruthy()
    expect(
      screen.getByLabelText("submissions.student.submitGuide.copyMilestone"),
    ).toBeTruthy()
  })

  it("falls back to a generic milestone name when only globs are configured", () => {
    render(
      <SubmitGuidance
        repoHtmlUrl="https://github.com/acme/cs-hw1-student1"
        submissionMode="tag"
        submissionTags={["v*"]}
      />,
    )
    expect(
      screen.getByText("git tag milestone && git push origin milestone"),
    ).toBeTruthy()
  })
})
