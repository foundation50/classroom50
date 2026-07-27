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

import { PreflightRecap } from "./PreflightRecap"
import type { PreflightResult } from "@/util/rosterUploadPreflight"

afterEach(cleanup)

const noop = () => {}

type RoleChange = PreflightResult["roleChanges"][number]

const roleChange = (over: Partial<RoleChange> = {}): RoleChange => ({
  kind: "role_change",
  username: "userb",
  role: "ta",
  currentRole: "student",
  currentRoles: ["student"],
  changedFields: [],
  changes: [],
  ...over,
})

describe("PreflightRecap confirmation gate", () => {
  it("renders nothing when no confirmation is required", () => {
    const { container } = render(
      <PreflightRecap
        roleChanges={[]}
        teacherEnrolls={[]}
        needsRoleConfirm={false}
        confirmGrantsOwner={false}
        roleChangesConfirmed={false}
        onRoleChangesConfirmedChange={noop}
        needsMetadataConfirm={false}
        metadataUpdateCount={0}
        metadataConfirmed={false}
        onMetadataConfirmedChange={noop}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("gates metadata updates behind a review hint + checkbox, not a text list", () => {
    render(
      <PreflightRecap
        roleChanges={[]}
        teacherEnrolls={[]}
        needsRoleConfirm={false}
        confirmGrantsOwner={false}
        roleChangesConfirmed={false}
        onRoleChangesConfirmedChange={noop}
        needsMetadataConfirm={true}
        metadataUpdateCount={1}
        metadataConfirmed={false}
        onMetadataConfirmedChange={noop}
      />,
    )
    expect(screen.getByText(/preflightMetadataReviewHint:1/)).toBeTruthy()
    expect(screen.getByText(/preflightConfirmMetadata:1/)).toBeTruthy()
    // Per-field stored->CSV values live in the table, not re-listed here.
    expect(screen.queryByText(/preflightMetadataDetail/)).toBeNull()
  })

  it("shows the combined-save notice for a role-change row carrying metadata", () => {
    render(
      <PreflightRecap
        roleChanges={[
          roleChange({
            changedFields: ["email"],
            changes: [{ field: "email", from: "old@x.edu", to: "new@x.edu" }],
          }),
        ]}
        teacherEnrolls={[]}
        needsRoleConfirm={true}
        confirmGrantsOwner={false}
        roleChangesConfirmed={false}
        onRoleChangesConfirmedChange={noop}
        needsMetadataConfirm={false}
        metadataUpdateCount={0}
        metadataConfirmed={false}
        onMetadataConfirmedChange={noop}
      />,
    )
    expect(
      screen.getByText("students.preflightRoleChangeMetadataNotice"),
    ).toBeTruthy()
    expect(screen.queryByText(/preflightMetadataDetail/)).toBeNull()
  })

  it("omits the combined-save notice when no role-change row carries metadata", () => {
    render(
      <PreflightRecap
        roleChanges={[roleChange()]}
        teacherEnrolls={[]}
        needsRoleConfirm={true}
        confirmGrantsOwner={false}
        roleChangesConfirmed={false}
        onRoleChangesConfirmedChange={noop}
        needsMetadataConfirm={false}
        metadataUpdateCount={0}
        metadataConfirmed={false}
        onMetadataConfirmedChange={noop}
      />,
    )
    expect(
      screen.queryByText("students.preflightRoleChangeMetadataNotice"),
    ).toBeNull()
  })
})
