import { describe, expect, it } from "vitest"

import {
  templateForkNoteView,
  templateRestrictedNoteView,
} from "./templateNoteView"

describe("templateForkNoteView", () => {
  const base = {
    kind: "private-fork" as const,
    owner: "cs50",
    repo: "hw1",
    branch: "main",
  }

  it("renders an in-org parent as an amber warning with the in-org copy", () => {
    const view = templateForkNoteView({
      ...base,
      parent: "cs50/upstream",
      parentInOrg: true,
    })
    expect(view.tone).toBe("warning")
    expect(view.messageKey).toBe("assignments.template.privateForkInOrg")
  })

  it("renders a cross-org parent as a red error with the cross-org copy", () => {
    const view = templateForkNoteView({
      ...base,
      parent: "other-org/secret",
      parentInOrg: false,
    })
    expect(view.tone).toBe("error")
    expect(view.messageKey).toBe("assignments.template.privateForkCrossOrg")
  })

  it("renders an absent parent as a red error with the no-parent copy", () => {
    const view = templateForkNoteView({ ...base, parentInOrg: false })
    expect(view.tone).toBe("error")
    expect(view.messageKey).toBe("assignments.template.privateForkNoParent")
  })
})

describe("templateRestrictedNoteView", () => {
  const base = {
    kind: "restricted" as const,
    owner: "cs50",
    repo: "hw1",
    policyUrl: "https://github.com/orgs/cs50/policies",
    message: "IP allow list enabled",
    httpStatus: 403,
  }

  it("uses the scope-gap copy when scopeGap is true", () => {
    expect(
      templateRestrictedNoteView({ ...base, scopeGap: true }).messageKey,
    ).toBe("assignments.template.restrictedScope")
  })

  it("uses the org-restriction copy when scopeGap is false", () => {
    expect(
      templateRestrictedNoteView({ ...base, scopeGap: false }).messageKey,
    ).toBe("assignments.template.restricted")
  })
})
