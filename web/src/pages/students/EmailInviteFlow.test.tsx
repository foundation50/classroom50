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

describe("EmailInvitePreview invalid-email handling", () => {
  it("shows the normal preview (table + send) when every line is valid", () => {
    render(<EmailInvitePreview {...baseProps} />)
    expect(screen.queryByText(/emailInviteInvalidBlocked/)).toBeNull()
    expect(screen.getByText("ada@x.edu")).toBeTruthy()
    expect(screen.getByRole("button", { name: /sendInviteCount/ })).toBeTruthy()
  })

  it("blocks the whole preview when any line is invalid: no table, no send", () => {
    render(
      <EmailInvitePreview
        {...baseProps}
        invalidEmails={[
          { line: 2, value: "not-an-email" },
          { line: 4, value: "octocat" },
        ]}
      />,
    )
    // A concise blocked warning names the count and lists each bad line.
    expect(screen.getByText(/emailInviteInvalidBlocked:count=2/)).toBeTruthy()
    expect(
      screen.getByText(/emailInviteInvalidRow:line=2,value=not-an-email/),
    ).toBeTruthy()
    expect(
      screen.getByText(/emailInviteInvalidRow:line=4,value=octocat/),
    ).toBeTruthy()
    // No valid-email table and no send button — only Cancel.
    expect(screen.queryByText("ada@x.edu")).toBeNull()
    expect(screen.queryByRole("button", { name: /sendInviteCount/ })).toBeNull()
    expect(screen.getByRole("button", { name: /common.cancel/ })).toBeTruthy()
  })

  it("blocks even a single invalid line among otherwise-valid emails", () => {
    render(
      <EmailInvitePreview
        {...baseProps}
        emails={["ada@x.edu", "bob@x.edu"]}
        invalidEmails={[{ line: 3, value: "bad" }]}
      />,
    )
    expect(screen.getByText(/emailInviteInvalidBlocked:count=1/)).toBeTruthy()
    expect(screen.queryByText("ada@x.edu")).toBeNull()
    expect(screen.queryByRole("button", { name: /sendInviteCount/ })).toBeNull()
  })
})
