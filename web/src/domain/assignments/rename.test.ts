import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import {
  renameAssignment,
  rewriteMarkerAssignment,
  rekeyScoresBucket,
  isRenameEligible,
  needsRenameFinish,
} from "./rename"
import type { Assignment } from "@/types/classroom"

const ORG = "o"
const CLASSROOM = "cs"
// Over budget: len("cs") + len(OLD) = 2 + 60 = 62 > 59.
const OLD = "hw-" + "x".repeat(57)
const NEW = "ps3"

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")

function apiError(
  status: number,
  url: string,
  retryAfter: number | null = null,
): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url,
    message: `HTTP ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter,
    },
  })
}

const marker = (slug: string, comment = "") =>
  (comment ? `# ${comment}\n` : "") +
  `schema: "classroom50/repo-config/v1"\n` +
  `classroom: "${CLASSROOM}"\n` +
  `assignment: "${slug}"\n` +
  `owner:\n  username: "alice"\n`

const assignmentsBody = (entries: Partial<Assignment>[]) =>
  JSON.stringify({
    schema: "classroom50/assignments/v1",
    assignments: entries,
  })

const baseEntry = (over: Partial<Assignment> = {}): Partial<Assignment> => ({
  slug: OLD,
  name: "Homework",
  mode: "individual",
  autograder: "default",
  ...over,
})

type Fixture = {
  client: GitHubClient
  state: {
    assignments: string
    scores?: string
    markers: Record<string, string>
  }
  captured: {
    configTrees: { path: string; content?: string; sha?: string | null }[][]
    repoTrees: Record<string, string[]>
    repoMessages: Record<string, string[]>
    renames: Record<string, string>
  }
}

// A stateful mock GitHub mirroring the CLI test's newRenameServer: config-repo
// reads/writes (tree posts apply to state on the ref PATCH, so the second
// commit observes the first), org repo listing, and per-student-repo marker
// read/rewrite + PATCH rename. `failRename` fails the PATCH per repo with the
// given status (`retryAfter` makes a 403 a secondary rate limit);
// `failLockRestore` 500s the config ref PATCH of the SECOND config commit
// (the lock restore).
function makeFixture(opts: {
  assignments: string
  scores?: string
  repos: string[]
  markers: Record<string, string>
  configTreePaths?: { path: string; sha: string }[]
  failRename?: Record<string, { status: number; retryAfter?: number }>
  failLockRestore?: boolean
}): Fixture {
  const state = {
    assignments: opts.assignments,
    scores: opts.scores,
    markers: { ...opts.markers },
  }
  const captured: Fixture["captured"] = {
    configTrees: [],
    repoTrees: {},
    repoMessages: {},
    renames: {},
  }
  // Config-repo tree upserts land in state only when the ref PATCH commits.
  let pendingConfig: Record<string, string> = {}
  const pendingRepoTree: Record<string, string> = {}
  let configCommits = 0

  const request = vi.fn(
    async (
      url: string,
      init?: { method?: string; body?: unknown },
    ): Promise<unknown> => {
      const method = init?.method ?? "GET"

      // --- config repo ---
      if (method === "GET" && /\/repos\/o\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      if (
        method === "GET" &&
        url.includes("/repos/o/classroom50/git/ref/heads/main")
      ) {
        return { object: { sha: "cfg-ref" } }
      }
      if (
        method === "GET" &&
        url.includes("/repos/o/classroom50/git/commits/")
      ) {
        return { tree: { sha: "cfg-tree" } }
      }
      if (
        method === "GET" &&
        url.includes("/repos/o/classroom50/contents/cs/assignments.json")
      ) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(state.assignments),
        }
      }
      if (
        method === "GET" &&
        url.includes("/repos/o/classroom50/contents/cs/scores.json")
      ) {
        if (state.scores === undefined) throw apiError(404, url)
        return { type: "file", encoding: "base64", content: b64(state.scores) }
      }
      if (
        method === "GET" &&
        url.includes("/repos/o/classroom50/git/trees/cfg-tree?recursive=1")
      ) {
        return {
          truncated: false,
          tree: (opts.configTreePaths ?? []).map((e) => ({
            path: e.path,
            mode: "100644",
            type: "blob",
            sha: e.sha,
          })),
        }
      }
      if (method === "POST" && url === "/repos/o/classroom50/git/trees") {
        const body = init?.body as {
          tree: { path: string; content?: string; sha?: string | null }[]
        }
        captured.configTrees.push(body.tree)
        pendingConfig = {}
        for (const entry of body.tree) {
          if (typeof entry.content === "string") {
            pendingConfig[entry.path] = entry.content
          }
        }
        return { sha: "cfg-newtree" }
      }
      if (method === "POST" && url === "/repos/o/classroom50/git/commits") {
        configCommits += 1
        return { sha: "cfg-newcommit" }
      }
      if (
        method === "PATCH" &&
        url.includes("/repos/o/classroom50/git/refs/heads/main")
      ) {
        if (opts.failLockRestore && configCommits >= 2) {
          throw apiError(500, url)
        }
        if (pendingConfig["cs/assignments.json"]) {
          state.assignments = pendingConfig["cs/assignments.json"]
        }
        if (pendingConfig["cs/scores.json"]) {
          state.scores = pendingConfig["cs/scores.json"]
        }
        return { object: { sha: "cfg-newcommit" } }
      }

      // --- org listing ---
      if (method === "GET" && url.startsWith("/orgs/o/repos")) {
        const page = Number(new URL(url, "http://x").searchParams.get("page"))
        return page === 1
          ? opts.repos.map((name) => ({ name, default_branch: "main" }))
          : []
      }

      // --- student repos ---
      const repoMatch = /^\/repos\/o\/([^/]+)(\/.*)?$/.exec(url.split("?")[0])
      if (repoMatch && repoMatch[1] !== "classroom50") {
        const repo = repoMatch[1]
        const rest = repoMatch[2] ?? ""
        if (method === "GET" && rest === "/git/ref/heads/main") {
          if (!(repo in state.markers) && !opts.repos.includes(repo)) {
            throw apiError(404, url)
          }
          return { object: { sha: `head-${repo}` } }
        }
        if (method === "GET" && rest === "/contents/.classroom50.yaml") {
          const content = state.markers[repo]
          if (content === undefined) throw apiError(404, url)
          return { type: "file", encoding: "base64", content: b64(content) }
        }
        if (method === "GET" && rest.startsWith("/git/commits/")) {
          return { tree: { sha: `tree-${repo}` } }
        }
        if (method === "POST" && rest === "/git/trees") {
          const body = init?.body as { tree: { content: string }[] }
          pendingRepoTree[repo] = body.tree[0].content
          return { sha: `newtree-${repo}` }
        }
        if (method === "POST" && rest === "/git/commits") {
          const body = init?.body as { message: string }
          ;(captured.repoMessages[repo] ??= []).push(body.message)
          return { sha: `newc-${repo}` }
        }
        if (method === "PATCH" && rest === "/git/refs/heads/main") {
          state.markers[repo] = pendingRepoTree[repo]
          ;(captured.repoTrees[repo] ??= []).push(pendingRepoTree[repo])
          return { object: { sha: `newc-${repo}` } }
        }
        if (method === "PATCH" && rest === "") {
          const body = init?.body as { name: string }
          const failure = opts.failRename?.[repo]
          if (failure) {
            throw apiError(failure.status, url, failure.retryAfter ?? null)
          }
          captured.renames[repo] = body.name
          return {}
        }
      }

      throw new Error(`unexpected request: ${method} ${url}`)
    },
  )
  // classroom.json archive guard: 404 -> active.
  const requestRaw = vi.fn(async (url: string) => {
    throw apiError(404, url)
  })
  return {
    client: { request, requestRaw } as unknown as GitHubClient,
    state,
    captured,
  }
}

const aliceRepo = `${CLASSROOM}-${OLD}-alice`
const aliceNewRepo = `${CLASSROOM}-${NEW}-alice`
// A sibling assignment whose slug extends OLD, so its repo shares the prefix.
const foreignRepo = `${CLASSROOM}-${OLD}-b-bob`

const writtenAssignments = (fix: Fixture) =>
  JSON.parse(fix.state.assignments) as {
    assignments: (Assignment & Record<string, unknown>)[]
  }

describe("renameAssignment (fresh)", () => {
  it("commits config atomically, rewrites the marker before renaming, skips the sibling, and releases the lock", async () => {
    const fix = makeFixture({
      assignments: assignmentsBody([baseEntry()]),
      scores: JSON.stringify({
        schema: "classroom50/scores/v1",
        assignments: { [OLD]: { type: "individual", entries: [] } },
      }),
      repos: [aliceRepo, foreignRepo, "unrelated"],
      markers: {
        [aliceRepo]: marker(OLD, "added by TA, keep me"),
        [foreignRepo]: marker(`${OLD}-b`),
      },
      configTreePaths: [
        { path: `cs/autograders/${OLD}/autograder.py`, sha: "blob1" },
        { path: "cs/autograders/other/autograder.py", sha: "blob2" },
      ],
    })
    const progress: number[] = []
    const summary = await renameAssignment(
      fix.client,
      { org: ORG, classroom: CLASSROOM, oldSlug: OLD, newSlug: NEW },
      { onProgress: (p) => progress.push(p.processed) },
    )

    // Config: slug + renamed_from landed; the fan-out lock was released after
    // every repo landed (absent-is-false shape, so no `locked` key remains).
    const entry = writtenAssignments(fix).assignments[0]
    expect(entry.slug).toBe(NEW)
    expect(entry.renamed_from).toBe(OLD)
    expect("locked" in entry).toBe(false)

    // The FIRST config tree (the rename commit) carried assignments.json with
    // locked:true, the scores re-key, and the autograder dir move by blob SHA.
    const renameTree = fix.captured.configTrees[0]
    const assignmentsEntry = renameTree.find(
      (e) => e.path === "cs/assignments.json",
    )
    expect(assignmentsEntry?.content).toContain('"locked": true')
    const scores = JSON.parse(fix.state.scores!) as {
      assignments: Record<string, unknown>
    }
    expect(Object.keys(scores.assignments)).toEqual([NEW])
    expect(
      renameTree.find((e) => e.path === `cs/autograders/${NEW}/autograder.py`),
    ).toMatchObject({ sha: "blob1" })
    expect(
      renameTree.find((e) => e.path === `cs/autograders/${OLD}/autograder.py`),
    ).toMatchObject({ sha: null })
    // The unrelated autograder dir is untouched.
    expect(
      renameTree.some((e) => e.path.includes("cs/autograders/other/")),
    ).toBe(false)

    // Alice: comment-preserving marker rewrite with [skip ci], then renamed.
    expect(fix.state.markers[aliceRepo]).toContain(`assignment: "${NEW}"`)
    expect(fix.state.markers[aliceRepo]).toContain("# added by TA, keep me")
    expect(fix.captured.repoMessages[aliceRepo]?.[0]).toContain("[skip ci]")
    expect(fix.captured.renames[aliceRepo]).toBe(aliceNewRepo)

    // The sibling-marker repo: enumerated by prefix but left untouched.
    expect(fix.captured.renames[foreignRepo]).toBeUndefined()
    expect(fix.state.markers[foreignRepo]).toBe(marker(`${OLD}-b`))

    expect(summary.mode).toBe("fresh")
    expect(summary.failed).toBe(0)
    expect(summary.lockReleased).toBe(true)
    const byRepo = Object.fromEntries(
      summary.results.map((r) => [r.repo, r.outcome]),
    )
    expect(byRepo[aliceRepo]).toBe("renamed")
    expect(byRepo[foreignRepo]).toBe("skippedForeign")
    expect(byRepo["unrelated"]).toBeUndefined()
    expect(progress).toEqual([0, 1])
  })

  it("keeps the assignment LOCKED while any repo failed its rename", async () => {
    const fix = makeFixture({
      assignments: assignmentsBody([baseEntry()]),
      repos: [aliceRepo],
      markers: { [aliceRepo]: marker(OLD) },
      failRename: { [aliceRepo]: { status: 422 } },
    })
    const summary = await renameAssignment(fix.client, {
      org: ORG,
      classroom: CLASSROOM,
      oldSlug: OLD,
      newSlug: NEW,
    })
    expect(summary.failed).toBe(1)
    expect(summary.lockReleased).toBe(false)
    expect(summary.results[0].outcome).toBe("failed")
    expect(summary.results[0].reason?.key).toBe(
      "assignments.rename.reason.renameConflict",
    )
    // The straggler's marker DID move to the new slug (marker before rename),
    // and the lock holds so no accept can occupy the new repo name.
    expect(fix.state.markers[aliceRepo]).toContain(`assignment: "${NEW}"`)
    expect(writtenAssignments(fix).assignments[0].locked).toBe(true)
  })

  it("reports an unverifiable repo (no marker) without touching it and still releases the lock", async () => {
    const fix = makeFixture({
      assignments: assignmentsBody([baseEntry()]),
      repos: [aliceRepo],
      markers: {},
    })
    const summary = await renameAssignment(fix.client, {
      org: ORG,
      classroom: CLASSROOM,
      oldSlug: OLD,
      newSlug: NEW,
    })
    expect(summary.results[0].outcome).toBe("skippedNoMarker")
    expect(fix.captured.renames[aliceRepo]).toBeUndefined()
    // A skip is not a failure: the repo was already broken for grading, and a
    // re-accept heals it — so the lock is not held hostage.
    expect(summary.failed).toBe(0)
    expect(summary.lockReleased).toBe(true)
  })

  it("preserves a pre-existing teacher lock instead of releasing it", async () => {
    const fix = makeFixture({
      assignments: assignmentsBody([baseEntry({ locked: true })]),
      repos: [aliceRepo],
      markers: { [aliceRepo]: marker(OLD) },
    })
    const summary = await renameAssignment(fix.client, {
      org: ORG,
      classroom: CLASSROOM,
      oldSlug: OLD,
      newSlug: NEW,
    })
    expect(summary.failed).toBe(0)
    expect(summary.prevLocked).toBe(true)
    // The teacher locked it before the rename; this run must not unlock it.
    expect(summary.lockReleased).toBe(false)
    expect(writtenAssignments(fix).assignments[0].locked).toBe(true)
  })

  it("degrades to lockRestoreFailed when the release commit fails, without failing the run", async () => {
    const fix = makeFixture({
      assignments: assignmentsBody([baseEntry()]),
      repos: [aliceRepo],
      markers: { [aliceRepo]: marker(OLD) },
      failLockRestore: true,
    })
    const summary = await renameAssignment(fix.client, {
      org: ORG,
      classroom: CLASSROOM,
      oldSlug: OLD,
      newSlug: NEW,
    })
    expect(summary.failed).toBe(0)
    expect(summary.lockReleased).toBe(false)
    expect(summary.lockRestoreFailed).toBe(true)
    // The rename itself landed even though the unlock didn't.
    expect(fix.captured.renames[aliceRepo]).toBe(aliceNewRepo)
    expect(writtenAssignments(fix).assignments[0].locked).toBe(true)
  })

  it("classifies a rate-limited rename and defers the remaining repos without API calls", async () => {
    const bobRepo = `${CLASSROOM}-${OLD}-bob`
    const fix = makeFixture({
      assignments: assignmentsBody([baseEntry()]),
      repos: [aliceRepo, bobRepo],
      markers: { [aliceRepo]: marker(OLD), [bobRepo]: marker(OLD) },
      // 403 + Retry-After = a secondary rate limit, NOT a permission failure.
      failRename: { [aliceRepo]: { status: 403, retryAfter: 60 } },
    })
    const summary = await renameAssignment(fix.client, {
      org: ORG,
      classroom: CLASSROOM,
      oldSlug: OLD,
      newSlug: NEW,
    })
    const byRepo = Object.fromEntries(summary.results.map((r) => [r.repo, r]))
    expect(byRepo[aliceRepo].outcome).toBe("failed")
    expect(byRepo[aliceRepo].reason?.key).toBe(
      "assignments.rename.reason.rateLimited",
    )
    // Bob was deferred without touching the API: no marker rewrite, no rename.
    expect(byRepo[bobRepo].outcome).toBe("failed")
    expect(byRepo[bobRepo].reason?.key).toBe(
      "assignments.rename.reason.rateLimitedDeferred",
    )
    expect(fix.state.markers[bobRepo]).toBe(marker(OLD))
    expect(fix.captured.renames[bobRepo]).toBeUndefined()
    // Both count as failed, so the lock holds for the finish re-run.
    expect(summary.failed).toBe(2)
    expect(summary.lockReleased).toBe(false)
  })

  it("classifies a plain 403 as needs-admin and a 500 as a generic failure", async () => {
    const bobRepo = `${CLASSROOM}-${OLD}-bob`
    const fix = makeFixture({
      assignments: assignmentsBody([baseEntry()]),
      repos: [aliceRepo, bobRepo],
      markers: { [aliceRepo]: marker(OLD), [bobRepo]: marker(OLD) },
      // A plain 403 (no Retry-After) is a permission failure — it must NOT
      // trip the rate-limit short-circuit, so bob still gets his attempt.
      failRename: { [aliceRepo]: { status: 403 }, [bobRepo]: { status: 500 } },
    })
    const summary = await renameAssignment(fix.client, {
      org: ORG,
      classroom: CLASSROOM,
      oldSlug: OLD,
      newSlug: NEW,
    })
    const byRepo = Object.fromEntries(summary.results.map((r) => [r.repo, r]))
    expect(byRepo[aliceRepo].reason?.key).toBe(
      "assignments.rename.reason.renameForbidden",
    )
    expect(byRepo[bobRepo].reason?.key).toBe(
      "assignments.rename.reason.renameFailed",
    )
  })
})

describe("renameAssignment (preflight gates)", () => {
  const gate = (
    assignments: string,
    input?: Partial<{ oldSlug: string; newSlug: string }>,
  ) =>
    renameAssignment(
      makeFixture({ assignments, repos: [], markers: {} }).client,
      {
        org: ORG,
        classroom: CLASSROOM,
        oldSlug: input?.oldSlug ?? OLD,
        newSlug: input?.newSlug ?? NEW,
      },
    )

  it("rejects a second rename (one-shot)", async () => {
    await expect(
      gate(assignmentsBody([baseEntry({ renamed_from: "older" })])),
    ).rejects.toThrow(/alreadyRenamed/)
  })

  it("rejects an assignment that fits the budget", async () => {
    await expect(
      gate(assignmentsBody([baseEntry({ slug: "fits" })]), {
        oldSlug: "fits",
      }),
    ).rejects.toThrow(/fitsBudget/)
  })

  it("rejects a taken new slug", async () => {
    await expect(
      gate(assignmentsBody([baseEntry(), { ...baseEntry(), slug: NEW }])),
    ).rejects.toThrow(/slugTaken/)
  })

  it("rejects a reserved new slug (another assignment's pre-rename name)", async () => {
    await expect(
      gate(
        assignmentsBody([
          baseEntry(),
          { ...baseEntry(), slug: "other", renamed_from: NEW },
        ]),
      ),
    ).rejects.toThrow(/slugReserved/)
  })

  it("rejects an unknown old slug", async () => {
    await expect(gate(assignmentsBody([]))).rejects.toThrow(/notFound/)
  })

  it("rejects an invalid or over-budget new slug before any read", async () => {
    await expect(gate("{}", { newSlug: "UPPER" })).rejects.toThrow(
      /invalidSlug/,
    )
    await expect(gate("{}", { newSlug: "y".repeat(58) })).rejects.toThrow(
      /overBudget/,
    )
    await expect(gate("{}", { newSlug: OLD })).rejects.toThrow(/sameSlug/)
  })
})

describe("renameAssignment (resume)", () => {
  it("heals stragglers: renames missed repos, rewrites stale markers, no-ops completed ones", async () => {
    const straggler = `${CLASSROOM}-${OLD}-carol`
    const staleMarker = aliceNewRepo // renamed, marker still old
    const done = `${CLASSROOM}-${NEW}-dave`
    const fix = makeFixture({
      assignments: assignmentsBody([
        { ...baseEntry(), slug: NEW, renamed_from: OLD, locked: true },
      ]),
      repos: [straggler, staleMarker, done],
      markers: {
        [straggler]: marker(OLD),
        [staleMarker]: marker(OLD),
        [done]: marker(NEW),
      },
    })
    const summary = await renameAssignment(fix.client, {
      org: ORG,
      classroom: CLASSROOM,
      oldSlug: OLD,
      newSlug: NEW,
    })
    expect(summary.mode).toBe("resume")
    const byRepo = Object.fromEntries(
      summary.results.map((r) => [r.repo, r.outcome]),
    )
    expect(byRepo[straggler]).toBe("renamed")
    expect(fix.captured.renames[straggler]).toBe(`${CLASSROOM}-${NEW}-carol`)
    expect(byRepo[staleMarker]).toBe("markerHealed")
    expect(fix.state.markers[staleMarker]).toContain(`assignment: "${NEW}"`)
    expect(byRepo[done]).toBe("current")
    // Resume never guesses the pre-rename lock state: no lock-restore commit.
    expect(summary.lockReleased).toBe(false)
    expect(writtenAssignments(fix).assignments[0].locked).toBe(true)
  })
})

describe("rewriteMarkerAssignment", () => {
  it("rewrites in place, preserving comments and quote style", () => {
    const out = rewriteMarkerAssignment(marker(OLD, "student note"), OLD, NEW)
    expect(out.changed).toBe(true)
    expect(out.content).toContain("# student note")
    expect(out.content).toContain(`assignment: "${NEW}"`)
    expect(out.content).toContain(`classroom: "${CLASSROOM}"`)
  })

  it("is a no-op when the marker already carries the new slug", () => {
    expect(rewriteMarkerAssignment(marker(NEW), OLD, NEW)).toEqual({
      changed: false,
    })
  })

  it("classifies a foreign marker instead of rewriting it", () => {
    expect(rewriteMarkerAssignment(marker("other"), OLD, NEW)).toEqual({
      changed: false,
      foreignSlug: "other",
    })
  })

  it("throws for an unparseable document or a missing assignment key", () => {
    expect(() => rewriteMarkerAssignment(": not yaml [", OLD, NEW)).toThrow()
    expect(() =>
      rewriteMarkerAssignment('classroom: "cs"\n', OLD, NEW),
    ).toThrow(/assignment/)
  })
})

describe("rekeyScoresBucket", () => {
  it("moves the bucket preserving position and unknown top-level keys", () => {
    const raw = JSON.stringify(
      {
        schema: "classroom50/scores/v1",
        future_field: true,
        assignments: { a: 1, [OLD]: { entries: [] }, z: 2 },
      },
      null,
      2,
    )
    const out = rekeyScoresBucket(raw, OLD, NEW)
    const parsed = JSON.parse(out!) as {
      future_field: boolean
      assignments: Record<string, unknown>
    }
    expect(parsed.future_field).toBe(true)
    expect(Object.keys(parsed.assignments)).toEqual(["a", NEW, "z"])
  })

  it("returns null when nothing was collected under the old slug", () => {
    expect(
      rekeyScoresBucket(JSON.stringify({ assignments: {} }), OLD, NEW),
    ).toBeNull()
  })

  it("refuses to overwrite an existing new bucket with a keyed error", () => {
    expect(() =>
      rekeyScoresBucket(
        JSON.stringify({ assignments: { [OLD]: 1, [NEW]: 2 } }),
        OLD,
        NEW,
      ),
    ).toThrow(/scoresBucketExists/)
  })
})

describe("eligibility gates", () => {
  it("isRenameEligible requires over-budget AND never-renamed", () => {
    const over = { slug: OLD } as Assignment
    expect(isRenameEligible(CLASSROOM, over)).toBe(true)
    expect(
      isRenameEligible(CLASSROOM, {
        slug: OLD,
        renamed_from: "x",
      } as Assignment),
    ).toBe(false)
    expect(isRenameEligible(CLASSROOM, { slug: "fits" } as Assignment)).toBe(
      false,
    )
  })

  it("needsRenameFinish flags a renamed assignment still holding the fan-out lock", () => {
    expect(
      needsRenameFinish({
        slug: NEW,
        renamed_from: OLD,
        locked: true,
      } as Assignment),
    ).toBe(true)
    expect(
      needsRenameFinish({ slug: NEW, renamed_from: OLD } as Assignment),
    ).toBe(false)
    expect(needsRenameFinish({ slug: NEW, locked: true } as Assignment)).toBe(
      false,
    )
  })
})
