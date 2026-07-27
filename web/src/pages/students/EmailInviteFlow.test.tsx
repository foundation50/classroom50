// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts
          ? `${key}:${Object.entries(opts)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(",")}`
          : key,
    }),
  }
})

import { EmailInvitePreview } from "./EmailInviteFlow"

afterEach(cleanup)

const noop = () => {}

const baseProps = {
  emails: ["ada@x.edu"],
  invalidEmails: [],
  emailRoles: { "ada@x.edu": "student" as const },
  emailOwnerConfirmed: false,
  emailHasTeacher: false,
  canProcess: true,
  onRoleChange: noop,
  onOwnerConfirmedChange: noop,
  onCancel: noop,
  onSend: noop,
}

describe("EmailInvitePreview invalid-email feedback", () => {
  it("shows no invalid notice when every line is a valid email", () => {
    render(<EmailInvitePreview {...baseProps} />)
    expect(screen.queryByText(/emailInviteInvalidNotice/)).toBeNull()
  })

  it("lists each invalid line with its line number and value", () => {
    render(
      <EmailInvitePreview
        {...baseProps}
        invalidEmails={[
          { line: 2, value: "not-an-email" },
          { line: 4, value: "octocat" },
        ]}
      />,
    )
    // The header names how many lines are invalid...
    expect(screen.getByText(/emailInviteInvalidNotice:count=2/)).toBeTruthy()
    // ...and each bad line is called out with its number + raw value.
    expect(
      screen.getByText(/emailInviteInvalidRow:line=2,value=not-an-email/),
    ).toBeTruthy()
    expect(
      screen.getByText(/emailInviteInvalidRow:line=4,value=octocat/),
    ).toBeTruthy()
  })

  it("still shows the valid emails alongside the invalid notice", () => {
    render(
      <EmailInvitePreview
        {...baseProps}
        invalidEmails={[{ line: 3, value: "bad" }]}
      />,
    )
    expect(screen.getByText("ada@x.edu")).toBeTruthy()
    expect(screen.getByText(/emailInviteInvalidNotice/)).toBeTruthy()
  })
})
