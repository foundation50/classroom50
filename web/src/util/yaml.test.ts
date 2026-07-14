import { describe, expect, it } from "vitest"
import { parseClassroom50Yaml } from "./yaml"
import { createClassroom50Yaml } from "@/domain/assignments"

describe("parseClassroom50Yaml back-compat", () => {
  it("parses a pre-v1 file with only classroom + assignment", () => {
    const cfg = parseClassroom50Yaml(`classroom: "cs50"\nassignment: "hw1"\n`)
    expect(cfg.classroom).toBe("cs50")
    expect(cfg.assignment).toBe("hw1")
    expect(cfg.owner).toBeUndefined()
    expect(cfg.source).toBeUndefined()
  })

  it("parses a CLI-authored file with a source block but no owner/schema", () => {
    const cfg = parseClassroom50Yaml(
      `classroom: "cs50"\nassignment: "hw1"\nsource:\n  owner: "acme"\n  repo: "tmpl"\n  branch: "main"\n`,
    )
    expect(cfg.source?.owner).toBe("acme")
  })

  it("throws when classroom or assignment is missing", () => {
    expect(() => parseClassroom50Yaml(`assignment: "hw1"\n`)).toThrow()
    expect(() => parseClassroom50Yaml(`classroom: "cs50"\n`)).toThrow()
  })
})

describe("createClassroom50Yaml -> parseClassroom50Yaml round trip", () => {
  it("round-trips a full v1 file with numeric owner id and source owner_id", () => {
    const yaml = createClassroom50Yaml({
      classroom: "cs50",
      assignment: "hw1",
      ownerUsername: "alice",
      ownerId: 12345,
      acceptedAt: "2026-06-25T17:42:09Z",
      sourceOwner: "acme",
      sourceOwnerId: 67890,
      sourceRepo: "tmpl",
      sourceBranch: "main",
    })

    // id MUST be an unquoted YAML number (the CLI parses *int64) — never "12345".
    expect(yaml).toMatch(/^ {2}id: 12345$/m)
    expect(yaml).toMatch(/^ {2}owner_id: 67890$/m)
    expect(yaml).not.toMatch(/id: "12345"/)

    const cfg = parseClassroom50Yaml(yaml)
    expect(cfg.schema).toBe("classroom50/repo-config/v1")
    expect(cfg.owner?.username).toBe("alice")
    expect(cfg.owner?.id).toBe(12345)
    expect(cfg.owner?.accepted_at).toBe("2026-06-25T17:42:09Z")
    expect(cfg.source?.owner).toBe("acme")
    expect(cfg.source?.owner_id).toBe(67890)
  })

  it("emits null (not a string) when ids are unresolved", () => {
    const yaml = createClassroom50Yaml({
      classroom: "cs50",
      assignment: "hw1",
      ownerUsername: "alice",
      ownerId: null,
    })
    expect(yaml).toMatch(/^ {2}id: null$/m)
    expect(yaml).not.toMatch(/id: "null"/)

    const cfg = parseClassroom50Yaml(yaml)
    expect(cfg.owner?.username).toBe("alice")
    expect(cfg.owner?.id).toBeNull()
  })

  it("omits the source block for a template-less assignment", () => {
    const yaml = createClassroom50Yaml({
      classroom: "cs50",
      assignment: "hw1",
      ownerUsername: "alice",
      ownerId: 1,
    })
    expect(yaml).not.toContain("source:")

    const cfg = parseClassroom50Yaml(yaml)
    expect(cfg.source).toBeUndefined()
  })

  it("emits and round-trips the secret when the classroom is protected", () => {
    const yaml = createClassroom50Yaml({
      classroom: "cs50",
      assignment: "hw1",
      ownerUsername: "alice",
      ownerId: 1,
      secret: "a1b2c3d4",
    })
    expect(yaml).toMatch(/^secret: "a1b2c3d4"$/m)

    const cfg = parseClassroom50Yaml(yaml)
    expect(cfg.secret).toBe("a1b2c3d4")
  })

  it("omits the secret line for an unprotected classroom", () => {
    const yaml = createClassroom50Yaml({
      classroom: "cs50",
      assignment: "hw1",
      ownerUsername: "alice",
      ownerId: 1,
    })
    expect(yaml).not.toMatch(/^secret:/m)

    const cfg = parseClassroom50Yaml(yaml)
    expect(cfg.secret).toBeUndefined()
  })
})
