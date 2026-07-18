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
})
