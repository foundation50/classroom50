import { describe, expect, it } from "vitest"

import { templateForkNoteView } from "./templateNoteView"

describe("templateForkNoteView", () => {
  const base = {
    kind: "private-fork" as const,
    owner: "cs50",
    repo: "hw1",
    branch: "main",
  }

  it("selects the in-org copy for an in-org parent", () => {
    const view = templateForkNoteView({
      ...base,
      parent: "cs50/upstream",
      parentInOrg: true,
    })
    expect(view.messageKey).toBe("assignments.template.privateForkInOrg")
  })

  it("selects the cross-org copy for a cross-org parent", () => {
    const view = templateForkNoteView({
      ...base,
      parent: "other-org/secret",
      parentInOrg: false,
    })
    expect(view.messageKey).toBe("assignments.template.privateForkCrossOrg")
  })

  it("selects the no-parent copy when the parent is absent", () => {
    const view = templateForkNoteView({ ...base, parentInOrg: false })
    expect(view.messageKey).toBe("assignments.template.privateForkNoParent")
  })
})
