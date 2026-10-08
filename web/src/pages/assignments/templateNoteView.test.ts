import { describe, expect, it } from "vitest"

import { teamGrantTemplate, templateForkNoteView } from "./templateNoteView"

describe("templateForkNoteView", () => {
  const base = {
    kind: "private-fork" as const,
    owner: "cs50",
    repo: "hw1",
    branch: "main",
    forksCount: 0,
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

describe("teamGrantTemplate", () => {
  const okBase = {
    kind: "ok" as const,
    owner: "cs50",
    repo: "tmpl",
    branch: "main",
    forksCount: 4,
  }

  it("returns the template for an in-org private ok verdict", () => {
    expect(
      teamGrantTemplate({ ...okBase, visibility: "private", inOrg: true }),
    ).toEqual({ owner: "cs50", repo: "tmpl", branch: "main", forksCount: 4 })
  })

  it("returns the template for every private-fork verdict", () => {
    expect(
      teamGrantTemplate({
        kind: "private-fork",
        owner: "cs50",
        repo: "hw1",
        branch: "main",
        parentInOrg: true,
        forksCount: 2,
      }),
    ).toEqual({ owner: "cs50", repo: "hw1", branch: "main", forksCount: 2 })
  })

  it("is null when no team grant fires", () => {
    expect(
      teamGrantTemplate({ ...okBase, visibility: "public", inOrg: true }),
    ).toBeNull()
    expect(
      teamGrantTemplate({ ...okBase, visibility: "private", inOrg: false }),
    ).toBeNull()
    expect(teamGrantTemplate({ kind: "empty" })).toBeNull()
    expect(teamGrantTemplate(null)).toBeNull()
  })
})
