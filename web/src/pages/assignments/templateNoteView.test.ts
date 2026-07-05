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
    expect(view.labelKey).toBe("assignments.template.privateForkInOrg_1")
    expect(view.suffixKey).toBe("assignments.template.privateForkInOrg_2")
  })

  it("renders a cross-org parent as a red error with the cross-org copy", () => {
    const view = templateForkNoteView({
      ...base,
      parent: "other-org/secret",
      parentInOrg: false,
    })
    expect(view.tone).toBe("error")
    expect(view.labelKey).toBe("assignments.template.privateForkCrossOrg_1")
    expect(view.suffixKey).toBe("assignments.template.privateForkCrossOrg_2")
  })

  it("renders an absent parent as a red error with the no-parent label and cross-org suffix", () => {
    const view = templateForkNoteView({ ...base, parentInOrg: false })
    expect(view.tone).toBe("error")
    expect(view.labelKey).toBe("assignments.template.privateForkNoParent_1")
    // No dedicated privateForkNoParent_2 key — unknown upstream is the
    // higher-risk cross-org case and reuses that suffix.
    expect(view.suffixKey).toBe("assignments.template.privateForkCrossOrg_2")
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
