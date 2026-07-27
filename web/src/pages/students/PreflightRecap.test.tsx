// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    // Echo the key + interpolated params so assertions can match on content.
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

import { PreflightRecap } from "./PreflightRecap"
import type { PreflightResult } from "@/util/rosterUploadPreflight"

afterEach(cleanup)

const baseResult = (over: Partial<PreflightResult> = {}): PreflightResult => ({
  outcomes: [],
  noAction: [],
  metadataUpdate: [],
  needsInvite: [],
  enroll: [],
  roleChanges: [],
  allAlreadyMembers: true,
  ...over,
})

const noop = () => {}

describe("PreflightRecap metadata confirmation", () => {
  it("gates metadata updates behind a review hint + checkbox, not a text list", () => {
    const preflight = baseResult({
      metadataUpdate: [
        {
          kind: "metadata_update",
          username: "ada",
          role: "student",
          changedFields: ["email"],
          changes: [{ field: "email", from: "old@x.edu", to: "new@x.edu" }],
        },
      ],
    })
    render(
      <PreflightRecap
        preflight={preflight}
        roleChanges={[]}
        teacherEnrolls={[]}
        needsRoleConfirm={false}
        confirmGrantsOwner={false}
        roleChangesConfirmed={false}
        onRoleChangesConfirmedChange={noop}
        needsMetadataConfirm={true}
        metadataConfirmed={false}
        onMetadataConfirmedChange={noop}
      />,
    )

    // The recap points the teacher to the highlighted table cells...
    expect(screen.getByText(/preflightMetadataReviewHint:count=1/)).toBeTruthy()
    // ...and gates the write with the confirmation checkbox.
    expect(screen.getByText(/preflightConfirmMetadata:count=1/)).toBeTruthy()
    // The per-field stored->CSV values are shown in the table, NOT re-listed here.
    expect(screen.queryByText(/preflightMetadataDetail/)).toBeNull()
  })

  it("shows the combined-save notice for a role-change row carrying metadata", () => {
    const preflight = baseResult({
      allAlreadyMembers: false,
      roleChanges: [
        {
          kind: "role_change",
          username: "userb",
          role: "ta",
          currentRole: "student",
          currentRoles: ["student"],
          changedFields: ["email"],
          changes: [{ field: "email", from: "old@x.edu", to: "new@x.edu" }],
        },
      ],
    })
    render(
      <PreflightRecap
        preflight={preflight}
        roleChanges={preflight.roleChanges}
        teacherEnrolls={[]}
        needsRoleConfirm={true}
        confirmGrantsOwner={false}
        roleChangesConfirmed={false}
        onRoleChangesConfirmedChange={noop}
        needsMetadataConfirm={false}
        metadataConfirmed={false}
        onMetadataConfirmedChange={noop}
      />,
    )
    // The role move is listed; its metadata delta is shown in the table, but the
    // recap warns the teacher that details are saved with the move.
    expect(
      screen.getByText("students.preflightRoleChangeMetadataNotice"),
    ).toBeTruthy()
    expect(screen.queryByText(/preflightMetadataDetail/)).toBeNull()
  })

  it("omits the combined-save notice when no role-change row carries metadata", () => {
    const preflight = baseResult({
      allAlreadyMembers: false,
      roleChanges: [
        {
          kind: "role_change",
          username: "userb",
          role: "ta",
          currentRole: "student",
          currentRoles: ["student"],
          changedFields: [],
          changes: [],
        },
      ],
    })
    render(
      <PreflightRecap
        preflight={preflight}
        roleChanges={preflight.roleChanges}
        teacherEnrolls={[]}
        needsRoleConfirm={true}
        confirmGrantsOwner={false}
        roleChangesConfirmed={false}
        onRoleChangesConfirmedChange={noop}
        needsMetadataConfirm={false}
        metadataConfirmed={false}
        onMetadataConfirmedChange={noop}
      />,
    )
    expect(
      screen.queryByText("students.preflightRoleChangeMetadataNotice"),
    ).toBeNull()
  })
})
