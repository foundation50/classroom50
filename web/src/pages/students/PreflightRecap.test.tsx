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

describe("PreflightRecap metadata rendering", () => {
  it("renders the per-field stored->CSV delta and the (empty) fallback", () => {
    const preflight = baseResult({
      metadataUpdate: [
        {
          kind: "metadata_update",
          username: "ada",
          role: "student",
          changedFields: ["email", "section"],
          changes: [
            { field: "email", from: "old@x.edu", to: "new@x.edu" },
            // A previously-blank field exercises the (empty) fallback.
            { field: "section", from: "", to: "Lab 3" },
          ],
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

    // Email delta shows the concrete from -> to values.
    expect(
      screen.getByText(
        /preflightMetadataDetail:.*from=old@x\.edu,to=new@x\.edu/,
      ),
    ).toBeTruthy()
    // Blank stored value renders via the (empty) fallback key, not a literal "".
    expect(
      screen.getByText(
        /preflightMetadataDetail:.*from=students\.preflightMetadataEmpty,to=Lab 3/,
      ),
    ).toBeTruthy()
    // The metadata confirmation checkbox is present.
    expect(screen.getByText(/preflightConfirmMetadata:count=1/)).toBeTruthy()
  })

  it("shows a role-change row's metadata delta and the combined-save notice", () => {
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

    // The role move is listed AND its metadata delta is shown beneath it, so the
    // detail overwrite is visible under the role-change confirmation (not silent).
    expect(
      screen.getByText(
        /preflightMetadataDetail:.*from=old@x\.edu,to=new@x\.edu/,
      ),
    ).toBeTruthy()
    // The notice tells the teacher details are saved with the team change.
    expect(
      screen.getByText("students.preflightRoleChangeMetadataNotice"),
    ).toBeTruthy()
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
