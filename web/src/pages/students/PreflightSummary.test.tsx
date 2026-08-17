// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

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

import { PreflightSummary, summarizePreflight } from "./PreflightSummary"
import type { PreflightResult } from "@/util/rosterUploadPreflight"

afterEach(cleanup)

const result = (over: Partial<PreflightResult> = {}): PreflightResult => ({
  outcomes: [],
  noAction: [],
  metadataUpdate: [],
  needsInvite: [],
  enroll: [],
  roleChanges: [],
  identityMismatches: [],
  allAlreadyMembers: true,
  ...over,
})

const mk = (username: string, role = "student" as const) => ({
  kind: "no_action" as const,
  username,
  role,
})

describe("summarizePreflight", () => {
  it("collapses the five buckets into add / update / skip", () => {
    const s = summarizePreflight(
      result({
        needsInvite: [{ kind: "needs_invite", username: "a", role: "student" }],
        enroll: [
          {
            kind: "enroll",
            username: "b",
            role: "student",
            changedFields: [],
            changes: [],
          },
        ],
        metadataUpdate: [
          {
            kind: "metadata_update",
            username: "c",
            role: "student",
            changedFields: ["email"],
            changes: [{ field: "email", from: "x", to: "y" }],
          },
        ],
        roleChanges: [
          {
            kind: "role_change",
            username: "d",
            role: "ta",
            currentRole: "student",
            currentRoles: ["student"],
            changedFields: [],
            changes: [],
          },
        ],
        noAction: [mk("e"), mk("f")],
      }),
    )
    expect(s.addCount).toBe(2) // invite + enroll
    expect(s.updateCount).toBe(2) // metadata + role_change
    expect(s.skipCount).toBe(2) // no_action
  })
})

describe("PreflightSummary", () => {
  it("renders only non-zero categories as count pills", () => {
    render(
      <PreflightSummary
        preflight={result({
          needsInvite: [
            { kind: "needs_invite", username: "a", role: "student" },
          ],
          noAction: [mk("b")],
        })}
        detailsOpen={false}
        onToggleDetails={() => {}}
      />,
    )
    // add (1) and skip (1) present; update (0) hidden.
    expect(screen.getByText("students.summary_add:1")).toBeTruthy()
    expect(screen.getByText("students.summary_skip:1")).toBeTruthy()
    expect(screen.queryByText(/summary_update/)).toBeNull()
  })

  it("shows a no-changes message when every category is empty", () => {
    render(
      <PreflightSummary
        preflight={result()}
        detailsOpen={false}
        onToggleDetails={() => {}}
      />,
    )
    expect(screen.getByText("students.summaryNoChanges")).toBeTruthy()
  })

  it("toggles the details label and fires the callback", async () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <PreflightSummary
        preflight={result({ noAction: [mk("a")] })}
        detailsOpen={false}
        onToggleDetails={onToggle}
      />,
    )
    const btn = screen.getByRole("button", {
      name: "students.summaryViewDetails",
    })
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    btn.click()
    expect(onToggle).toHaveBeenCalledOnce()

    rerender(
      <PreflightSummary
        preflight={result({ noAction: [mk("a")] })}
        detailsOpen={true}
        onToggleDetails={onToggle}
      />,
    )
    expect(
      screen.getByRole("button", { name: "students.summaryHideDetails" }),
    ).toBeTruthy()
  })
})
