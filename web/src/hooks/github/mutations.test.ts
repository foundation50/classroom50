import { describe, expect, it, vi } from "vitest"

import {
  buildClassroomUpdate,
  editClassroom,
  ensurePages,
  ensureSkeletonFiles,
  ensureWorkflowPermissions,
  findStaleSkeletonFiles,
  gitBlobSha,
  triggerRegrade,
  validateServiceToken,
  REGRADE_WORKFLOW,
} from "./mutations"
import { GitHubAPIError } from "./errors"
import { createGitHubClient } from "./client"
import { buildSkeletonFiles } from "@/skeleton/skeleton"

// validateServiceToken builds its own client from the pasted token via
// createGitHubClient; mock the module so the test can drive that client's
// `request` to simulate GitHub's repo-permissions read.
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>()
  return { ...actual, createGitHubClient: vi.fn() }
})
import type { GitHubClient } from "./client"

// classroom.json is a strict cross-binary contract (the Go gh-teacher CLI
// round-trips it with DisallowUnknownFields), so the edit merge must (a) only
// write fields the caller actually changed and (b) preserve everything else —
// including unknown/future fields a sibling binary wrote. Mirrors the
// present/absent discipline of util/yaml.test.ts.
describe("buildClassroomUpdate", () => {
  const base = {
    schema: "classroom50/classroom/v1",
    name: "Intro CS",
    short_name: "intro-cs",
    term: "Fall 2026",
    org: "acme",
  }

  it("writes a field only when provided; omits it otherwise", () => {
    expect(buildClassroomUpdate(base, { name: "Renamed" })).toEqual({
      ...base,
      name: "Renamed",
    })
    // A name-only edit leaves term untouched.
    const out = buildClassroomUpdate(base, { name: "Renamed" })
    expect(out.term).toBe("Fall 2026")
  })

  it("archive writes active:false; unarchive writes active:true (not delete)", () => {
    const archived = buildClassroomUpdate(base, { active: false })
    expect(archived.active).toBe(false)

    // Unarchiving an already-archived record overwrites false with true.
    const unarchived = buildClassroomUpdate(
      { ...base, active: false },
      { active: true },
    )
    expect(unarchived.active).toBe(true)
  })

  it("a pure archive toggle preserves the persisted name/term", () => {
    const out = buildClassroomUpdate(base, { active: false })
    expect(out.name).toBe("Intro CS")
    expect(out.term).toBe("Fall 2026")
    expect(out.active).toBe(false)
  })

  it("a name/term edit does NOT introduce an active key on a legacy record", () => {
    // Legacy classroom.json never wrote `active`; editing name/term must not
    // add it (absent = active).
    const out = buildClassroomUpdate(base, { name: "X", term: "Y" })
    expect("active" in out).toBe(false)
  })

  it("preserves unknown/future fields written by a sibling binary", () => {
    const withUnknown = {
      ...base,
      future_field: "from-newer-cli",
      nested: { a: 1 },
    }
    const out = buildClassroomUpdate(withUnknown, { active: false })
    expect(out.future_field).toBe("from-newer-cli")
    expect(out.nested).toEqual({ a: 1 })
  })

  it("omits every optional field when none are provided (identity merge)", () => {
    expect(buildClassroomUpdate(base, {})).toEqual(base)
  })
})

// editClassroom enforces "archived classrooms are read-only" on the write path
// — the authoritative guard, not just UI gating. The gate must (a) refuse a
// settings edit (name/term) on an archived classroom even
// when a crafted payload bundles `active: false` to re-assert the archived
// state, and (b) let a genuine unarchive (active: true) through. editClassroom
// does I/O via getBranchRef/getCommit/getClassroomJson/createBlob/
// createTreeFromEntries/createCommit/updateRef, all on the GitHubClient, so we
// stub a path-routing fake client.
describe("editClassroom archived read-only guard", () => {
  // A fake client routing each git/contents path to a canned response. The
  // archived classroom.json is returned by the contents endpoint; if the guard
  // is bypassed, createBlob's POST to git/blobs fires (which we assert against).
  const makeClient = (archivedRecord: Record<string, unknown>) => {
    const blobPost = vi.fn()
    const requestRaw = vi.fn().mockImplementation((path: string) => {
      if (path.includes("/contents/")) {
        return Promise.resolve(JSON.stringify(archivedRecord))
      }
      return Promise.reject(new Error(`unexpected requestRaw: ${path}`))
    })
    const request = vi.fn().mockImplementation((path: string) => {
      if (path.endsWith("/git/ref/heads/main")) {
        return Promise.resolve({ object: { sha: "base-sha" } })
      }
      if (path.includes("/git/commits/")) {
        return Promise.resolve({ tree: { sha: "base-tree-sha" } })
      }
      if (path.endsWith("/git/blobs")) {
        blobPost()
        return Promise.resolve({ sha: "blob-sha" })
      }
      if (path.endsWith("/git/trees")) {
        return Promise.resolve({ sha: "tree-sha" })
      }
      if (path.endsWith("/git/commits")) {
        return Promise.resolve({ sha: "new-commit-sha" })
      }
      if (path.endsWith("/git/refs/heads/main")) {
        return Promise.resolve({})
      }
      return Promise.reject(new Error(`unexpected request: ${path}`))
    })
    const client = { request, requestRaw } as unknown as GitHubClient
    return { client, blobPost }
  }

  const archived = {
    short_name: "cs101",
    name: "CS 101",
    term: "Fall",
    active: false,
  }

  it("refuses a name/term edit on an archived classroom (no active sent)", async () => {
    const { client, blobPost } = makeClient(archived)
    await expect(
      editClassroom(client, { org: "acme", slug: "cs101", name: "Renamed" }),
    ).rejects.toThrow(/read-only/i)
    // Fail-closed BEFORE any write — no blob was created.
    expect(blobPost).not.toHaveBeenCalled()
  })

  it("refuses a settings edit even when active:false is bundled in (bypass closed)", async () => {
    const { client, blobPost } = makeClient(archived)
    await expect(
      editClassroom(client, {
        org: "acme",
        slug: "cs101",
        name: "Renamed",
        active: false,
      }),
    ).rejects.toThrow(/read-only/i)
    expect(blobPost).not.toHaveBeenCalled()
  })

  it("allows a pure unarchive (active:true) on an archived classroom", async () => {
    const { client, blobPost } = makeClient(archived)
    await expect(
      editClassroom(client, { org: "acme", slug: "cs101", active: true }),
    ).resolves.toMatchObject({ newCommitSha: "new-commit-sha" })
    // Unarchive proceeds to write.
    expect(blobPost).toHaveBeenCalledTimes(1)
  })

  it("allows an unarchive bundled with a settings edit (active:true + name)", async () => {
    const { client, blobPost } = makeClient(archived)
    await expect(
      editClassroom(client, {
        org: "acme",
        slug: "cs101",
        active: true,
        name: "Reopened",
      }),
    ).resolves.toMatchObject({ newCommitSha: "new-commit-sha" })
    expect(blobPost).toHaveBeenCalledTimes(1)
  })

  it("allows a normal edit on an active classroom", async () => {
    const { client, blobPost } = makeClient({
      short_name: "cs101",
      name: "CS 101",
      term: "Fall",
      active: true,
    })
    await expect(
      editClassroom(client, { org: "acme", slug: "cs101", name: "Renamed" }),
    ).resolves.toMatchObject({ newCommitSha: "new-commit-sha" })
    expect(blobPost).toHaveBeenCalledTimes(1)
  })
})

// ensurePages (the re-run/init write path) must agree with checkPages (the
// audit read path) on the same org — they decide status from the same live
// read-back, so a re-run can't warn about a Pages site the audit shows green.
describe("ensurePages alignment with checkPages", () => {
  const notFound = () =>
    new GitHubAPIError({
      status: 404,
      url: "x",
      message: "Not Found",
      body: null,
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: null,
      },
    })

  const conflict = () =>
    new GitHubAPIError({
      status: 409,
      url: "x",
      message: "Conflict",
      body: null,
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: null,
      },
    })

  // pagesLive is what GET /pages returns after the writes (the source of truth).
  function makeClient(opts: {
    enablePost?: () => Promise<unknown>
    visibilityPut?: () => Promise<unknown>
    pagesLive: unknown | GitHubAPIError
  }): GitHubClient {
    return {
      request: <T>(path: string, options?: { method?: string }) => {
        const method = options?.method ?? "GET"
        if (path.endsWith("/pages") && method === "POST") {
          return (opts.enablePost?.() ?? Promise.resolve({})) as Promise<T>
        }
        if (path.endsWith("/pages") && method === "PUT") {
          return (opts.visibilityPut?.() ?? Promise.resolve({})) as Promise<T>
        }
        if (path.endsWith("/pages") && method === "GET") {
          if (opts.pagesLive instanceof GitHubAPIError) {
            return Promise.reject(opts.pagesLive) as Promise<T>
          }
          return Promise.resolve(opts.pagesLive) as Promise<T>
        }
        return Promise.reject(
          new Error(`unexpected: ${method} ${path}`),
        ) as Promise<T>
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
    }
  }

  it("reports complete when the site is already public, even if the visibility PUT 422s", async () => {
    const client = makeClient({
      enablePost: () => Promise.reject(conflict()), // already enabled
      visibilityPut: () => Promise.reject(notFound()), // re-run PUT rejected
      pagesLive: { build_type: "workflow", public: true }, // but live is correct
    })
    const result = await ensurePages(client, "acme", "classroom50")
    expect(result.status).toBe("complete")
    expect(result.message).toMatch(/public/i)
  })

  it("warns with an explanatory message when the site is genuinely not public", async () => {
    const client = makeClient({
      visibilityPut: () => Promise.reject(notFound()),
      pagesLive: { build_type: "workflow", public: false },
    })
    const result = await ensurePages(client, "acme", "classroom50")
    expect(result.status).toBe("warning")
    expect(result.message.length).toBeGreaterThan(0)
  })
})

// A 409 on the repo workflow-permissions PUT means write is disabled by an
// org/enterprise policy — benign (skeleton workflows declare their own
// permissions), so ensureWorkflowPermissions must report a managed-by-policy
// warning, never throw a hard error.
describe("ensureWorkflowPermissions org-policy conflict", () => {
  function conflict() {
    return new GitHubAPIError({
      status: 409,
      url: "x",
      message:
        "Write permissions for workflows are disabled by the organization",
      body: null,
      rateLimit: {
        limit: null,
        remaining: null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: null,
      },
    })
  }

  function makeClient(repoReadback: { default_workflow_permissions: string }) {
    const client: GitHubClient = {
      request: <T>(path: string, options?: { method?: string }) => {
        const method = options?.method ?? "GET"
        if (path.endsWith("/actions/permissions/workflow")) {
          if (method === "PUT") return Promise.reject(conflict()) as Promise<T>
          return Promise.resolve(repoReadback) as Promise<T>
        }
        return Promise.reject(
          new Error(`unexpected: ${method} ${path}`),
        ) as Promise<T>
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
    }
    return client
  }

  it("returns a managed-by-policy complete (not a warning or throw) on a 409", async () => {
    const client = makeClient({ default_workflow_permissions: "read" })
    const result = await ensureWorkflowPermissions(
      client,
      "acme",
      "classroom50",
    )
    // Org-managed read is acceptable and shown green, matching the audit — no
    // warning badge for a state the preflight checklist reports as OK.
    expect(result.status).toBe("complete")
    expect(result.managedByOrgPolicy).toBe(true)
    expect(result.message.length).toBeGreaterThan(0)
  })
})

// triggerRegrade dispatches regrade.yaml in <org>/classroom50, snapshotting the
// newest dispatch run id first so the caller can bind to its own run. We assert
// the dispatch payload shape (the cross-binary input contract with the CLI's
// regrade.yaml) and the sinceRunId snapshot behavior.
describe("triggerRegrade", () => {
  type Call = { path: string; init?: { method?: string; body?: unknown } }

  const makeClient = (opts: { baselineRunId: number | null }) => {
    const calls: Call[] = []
    const request = vi
      .fn()
      .mockImplementation((path: string, init?: unknown) => {
        calls.push({ path, init: init as Call["init"] })
        // getRepo: GET /repos/{org}/classroom50
        if (/^\/repos\/[^/]+\/classroom50$/.test(path)) {
          return Promise.resolve({ default_branch: "trunk" })
        }
        // baseline newest dispatch run
        if (path.includes(`/workflows/${REGRADE_WORKFLOW}/runs`)) {
          return Promise.resolve({
            workflow_runs:
              opts.baselineRunId === null ? [] : [{ id: opts.baselineRunId }],
          })
        }
        // the dispatch POST
        if (path.includes(`/workflows/${REGRADE_WORKFLOW}/dispatches`)) {
          return Promise.resolve(undefined)
        }
        return Promise.reject(new Error(`unexpected request: ${path}`))
      })
    const client = { request } as unknown as GitHubClient
    return { client, calls }
  }

  const findDispatch = (calls: Call[]) =>
    calls.find((c) => c.path.includes("/dispatches"))

  it("dispatches with classroom + assignment and snapshots the baseline run id", async () => {
    const { client, calls } = makeClient({ baselineRunId: 42 })
    const result = await triggerRegrade(client, {
      org: "acme",
      classroom: "cs101",
      assignment: "hello",
    })

    expect(result.sinceRunId).toBe(42)
    const dispatch = findDispatch(calls)
    expect(dispatch).toBeDefined()
    expect(dispatch?.init?.method).toBe("POST")
    expect(dispatch?.init?.body).toEqual({
      // default_branch from getRepo is used as the dispatch ref.
      ref: "trunk",
      inputs: { classroom: "cs101", assignment: "hello" },
    })
  })

  it("includes the owner input only when scoping to a single student", async () => {
    const { client, calls } = makeClient({ baselineRunId: null })
    const result = await triggerRegrade(client, {
      org: "acme",
      classroom: "cs101",
      assignment: "hello",
      owner: "alice",
    })

    // No prior dispatch runs -> null baseline.
    expect(result.sinceRunId).toBeNull()
    const dispatch = findDispatch(calls)
    expect(dispatch?.init?.body).toEqual({
      ref: "trunk",
      inputs: { classroom: "cs101", assignment: "hello", owner: "alice" },
    })
  })

  it("requires org, classroom, and assignment", async () => {
    const { client } = makeClient({ baselineRunId: null })
    await expect(
      triggerRegrade(client, {
        org: undefined,
        classroom: "cs101",
        assignment: "hello",
      }),
    ).rejects.toThrow(/org/)
    await expect(
      triggerRegrade(client, {
        org: "acme",
        classroom: undefined,
        assignment: "hello",
      }),
    ).rejects.toThrow(/classroom/)
    await expect(
      triggerRegrade(client, {
        org: "acme",
        classroom: "cs101",
        assignment: undefined,
      }),
    ).rejects.toThrow(/assignment/)
  })
})

// validateServiceToken asserts the token can WRITE the classroom50 repo
// (permissions.push — regrade needs write, not just the read collect needs)
// AND can read the org's members (Members: Read — team-driven collection lists
// the classroom team). It reads GET /repos/{org}/classroom50 then GET
// /orgs/{org}/members as the pasted token (via a mocked createGitHubClient) and
// rejects a read-only or Members-less token with an actionable hint.
describe("validateServiceToken", () => {
  const mockTokenClient = (impl: (path: string) => Promise<unknown>) => {
    const request = vi.fn().mockImplementation(impl)
    vi.mocked(createGitHubClient).mockReturnValue({
      request,
    } as unknown as ReturnType<typeof createGitHubClient>)
    return request
  }

  const rateLimit = {
    limit: null,
    remaining: null,
    used: null,
    reset: null,
    resource: null,
    retryAfter: null,
  }
  const apiError = (status: number) =>
    new GitHubAPIError({
      status,
      url: "/repos/acme/classroom50",
      message: `http ${status}`,
      body: {},
      rateLimit,
    })

  it("accepts a token with write access and org-members read", async () => {
    const request = mockTokenClient((path) => {
      if (path === "/repos/acme/classroom50") {
        return Promise.resolve({ permissions: { push: true } })
      }
      if (path === "/orgs/acme/members?per_page=1") {
        return Promise.resolve([])
      }
      throw new Error(`unexpected path ${path}`)
    })
    await expect(
      validateServiceToken("github_pat_x", "acme"),
    ).resolves.toBeUndefined()
    // Both the Contents (repo) and Members (org) probes must run.
    expect(request).toHaveBeenCalledWith("/repos/acme/classroom50")
    expect(request).toHaveBeenCalledWith("/orgs/acme/members?per_page=1")
  })

  it("rejects a read-only token (permissions.push false) with a write hint", async () => {
    mockTokenClient(() => Promise.resolve({ permissions: { push: false } }))
    await expect(validateServiceToken("github_pat_x", "acme")).rejects.toThrow(
      /lacks write access|Read and write/,
    )
  })

  it("rejects a Members-less token (org members 403) with a Members: Read hint", async () => {
    mockTokenClient((path) => {
      if (path === "/repos/acme/classroom50") {
        return Promise.resolve({ permissions: { push: true } })
      }
      return Promise.reject(apiError(403))
    })
    await expect(validateServiceToken("github_pat_x", "acme")).rejects.toThrow(
      /Members: Read|can't read the org's members/,
    )
  })

  it("rejects when the org members probe 404s (no Members scope)", async () => {
    mockTokenClient((path) => {
      if (path === "/repos/acme/classroom50") {
        return Promise.resolve({ permissions: { push: true } })
      }
      return Promise.reject(apiError(404))
    })
    await expect(validateServiceToken("github_pat_x", "acme")).rejects.toThrow(
      /Members: Read|can't read the org's members/,
    )
  })

  // FAIL-OPEN: a 401 or 5xx on the members probe (after the repo read already
  // proved the token valid) is inconclusive and must NOT reject the token.
  it("proceeds when the org members probe 401s (inconclusive, not fatal)", async () => {
    mockTokenClient((path) => {
      if (path === "/repos/acme/classroom50") {
        return Promise.resolve({ permissions: { push: true } })
      }
      return Promise.reject(apiError(401))
    })
    await expect(
      validateServiceToken("github_pat_x", "acme"),
    ).resolves.toBeUndefined()
  })

  it("proceeds when the org members probe 500s or hits a network error", async () => {
    mockTokenClient((path) => {
      if (path === "/repos/acme/classroom50") {
        return Promise.resolve({ permissions: { push: true } })
      }
      return Promise.reject(apiError(500))
    })
    await expect(
      validateServiceToken("github_pat_x", "acme"),
    ).resolves.toBeUndefined()

    mockTokenClient((path) => {
      if (path === "/repos/acme/classroom50") {
        return Promise.resolve({ permissions: { push: true } })
      }
      return Promise.reject(new TypeError("Failed to fetch"))
    })
    await expect(
      validateServiceToken("github_pat_x", "acme"),
    ).resolves.toBeUndefined()
  })

  it("maps a 403 to the actionable scope hint", async () => {
    mockTokenClient(() => Promise.reject(apiError(403)))
    await expect(validateServiceToken("github_pat_x", "acme")).rejects.toThrow(
      /Read and write/,
    )
  })

  it("maps a 401 to invalid/expired/revoked", async () => {
    mockTokenClient(() => Promise.reject(apiError(401)))
    await expect(validateServiceToken("github_pat_x", "acme")).rejects.toThrow(
      /invalid, expired, or revoked/,
    )
  })

  it("requires an org and a non-empty token", async () => {
    await expect(validateServiceToken("tok", undefined)).rejects.toThrow(/org/)
    await expect(validateServiceToken("   ", "acme")).rejects.toThrow(
      /Enter a token/,
    )
  })
})

// gitBlobSha must match `git hash-object` so a skeleton file's bundled content
// can be compared against the SHA GitHub reports for the repo's tree entry.
describe("gitBlobSha", () => {
  it("matches git hash-object for a known body", async () => {
    // echo -n "hello\n" | git hash-object --stdin
    expect(await gitBlobSha("hello\n")).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    )
  })

  it("hashes the empty blob", async () => {
    expect(await gitBlobSha("")).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    )
  })
})

// The web re-run must upgrade drifted skeleton files (not just fill in missing
// paths), mirroring the CLI's diffSkeleton. These pin the content-diff: a file
// whose tree SHA matches the bundled content is left alone; a missing or
// drifted one is flagged stale.
describe("findStaleSkeletonFiles", () => {
  const org = "acme"

  // A client whose recursive-tree read reports `treeBlobs` (path -> sha) and
  // whose repo read reports the default branch. No writes happen here — the
  // diff is read-only.
  function diffClient(treeBlobs: Record<string, string>) {
    const request = vi.fn(async (url: string) => {
      if (url.includes("/git/ref/heads/")) return { object: { sha: "refsha" } }
      if (url.includes("/git/commits/")) return { tree: { sha: "treesha" } }
      if (url.includes("/git/trees/")) {
        return {
          truncated: false,
          tree: Object.entries(treeBlobs).map(([path, sha]) => ({
            path,
            type: "blob",
            sha,
          })),
        }
      }
      if (/\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      throw new Error(`unexpected request: ${url}`)
    })
    return { request } as unknown as GitHubClient
  }

  async function bundledShas() {
    const files = buildSkeletonFiles("main")
    const entries = await Promise.all(
      files.map(async (f) => [f.path, await gitBlobSha(f.content)] as const),
    )
    return { files, shas: Object.fromEntries(entries) }
  }

  it("reports nothing stale when every tree SHA matches the bundle", async () => {
    const { shas } = await bundledShas()
    const stale = await findStaleSkeletonFiles(diffClient(shas), org)
    expect(stale).toEqual([])
  })

  it("flags a file whose content drifted from the bundle", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const stale = await findStaleSkeletonFiles(
      diffClient({ ...shas, [drifted]: "0".repeat(40) }),
      org,
    )
    expect(stale.map((f) => f.path)).toEqual([drifted])
  })

  it("flags a file absent from the tree", async () => {
    const { files, shas } = await bundledShas()
    const missing = files[0].path
    const without = { ...shas }
    delete without[missing]
    const stale = await findStaleSkeletonFiles(diffClient(without), org)
    expect(stale.map((f) => f.path)).toContain(missing)
  })

  it("tags missing files as creates and drifted files as overwrites", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const missing = files[1].path
    const tree = { ...shas, [drifted]: "0".repeat(40) }
    delete tree[missing]
    const stale = await findStaleSkeletonFiles(diffClient(tree), org)
    const byPath = Object.fromEntries(stale.map((f) => [f.path, f.exists]))
    expect(byPath[drifted]).toBe(true)
    expect(byPath[missing]).toBe(false)
  })
})

// The overwrite confirmation: drifted (existing) skeleton files are only
// re-committed when confirmOverwrite resolves true; declining leaves them
// untouched but still creates any missing files. Mirrors the CLI's refresh
// prompt, surfaced as a GUI modal.
describe("ensureSkeletonFiles overwrite confirmation", () => {
  const org = "acme"

  // A client that answers the read endpoints (ref/commit/tree/repo) from
  // `treeBlobs` and records every write (POST/PATCH) so a test can assert
  // whether the overwrite commit happened. The tree-read SHA the writes need is
  // served too. getBranchRef/getCommit hit the same ref/commit URLs.
  function rwClient(treeBlobs: Record<string, string>) {
    const writes: string[] = []
    const request = vi.fn(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET"
      if (method !== "GET") {
        writes.push(`${method} ${url}`)
        if (url.includes("/git/trees")) return { sha: "newtree" }
        if (url.includes("/git/commits")) return { sha: "newcommit" }
        if (url.includes("/git/refs/")) return { object: { sha: "newcommit" } }
        return {}
      }
      if (url.includes("/git/ref/heads/")) return { object: { sha: "refsha" } }
      if (url.includes("/git/commits/"))
        return { sha: "refsha", tree: { sha: "basetree" } }
      if (url.includes("/git/trees/")) {
        return {
          truncated: false,
          tree: Object.entries(treeBlobs).map(([path, sha]) => ({
            path,
            type: "blob",
            sha,
          })),
        }
      }
      if (/\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    return { client: { request } as unknown as GitHubClient, writes }
  }

  async function bundledShas() {
    const files = buildSkeletonFiles("main")
    const entries = await Promise.all(
      files.map(async (f) => [f.path, await gitBlobSha(f.content)] as const),
    )
    return { files, shas: Object.fromEntries(entries) }
  }

  it("does nothing (no confirm) when the skeleton is up to date", async () => {
    const { shas } = await bundledShas()
    const { client, writes } = rwClient(shas)
    const confirm = vi.fn(async () => true)
    const result = await ensureSkeletonFiles(client, org, confirm)
    expect(confirm).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(result.created).toEqual([])
  })

  it("overwrites drifted files when the teacher confirms", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const { client, writes } = rwClient({ ...shas, [drifted]: "0".repeat(40) })
    const confirm = vi.fn(async () => true)
    const result = await ensureSkeletonFiles(client, org, confirm)
    expect(confirm).toHaveBeenCalledWith([drifted])
    expect(result.created).toEqual([drifted])
    expect(result.skippedOverwrite).toEqual([])
    expect(writes.some((w) => w.includes("/git/trees"))).toBe(true)
  })

  it("skips drifted files but still creates missing ones when declined", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const missing = files[1].path
    const tree = { ...shas, [drifted]: "0".repeat(40) }
    delete tree[missing]
    const { client, writes } = rwClient(tree)
    const confirm = vi.fn(async () => false)

    const result = await ensureSkeletonFiles(client, org, confirm)

    expect(confirm).toHaveBeenCalledWith([drifted])
    // The missing file is still created; the drifted one is left untouched.
    expect(result.created).toEqual([missing])
    expect(result.skippedOverwrite).toEqual([drifted])
    // A commit still lands (for the created file), but it must not include the
    // declined path — verified via created above; here we assert a write ran.
    expect(writes.some((w) => w.includes("/git/trees"))).toBe(true)
  })

  it("makes no commit when the only change is a declined overwrite", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const { client, writes } = rwClient({ ...shas, [drifted]: "0".repeat(40) })
    const confirm = vi.fn(async () => false)

    const result = await ensureSkeletonFiles(client, org, confirm)

    expect(result.created).toEqual([])
    expect(result.skippedOverwrite).toEqual([drifted])
    expect(writes).toEqual([])
  })

  it("without a confirm hook, overwrites drifted files unprompted", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const { client, writes } = rwClient({ ...shas, [drifted]: "0".repeat(40) })
    const result = await ensureSkeletonFiles(client, org)
    expect(result.created).toEqual([drifted])
    expect(writes.some((w) => w.includes("/git/trees"))).toBe(true)
  })
})

// The skeleton commit uses a force:false ref PATCH and retries on a 422
// non-fast-forward (the concurrent-writer race the confirm-modal pause opens),
// re-diffing against the freshly-read parent each attempt; a non-422 error and
// retry exhaustion both surface to the caller. This is the PR's concurrency
// safety claim, so it gets its own coverage.
describe("ensureSkeletonFiles non-fast-forward retry", () => {
  const org = "acme"

  const rateLimit = {
    limit: null,
    remaining: null,
    used: null,
    reset: null,
    resource: null,
    retryAfter: null,
  }
  const apiError = (status: number, message: string, body: unknown = {}) =>
    new GitHubAPIError({
      status,
      url: `/repos/${org}/classroom50/git/refs/heads/main`,
      message,
      body,
      rateLimit,
    })

  async function bundledShas() {
    const files = buildSkeletonFiles("main")
    const entries = await Promise.all(
      files.map(async (f) => [f.path, await gitBlobSha(f.content)] as const),
    )
    return { files, shas: Object.fromEntries(entries) }
  }

  // Like rwClient, but the ref PATCH (the optimistic-rebase step) rejects with
  // `patchError` for its first `failRefPatches` calls before succeeding. The
  // tree read keeps reporting `treeBlobs` so the re-diff on a retry still sees
  // the file as drifted (a stuck race, not a concurrent writer that converged).
  function retryingClient(
    treeBlobs: Record<string, string>,
    failRefPatches: number,
    patchError: unknown,
  ) {
    let refPatchCount = 0
    const refPatches: number[] = []
    const request = vi.fn(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? "GET"
      if (method !== "GET") {
        if (url.includes("/git/refs/")) {
          refPatchCount++
          refPatches.push(refPatchCount)
          if (refPatchCount <= failRefPatches) throw patchError
          return { object: { sha: "newcommit" } }
        }
        if (url.includes("/git/trees")) return { sha: "newtree" }
        if (url.includes("/git/commits")) return { sha: "newcommit" }
        return {}
      }
      if (url.includes("/git/ref/heads/")) return { object: { sha: "refsha" } }
      if (url.includes("/git/commits/"))
        return { sha: "refsha", tree: { sha: "basetree" } }
      if (url.includes("/git/trees/")) {
        return {
          truncated: false,
          tree: Object.entries(treeBlobs).map(([path, sha]) => ({
            path,
            type: "blob",
            sha,
          })),
        }
      }
      if (/\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    return { client: { request } as unknown as GitHubClient, refPatches }
  }

  it("retries on a 422 non-fast-forward and succeeds on the next attempt", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const { client, refPatches } = retryingClient(
      { ...shas, [drifted]: "0".repeat(40) },
      1,
      apiError(422, "Update is not a fast forward"),
    )
    const result = await ensureSkeletonFiles(client, org)
    expect(result.created).toEqual([drifted])
    // First PATCH 422s, the loop re-diffs and the second PATCH lands.
    expect(refPatches).toEqual([1, 2])
  })

  it("rethrows when every attempt loses the non-fast-forward race", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const err = apiError(422, "Update is not a fast forward")
    const { client, refPatches } = retryingClient(
      { ...shas, [drifted]: "0".repeat(40) },
      Infinity,
      err,
    )
    await expect(ensureSkeletonFiles(client, org)).rejects.toBe(err)
    // Bounded to SKELETON_COMMIT_ATTEMPTS (3).
    expect(refPatches).toEqual([1, 2, 3])
  })

  it("rethrows a non-422 error immediately without retrying", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    const err = apiError(500, "boom")
    const { client, refPatches } = retryingClient(
      { ...shas, [drifted]: "0".repeat(40) },
      Infinity,
      err,
    )
    await expect(ensureSkeletonFiles(client, org)).rejects.toBe(err)
    // No retry: the loop rethrows on the first non-fast-forward-miss.
    expect(refPatches).toEqual([1])
  })

  it("does not retry a 422 that is not a non-fast-forward", async () => {
    const { files, shas } = await bundledShas()
    const drifted = files[0].path
    // A 422 whose message/body don't mention a fast-forward race is a real
    // error (e.g. validation), not the optimistic-rebase loss — rethrow it.
    const err = apiError(422, "Validation failed", { message: "Invalid ref" })
    const { client, refPatches } = retryingClient(
      { ...shas, [drifted]: "0".repeat(40) },
      Infinity,
      err,
    )
    await expect(ensureSkeletonFiles(client, org)).rejects.toBe(err)
    expect(refPatches).toEqual([1])
  })
})
