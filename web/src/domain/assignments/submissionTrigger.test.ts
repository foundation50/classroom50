import { describe, expect, it } from "vitest"

import {
  rewriteShimTrigger,
  shimUpdateCommitMessage,
} from "./submissionTrigger"
import { defaultAutograderWorkflow } from "./autograderYaml"

// The CLI-accept shim differs from the web template only in its comment
// header — the retrofit must survive both and preserve everything around the
// trigger block. (The Go twin pins the same cases in submissionmode_test.go.)
const cliShimEveryPush = `# Classroom50 autograder shim.
#
# This file should not be edited.

name: Autograde

on:
  push:
    branches: ["main"]
    tags: ["submit/*"]

jobs:
  grade:
    uses: "o/classroom50/.github/workflows/autograde-runner.yaml@main"
    permissions:
      contents: write
      statuses: write
      pull-requests: write
`

describe("rewriteShimTrigger", () => {
  it("every-push → tag removes exactly the branches line (CLI-accepted shim)", () => {
    const result = rewriteShimTrigger(cliShimEveryPush, "tag", "main")
    if (result.kind !== "changed") throw new Error(`kind = ${result.kind}`)
    expect(result.content).not.toContain("branches:")
    expect(result.content).toBe(
      cliShimEveryPush.replace('    branches: ["main"]\n', ""),
    )
  })

  it("every-push → tag works on the web-rendered shim too", () => {
    const webShim = defaultAutograderWorkflow("o", "main", "main")
    const result = rewriteShimTrigger(webShim, "tag", "main")
    if (result.kind !== "changed") throw new Error(`kind = ${result.kind}`)
    // Equals what the web renders natively in tag mode.
    expect(result.content).toBe(
      defaultAutograderWorkflow("o", "main", "main", "tag"),
    )
  })

  it("tag → every-push inserts the branches line with the repo's CURRENT branch", () => {
    const tagShim = defaultAutograderWorkflow("o", "main", "main", "tag")
    const result = rewriteShimTrigger(tagShim, "every-push", "master")
    if (result.kind !== "changed") throw new Error(`kind = ${result.kind}`)
    expect(result.content).toContain(
      '    branches: ["master"]\n    tags: ["submit/*"]',
    )
  })

  it("is idempotent: already on target → current, no content", () => {
    const tagShim = defaultAutograderWorkflow("o", "main", "main", "tag")
    expect(rewriteShimTrigger(tagShim, "tag", "main").kind).toBe("current")
    expect(rewriteShimTrigger(cliShimEveryPush, "every-push", "main").kind).toBe(
      "current",
    )
  })

  it("refuses unrecognized content (never rewrites custom shims)", () => {
    for (const content of [
      "name: Custom\non:\n  workflow_dispatch: {}\njobs: {}\n",
      'on:\n  push:\n    branches: ["main"]\n', // no submit/* tags line
      "",
    ]) {
      expect(rewriteShimTrigger(content, "tag", "main").kind).toBe(
        "unrecognized",
      )
    }
  })

  it("round-trips: tag → every-push → tag restores the original", () => {
    const tagShim = defaultAutograderWorkflow("o", "main", "main", "tag")
    const toPush = rewriteShimTrigger(tagShim, "every-push", "main")
    if (toPush.kind !== "changed") throw new Error("expected change")
    const back = rewriteShimTrigger(toPush.content, "tag", "main")
    if (back.kind !== "changed") throw new Error("expected change")
    expect(back.content).toBe(tagShim)
  })
})

describe("shimUpdateCommitMessage", () => {
  it("is byte-identical to the Go contract.ShimUpdateCommitMessage", () => {
    // Pinned on the Go side by TestShimUpdateCommitMessage; the [skip ci] is
    // load-bearing (a tag→every-push retrofit commit must not grade itself).
    expect(shimUpdateCommitMessage("tag")).toBe(
      "[Classroom 50] Update autograder trigger to tag (submission-mode)\n\n[skip ci]",
    )
  })
})
