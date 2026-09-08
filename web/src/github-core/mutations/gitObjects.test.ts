import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"

import {
  createClassroomMetadata,
  createGitCommit,
  createGitTree,
  createRepoCommit,
  createRepoTree,
  assignmentAcceptTree,
  updateRef,
  updateRepoRef,
} from "./gitObjects"
import type { StaffTeamRefs } from "./teams"

const makeClient = () => {
  const request = vi.fn<(path: string, init?: unknown) => Promise<unknown>>(
    async () => ({ sha: "NEW" }),
  )
  return { client: { request } as unknown as GitHubClient, request }
}

describe("git-data primitives", () => {
  it("createRepoTree posts the entries on the base tree of the given repo", async () => {
    const { client, request } = makeClient()
    const tree = [
      {
        path: "a.json",
        mode: "100644" as const,
        type: "blob" as const,
        content: "{}",
      },
      {
        path: "old",
        mode: "100644" as const,
        type: "blob" as const,
        sha: null,
      },
    ]
    await createRepoTree(client, {
      owner: "acme",
      repo: "hw1-ann",
      baseTreeSha: "BASE",
      tree,
    })
    expect(request).toHaveBeenCalledWith("/repos/acme/hw1-ann/git/trees", {
      method: "POST",
      body: { base_tree: "BASE", tree },
    })
  })

  it("createRepoCommit parents the commit on one sha", async () => {
    const { client, request } = makeClient()
    await createRepoCommit(client, {
      owner: "acme",
      repo: "hw1-ann",
      message: "m",
      treeSha: "T",
      parentSha: "P",
    })
    expect(request).toHaveBeenCalledWith("/repos/acme/hw1-ann/git/commits", {
      method: "POST",
      body: { message: "m", tree: "T", parents: ["P"] },
    })
  })

  // Fast-forward only, and a branch with a slash is one path segment to the
  // refs API, so it must be encoded rather than split.
  it("updateRepoRef moves the ref without force and encodes the branch", async () => {
    const { client, request } = makeClient()
    await updateRepoRef(client, {
      owner: "acme",
      repo: "hw1-ann",
      branch: "release/2026",
      commitSha: "C",
    })
    expect(request).toHaveBeenCalledWith(
      "/repos/acme/hw1-ann/git/refs/heads/release%2F2026",
      { method: "PATCH", body: { sha: "C", force: false } },
    )
  })

  it("the config-repo partials fix the repo and keep their old shapes", async () => {
    const { client, request } = makeClient()
    await createGitTree(client, { org: "acme", base_tree: "BASE", tree: [] })
    await createGitCommit(client, {
      org: "acme",
      message: "m",
      tree_sha: "T",
      parents: ["P"],
    })
    await updateRef(client, "acme", "C")
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "/repos/acme/classroom50/git/trees",
      "/repos/acme/classroom50/git/commits",
      "/repos/acme/classroom50/git/refs/heads/main",
    ])
  })
})

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
describe("assignmentAcceptTree entries", () => {
  const metadataYaml = "classroom: cs"

  it("commits marker + shim, no deletions, by default", () => {
    const tree = assignmentAcceptTree({
      metadataYaml,
      autogradeYaml: "name: a",
    })
    expect(tree.map((e) => e.path)).toEqual([
      ".classroom50.yaml",
      ".github/workflows/autograde.yaml",
    ])
    expect(tree.every((e) => !("sha" in e))).toBe(true)
  })

  it("an empty shim commits only the marker", () => {
    const tree = assignmentAcceptTree({ metadataYaml, autogradeYaml: "" })
    expect(tree.map((e) => e.path)).toEqual([".classroom50.yaml"])
  })

  it("deletePaths posts sha:null deletion entries (init_shim README removal)", () => {
    const tree = assignmentAcceptTree({
      metadataYaml,
      autogradeYaml: "name: a",
      deletePaths: ["README.md"],
    })
    const readme = tree.find((e) => e.path === "README.md")
    expect(readme).toEqual({
      path: "README.md",
      mode: "100644",
      type: "blob",
      sha: null,
    })
  })
})
