import { describe, expect, it } from "vitest"

import { canonicalTemplateRef } from "./templateRefNormalize"
import type { TemplateAccessVerification } from "@/domain/assignments"

const ORG = "cs50"

const ok = (
  owner: string,
  repo: string,
  branch = "main",
): TemplateAccessVerification => ({
  kind: "ok",
  owner,
  repo,
  branch,
  visibility: "public",
  inOrg: owner === ORG,
})

describe("canonicalTemplateRef", () => {
  it("expands a confirmed bare name to owner/repo", () => {
    expect(canonicalTemplateRef(ok(ORG, "starter"), "starter")).toBe(
      "cs50/starter",
    )
  })

  it("rewrites to GitHub's canonical casing", () => {
    expect(canonicalTemplateRef(ok("ACME", "Starter"), "acme/starter")).toBe(
      "ACME/Starter",
    )
  })

  it("preserves a branch the teacher typed", () => {
    expect(canonicalTemplateRef(ok(ORG, "starter", "dev"), "starter@dev")).toBe(
      "cs50/starter@dev",
    )
  })

  it("never appends the resolved default branch (#673)", () => {
    // The verdict's branch is `main`, but the teacher didn't ask for it — the
    // rewrite must still change casing without pinning a branch.
    expect(canonicalTemplateRef(ok(ORG, "Starter"), "starter")).toBe(
      "cs50/Starter",
    )
  })

  it("returns null when the value is already canonical, so nothing rewrites", () => {
    expect(canonicalTemplateRef(ok(ORG, "starter"), "cs50/starter")).toBeNull()
  })

  it("is idempotent — normalizing its own output changes nothing", () => {
    const once = canonicalTemplateRef(ok(ORG, "starter"), "starter")
    expect(once).toBe("cs50/starter")
    expect(canonicalTemplateRef(ok(ORG, "starter"), once!)).toBeNull()
  })

  it("normalizes a pasted URL to owner/repo", () => {
    expect(
      canonicalTemplateRef(
        ok("acme", "starter"),
        "https://github.com/acme/starter",
      ),
    ).toBe("acme/starter")
  })

  it.each([
    "not-template",
    "empty-template",
    "no-branch",
    "private-out-of-org",
  ] as const)("normalizes on the confirmed-but-unusable verdict %s", (kind) => {
    // These verdicts still resolved a real repo, so the field should show its
    // real name while the note explains why it can't be used yet.
    const verification = {
      kind,
      owner: ORG,
      repo: "Starter",
    } as TemplateAccessVerification
    expect(canonicalTemplateRef(verification, "starter")).toBe("cs50/Starter")
  })

  it.each([
    { kind: "not-visible", owner: ORG, repo: "starter" },
    { kind: "rate-limited", owner: ORG, repo: "starter", outage: false },
    { kind: "unknown", owner: ORG, repo: "starter", outage: false },
  ])(
    "leaves the text alone on the unresolved verdict $kind",
    (verification) => {
      expect(
        canonicalTemplateRef(
          verification as TemplateAccessVerification,
          "starter",
        ),
      ).toBeNull()
    },
  )

  it("leaves the text alone on an invalid ref", () => {
    expect(
      canonicalTemplateRef(
        { kind: "invalid", message: { key: "x" } },
        "https://gitlab.com/a/b",
      ),
    ).toBeNull()
  })

  it("returns null with no verdict yet", () => {
    expect(canonicalTemplateRef(null, "starter")).toBeNull()
    expect(canonicalTemplateRef(undefined, "starter")).toBeNull()
  })

  it("returns null for an empty field", () => {
    expect(canonicalTemplateRef(ok(ORG, "starter"), "   ")).toBeNull()
  })
})
