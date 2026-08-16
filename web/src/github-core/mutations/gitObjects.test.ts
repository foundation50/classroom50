import { describe, expect, it, vi } from "vitest"
import { createClassroomMetadata, createTreeForAssignment } from "./gitObjects"
import type { GitHubClient } from "@/github-core/client"
import type { StaffTeamRefs } from "./teams"

// Pins the classroom.json `teams` persistence gate in createClassroomMetadata.
// A too-narrow gate reading only (teams.teacher || teams.ta) would silently
// drop the teams block for an hta-only classroom on create. These assert every
// staff-role-only block is persisted (and that an empty/absent block is still
// omitted, matching the CLI's `omitempty`).
describe("createClassroomMetadata teams persistence", () => {
  const teacher = { id: 1, slug: "classroom50-cs-teacher" }
  const ta = { id: 2, slug: "classroom50-cs-ta" }
  const hta = { id: 3, slug: "classroom50-cs-hta" }

  const build = (teams?: StaffTeamRefs) =>
    createClassroomMetadata(
      "org",
      "cs",
      undefined,
      "fall",
      undefined,
      undefined,
      teams,
    )

  it("persists a teacher-only teams block (the rename regression)", () => {
    const meta = build({ teacher })
    expect(meta.teams).toEqual({ teacher })
  })

  it("persists a ta-only teams block", () => {
    const meta = build({ ta })
    expect(meta.teams).toEqual({ ta })
  })

  it("persists an hta-only teams block", () => {
    const meta = build({ hta })
    expect(meta.teams).toEqual({ hta })
  })

  it("persists a full teacher+ta block", () => {
    const meta = build({ teacher, ta })
    expect(meta.teams).toEqual({ teacher, ta })
  })

  it("omits an empty or absent teams block (matches CLI omitempty)", () => {
    expect(build(undefined).teams).toBeUndefined()
    expect(build({}).teams).toBeUndefined()
  })
})

// Pins the accept-commit tree shape: the no-shim (empty autogradeYaml) case
// commits only the marker, and the init_shim deletePaths case posts a
// `sha: null` deletion entry (the Trees API's "remove from base_tree") so the
// auto_init README is removed in the same commit. Mirrors the CLI's
// classroomcfg.DropFiles tests.
describe("createTreeForAssignment tree entries", () => {
  const capture = () => {
    const request = vi.fn(async () => ({ sha: "tree-sha" }))
    const client = { request } as unknown as GitHubClient
    const treeOf = () => {
      const call = request.mock.calls[0] as unknown as [
        string,
        { body: { tree: { path: string; content?: string; sha?: null }[] } },
      ]
      return call[1].body.tree
    }
    return { client, treeOf }
  }

  const base = {
    owner: "org",
    repo: "hw-alice",
    baseTreeSha: "base",
    metadataYaml: "classroom: cs",
  }

  it("commits marker + shim, no deletions, by default", async () => {
    const { client, treeOf } = capture()
    await createTreeForAssignment({ client, ...base, autogradeYaml: "name: a" })
    const paths = treeOf().map((e) => e.path)
    expect(paths).toEqual([
      ".classroom50.yaml",
      ".github/workflows/autograde.yaml",
    ])
    expect(treeOf().every((e) => e.sha === undefined)).toBe(true)
  })

  it("an empty shim commits only the marker", async () => {
    const { client, treeOf } = capture()
    await createTreeForAssignment({ client, ...base, autogradeYaml: "" })
    expect(treeOf().map((e) => e.path)).toEqual([".classroom50.yaml"])
  })

  it("deletePaths posts sha:null deletion entries (init_shim README removal)", async () => {
    const { client, treeOf } = capture()
    await createTreeForAssignment({
      client,
      ...base,
      autogradeYaml: "name: a",
      deletePaths: ["README.md"],
    })
    const readme = treeOf().find((e) => e.path === "README.md")
    expect(readme).toBeDefined()
    expect(readme?.sha).toBeNull()
    expect(readme?.content).toBeUndefined()
  })
})
