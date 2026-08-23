// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts down.
import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { migrateClassroom } from "./migrate"
import type {
  ClassroomAssignmentDetail,
  ClassroomDetail,
  MigrationItem,
  MigrationItemStatus,
  MigrationPreflight,
} from "./types"

const emptyRateLimit = {
  limit: null,
  remaining: null,
  reset: null,
  used: null,
  resource: null,
  retryAfter: null,
}
const notFound = (url: string) =>
  new GitHubAPIError({
    status: 404,
    url,
    message: "Not Found",
    body: null,
    rateLimit: emptyRateLimit,
  })

const classroom: ClassroomDetail = {
  id: 1,
  name: "CS 50",
  archived: false,
  url: "https://classroom.github.com/classrooms/1",
  organization: { id: 1, login: "src-org" },
}

const assignment = (
  over: Partial<ClassroomAssignmentDetail> = {},
): ClassroomAssignmentDetail => {
  const slug = (over.slug as string) ?? "hw1"
  return {
    id: 10,
    public_repo: true,
    title: "HW1",
    type: "individual",
    invite_link: "",
    slug: "hw1",
    deadline: null,
    max_teams: null,
    starter_code_repository: {
      id: 9,
      name: slug,
      full_name: `src/${slug}`,
      private: true,
      default_branch: "main",
    },
    ...over,
  }
}

const importItem = (
  slug = "hw1",
  over: Partial<MigrationItem> = {},
): MigrationItem => ({
  assignment: assignment({ slug, id: slug === "hw1" ? 10 : 11 }),
  action: "import",
  targetName: slug,
  targetPrivate: true,
  ...over,
})

function plan(items: MigrationItem[]): MigrationPreflight {
  return {
    classroom,
    targetOrg: "dst",
    name: "CS 50",
    shortName: "cs-50",
    term: "Fall-2026",
    templateSuffix: "",
    items,
    renames: [],
    counts: {
      import: items.filter((i) => i.action === "import").length,
      reuse: items.filter((i) => i.action === "reuse").length,
      skip: items.filter((i) => i.action === "skip").length,
    },
    blockers: [],
  }
}

// Route-table client. `failGenerateFor` forces a generate failure for a slug.
// `dirExistsAtStart` makes the pre-write dir check report an existing classroom.
function makeClient(opts: {
  failGenerateFor?: string
  dirExistsAtStart?: boolean
}): {
  client: GitHubClient
  committed: () => Record<string, unknown>
  grants: () => string[]
} {
  const grants: string[] = []
  let committedTree: Record<string, string> = {}

  const request = vi.fn(
    async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET"

      // Pre-write dir existence check
      if (url.includes(`/${"classroom50"}/contents/`)) {
        if (opts.dirExistsAtStart) return { type: "file" }
        throw notFound(url)
      }
      // generate
      if (url.endsWith("/generate")) {
        const slug = url.match(/\/repos\/src\/([^/]+)\/generate/)?.[1]
        if (slug && opts.failGenerateFor === slug)
          throw new Error("generate boom")
        return { default_branch: "main" }
      }
      // mark as template (PATCH /repos/dst/<name>)
      if (method === "PATCH" && /^\/repos\/dst\/[^/]+$/.test(url)) return {}
      // config repo default branch
      if (/^\/repos\/dst\/classroom50$/.test(url))
        return { default_branch: "main" }
      // config-repo ref/commit reads for the scaffold commit (checked before the
      // generic template branch-wait route below)
      if (url.includes("/classroom50/git/ref/heads/main"))
        return { object: { sha: "parent" } }
      if (url.includes("/classroom50/git/commits/"))
        return { tree: { sha: "basetree" } }
      // template branch-wait ref read (any non-config repo)
      if (url.includes("/git/ref/heads/")) return { object: { sha: "s" } }
      // team create/adopt
      if (method === "POST" && /\/orgs\/dst\/teams$/.test(url)) {
        const name = (init?.body as { name: string }).name
        return { id: name.length, slug: name }
      }
      if (method === "GET" && /\/orgs\/dst\/teams\/[^/]+$/.test(url)) {
        const slug = url.split("/").pop() as string
        return { id: slug.length, slug, privacy: "secret" }
      }
      // config-repo grant PUT to config repo (ensureStaffTeams) or template grant
      if (method === "PUT" && /\/orgs\/dst\/teams\/[^/]+\/repos\//.test(url)) {
        grants.push(url)
        return {}
      }
      // membership add/remove
      if (/\/memberships\//.test(url)) return {}
      // blob/tree/commit writes
      if (url.endsWith("/git/blobs")) {
        const body = init?.body as { content: string }
        // stash blob content by a synthetic sha we can map in the tree write
        const sha = `blob${Object.keys(committedTree).length}`
        committedTree[sha] = body.content
        return { sha }
      }
      if (url.endsWith("/git/trees")) {
        const body = init?.body as {
          tree: Array<{ path: string; sha: string }>
        }
        const mapped: Record<string, string> = {}
        for (const t of body.tree) mapped[t.path] = committedTree[t.sha]
        committedTree = { ...committedTree, __paths: JSON.stringify(mapped) }
        return { sha: "newtree" }
      }
      if (url.endsWith("/git/commits")) return { sha: "newcommit" }
      if (method === "PATCH" && url.includes("/git/refs/heads/main"))
        return { object: { sha: "newcommit" } }

      throw new Error(`unexpected: ${method} ${url}`)
    },
  )

  return {
    client: { request } as unknown as GitHubClient,
    committed: () =>
      JSON.parse((committedTree.__paths as string) ?? "{}") as Record<
        string,
        unknown
      >,
    grants: () => grants,
  }
}

describe("migrateClassroom", () => {
  it("commits the scaffold with entries + migrated_from and returns counts", async () => {
    const { client, committed } = makeClient({})
    const statuses: MigrationItemStatus[] = []
    const result = await migrateClassroom(client, plan([importItem("hw1")]), {
      creator: "prof",
      onItem: (s) => statuses.push(s),
    })

    expect(result.generated).toBe(1)
    expect(result.skipped).toHaveLength(0)
    expect(result.commitSha).toBe("newcommit")

    const paths = committed()
    const classroomJson = JSON.parse(paths["cs-50/classroom.json"] as string)
    expect(classroomJson.migrated_from).toMatchObject({
      source: "github_classroom",
      classroom_id: 1,
    })
    expect(classroomJson.term).toBe("Fall-2026")
    expect(classroomJson.name).toBe("CS 50")
    const assignmentsJson = JSON.parse(
      paths["cs-50/assignments.json"] as string,
    )
    expect(assignmentsJson.assignments).toHaveLength(1)
    expect(assignmentsJson.assignments[0].autograder).toBe("default")

    // onItem streamed running -> generated
    expect(statuses.map((s) => s.status)).toEqual(["running", "generated"])
  })

  it("imports a template-less assignment with no template and no generate call", async () => {
    const { client, committed } = makeClient({})
    const templateLessItem: MigrationItem = {
      assignment: assignment({
        slug: "essay",
        id: 20,
        starter_code_repository: null,
      }),
      action: "import",
      targetName: "essay",
      templateLess: true,
    }
    const result = await migrateClassroom(client, plan([templateLessItem]), {})
    expect(result.generated).toBe(1)
    expect(result.skipped).toHaveLength(0)

    const assignmentsJson = JSON.parse(
      committed()["cs-50/assignments.json"] as string,
    )
    expect(assignmentsJson.assignments).toHaveLength(1)
    expect(assignmentsJson.assignments[0].slug).toBe("essay")
    expect(assignmentsJson.assignments[0].template).toBeUndefined()
  })

  it("uses an overridden class name in classroom.json", async () => {
    const { client, committed } = makeClient({})
    await migrateClassroom(
      client,
      { ...plan([importItem("hw1")]), name: "Intro to CS (Fall)" },
      {},
    )
    const classroomJson = JSON.parse(
      committed()["cs-50/classroom.json"] as string,
    )
    expect(classroomJson.name).toBe("Intro to CS (Fall)")
  })

  it("downgrades a failed copy to skipped but still commits the rest", async () => {
    const { client, committed } = makeClient({ failGenerateFor: "hw2" })
    const result = await migrateClassroom(
      client,
      plan([importItem("hw1"), importItem("hw2")]),
      {},
    )
    expect(result.generated).toBe(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ slug: "hw2" })
    expect(result.skipped[0].reason?.key).toBe("migration.reason.copyFailed")

    const assignmentsJson = JSON.parse(
      committed()["cs-50/assignments.json"] as string,
    )
    expect(
      assignmentsJson.assignments.map((a: { slug: string }) => a.slug),
    ).toEqual(["hw1"])
  })

  it("refuses to overwrite when the dir appeared before the write", async () => {
    const { client } = makeClient({ dirExistsAtStart: true })
    await expect(
      migrateClassroom(client, plan([importItem("hw1")]), {}),
    ).rejects.toThrow(/already exists/)
  })

  it("grants the classroom team pull on a private template", async () => {
    const { client, grants } = makeClient({})
    await migrateClassroom(client, plan([importItem("hw1")]), {})
    // At least the student team gets a pull grant on the private template repo.
    expect(
      grants().some((g) =>
        /\/teams\/classroom50-cs-50\/repos\/dst\/hw1$/.test(g),
      ),
    ).toBe(true)
  })

  it("throws when the plan still has blockers", async () => {
    const { client } = makeClient({})
    const blocked = {
      ...plan([importItem("hw1")]),
      blockers: [{ kind: "dir_exists" as const }],
    }
    await expect(migrateClassroom(client, blocked, {})).rejects.toThrow(
      /blockers/,
    )
  })
})
