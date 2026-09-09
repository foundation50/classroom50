// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "count" in opts ? `${key}:${opts.count}` : key,
    }),
  }
})

import OrphanedInvitationsNotice from "./OrphanedInvitationsNotice"
import type { OrphanedFailedInvitation } from "@/util/orgMembers"

const orphan = (
  id: number,
  who: { login?: string; email?: string },
  kind: "expired" | "failed" = "expired",
): OrphanedFailedInvitation => ({
  invitation: {
    id,
    login: who.login ?? null,
    email: who.email ?? null,
    role: "direct_member",
    created_at: "",
    failed_at: "2026-09-07T00:41:28Z",
    failed_reason: kind === "expired" ? "Invitation expired." : "Email bounced",
  },
  ref: {
    id,
    kind,
    failed_at: "2026-09-07T00:41:28Z",
    reason: kind === "expired" ? "Invitation expired." : "Email bounced",
  },
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("OrphanedInvitationsNotice", () => {
  it("summarises collapsed, then lists identifiers on View details", () => {
    render(
      <OrphanedInvitationsNotice
        orphans={[
          orphan(1, { email: "gone@x.edu" }),
          orphan(2, { login: "left" }, "failed"),
        ]}
        busy={false}
        onDismiss={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    )
    expect(screen.getByText("orgMembers.orphanedInvitesTitle:2")).not.toBeNull()
    expect(screen.queryByText("gone@x.edu")).toBeNull()

    fireEvent.click(screen.getByText("orgMembers.orphanedInvitesView"))

    expect(screen.getByText("gone@x.edu")).not.toBeNull()
    expect(screen.getByText("@left")).not.toBeNull()
    // The bounce keeps GitHub's reason; the expiry doesn't repeat it.
    expect(screen.getByText("Email bounced")).not.toBeNull()
    expect(screen.queryByText("Invitation expired.")).toBeNull()
  })

  it("dismisses one or all by id", () => {
    const onDismiss = vi.fn()
    const onDismissAll = vi.fn()
    render(
      <OrphanedInvitationsNotice
        orphans={[
          orphan(1, { email: "gone@x.edu" }),
          orphan(2, { login: "left" }),
        ]}
        busy={false}
        onDismiss={onDismiss}
        onDismissAll={onDismissAll}
      />,
    )
    fireEvent.click(screen.getByText("orgMembers.orphanedInvitesDismissAll"))
    expect(onDismissAll).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText("orgMembers.orphanedInvitesView"))
    fireEvent.click(
      screen.getAllByText("orgMembers.orphanedInvitesDismiss")[1]!,
    )
    expect(onDismiss).toHaveBeenCalledWith(2)
  })

  it("renders nothing with no orphans", () => {
    const { container } = render(
      <OrphanedInvitationsNotice
        orphans={[]}
        busy={false}
        onDismiss={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    )
    expect(container.innerHTML).toBe("")
  })
})
