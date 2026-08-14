import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  addFounderCollaborator,
  assertAssignmentModeCoherent,
  buildReusedEntry,
  copyAssignmentToClassroom,
  createAssignmentRepo,
  editAssignment,
  founderPermission,
  nextAvailableSlug,
  permissionSatisfies,
  preserveUnmanagedAssignmentKeys,
  resolveAutograderWorkflow,
  resolveTemplate,
  resolveTemplateGrant,
  setAssignmentLock,
  setAssignmentClosed,
  migrateClassroomAssignments,
  TEMPLATE_READ_STAFF_ROLES,
  verifyTemplateAccess,
} from "./assignments"
// Not on the @/domain/assignments barrel (the wrapper is internal scaffolding),
// so reach the module directly rather than widening the public surface.
import { withAcceptStep } from "./assignments/accessPrimitives"
import { defaultAutograderWorkflow } from "./assignments/autograderYaml"
import { extractAssignments } from "@/github-core/queries"
import { localizedError, localizedMessageOf } from "@/types/localizedMessage"
import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"
import { REPO_PERMISSIONS, SUBMISSION_MODES } from "@/types/classroom"
import type { SubmissionMode } from "@/types/classroom"

const fullSource: Assignment = {
  slug: "hw1",
  name: "Homework 1",
  description: "Intro problem set",
  mode: "individual",
  autograder: "default",
  feedback_pr: true,
  template: { owner: "acme", repo: "hw1-starter", branch: "main" },
  due: "2026-09-01T23:59:00Z",
  due_meta: {
    input: "2026-09-01 23:59",
    offset: "+00:00",
    source: "explicit-offset",
  },
  max_group_size: 3,
  runtime: { "runs-on": "ubuntu-latest", container: { image: "python:3.14" } },
  allowed_files: ["src/*.py", "!src/secret.py"],
  release_assets: ["report.pdf", "plots/chart.png"],
  pass_threshold: 80,
  tests: [{ type: "run", name: "build", run: "make", points: 10 }],
}

describe("buildReusedEntry", () => {
  it("copies every field verbatim, overriding only slug and name", () => {
    const entry = buildReusedEntry(fullSource, {
      slug: "hw1-fall",
      name: "Homework 1 (Fall)",
    })

    expect(entry).toEqual({
      ...fullSource,
      slug: "hw1-fall",
      name: "Homework 1 (Fall)",
    })
  })

  it("deep-copies nested objects and arrays (no shared references)", () => {
    const entry = buildReusedEntry(fullSource, {
      slug: "hw1",
      name: "Homework 1",
    })

    expect(entry.template).not.toBe(fullSource.template)
    expect(entry.due_meta).not.toBe(fullSource.due_meta)
    expect(entry.runtime).not.toBe(fullSource.runtime)
    expect(entry.runtime?.container).not.toBe(fullSource.runtime?.container)
    expect(entry.allowed_files).not.toBe(fullSource.allowed_files)
    expect(entry.release_assets).not.toBe(fullSource.release_assets)
    expect(entry.tests).not.toBe(fullSource.tests)
    expect(entry.tests?.[0]).not.toBe(fullSource.tests?.[0])

    // Mutating the copy must not leak back into the source.
    entry.allowed_files?.push("extra")
    entry.release_assets?.push("extra.txt")
    entry.tests?.push({ type: "run", name: "x", run: "x", points: 0 })
    expect(fullSource.allowed_files).toHaveLength(2)
    expect(fullSource.release_assets).toHaveLength(2)
    expect(fullSource.tests).toHaveLength(1)
  })

  it("trims the slug and name overrides", () => {
    const entry = buildReusedEntry(fullSource, {
      slug: "  hw1-fall  ",
      name: "  Homework 1  ",
    })
    expect(entry.slug).toBe("hw1-fall")
    expect(entry.name).toBe("Homework 1")
  })

  it("defaults to the source slug/name when overrides match them", () => {
    const entry = buildReusedEntry(fullSource, {
      slug: fullSource.slug,
      name: fullSource.name,
    })
    expect(entry.slug).toBe("hw1")
    expect(entry.name).toBe("Homework 1")
  })

  it("throws when the slug is blank", () => {
    expect(() =>
      buildReusedEntry(fullSource, { slug: "   ", name: "Homework 1" }),
    ).toThrow(/slug is required/i)
  })

  it("omits absent optional fields rather than writing them as undefined", () => {
    const minimal: Assignment = {
      slug: "bare",
      name: "Bare",
      mode: "individual",
      autograder: "default",
    }
    const entry = buildReusedEntry(minimal, { slug: "bare2", name: "Bare 2" })

    // Keys that resolve to undefined must not be present (omitempty-clean for
    // the strict CLI parser).
    expect("template" in entry).toBe(false)
    expect("due_meta" in entry).toBe(false)
    expect("runtime" in entry).toBe(false)
    expect("allowed_files" in entry).toBe(false)
    expect("tests" in entry).toBe(false)
    expect(entry).toEqual({
      slug: "bare2",
      name: "Bare 2",
      mode: "individual",
      autograder: "default",
    })
  })

  it("drops an empty runtime.container while keeping runtime", () => {
    const source: Assignment = {
      slug: "rt",
      name: "Runtime only",
      mode: "individual",
      autograder: "default",
      runtime: { "runs-on": "ubuntu-latest" },
    }
    const entry = buildReusedEntry(source, { slug: "rt2", name: "Runtime 2" })
    expect(entry.runtime).toEqual({ "runs-on": "ubuntu-latest" })
    expect("container" in (entry.runtime ?? {})).toBe(false)
  })

  it("preserves a pass_threshold of 0 (falsy but meaningful)", () => {
    const source: Assignment = {
      slug: "z",
      name: "Zero",
      mode: "individual",
      autograder: "default",
      pass_threshold: 0,
    }
    const entry = buildReusedEntry(source, { slug: "z2", name: "Zero 2" })
    expect(entry.pass_threshold).toBe(0)
  })

  it("omits empty release_assets and rejects invalid populated reuse", () => {
    const empty = buildReusedEntry(
      { ...fullSource, release_assets: [] },
      { slug: "copy", name: "Copy" },
    )
    expect("release_assets" in empty).toBe(false)

    expect(() =>
      buildReusedEntry(
        { ...fullSource, release_assets: ["a/report.pdf", "b/report.pdf"] },
        { slug: "copy", name: "Copy" },
      ),
    ).toThrow(/configured more than once/i)
  })

  it("rejects populated release_assets when reusing an empty_repo assignment", () => {
    const source: Assignment = {
      slug: "bare",
      name: "Bare",
      mode: "individual",
      autograder: "default",
      feedback_pr: false,
      empty_repo: true,
      release_assets: ["report.pdf"],
    }

    expect(() =>
      buildReusedEntry(source, { slug: "bare-copy", name: "Bare Copy" }),
    ).toThrow(/empty_repo.*release/i)
  })

  it("preserves no_autograder verbatim on reuse (tolerate-and-preserve)", () => {
    // no_autograder rides through the whole-source spread — a templated
    // teacher-supplied-CI assignment stays that way when copied to a new
    // classroom. Unlike empty_repo it keeps its template.
    const source: Assignment = {
      slug: "ci-lab",
      name: "CI Lab",
      mode: "individual",
      autograder: "default",
      template: { owner: "o", repo: "t", branch: "main" },
      feedback_pr: true,
      no_autograder: true,
    }

    const copy = buildReusedEntry(source, { slug: "ci-copy", name: "CI Copy" })
    expect(copy.no_autograder).toBe(true)
    expect(copy.template).toEqual({ owner: "o", repo: "t", branch: "main" })
    expect(copy.feedback_pr).toBe(true)
  })

  it("preserves an empty tests/allowed_files array (present, not dropped)", () => {
    // Empty array is truthy, so the omitempty cleanup must NOT delete it —
    // absent vs [] can mean different things to the CLI, so reuse copies the
    // source's choice verbatim.
    const source: Assignment = {
      slug: "e",
      name: "Empties",
      mode: "individual",
      autograder: "default",
      tests: [],
      allowed_files: [],
    }
    const entry = buildReusedEntry(source, { slug: "e2", name: "Empties 2" })
    expect(entry.tests).toEqual([])
    expect(entry.allowed_files).toEqual([])
  })

  it("copies a runtime with a container but no runs-on", () => {
    const source: Assignment = {
      slug: "c",
      name: "Container only",
      mode: "individual",
      autograder: "default",
      runtime: { container: { image: "node:22" } },
    }
    const entry = buildReusedEntry(source, { slug: "c2", name: "Container 2" })
    expect(entry.runtime).toEqual({ container: { image: "node:22" } })
  })

  it("copies language toolchains + apt, deep-copying the apt array", () => {
    const source: Assignment = {
      slug: "lang",
      name: "Languages",
      mode: "individual",
      autograder: "default",
      runtime: {
        python: "3.14",
        node: "20",
        java: "21",
        go: "1.23",
        apt: ["cmake", "valgrind"],
      },
    }
    const entry = buildReusedEntry(source, {
      slug: "lang2",
      name: "Languages 2",
    })
    expect(entry.runtime).toEqual({
      python: "3.14",
      node: "20",
      java: "21",
      go: "1.23",
      apt: ["cmake", "valgrind"],
    })
    // apt is re-cloned, not shared, so mutating the copy can't leak back.
    expect(entry.runtime?.apt).not.toBe(source.runtime?.apt)
    entry.runtime?.apt?.push("extra")
    expect(source.runtime?.apt).toHaveLength(2)
  })

  it("self-heals a container+apt source by dropping apt (mirrors the edit path)", () => {
    // A legacy source illegally carrying both container and apt would produce an
    // assignments.json the CLI rejects; reuse drops apt so the copy is valid.
    const source = {
      slug: "c",
      name: "Container + apt",
      mode: "individual",
      autograder: "default",
      runtime: { container: { image: "ubuntu:24.04" }, apt: ["cmake"] },
    } as unknown as Assignment
    const entry = buildReusedEntry(source, { slug: "c2", name: "Copy" })
    expect(entry.runtime).toEqual({ container: { image: "ubuntu:24.04" } })
    expect("apt" in (entry.runtime ?? {})).toBe(false)
  })
})

describe("preserveUnmanagedAssignmentKeys", () => {
  it("carries forward migrated_from from the existing entry", () => {
    const existing: Assignment = {
      ...fullSource,
      migrated_from: {
        source: "github-classroom",
        classroom_id: 42,
        assignment_id: 7,
        original_slug: "hw1-old",
        migrated_at: "2026-01-02T03:04:05Z",
      },
    }
    // A fresh form rebuild drops migrated_from.
    const edited: Assignment = {
      slug: "hw1",
      name: "Homework 1 (edited)",
      mode: "individual",
      autograder: "default",
    }
    const merged = preserveUnmanagedAssignmentKeys(existing, edited)
    expect(merged.migrated_from).toEqual(existing.migrated_from)
    expect(merged.name).toBe("Homework 1 (edited)")
  })

  it("preserves unknown future keys but never overwrites managed ones", () => {
    const existing = {
      slug: "hw1",
      name: "Old name",
      mode: "individual",
      autograder: "default",
      // Unknown key from a newer binary.
      experimental_flag: { enabled: true },
      // Stale managed key the edit changes below.
      pass_threshold: 50,
    } as unknown as Assignment
    const edited: Assignment = {
      slug: "hw1",
      name: "New name",
      mode: "individual",
      autograder: "default",
      pass_threshold: 90,
    }
    const merged = preserveUnmanagedAssignmentKeys(existing, edited) as Record<
      string,
      unknown
    >
    expect(merged.experimental_flag).toEqual({ enabled: true })
    expect(merged.pass_threshold).toBe(90)
    expect(merged.name).toBe("New name")
  })

  it("does not re-add a managed key the edit deliberately cleared", () => {
    const existing: Assignment = { ...fullSource, due: "2026-09-01T23:59:00Z" }
    // Edit removed the due date (omitted from the rebuilt entry).
    const edited: Assignment = {
      slug: "hw1",
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
    }
    const merged = preserveUnmanagedAssignmentKeys(existing, edited)
    expect(merged.due).toBeUndefined()
  })

  it("preserves closed (and locked) across an edit that never carries them", () => {
    // Both flags are owned by their own actions, not the edit form; a rebuilt
    // entry omits them, so the merge must carry them forward verbatim.
    const existing: Assignment = { ...fullSource, closed: true, locked: true }
    const edited: Assignment = {
      slug: "hw1",
      name: "Homework 1 (edited)",
      mode: "individual",
      autograder: "default",
    }
    const merged = preserveUnmanagedAssignmentKeys(existing, edited)
    expect(merged.closed).toBe(true)
    expect(merged.locked).toBe(true)
  })
})

describe("nextAvailableSlug", () => {
  it("returns the base unchanged when it is free", () => {
    expect(nextAvailableSlug("hw1", ["hw2", "hw3"])).toBe("hw1")
    expect(nextAvailableSlug("hw1", [])).toBe("hw1")
  })

  it("suffixes -2 when the base is taken", () => {
    expect(nextAvailableSlug("hw1", ["hw1"])).toBe("hw1-2")
  })

  it("skips taken suffixes until it finds a free one", () => {
    expect(nextAvailableSlug("hw1", ["hw1", "hw1-2", "hw1-3"])).toBe("hw1-4")
  })

  it("increments a base that already ends in -<n> instead of stacking", () => {
    expect(nextAvailableSlug("hw1-2", ["hw1-2"])).toBe("hw1-3")
    expect(nextAvailableSlug("hw1-2", ["hw1-2", "hw1-3"])).toBe("hw1-4")
  })

  it("treats a base ending in -<n> as free when nothing collides", () => {
    expect(nextAvailableSlug("hw1-2", ["hw1"])).toBe("hw1-2")
  })

  it("matches taken slugs case-insensitively", () => {
    expect(nextAvailableSlug("HW1", ["hw1"])).toBe("HW1-2")
    expect(nextAvailableSlug("hw1", ["HW1", "Hw1-2"])).toBe("hw1-3")
  })

  it("splits only the trailing -<n> on a stem with internal hyphens", () => {
    // "hw-1-2" -> stem "hw-1", n=3 (not "hw" / "hw-1-2-2").
    expect(nextAvailableSlug("hw-1-2", ["hw-1-2"])).toBe("hw-1-3")
  })
})

describe("editAssignment (preserved-entry integration)", () => {
  const ORG = "acme"
  const CLASSROOM = "cs50"
  const SLUG = "hw1"
  const notFound = (url: string) =>
    new GitHubAPIError({
      status: 404,
      url,
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

  // The CLI-authored entry the GUI is about to edit: carries a CLI-only
  // migrated_from block (the form never manages it) and a managed `due` the edit
  // clears.
  const existingEntry: Assignment = {
    slug: SLUG,
    name: "Homework 1",
    mode: "individual",
    autograder: "default",
    feedback_pr: true,
    due: "2026-09-01T23:59:00Z",
    migrated_from: {
      source: "github-classroom",
      classroom_id: 42,
      assignment_id: 7,
      original_slug: "hw1-old",
      migrated_at: "2026-01-02T03:04:05Z",
    },
  }

  // Route-table GitHubClient covering exactly the endpoints editAssignment hits
  // on the template-less path: ref read, commit read, assignments.json contents
  // read, then tree/commit/ref writes. classroom.json is absent (404) so the
  // archive guard reads the classroom as active.
  function makeClient(entry: Assignment = existingEntry): {
    client: GitHubClient
    committedContent: () => string
  } {
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [entry],
    }
    const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")

    let committedContent = ""

    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      if (
        method === "GET" &&
        url.endsWith("/contents/.github/scripts/materialize_tests.py")
      ) {
        return { type: "file" }
      }
      if (
        method === "GET" &&
        url.endsWith(`/contents/${CLASSROOM}/autograders/${SLUG}/autograder.py`)
      ) {
        throw notFound(url)
      }
      if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      if (method === "GET" && url.includes("/git/ref/heads/main")) {
        return { object: { sha: "refsha" } }
      }
      if (method === "GET" && url.includes("/git/commits/refsha")) {
        return { tree: { sha: "basetree" } }
      }
      if (method === "GET" && url.includes("/contents/cs50/assignments.json")) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(JSON.stringify(assignmentsFile)),
        }
      }
      if (method === "POST" && url.endsWith("/git/trees")) {
        const body = (init as { body?: { tree: { content: string }[] } }).body
        committedContent = body!.tree[0].content
        return { sha: "newtree" }
      }
      if (method === "POST" && url.endsWith("/git/commits")) {
        return { sha: "newcommit" }
      }
      if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
        return { object: { sha: "newcommit" } }
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    // classroom.json read (archive guard): 404 -> treated as active.
    const requestRaw = vi.fn(async () => {
      throw new GitHubAPIError({
        status: 404,
        url: "classroom.json",
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
    })

    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      committedContent: () => committedContent,
    }
  }

  function editInput(overrides: Partial<Record<string, unknown>> = {}) {
    // The form rebuilds only the fields it manages; this renames the
    // assignment and clears the due date (omitted from the rebuilt entry).
    return {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      name: "Homework 1 (edited)",
      description: "",
      template_repo: "",
      due_date: "",
      mode: "individual",
      max_group_size: 0,
      release_assets: "",
      tests: [],
      ...overrides,
    } as unknown as Parameters<typeof editAssignment>[1]
  }

  it("preserves migrated_from, applies the rename, and drops the cleared due", async () => {
    const { client, committedContent } = makeClient()

    await editAssignment(client, editInput())

    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!

    // Unmanaged CLI field rides through the read-modify-write.
    expect(edited.migrated_from).toEqual(existingEntry.migrated_from)
    // Managed edit wins.
    expect(edited.name).toBe("Homework 1 (edited)")
    // Cleared managed key is not resurrected from the stale existing entry.
    expect(edited.due).toBeUndefined()
  })

  it("pins the written slug to the stored assignment (no rename on edit)", async () => {
    const { client, committedContent } = makeClient()

    await editAssignment(client, editInput())

    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    // Exactly one entry, and its slug is the stored identity — the edit rebuilds
    // the entry but can never change the slug (it's the repo-path identity and
    // the lookup key). Guards the explicit slug pin in editAssignment.
    expect(written.assignments).toHaveLength(1)
    expect(written.assignments[0].slug).toBe(SLUG)
    expect(written.assignments[0].name).toBe("Homework 1 (edited)")
  })

  it.each([
    ["omitted", undefined, undefined],
    ["zero", 0, undefined],
    ["positive", 600, 600],
  ] as const)(
    "serializes a %s setup timeout through the existing test contract",
    async (_label, setupTimeout, expectedTimeout) => {
      const { client, committedContent } = makeClient()
      const overrides: Record<string, unknown> = {
        setup_command: "python3 -m pip install -e .",
      }
      if (setupTimeout !== undefined) {
        overrides.setup_timeout = setupTimeout
      }

      await editAssignment(client, editInput(overrides))

      const written = JSON.parse(committedContent()) as {
        assignments: Assignment[]
      }
      expect(written.assignments[0].tests?.[0]).toEqual({
        name: "setup",
        type: "run",
        run: "python3 -m pip install -e .",
        points: 0,
        ...(expectedTimeout === undefined ? {} : { timeout: expectedTimeout }),
      })
    },
  )

  it("rejects an invalid setup timeout at the write boundary", async () => {
    const { client } = makeClient()

    await expect(
      editAssignment(
        client,
        editInput({ setup_command: "make", setup_timeout: 601 }),
      ),
    ).rejects.toThrow(/setup_timeout/)
  })

  it("ignores setup timeout when the command is blank", async () => {
    const { client, committedContent } = makeClient()

    await editAssignment(
      client,
      editInput({ setup_command: "  ", setup_timeout: 601 }),
    )

    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    expect(written.assignments[0].tests).toBeUndefined()
  })

  it("writes ordered exact release paths and omits blank input", async () => {
    const first = makeClient()
    await editAssignment(
      first.client,
      editInput({ release_assets: "report.pdf\nplots/chart.png" }),
    )
    const written = JSON.parse(first.committedContent()) as {
      assignments: Assignment[]
    }
    expect(written.assignments[0].release_assets).toEqual([
      "report.pdf",
      "plots/chart.png",
    ])

    const second = makeClient({
      ...existingEntry,
      release_assets: ["report.pdf"],
    })
    await editAssignment(second.client, editInput({ release_assets: "" }))
    const cleared = JSON.parse(second.committedContent()) as {
      assignments: Assignment[]
    }
    expect("release_assets" in cleared.assignments[0]).toBe(false)
  })

  it("rejects invalid direct release paths", async () => {
    const ordinary = makeClient()
    await expect(
      editAssignment(
        ordinary.client,
        editInput({ release_assets: "../report.pdf" }),
      ),
    ).rejects.toThrow(/release_assets/)
  })

  it("throws when the target slug does not exist (edit is slug-keyed)", async () => {
    const { client } = makeClient()

    await expect(
      editAssignment(client, editInput({ slug: "does-not-exist" })),
    ).rejects.toThrow(/does-not-exist/)
  })

  it("writes language runtimes and drops an unknown runtime sub-key on edit", async () => {
    // Existing entry with language toolchains + apt AND a foreign runtime
    // sub-key (`rust`). `runtime` is a CLOSED contract object — the CLI decodes
    // it with DisallowUnknownFields (RuntimeRef has no Extra) and the schema
    // sets additionalProperties:false — so a GUI edit must rebuild runtime from
    // the known sub-keys and drop the foreign key, self-healing rather than
    // round-tripping a file the CLI would refuse to parse.
    const runtimeEntry = {
      slug: SLUG,
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      feedback_pr: true,
      runtime: {
        python: "3.11",
        node: "20",
        apt: ["cmake"],
        rust: "1.80",
      },
    } as unknown as Assignment
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [runtimeEntry],
    }
    const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")
    let capturedContent = ""
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      if (method === "GET" && url.includes("/git/ref/heads/main")) {
        return { object: { sha: "refsha" } }
      }
      if (method === "GET" && url.includes("/git/commits/refsha")) {
        return { tree: { sha: "basetree" } }
      }
      if (method === "GET" && url.includes("/contents/cs50/assignments.json")) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(JSON.stringify(assignmentsFile)),
        }
      }
      if (method === "POST" && url.endsWith("/git/trees")) {
        const body = (init as { body?: { tree: { content: string }[] } }).body
        capturedContent = body!.tree[0].content
        return { sha: "newtree" }
      }
      if (method === "POST" && url.endsWith("/git/commits")) {
        return { sha: "newcommit" }
      }
      if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
        return { object: { sha: "newcommit" } }
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    const requestRaw = vi.fn(async () => {
      throw new GitHubAPIError({
        status: 404,
        url: "classroom.json",
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
    })
    const client = { request, requestRaw } as unknown as GitHubClient

    // The edit form round-trips the language fields (python bumped to 3.14,
    // node/apt kept). `rust` is not a schema sub-key, so it must be dropped.
    await editAssignment(
      client,
      editInput({
        runtime_python: "3.14",
        runtime_node: "20",
        runtime_apt: "cmake",
      }),
    )

    const written = JSON.parse(capturedContent) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.runtime).toEqual({
      python: "3.14",
      node: "20",
      apt: ["cmake"],
    })
    // The foreign runtime sub-key self-heals away (closed contract object).
    expect("rust" in (edited.runtime ?? {})).toBe(false)
  })

  it("drops language + apt runtime on a self-hosted runner (matches the workflow's runner.environment skip, #369)", async () => {
    const { client, committedContent } = makeClient()

    // A self-hosted runner skips managed toolchain/apt setup at grade time, so
    // persisting python/apt would write values the runtime discards. runs-on is
    // kept; only the ignored toolchain sub-keys are stripped.
    await editAssignment(
      client,
      editInput({
        runs_on: "self-hosted, linux, x64",
        runtime_python: "3.14",
        runtime_node: "20",
        runtime_apt: "cmake",
      }),
    )

    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.runtime).toEqual({
      "runs-on": ["self-hosted", "linux", "x64"],
    })
    for (const key of ["python", "node", "java", "go", "rust", "apt"]) {
      expect(key in (edited.runtime ?? {})).toBe(false)
    }
  })

  it("keeps language + apt runtime on a hosted runner", async () => {
    const { client, committedContent } = makeClient()

    await editAssignment(
      client,
      editInput({
        runs_on: "ubuntu-latest",
        runtime_python: "3.14",
        runtime_apt: "cmake",
      }),
    )

    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.runtime).toEqual({
      "runs-on": "ubuntu-latest",
      python: "3.14",
      apt: ["cmake"],
    })
  })

  it("rejects apt packages combined with a container image", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(
        client,
        editInput({ container_image: "gcc:13", runtime_apt: "cmake" }),
      ),
    ).rejects.toThrow(/can't be combined with a Docker image/i)
  })

  it("rejects a container image paired with a macOS/Windows runner label", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(
        client,
        editInput({ container_image: "gcc:13", runs_on: "macos-15" }),
      ),
    ).rejects.toThrow(/Ubuntu hosts only/i)
  })

  it("rejects an invalid language version before any write", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(client, editInput({ runtime_python: "3.14 bad" })),
    ).rejects.toThrow(/runtime\.python/i)
  })

  it("rejects a container image with shell metacharacters before any write", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(
        client,
        editInput({ container_image: "ubuntu:24.04;rm -rf /" }),
      ),
    ).rejects.toThrow(/runtime\.container\.image/i)
  })

  it("rejects a container user with a dangling colon before any write", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(
        client,
        editInput({ container_image: "ubuntu:24.04", container_user: "1000:" }),
      ),
    ).rejects.toThrow(/runtime\.container\.user/i)
  })

  it("rejects an injection-shaped runs-on label before any write", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(client, editInput({ runs_on: "a;b" })),
    ).rejects.toThrow(/runtime\.runs-on/i)
  })

  it("allows flipping empty_repo on after creation (mutable, UI warns)", async () => {
    // existingEntry has no empty_repo (false); the edit enables it. The domain
    // layer no longer blocks this — the UI warns when students already
    // accepted, since existing repos aren't retrofitted.
    const { client, committedContent } = makeClient()
    await editAssignment(client, editInput({ empty_repo: true }))
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.empty_repo).toBe(true)
  })

  it("allows flipping no_autograder off after creation (mutable, UI warns)", async () => {
    const ciEntry: Assignment = {
      slug: SLUG,
      name: "CI Lab",
      mode: "individual",
      autograder: "default",
      template: { owner: "o", repo: "t", branch: "main" },
      feedback_pr: true,
      no_autograder: true,
    }
    const { client, committedContent } = makeBareClient(ciEntry)
    await editAssignment(client, editInput({ no_autograder: false }))
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    // Collapsed to the wire's absent-is-false shape.
    expect(edited.no_autograder).toBeUndefined()
  })

  it("allows flipping init_shim on after creation (mutable, UI warns)", async () => {
    // existingEntry has no init_shim; the edit enables it. No longer blocked.
    const { client, committedContent } = makeClient()
    await editAssignment(client, editInput({ init_shim: true }))
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.init_shim).toBe(true)
  })

  it("allows flipping init_shim off after creation (mutable, UI warns)", async () => {
    const shimEntry: Assignment = {
      slug: SLUG,
      name: "Scratch",
      mode: "individual",
      autograder: "default",
      feedback_pr: true,
      init_shim: true,
    }
    const { client, committedContent } = makeBareClient(shimEntry)
    await editAssignment(client, editInput({ init_shim: false }))
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.init_shim).toBeUndefined()
  })

  it("allows changing grading.mode after creation (auto -> manual, UI warns)", async () => {
    // existingEntry has no grading (resolves to auto); the edit sets manual. No
    // longer blocked — the UI warns that scores under the old mode may misread.
    const { client, committedContent } = makeClient()
    await editAssignment(
      client,
      editInput({ grading: { mode: "manual", max_points: 50 } }),
    )
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.grading).toEqual({ mode: "manual", max_points: 50 })
  })

  it("allows changing grading.mode after creation (manual -> auto, UI warns)", async () => {
    const manualEntry: Assignment = {
      slug: SLUG,
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      template: { owner: "cs50", repo: "hello-template", branch: "main" },
      feedback_pr: true,
      grading: { mode: "manual", max_points: 50 },
    }
    const { client, committedContent } = makeBareClient(manualEntry)
    await editAssignment(client, editInput({ grading: { mode: "auto" } }))
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    // auto collapses to omitted (today's wire default).
    expect(edited.grading).toBeUndefined()
  })

  it("writes grading:{mode,max_points} on a same-mode manual edit", async () => {
    // A manual assignment edited without changing the mode: buildAssignmentEntry
    // emits the grading block. max_points is mutable, so a bumped value lands.
    const manualEntry: Assignment = {
      slug: SLUG,
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      template: { owner: "cs50", repo: "hello-template", branch: "main" },
      feedback_pr: true,
      grading: { mode: "manual", max_points: 50 },
    }
    const { client, committedContent } = makeBareClient(manualEntry)
    await editAssignment(
      client,
      editInput({ grading: { mode: "manual", max_points: 80 } }),
    )
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.grading).toEqual({ mode: "manual", max_points: 80 })
  })

  it("rejects a manual grading edit with an out-of-range max_points", async () => {
    // Manual edit with max_points 0 must hit buildAssignmentEntry's grading
    // validation throw (min 1).
    const manualEntry: Assignment = {
      slug: SLUG,
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      template: { owner: "cs50", repo: "hello-template", branch: "main" },
      feedback_pr: true,
      grading: { mode: "manual", max_points: 50 },
    }
    const { client } = makeBareClient(manualEntry)
    await expect(
      editAssignment(
        client,
        editInput({ grading: { mode: "manual", max_points: 0 } }),
      ),
    ).rejects.toThrow(/grading\.max_points/)
  })

  it("rejects a grading edit carrying max_points on a non-manual mode", async () => {
    // An auto assignment edited with grading:{mode:auto, max_points} must hit
    // the defensive "max_points only valid for manual" throw.
    const { client } = makeClient()
    await expect(
      editAssignment(
        client,
        editInput({ grading: { mode: "auto", max_points: 10 } }),
      ),
    ).rejects.toThrow(/grading\.max_points/)
  })

  it("allows flipping empty_repo off after creation (mutable, UI warns)", async () => {
    const bareEntry: Assignment = {
      slug: SLUG,
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      feedback_pr: false,
      empty_repo: true,
    }
    const { client, committedContent } = makeBareClient(bareEntry)
    // Form sends empty_repo: false — a flip that now lands.
    await editAssignment(client, editInput({ empty_repo: false }))
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.empty_repo).toBeUndefined()
  })

  it("preserves empty_repo and forces feedback_pr off on a same-value edit", async () => {
    const bareEntry: Assignment = {
      slug: SLUG,
      name: "Actions Lab",
      mode: "individual",
      autograder: "default",
      feedback_pr: false,
      empty_repo: true,
    }
    const { client, committedContent } = makeBareClient(bareEntry)

    await editAssignment(
      client,
      editInput({ name: "Actions Lab (edited)", empty_repo: true }),
    )

    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.empty_repo).toBe(true)
    expect(edited.name).toBe("Actions Lab (edited)")
    // feedback_pr stays structurally off even though the input omitted it
    // (the ?? true default must not apply to an empty repo).
    expect(edited.feedback_pr).toBe(false)
  })

  it("rejects grading-adjacent fields alongside empty_repo (mutual exclusion)", async () => {
    const bareEntry: Assignment = {
      slug: SLUG,
      name: "Actions Lab",
      mode: "individual",
      autograder: "default",
      feedback_pr: false,
      empty_repo: true,
    }
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ template_repo: "acme/starter" }, /can't use a template/],
      [{ setup_command: "make", setup_timeout: 601 }, /never autogrades/],
      [{ feedback_pr: true }, /no baseline commit/],
      [{ allowed_files: "*.py" }, /restrict allowed files/],
      [{ release_assets: "report.pdf" }, /release/],
      [{ pass_threshold: 70 }, /passing threshold/],
    ]
    for (const [overrides, want] of cases) {
      const { client } = makeBareClient(bareEntry)
      await expect(
        editAssignment(client, editInput({ empty_repo: true, ...overrides })),
      ).rejects.toThrow(want)
    }
  })

  it("permits the submission definition alongside empty_repo (detection, not a trigger)", async () => {
    // The submission definition is how the app identifies submissions on the
    // submissions page; it is valid for a bare repo (no shim triggers on it).
    const bareEntry: Assignment = {
      slug: SLUG,
      name: "Actions Lab",
      mode: "individual",
      autograder: "default",
      feedback_pr: false,
      empty_repo: true,
    }
    const { client, committedContent } = makeBareClient(bareEntry)
    await editAssignment(
      client,
      editInput({
        empty_repo: true,
        submission_mode: "tag",
        submission_tags: ["phase1", "v*"],
      }),
    )
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.submission_mode).toBe("tag")
    expect(edited.submission_tags).toEqual(["phase1", "v*"])
  })

  // The write path's submission_mode branches (buildAssignmentEntry is not
  // exported — assert through editAssignment, like the sibling tests above):
  // 1.28+ ALWAYS writes submission_mode explicitly (the migration signal), so
  // "tag" and "every-push" both land verbatim and an absent input defaults to
  // an explicit "every-push"; junk is rejected before a file the CLI would
  // refuse to parse can be written.
  it("always writes submission_mode explicitly (the 1.28 migration signal)", async () => {
    for (const [input, want] of [
      ["tag", "tag"],
      ["every-push", "every-push"],
      [undefined, "every-push"],
    ] as const) {
      const { client, committedContent } = makeClient()
      await editAssignment(client, editInput({ submission_mode: input }))
      const written = JSON.parse(committedContent()) as {
        assignments: Assignment[]
      }
      const edited = written.assignments.find((a) => a.slug === SLUG)!
      expect(edited.submission_mode).toBe(want)
    }
  })

  it("rejects an out-of-enum submission_mode before writing", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(client, editInput({ submission_mode: "on-demand" })),
    ).rejects.toThrow(/submission_mode: must be one of every-push, tag/)
  })

  // copy_about / copy_topics (issue #569): template-required guard + omitempty.
  it("rejects copy_about / copy_topics without a template", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(client, editInput({ copy_about: true })),
    ).rejects.toThrow(/copy_about: requires a template/)
    await expect(
      editAssignment(client, editInput({ copy_topics: true })),
    ).rejects.toThrow(/copy_topics: requires a template/)
  })

  it("omits copy_about / copy_topics when false (template-less)", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(client, editInput())
    const written = JSON.parse(committedContent()) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.copy_about).toBeUndefined()
    expect(edited.copy_topics).toBeUndefined()
  })

  // Route-table client like makeClient(), but seeded with a caller-supplied
  // existing entry (the empty_repo tests need a bare one).
  function makeBareClient(entry: Assignment): {
    client: GitHubClient
    committedContent: () => string
  } {
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [entry],
    }
    const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")
    let committedContent = ""

    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      if (method === "GET" && url.includes("/git/ref/heads/main")) {
        return { object: { sha: "refsha" } }
      }
      if (method === "GET" && url.includes("/git/commits/refsha")) {
        return { tree: { sha: "basetree" } }
      }
      if (method === "GET" && url.includes("/contents/cs50/assignments.json")) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(JSON.stringify(assignmentsFile)),
        }
      }
      if (method === "POST" && url.endsWith("/git/trees")) {
        const body = (init as { body?: { tree: { content: string }[] } }).body
        committedContent = body!.tree[0].content
        return { sha: "newtree" }
      }
      if (method === "POST" && url.endsWith("/git/commits")) {
        return { sha: "newcommit" }
      }
      if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
        return { object: { sha: "newcommit" } }
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    const requestRaw = vi.fn(async () => {
      throw new GitHubAPIError({
        status: 404,
        url: "classroom.json",
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
    })
    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      committedContent: () => committedContent,
    }
  }

  it("re-validates an unchanged stored ref and allows a cross-org private fork", async () => {
    // An assignment whose stored template is an in-org private fork of a private
    // cross-org upstream. Editing WITHOUT changing the ref re-validates live via
    // resolveTemplate; since generate copies the fork's own objects, this is no
    // longer blocked — the edit succeeds and re-affirms the team grant.
    const forkEntry: Assignment = {
      slug: SLUG,
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      feedback_pr: true,
      template: { owner: ORG, repo: "hw1-fork", branch: "main" },
    }
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [forkEntry],
    }
    const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")
    const grants: string[] = []

    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      const grantMatch = url.match(/\/orgs\/[^/]+\/teams\/([^/]+)\/repos\//)
      if (method === "PUT" && grantMatch) {
        grants.push(grantMatch[1])
        return {}
      }
      if (/\/repos\/[^/]+\/classroom50$/.test(url))
        return { default_branch: "main" }
      if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
      if (url.includes("/git/commits/s")) return { tree: { sha: "t" } }
      if (url.includes("/contents/cs50/assignments.json")) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(JSON.stringify(assignmentsFile)),
        }
      }
      if (url.endsWith("/git/trees")) return { sha: "newtree" }
      if (url.endsWith("/git/commits")) return { sha: "newcommit" }
      if (url.endsWith("/git/refs/heads/main")) return { object: { sha: "nc" } }
      // getRepo for the re-validated unchanged ref: an in-org private fork of a
      // private upstream in ANOTHER org.
      if (url.includes(`/repos/${ORG}/hw1-fork`)) {
        return {
          name: "hw1-fork",
          full_name: `${ORG}/hw1-fork`,
          private: true,
          is_template: true,
          fork: true,
          parent: { full_name: "other-org/secret-upstream", private: true },
          default_branch: "main",
        }
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const requestRaw = vi.fn(async () => {
      throw new GitHubAPIError({
        status: 404,
        url: "classroom.json",
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
    })
    const client = { request, requestRaw } as unknown as GitHubClient

    // Same ref as stored (bare repo -> owner defaults to org, branch omitted
    // -> unchanged), so the unchanged-ref short-circuit is exercised.
    const result = await editAssignment(
      client,
      editInput({
        slug: SLUG,
        template_repo: "hw1-fork",
        canGrantTemplateAccess: true,
      }),
    )

    // The edit committed instead of throwing the old cross-org-fork block:
    // resolveTemplate now allows the fork, so the write proceeded.
    expect(result).toBeDefined()
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("/git/commits"),
      expect.objectContaining({ method: "POST" }),
    )
  })

  // buildAssignmentEntry's student_permission branch (clamp group up to admin,
  // omit when it equals the mode default) is exercised through editAssignment's
  // write, asserting the entry that lands in the committed assignments.json —
  // the authoring-side clamp, distinct from the accept-time founderPermission
  // clamp covered elsewhere.
  function writtenEntry(committedContent: string): Assignment {
    const written = JSON.parse(committedContent) as {
      assignments: Assignment[]
    }
    return written.assignments.find((a) => a.slug === SLUG)!
  }

  it("individual + push (the default) omits student_permission", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(
      client,
      editInput({ mode: "individual", student_permission: "push" }),
    )
    expect(writtenEntry(committedContent()).student_permission).toBeUndefined()
  })

  it("individual + admin writes admin (a real above-default value)", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(
      client,
      editInput({ mode: "individual", student_permission: "admin" }),
    )
    expect(writtenEntry(committedContent()).student_permission).toBe("admin")
  })

  it("individual + a below-default value (pull) is written verbatim", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(
      client,
      editInput({ mode: "individual", student_permission: "pull" }),
    )
    expect(writtenEntry(committedContent()).student_permission).toBe("pull")
  })

  it("group + push clamps up to admin (which is the group default, so omitted not written as push)", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(
      client,
      editInput({
        mode: "group",
        max_group_size: 3,
        student_permission: "push",
      }),
    )
    // The clamp raises push -> admin; admin is the group default, so the entry
    // omits it. The load-bearing assertion is that the raw below-admin value was
    // NOT written through (a missing clamp would persist "push").
    expect(writtenEntry(committedContent()).student_permission).toBeUndefined()
  })

  it("group + admin (the group default) omits student_permission", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(
      client,
      editInput({
        mode: "group",
        max_group_size: 3,
        student_permission: "admin",
      }),
    )
    expect(writtenEntry(committedContent()).student_permission).toBeUndefined()
  })

  it("group + a below-admin value ('') omits (clamped value equals the group default)", async () => {
    const { client, committedContent } = makeClient()
    await editAssignment(
      client,
      editInput({ mode: "group", max_group_size: 3, student_permission: "" }),
    )
    expect(writtenEntry(committedContent()).student_permission).toBeUndefined()
  })

  it("throws on an off-ladder student_permission value", async () => {
    const { client } = makeClient()
    await expect(
      editAssignment(
        client,
        editInput({
          mode: "individual",
          student_permission: "owner" as unknown as string,
        }),
      ),
    ).rejects.toThrow(/student_permission/)
  })
})

describe("grantTeamTemplateRead (student + HTA/TA staff team eager grant)", () => {
  const ORG = "cs50"
  const CLASSROOM = "cs50"
  const SLUG = "hw1"
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")

  // Drives editAssignment down the in-org-private-template grant path and
  // records every team-repo PUT so a test can assert which teams got read on
  // the template. classroomJson controls the recorded team/teams block.
  function makeGrantClient(opts: {
    classroomJson: Record<string, unknown>
    taGrantThrows?: boolean
    // Visibility/kind of the template the edit resolves to. Defaults to a
    // private in-org template repo (the grant path). Set private:false to model
    // a public template (no grant), or isTemplate:false to model a non-template.
    templatePrivate?: boolean
    templateIsTemplate?: boolean
  }): { client: GitHubClient; grants: () => string[] } {
    const grants: string[] = []
    const templatePrivate = opts.templatePrivate ?? true
    const templateIsTemplate = opts.templateIsTemplate ?? true
    // Serve a repo read for BOTH the changed ref (tmpl-v2) and the stored ref
    // (tmpl), so a test can drive either the changed-ref or the unchanged-ref
    // branch of buildAssignmentEntry.
    const makeRepo = (name: string) => ({
      name,
      full_name: `${ORG}/${name}`,
      private: templatePrivate,
      is_template: templateIsTemplate,
      default_branch: "main",
    })
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [
        {
          slug: SLUG,
          name: "Homework 1",
          mode: "individual",
          autograder: "default",
          feedback_pr: true,
          template: { owner: ORG, repo: "tmpl", branch: "main" },
        },
      ],
    }

    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      // Team-repo grant PUT: /orgs/{org}/teams/{slug}/repos/{owner}/{repo}
      const grantMatch = url.match(/\/orgs\/[^/]+\/teams\/([^/]+)\/repos\//)
      if (method === "PUT" && grantMatch) {
        if (grantMatch[1].endsWith("-ta") && opts.taGrantThrows) {
          throw new GitHubAPIError({
            status: 500,
            url,
            message: "boom",
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
        grants.push(grantMatch[1])
        return {}
      }
      if (/\/repos\/[^/]+\/classroom50$/.test(url))
        return { default_branch: "main" }
      if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
      if (url.includes("/git/commits/s")) return { tree: { sha: "t" } }
      if (url.includes("/contents/cs50/assignments.json")) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(JSON.stringify(assignmentsFile)),
        }
      }
      if (url.includes(`/repos/${ORG}/tmpl-v2`)) return makeRepo("tmpl-v2")
      if (/\/repos\/[^/]+\/tmpl(\?|$)/.test(url)) return makeRepo("tmpl")
      if (url.endsWith("/git/trees")) return { sha: "newtree" }
      if (url.endsWith("/git/commits")) return { sha: "newcommit" }
      if (method === "PATCH" && url.includes("/git/refs/heads/main"))
        return { object: { sha: "newcommit" } }
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    // getClassroomJson (requestRaw) returns the recorded team block; the
    // archive guard reads the same body (active by default).
    const requestRaw = vi.fn(async () => JSON.stringify(opts.classroomJson))

    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      grants: () => grants,
    }
  }

  // `template_repo` defaults to a CHANGED ref (tmpl-v2 vs stored tmpl); pass
  // "tmpl" to exercise the unchanged-ref re-affirm branch.
  function editInput(templateRepo = "tmpl-v2") {
    return {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      name: "Homework 1",
      description: "",
      template_repo: templateRepo,
      due_date: "",
      mode: "individual",
      max_group_size: 0,
      release_assets: "",
      tests: [],
      // These tests exercise the owner-only template read-grant, which the
      // write path now performs only when the caller holds manageOrg.
      canGrantTemplateAccess: true,
    } as unknown as Parameters<typeof editAssignment>[1]
  }

  it("grants the student team plus the HTA and TA staff teams on a private in-org template", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: {
          hta: { id: 8, slug: "classroom50-cs50-hta" },
          ta: { id: 9, slug: "classroom50-cs50-ta" },
        },
      },
    })

    const result = await editAssignment(client, editInput())

    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual([
      "classroom50-cs50",
      "classroom50-cs50-hta",
      "classroom50-cs50-ta",
    ])
  })

  it("warns (not silently) when a non-owner author skips the owner-only grant", async () => {
    // A head-TA edit carries a stored in-org private template but no owner
    // rights; the write path must not attempt addRepositoryToTeam (it would
    // 403). The edit succeeds, no grant fires — but it must NOT silently return
    // undefined, or students 404 on accept with no signal. Surface an
    // owner-required warning instead so a teacher/owner can grant it.
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: { ta: { id: 9, slug: "classroom50-cs50-ta" } },
      },
    })

    // A non-owner input simply omits canGrantTemplateAccess (the mutation hook
    // sets it from can("manageOrg")); build one without the flag.
    const nonOwner = editInput("tmpl-v2") as Record<string, unknown>
    delete nonOwner.canGrantTemplateAccess
    const result = await editAssignment(
      client,
      nonOwner as unknown as Parameters<typeof editAssignment>[1],
    )

    // No owner-only grant fired, but the author is told an owner must act.
    expect(grants()).toEqual([])
    expect(result.templateGrantWarning).toBeDefined()
    expect(result.templateGrantWarning).toContain("organization owner")
  })

  it("grants only the student team when no staff teams are recorded", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
      },
    })

    const result = await editAssignment(client, editInput())

    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual(["classroom50-cs50"])
  })

  it("keeps the edit successful when a staff grant fails (non-blocking)", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: {
          hta: { id: 8, slug: "classroom50-cs50-hta" },
          ta: { id: 9, slug: "classroom50-cs50-ta" },
        },
      },
      taGrantThrows: true,
    })

    const result = await editAssignment(client, editInput())

    // Student + HTA grants landed; the TA failure did not surface as a save
    // warning and did not abort the loop.
    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual(["classroom50-cs50", "classroom50-cs50-hta"])
  })

  it("re-affirms the grant on an UNCHANGED in-org private template ref", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: {
          hta: { id: 8, slug: "classroom50-cs50-hta" },
          ta: { id: 9, slug: "classroom50-cs50-ta" },
        },
      },
    })

    // Same owner/repo/branch as the stored template (tmpl) — the unchanged-ref
    // branch. It must still re-affirm every team so a dropped grant is repaired.
    const result = await editAssignment(client, editInput("tmpl"))

    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual([
      "classroom50-cs50",
      "classroom50-cs50-hta",
      "classroom50-cs50-ta",
    ])
  })

  it("does not grant on an unchanged PUBLIC template ref", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: { ta: { id: 9, slug: "classroom50-cs50-ta" } },
      },
      templatePrivate: false,
    })

    const result = await editAssignment(client, editInput("tmpl"))

    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual([])
  })

  // Reuse path (copyAssignmentToClassroom) shares the same canGrantTemplateAccess
  // guard as create/edit; exercise both the owner (grants fire) and non-owner
  // (grants skipped, owner-required warning) branches through the grant client.
  function reuseSource(): Assignment {
    return {
      slug: "hw1",
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      feedback_pr: true,
      // In-org private template (served by makeGrantClient's `tmpl` route).
      template: { owner: ORG, repo: "tmpl", branch: "main" },
    }
  }

  it("reuse: owner grants student + HTA + TA teams on a private in-org template", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: {
          hta: { id: 8, slug: "classroom50-cs50-hta" },
          ta: { id: 9, slug: "classroom50-cs50-ta" },
        },
      },
    })

    const result = await copyAssignmentToClassroom(client, {
      org: ORG,
      source: reuseSource(),
      targetClassroom: CLASSROOM,
      targetSlug: "hw1-copy",
      canGrantTemplateAccess: true,
    })

    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual([
      "classroom50-cs50",
      "classroom50-cs50-hta",
      "classroom50-cs50-ta",
    ])
  })

  it("reuse: non-owner author warns (no grant) instead of silently skipping", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: { ta: { id: 9, slug: "classroom50-cs50-ta" } },
      },
    })

    const result = await copyAssignmentToClassroom(client, {
      org: ORG,
      source: reuseSource(),
      targetClassroom: CLASSROOM,
      targetSlug: "hw1-copy",
      // canGrantTemplateAccess omitted => non-owner (fail-closed).
    })

    expect(grants()).toEqual([])
    expect(result.templateGrantWarning).toBeDefined()
    expect(result.templateGrantWarning).toContain("organization owner")
  })

  // resolveTemplateGrant is the single grant-decision recipe shared verbatim by
  // createAssignment, editAssignment, and copyAssignmentToClassroom. Testing it
  // directly covers the create entry point's owner/non-owner branch (create
  // builds a full form input the grant-suite mock above doesn't model) without
  // duplicating the whole create write path. Nested here to reuse makeGrantClient
  // and the ORG/CLASSROOM fixtures the mock hardcodes.
  describe("resolveTemplateGrant (shared create/edit/reuse grant decision)", () => {
    const template = { owner: ORG, repo: "tmpl", branch: "main" }

    it("owner (canGrant true) attempts the grant: student + HTA + TA", async () => {
      const { client, grants } = makeGrantClient({
        classroomJson: {
          schema: "classroom50/classroom/v1",
          short_name: CLASSROOM,
          team: { id: 7, slug: "classroom50-cs50" },
          teams: {
            hta: { id: 8, slug: "classroom50-cs50-hta" },
            ta: { id: 9, slug: "classroom50-cs50-ta" },
          },
        },
      })

      const warning = await resolveTemplateGrant(
        client,
        ORG,
        CLASSROOM,
        "hw1",
        template,
        true,
      )

      expect(warning).toBeUndefined()
      expect(grants()).toEqual([
        "classroom50-cs50",
        "classroom50-cs50-hta",
        "classroom50-cs50-ta",
      ])
    })

    it("confirmed non-owner (canGrant false) warns and fires no grant", async () => {
      const { client, grants } = makeGrantClient({
        classroomJson: {
          schema: "classroom50/classroom/v1",
          short_name: CLASSROOM,
          team: { id: 7, slug: "classroom50-cs50" },
        },
      })

      const warning = await resolveTemplateGrant(
        client,
        ORG,
        CLASSROOM,
        "hw1",
        template,
        false,
      )

      expect(grants()).toEqual([])
      expect(warning).toBeDefined()
      expect(warning).toContain("organization owner")
    })

    it("undefined flag is treated as non-owner (fail-closed): warns, no grant", async () => {
      const { client, grants } = makeGrantClient({
        classroomJson: {
          schema: "classroom50/classroom/v1",
          short_name: CLASSROOM,
          team: { id: 7, slug: "classroom50-cs50" },
        },
      })

      const warning = await resolveTemplateGrant(
        client,
        ORG,
        CLASSROOM,
        "hw1",
        template,
        undefined,
      )

      expect(grants()).toEqual([])
      expect(warning).toContain("organization owner")
    })
  })
})

// The TS non-owner staff-team read set is a hand-mirror of the Go source of
// truth (configrepo.TemplateReadStaffRoles). Parse the Go literal and assert the
// two agree, so adding a role on the Go side without updating the TS grant fails
// here — a visible, required edit rather than a silent drop from the web grant.
describe("TEMPLATE_READ_STAFF_ROLES parity with Go TemplateReadStaffRoles", () => {
  // Go role-constant -> wire string (configrepo team.go: RoleHeadTA="hta", etc.).
  const GO_ROLE_VALUES: Record<string, string> = {
    RoleTeacher: "teacher",
    RoleHeadTA: "hta",
    RoleTA: "ta",
  }

  it("matches the Go non-owner staff role set", () => {
    // web/ is process.cwd() in vitest; the Go source is a sibling under cli/.
    const teamGo = readFileSync(
      path.join(
        process.cwd(),
        "..",
        "cli",
        "gh-teacher",
        "internal",
        "configrepo",
        "team.go",
      ),
      "utf8",
    )
    const match = teamGo.match(
      /var TemplateReadStaffRoles = \[\]StaffRole\{([^}]*)\}/,
    )
    expect(
      match,
      "TemplateReadStaffRoles literal not found in team.go",
    ).toBeTruthy()
    const goRoles = match![1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((constName) => {
        const value = GO_ROLE_VALUES[constName]
        expect(
          value,
          `unknown Go StaffRole constant ${constName}; add it to GO_ROLE_VALUES`,
        ).toBeTruthy()
        return value
      })

    expect([...TEMPLATE_READ_STAFF_ROLES]).toEqual(goRoles)
  })
})

describe("copyAssignmentToClassroom (reuse allows cross-org forks)", () => {
  const ORG = "acme"

  // Answers the pre-commit reads plus the full write flow, since a cross-org
  // fork is no longer blocked and reuse now proceeds to commit the entry. Also
  // answers the team-grant PUT + classroom.json read for the in-org private
  // fork case (the real #468 topology: an in-org fork of a cross-org parent).
  function makeClient(repo: unknown): {
    client: GitHubClient
    grants: () => string[]
  } {
    const grants: string[] = []
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [],
    }
    const classroomJson = {
      schema: "classroom50/classroom/v1",
      short_name: "cs51",
      team: { id: 7, slug: "classroom50-cs51" },
    }
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      const grantMatch = url.match(/\/orgs\/[^/]+\/teams\/([^/]+)\/repos\//)
      if (method === "PUT" && grantMatch) {
        grants.push(grantMatch[1])
        return {}
      }
      if (/\/repos\/[^/]+\/classroom50$/.test(url))
        return { default_branch: "main" }
      if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
      if (url.includes("/git/commits/s")) return { tree: { sha: "t" } }
      if (url.includes("/contents/cs51/assignments.json")) {
        return {
          type: "file",
          encoding: "base64",
          content: btoa(JSON.stringify(assignmentsFile)),
        }
      }
      if (url.endsWith("/git/trees")) return { sha: "newtree" }
      if (url.endsWith("/git/commits")) return { sha: "newcommit" }
      if (url.endsWith("/git/refs/heads/main")) return { object: { sha: "nc" } }
      if (url.includes("/repos/")) return repo
      throw new Error(`unexpected request: ${url}`)
    })
    // getClassroomJson + the archive guard both read classroom.json via
    // requestRaw as a raw JSON string.
    const requestRaw = vi.fn(async () => JSON.stringify(classroomJson))
    return {
      client: { request, requestRaw } as unknown as GitHubClient,
      grants: () => grants,
    }
  }

  // The real #468 topology: an in-org private fork whose upstream is a private
  // repo in ANOTHER org. Must reuse successfully (generate copies the fork's own
  // objects) rather than being blocked.
  const forkSource: Assignment = {
    slug: "hw1",
    name: "Homework 1",
    mode: "individual",
    autograder: "default",
    feedback_pr: true,
    template: { owner: ORG, repo: "hw1-fork", branch: "main" },
  }

  it("allows reusing an in-org private fork of a cross-org parent (#468 shape)", async () => {
    const { client } = makeClient({
      name: "hw1-fork",
      full_name: `${ORG}/hw1-fork`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "other-org/secret-upstream", private: true },
      default_branch: "main",
    })

    const result = await copyAssignmentToClassroom(client, {
      org: ORG,
      source: forkSource,
      targetClassroom: "cs51",
      canGrantTemplateAccess: true,
    })

    expect(result.newCommitSha).toBe("newcommit")
  })

  it("allows reusing an in-org private fork with an unknown (absent) parent", async () => {
    const { client } = makeClient({
      name: "hw1-fork",
      full_name: `${ORG}/hw1-fork`,
      private: true,
      is_template: true,
      fork: true,
      default_branch: "main",
    })

    const result = await copyAssignmentToClassroom(client, {
      org: ORG,
      source: forkSource,
      targetClassroom: "cs51",
      canGrantTemplateAccess: true,
    })

    expect(result.newCommitSha).toBe("newcommit")
  })
})

describe("verifyTemplateAccess", () => {
  const ORG = "cs50"

  const emptyRateLimit = {
    limit: null,
    remaining: null,
    used: null,
    reset: null,
    resource: null,
    retryAfter: null,
  }

  // A GitHubClient whose only method that matters here is `request`, which
  // returns the given repo object or throws the given error for the repo read.
  // When `branches` is supplied, a `/branches` request returns that array
  // (the size-0 emptiness tiebreaker) while every other path returns the repo.
  function clientReturning(
    result: unknown | (() => never),
    branches?: unknown[],
  ): GitHubClient {
    const request = vi.fn(async (path: string) => {
      if (branches !== undefined && path.includes("/branches")) {
        return branches
      }
      if (typeof result === "function") {
        ;(result as () => never)()
      }
      return result
    })
    return { request } as unknown as GitHubClient
  }

  function forbidden(
    message: string,
    scopes?: { accepted?: string; granted?: string },
  ) {
    return () => {
      throw new GitHubAPIError({
        status: 403,
        url: `https://api.github.com/repos/${ORG}/tmpl`,
        message,
        body: { message },
        rateLimit: emptyRateLimit,
        acceptedScopes: scopes?.accepted ?? null,
        oauthScopes: scopes?.granted ?? null,
      })
    }
  }

  it("returns ok for a public in-org template", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: false,
      is_template: true,
      default_branch: "main",
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.branch).toBe("main")
      expect(result.inOrg).toBe(true)
    }
  })

  it("returns not-template when is_template is false", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: false,
      is_template: false,
      default_branch: "main",
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("not-template")
  })

  it("returns empty-template when size 0 and the branches probe confirms no commits", async () => {
    const client = clientReturning(
      {
        name: "tmpl",
        full_name: `${ORG}/tmpl`,
        private: false,
        is_template: true,
        // GitHub reports a phantom default_branch for a commitless repo; the
        // authoritative signal is the empty branches array, not size alone.
        default_branch: "main",
        size: 0,
      },
      [], // no branches -> genuinely commitless
    )

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("empty-template")
  })

  it("does NOT flag a fresh repo with commits as empty despite size 0 (regression #544)", async () => {
    // A freshly-pushed repo reports size 0 for minutes even with real commits.
    // The branches probe (non-empty) proves it has commits, so it must resolve.
    const client = clientReturning(
      {
        name: "tmpl",
        full_name: `${ORG}/tmpl`,
        private: true,
        is_template: true,
        default_branch: "main",
        size: 0,
      },
      [{ name: "main" }], // has a branch -> has commits
    )

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).not.toBe("empty-template")
    expect(result.kind).toBe("ok")
  })

  it("fails open (not empty-template) when the size-0 branches probe is inconclusive", async () => {
    // A transient error on the probe must not manufacture a false empty verdict
    // on this advisory path.
    const request = vi.fn(async (path: string) => {
      if (path.includes("/branches")) {
        throw new GitHubAPIError({
          status: 500,
          url: path,
          message: "Server Error",
          body: {},
          rateLimit: emptyRateLimit,
        })
      }
      return {
        name: "tmpl",
        full_name: `${ORG}/tmpl`,
        private: true,
        is_template: true,
        default_branch: "main",
        size: 0,
      }
    })
    const client = { request } as unknown as GitHubClient

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).not.toBe("empty-template")
    expect(result.kind).toBe("ok")
  })

  it("does not probe branches when size > 0 (fast path)", async () => {
    const requestedPaths: string[] = []
    const request = vi.fn(async (path: string) => {
      requestedPaths.push(path)
      return {
        name: "tmpl",
        full_name: `${ORG}/tmpl`,
        private: false,
        is_template: true,
        default_branch: "main",
        size: 12,
      }
    })
    const client = { request } as unknown as GitHubClient

    await verifyTemplateAccess(client, ORG, "tmpl")

    const requestedBranches = requestedPaths.some((p) =>
      p.includes("/branches"),
    )
    expect(requestedBranches).toBe(false)
  })

  it("does not flag a fork as empty-template despite size 0, and never probes branches (regression #528)", async () => {
    // GitHub reports size 0 for a fork sharing objects with its parent even when
    // the fork has commits, so a fork must never be treated as commitless and
    // must never trigger the branches probe.
    const requestedPaths: string[] = []
    const request = vi.fn(async (path: string) => {
      requestedPaths.push(path)
      return {
        name: "cross-org-fork-template",
        full_name: `${ORG}/cross-org-fork-template`,
        private: false,
        is_template: true,
        fork: true,
        default_branch: "main",
        size: 0,
      }
    })
    const client = { request } as unknown as GitHubClient

    const result = await verifyTemplateAccess(
      client,
      ORG,
      "cross-org-fork-template",
    )

    const requestedBranches = requestedPaths.some((p) =>
      p.includes("/branches"),
    )
    expect(requestedBranches).toBe(false)

    expect(result.kind).not.toBe("empty-template")
  })

  it("prefers not-template over empty-template when both apply (ordering)", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: false,
      is_template: false,
      default_branch: "main",
      size: 0,
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("not-template")
  })

  it("returns not-visible when the repo read 404s (getRepo -> null)", async () => {
    const client = clientReturning(() => {
      throw new GitHubAPIError({
        status: 404,
        url: `https://api.github.com/repos/${ORG}/tmpl`,
        message: "Not Found",
        body: null,
        rateLimit: emptyRateLimit,
      })
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("not-visible")
  })

  it("carries GitHub's message and status on a plain 403 (restricted, no scope gap)", async () => {
    const ghMessage =
      "Although you appear to have the correct authorization credentials, the `cs50` organization has an IP allow list enabled"
    const client = clientReturning(forbidden(ghMessage))

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("restricted")
    if (result.kind === "restricted") {
      expect(result.message).toBe(ghMessage)
      expect(result.httpStatus).toBe(403)
      expect(result.scopeGap).toBe(false)
    }
  })

  it("flags scopeGap when the token's scopes don't satisfy the endpoint's required scopes", async () => {
    const client = clientReturning(
      // Endpoint requires repo/read:org; token holds neither -> real gap.
      forbidden("Resource not accessible by integration", {
        accepted: "repo, read:org",
        granted: "read:user",
      }),
    )

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("restricted")
    if (result.kind === "restricted") {
      expect(result.scopeGap).toBe(true)
    }
  })

  it("does NOT flag scopeGap for an org-restriction 403 that still carries X-Accepted-OAuth-Scopes the token satisfies", async () => {
    const client = clientReturning(
      // GitHub sends X-Accepted-OAuth-Scopes on most 403s; the token DOES hold
      // an accepted scope, so this is an org restriction, not a scope gap.
      forbidden(
        "Although you appear to have the correct authorization credentials, the `cs50` organization has enabled OAuth App access restrictions",
        { accepted: "repo", granted: "repo, read:org, workflow" },
      ),
    )

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("restricted")
    if (result.kind === "restricted") {
      expect(result.scopeGap).toBe(false)
    }
  })

  it("returns rate-limited (not restricted) when a 403 is a rate limit", async () => {
    const client = clientReturning(() => {
      throw new GitHubAPIError({
        status: 403,
        url: `https://api.github.com/repos/${ORG}/tmpl`,
        message: "API rate limit exceeded",
        body: null,
        rateLimit: { ...emptyRateLimit, remaining: 0 },
      })
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("rate-limited")
  })

  it("warns private-fork (cross-org) for an in-org private fork of a private upstream in another org", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "other-org/secret-upstream", private: true },
      default_branch: "main",
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("private-fork")
    if (result.kind === "private-fork") {
      expect(result.parent).toBe("other-org/secret-upstream")
      expect(result.parentInOrg).toBe(false)
      expect(result.branch).toBe("main")
    }
  })

  it("marks parentInOrg true when the private fork's upstream is in the classroom org", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: `${ORG}/upstream`, private: true },
      default_branch: "main",
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("private-fork")
    if (result.kind === "private-fork") {
      expect(result.parentInOrg).toBe(true)
    }
  })

  it("stays ok for a private fork whose upstream parent is public", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "other-org/public-upstream", private: false },
      default_branch: "main",
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    // A public parent generates fine, so no fork warning.
    expect(result.kind).toBe("ok")
  })

  it("warns private-fork with no named parent when GitHub omits the parent object", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      // parent omitted -> unknown upstream visibility, still warn (fail closed).
      default_branch: "main",
    })

    const result = await verifyTemplateAccess(client, ORG, "tmpl")

    expect(result.kind).toBe("private-fork")
    if (result.kind === "private-fork") {
      expect(result.parent).toBeUndefined()
      // Unknown upstream is treated as the higher-risk cross-org case.
      expect(result.parentInOrg).toBe(false)
    }
  })

  it("short-circuits to private-out-of-org (not private-fork) for an out-of-org private fork", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: "other-org/tmpl",
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "third-org/secret-upstream", private: true },
      default_branch: "main",
    })

    // Reference points at another org, so the private-out-of-org guard must fire
    // before the private-fork branch.
    const result = await verifyTemplateAccess(client, ORG, "other-org/tmpl")

    expect(result.kind).toBe("private-out-of-org")
  })

  it("classifies a teacher's own-account private fork as private-out-of-org (not private-fork / not ok-verify)", async () => {
    // Own-account (owner != org) private repo hits the private-out-of-org guard
    // before the fork branch and before ok-verify, locking the three-way parity
    // between verify, resolve, and accept for own-account private forks.
    const client = clientReturning({
      name: "tmpl",
      full_name: "teacher/tmpl",
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "other-org/secret-upstream", private: true },
      default_branch: "main",
    })

    const result = await verifyTemplateAccess(
      client,
      ORG,
      "teacher/tmpl",
      "teacher",
    )

    expect(result.kind).toBe("private-out-of-org")
  })
})

describe("resolveTemplate (create/edit blocking path)", () => {
  const ORG = "cs50"
  const ref = (owner: string, repo: string) => ({ owner, repo })

  function clientReturning(
    result: unknown,
    branches?: unknown[],
  ): GitHubClient {
    const request = vi.fn(async (path: string) => {
      if (branches !== undefined && path.includes("/branches")) {
        return branches
      }
      return result
    })
    return { request } as unknown as GitHubClient
  }

  it("throws for an empty template (size 0 and branches probe confirms no commits)", async () => {
    const client = clientReturning(
      {
        name: "tmpl",
        full_name: `${ORG}/tmpl`,
        private: false,
        is_template: true,
        default_branch: "main",
        size: 0,
      },
      [], // no branches -> genuinely commitless
    )

    await expect(
      resolveTemplate(client, ORG, ref(ORG, "tmpl")),
    ).rejects.toThrow(/has no commits/)
  })

  it("resolves a fresh template with commits despite size 0 (regression #544)", async () => {
    // A freshly-pushed repo reports size 0 for minutes even with real commits;
    // the branches probe (non-empty) proves it has commits, so it must resolve
    // rather than throw "has no commits".
    const client = clientReturning(
      {
        name: "tmpl",
        full_name: `${ORG}/tmpl`,
        private: true,
        is_template: true,
        default_branch: "main",
        size: 0,
      },
      [{ name: "main" }],
    )

    const result = await resolveTemplate(client, ORG, ref(ORG, "tmpl"))

    expect(result.template).toEqual({
      owner: ORG,
      repo: "tmpl",
      branch: "main",
    })
  })

  it("does not throw when the size-0 branches probe is inconclusive", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes("/branches")) {
        throw new GitHubAPIError({
          status: 500,
          url: path,
          message: "Server Error",
          body: {},
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
      return {
        name: "tmpl",
        full_name: `${ORG}/tmpl`,
        private: true,
        is_template: true,
        default_branch: "main",
        size: 0,
      }
    })
    const client = { request } as unknown as GitHubClient

    const result = await resolveTemplate(client, ORG, ref(ORG, "tmpl"))

    expect(result.template).toEqual({
      owner: ORG,
      repo: "tmpl",
      branch: "main",
    })
  })

  it("does not reject a fork with reported size 0 as commitless (regression #528)", async () => {
    // GitHub reports size 0 for a fork sharing objects with its parent even when
    // the fork has commits, so a fork must resolve normally rather than throw.
    const client = clientReturning({
      name: "cross-org-fork-template",
      full_name: `${ORG}/cross-org-fork-template`,
      private: false,
      is_template: true,
      fork: true,
      default_branch: "main",
      size: 0,
    })

    const result = await resolveTemplate(
      client,
      ORG,
      ref(ORG, "cross-org-fork-template"),
    )

    expect(result.template).toEqual({
      owner: ORG,
      repo: "cross-org-fork-template",
      branch: "main",
    })
  })

  it("resolves a template with commits (size > 0)", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: false,
      is_template: true,
      default_branch: "main",
      size: 12,
    })

    const result = await resolveTemplate(client, ORG, ref(ORG, "tmpl"))

    expect(result.template).toEqual({
      owner: ORG,
      repo: "tmpl",
      branch: "main",
    })
  })

  it("allows a cross-org private fork (generate copies the fork's own objects)", async () => {
    // Verified against GitHub: generate does NOT need parent access, so a
    // cross-org private fork must no longer be blocked at save. The only real
    // failure is the parent org's OAuth-App restriction, surfaced at accept.
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "other-org/secret-upstream", private: true },
      default_branch: "main",
    })

    const result = await resolveTemplate(client, ORG, ref(ORG, "tmpl"))

    expect(result.template).toEqual({
      owner: ORG,
      repo: "tmpl",
      branch: "main",
    })
    // In-org private template (the fork lives in ORG) still needs a team grant.
    expect(result.needsTeamGrant).toBe(true)
  })

  it("allows a private fork with an unknown (absent) parent", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      default_branch: "main",
    })

    const result = await resolveTemplate(client, ORG, ref(ORG, "tmpl"))

    expect(result.template?.repo).toBe("tmpl")
    expect(result.needsTeamGrant).toBe(true)
  })

  it("allows an in-org private fork (upstream reachable in the same org)", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: `${ORG}/upstream`, private: true },
      default_branch: "main",
    })

    const result = await resolveTemplate(client, ORG, ref(ORG, "tmpl"))

    expect(result.template).toEqual({
      owner: ORG,
      repo: "tmpl",
      branch: "main",
    })
    // In-org private template still needs the team read grant.
    expect(result.needsTeamGrant).toBe(true)
  })

  it("allows a private fork of a public upstream (generate works)", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "other-org/public-upstream", private: false },
      default_branch: "main",
    })

    const result = await resolveTemplate(client, ORG, ref(ORG, "tmpl"))

    expect(result.template?.repo).toBe("tmpl")
  })
})

// Mirrors gh-student's TestFounderPermission: individual gets least-privilege
// `push` (enough to push and trigger autograding, not to delete/transfer or
// manage collaborators); group gets `admin` for the founder-driven invite flow.
describe("founderPermission — accept-time repo role", () => {
  it("grants push for individual assignments", () => {
    expect(founderPermission("individual")).toBe("push")
  })

  it("grants admin for group assignments (founder manages collaborators)", () => {
    expect(founderPermission("group")).toBe("admin")
  })

  it("honors a configured student_permission for individual", () => {
    expect(founderPermission("individual", "admin")).toBe("admin")
    expect(founderPermission("individual", "pull")).toBe("pull")
    expect(founderPermission("individual", "maintain")).toBe("maintain")
  })

  it("clamps a group assignment up to admin even when configured lower", () => {
    // A group founder must hold admin to add teammates via `gh student invite`.
    expect(founderPermission("group", "push")).toBe("admin")
    expect(founderPermission("group", "pull")).toBe("admin")
    expect(founderPermission("group", "admin")).toBe("admin")
  })
})

// Mirrors gh-student's assertModeCoherentForCreate: a group-shaped entry
// (max_group_size >= 2) whose mode isn't `group` is rejected so the founder
// isn't silently under-privileged (push instead of admin).
describe("assertAssignmentModeCoherent", () => {
  it("accepts a coherent group entry", () => {
    expect(() => assertAssignmentModeCoherent("hw", "group", 3)).not.toThrow()
  })

  it("accepts an individual entry with no group size", () => {
    expect(() =>
      assertAssignmentModeCoherent("hw", "individual", undefined),
    ).not.toThrow()
    expect(() =>
      assertAssignmentModeCoherent("hw", "individual", 0),
    ).not.toThrow()
  })

  // Thrown OUTSIDE withAcceptStep, so the error alert is the only place a
  // student sees it — it must name its message or the page falls back to the
  // generic "something went wrong" with no reason and no remedy.
  it("rejects a group-shaped size with a non-group mode, naming the remedy", () => {
    expect(() => assertAssignmentModeCoherent("hw", "individual", 2)).toThrow()
    try {
      assertAssignmentModeCoherent("hw", "individual", 2)
    } catch (err) {
      expect(localizedMessageOf(err)).toEqual({
        key: "accept.errors.incoherentMode",
        params: { slug: "hw", maxGroupSize: 2, mode: "individual" },
      })
    }
  })
})

// permissionSatisfies decides whether the read-back after the grant is the role
// we set. isOwner picks the comparison: an org owner tolerates a benign higher
// residual (">=", their inherited/creator admin can't be self-downgraded),
// while a plain member must land EXACTLY on the target ("=="), so a
// silently-ignored downgrade (residual admin an intended lockdown must remove)
// fails loudly.
describe("permissionSatisfies — owner floor vs member exact match", () => {
  it("accepts a push grant that reads back as push (both roles)", () => {
    expect(permissionSatisfies("write", "write", "push", false)).toBe(true)
    expect(permissionSatisfies("write", "push", "push", false)).toBe(true)
  })

  it("accepts an admin grant that reads back as admin", () => {
    expect(permissionSatisfies("admin", "admin", "admin", false)).toBe(true)
    expect(permissionSatisfies("admin", "admin", "admin", true)).toBe(true)
  })

  it("owner: tolerates a still-higher read-back after a lower grant", () => {
    // An owner's effective role is the max of the direct grant, org base
    // permission, and unavoidable inherited/creator admin.
    expect(permissionSatisfies("admin", "admin", "push", true)).toBe(true)
    expect(permissionSatisfies("write", "maintain", "push", true)).toBe(true)
    expect(permissionSatisfies("write", "write", "pull", true)).toBe(true)
    expect(permissionSatisfies("admin", "admin", "pull", true)).toBe(true)
  })

  it("member: rejects a still-higher read-back (silently-ignored downgrade)", () => {
    // A below-default target on a student-created repo whose creator-admin
    // GitHub won't lower.
    expect(permissionSatisfies("admin", "admin", "push", false)).toBe(false)
    expect(permissionSatisfies("admin", "admin", "pull", false)).toBe(false)
    expect(permissionSatisfies("write", "maintain", "push", false)).toBe(false)
  })

  it("rejects a read-back BELOW the wanted role for both owner and member", () => {
    expect(permissionSatisfies("write", "push", "admin", true)).toBe(false)
    expect(permissionSatisfies("write", "push", "admin", false)).toBe(false)
    expect(permissionSatisfies("read", "read", "push", true)).toBe(false)
    expect(permissionSatisfies("write", "write", "maintain", false)).toBe(false)
  })

  it("falls back to the legacy field when role_name is absent", () => {
    // Legacy collapses maintain into write, so it can only prove push/write and
    // admin; the owner/member comparison choice is the same.
    expect(permissionSatisfies("write", undefined, "push", false)).toBe(true)
    expect(permissionSatisfies("admin", undefined, "admin", false)).toBe(true)
    expect(permissionSatisfies("write", undefined, "admin", true)).toBe(false)
    expect(permissionSatisfies("admin", undefined, "push", true)).toBe(true)
    expect(permissionSatisfies("admin", undefined, "push", false)).toBe(false)
  })

  it("rejects an unknown read-back role, failing closed", () => {
    expect(permissionSatisfies("", "", "push", true)).toBe(false)
    expect(permissionSatisfies(undefined, undefined, "push", false)).toBe(false)
  })
})

// Drives addFounderCollaborator end-to-end (PUT grant -> read-back -> throw),
// the web mirror of gh-student's TestInviteFounder / _VerificationFails.
// The web half of the student_permission enum lockstep guard: REPO_PERMISSIONS
// must equal the schema's student_permission enum (the declared source of
// truth). The Go half (contract.RepoPermissions vs the same enum) is pinned by
// TestStudentPermissionEnumParity, so a one-sided edit to any of the three
// mirrors fails CI here or there rather than silently drifting the accept-time
// floor verification.
describe("REPO_PERMISSIONS parity with assignments-v1 schema", () => {
  const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../schemas/assignments-v1.schema.json",
  )
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
    $defs: {
      assignment: {
        properties: { student_permission: { enum: string[] } }
      }
    }
  }

  it("matches the schema student_permission enum exactly and in order", () => {
    const schemaEnum =
      schema.$defs.assignment.properties.student_permission.enum
    expect(schemaEnum).toEqual([...REPO_PERMISSIONS])
  })
})

// The web half of the submission_mode enum lockstep guard: SUBMISSION_MODES
// must equal the schema's submission_mode enum (the declared source of truth).
// The Go half (contract.SubmissionModes vs the same enum) is pinned by
// TestSubmissionModeEnumParity; the runner's inline validator carries a
// by-value copy.
describe("SUBMISSION_MODES parity with assignments-v1 schema", () => {
  const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../schemas/assignments-v1.schema.json",
  )
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
    $defs: {
      assignment: {
        properties: { submission_mode: { enum: string[] } }
      }
    }
  }

  it("matches the schema submission_mode enum exactly and in order", () => {
    const schemaEnum = schema.$defs.assignment.properties.submission_mode.enum
    expect(schemaEnum).toEqual([...SUBMISSION_MODES])
  })
})

describe("addFounderCollaborator — self grant (PUT only, no read-back)", () => {
  const owner = "cs50"
  const repo = "cs50-fall-2026-hello-alice"
  const username = "alice"
  const collabPath = `/repos/${owner}/${repo}/collaborators/${username}`
  const permPath = `${collabPath}/permission`

  // Records the collaborator PUT and flags whether the permission sub-resource
  // was read back (it must NOT be — the self read-back races an unbounded
  // window; the grant guard lives on the teacher write paths instead).
  function makeClient() {
    const put = vi.fn()
    let readBack = false
    const request = vi.fn(async (path: string, opts?: { method?: string }) => {
      if (path === collabPath && opts?.method === "PUT") {
        put(opts)
        return undefined
      }
      if (path === permPath) {
        readBack = true
        return {}
      }
      throw new Error(`unexpected request: ${opts?.method ?? "GET"} ${path}`)
    })
    return {
      client: { request } as unknown as GitHubClient,
      request,
      put,
      readBack: () => readBack,
    }
  }

  it.each(["push", "admin", "pull"] as const)(
    "PUTs the requested role (%s) and trusts it — no read-back",
    async (permission) => {
      const { client, request, readBack } = makeClient()
      await expect(
        addFounderCollaborator({ client, owner, repo, username, permission }),
      ).resolves.toBeUndefined()
      expect(request).toHaveBeenCalledWith(collabPath, {
        method: "PUT",
        body: { permission },
      })
      expect(readBack()).toBe(false)
    },
  )

  it("propagates a genuine PUT failure (e.g. not an org member)", async () => {
    const err = new GitHubAPIError({
      status: 404,
      url: collabPath,
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
    const request = vi.fn(async () => {
      throw err
    })
    const client = { request } as unknown as GitHubClient
    await expect(
      addFounderCollaborator({
        client,
        owner,
        repo,
        username,
        permission: "push",
      }),
    ).rejects.toBe(err)
  })
})

// createAssignmentRepo returns the POST .../generate response verbatim. The
// generated repo's real branch is resolved later (in the commit retry), because
// the template copy is async — right after generate, default_branch is still a
// transient value and no ref exists yet.
describe("createAssignmentRepo", () => {
  it("returns the generated repo from the generate response", async () => {
    const paths: string[] = []
    const client: GitHubClient = {
      request: <T>(path: string, opts?: { method?: string }) => {
        paths.push(`${opts?.method ?? "GET"} ${path}`)
        if (path.endsWith("/generate")) {
          return Promise.resolve({
            name: "hw1-alice",
            default_branch: "main",
          } as T)
        }
        return Promise.reject(new Error(`unexpected: ${path}`))
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
      fetchArchive: () => Promise.reject(new Error("unexpected fetchArchive")),
    }

    const result = await createAssignmentRepo({
      client,
      templateOwner: "acme",
      templateRepo: "master-template",
      owner: "acme",
      name: "hw1-alice",
      fallbackBranch: "main",
    })

    expect(result.kind).toBe("generated")
    expect(result.repo.name).toBe("hw1-alice")
    // No extra confirming GET — the generate response is used directly.
    expect(paths).toEqual(["POST /repos/acme/master-template/generate"])
  })

  it("returns already-accepted on a 422 (repo exists)", async () => {
    const client: GitHubClient = {
      request: <T>(path: string) => {
        if (path.endsWith("/generate"))
          return Promise.reject(
            new GitHubAPIError({
              status: 422,
              url: path,
              message: "Unprocessable",
              body: null,
              rateLimit: {
                limit: null,
                remaining: null,
                used: null,
                reset: null,
                resource: null,
                retryAfter: null,
              },
            }),
          ) as Promise<T>
        return Promise.resolve({
          name: "hw1-alice",
          default_branch: "master",
        } as T)
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
      fetchArchive: () => Promise.reject(new Error("unexpected fetchArchive")),
    }

    const result = await createAssignmentRepo({
      client,
      templateOwner: "acme",
      templateRepo: "starter",
      owner: "acme",
      name: "hw1-alice",
      fallbackBranch: "main",
    })

    expect(result.kind).toBe("already-accepted")
    expect(result.repo.default_branch).toBe("master")
  })
})

// The default autograder shim is templated by the assignment repo's default
// branch (its push trigger) and the config repo's branch (its reusable-workflow
// ref), so autograde fires on a master-default repo and the @<branch> ref
// resolves even if the config-repo rename to main did not land.
describe("resolveAutograderWorkflow default shim branch templating", () => {
  it("templates the push-trigger branch and the runner ref (master)", async () => {
    const yaml = await resolveAutograderWorkflow({
      org: "cs50",
      classroom: "cs101",
      autograder: "default",
      branch: "master",
      configBranch: "master",
    })
    expect(yaml).toContain('branches: ["master"]')
    expect(yaml).toContain(
      'uses: "cs50/classroom50/.github/workflows/autograde-runner.yaml@master"',
    )
  })

  it("defaults to main when no branch is supplied", async () => {
    const yaml = await resolveAutograderWorkflow({
      org: "cs50",
      classroom: "cs101",
      autograder: "default",
    })
    expect(yaml).toContain('branches: ["main"]')
    expect(yaml).toContain("autograde-runner.yaml@main")
  })

  it("quotes a YAML-hostile branch name so it stays a string", async () => {
    // An unquoted `branches: [off]` would parse as boolean false; quoting keeps
    // it a branch name. Matches the CLI embed's quoted form.
    const yaml = await resolveAutograderWorkflow({
      org: "cs50",
      classroom: "cs101",
      autograder: "default",
      branch: "off",
      configBranch: "main",
    })
    expect(yaml).toContain('branches: ["off"]')
  })

  it("does not fetch from Pages for the default autograder", async () => {
    // Passing no client proves the default path never makes a network call
    // (a Pages fetch would dereference the undefined client and throw).
    await expect(
      resolveAutograderWorkflow({
        org: "cs50",
        classroom: "cs101",
        autograder: undefined,
        branch: "main",
        configBranch: "main",
      }),
    ).resolves.toContain('branches: ["main"]')
  })

  it("tag mode drops the branch trigger and keeps only submit/* tags", async () => {
    const yaml = await resolveAutograderWorkflow({
      org: "cs50",
      classroom: "cs101",
      autograder: "default",
      branch: "main",
      configBranch: "main",
      submissionMode: "tag",
    })
    expect(yaml).not.toContain("branches:")
    expect(yaml).toContain('tags: ["submit/*"]')
    expect(yaml).toContain(
      'uses: "cs50/classroom50/.github/workflows/autograde-runner.yaml@main"',
    )
    // Exactly one line removed: tag mode equals every-push minus the branch
    // trigger line. Mirrors the CLI's TestRenderEmbeddedShim_TagMode.
    const everyPush = defaultAutograderWorkflow("cs50", "main", "main")
    expect(yaml).toBe(everyPush.replace('    branches: ["main"]\n', ""))
  })

  it("every-push output is byte-identical for absent/explicit/junk modes", () => {
    // Introducing submission_mode must change nothing for existing
    // assignments: only the exact value "tag" alters the render.
    const base = defaultAutograderWorkflow("cs50", "main", "main")
    expect(defaultAutograderWorkflow("cs50", "main", "main", undefined)).toBe(
      base,
    )
    expect(
      defaultAutograderWorkflow("cs50", "main", "main", "every-push"),
    ).toBe(base)
    // Junk is unrepresentable in the SubmissionMode union, so cast to pin the
    // runtime contract: anything that isn't exactly "tag" renders every-push.
    expect(
      defaultAutograderWorkflow(
        "cs50",
        "main",
        "main",
        "junk" as SubmissionMode,
      ),
    ).toBe(base)
  })
})

describe("createAssignmentRepo (bare / empty_repo)", () => {
  // The empty_repo wire contract: a bare create POSTs auto_init:false (no
  // initial commit, no branches) and returns the dedicated kind:"bare" so no
  // caller trusts a default_branch or attempts a commit. Mirrors the CLI's
  // TestCreateEmptyPrivateAssignmentRepoInOrg_Bare.
  function makeClient() {
    let createBody: Record<string, unknown> | undefined
    const request = vi.fn(async (url: string, init?: unknown) => {
      const method = (init as { method?: string })?.method ?? "GET"
      if (method === "POST" && url === "/orgs/cs50/repos") {
        createBody = (init as { body?: Record<string, unknown> }).body
        return {
          name: "cs101-actions-lab-alice",
          full_name: "cs50/cs101-actions-lab-alice",
          html_url: "https://github.com/cs50/cs101-actions-lab-alice",
          ssh_url: "git@github.com:cs50/cs101-actions-lab-alice.git",
          default_branch: "main",
        }
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    })
    return {
      client: { request } as unknown as GitHubClient,
      getCreateBody: () => createBody,
    }
  }

  it("bare:true POSTs auto_init:false and returns kind:bare", async () => {
    const { client, getCreateBody } = makeClient()

    const result = await createAssignmentRepo({
      client,
      owner: "cs50",
      name: "cs101-actions-lab-alice",
      fallbackBranch: "main",
      bare: true,
    })

    expect(getCreateBody()).toMatchObject({ auto_init: false, private: true })
    expect(result.kind).toBe("bare")
  })

  it("without bare, POSTs auto_init:true (the shim-only path)", async () => {
    const { client, getCreateBody } = makeClient()

    // The non-bare template-less path commits control files after create; here
    // we only assert the create body's auto_init, so the follow-up commit
    // requests are irrelevant (the create response drives kind resolution).
    await createAssignmentRepo({
      client,
      owner: "cs50",
      name: "cs101-actions-lab-alice",
      fallbackBranch: "main",
    }).catch(() => {
      // The full non-bare flow makes further requests this minimal mock
      // doesn't stub; the create body assertion below is what matters.
    })

    expect(getCreateBody()).toMatchObject({ auto_init: true })
  })

  it("templated: passes include_all_branches to /generate (false and true)", async () => {
    for (const want of [false, true]) {
      let generateBody: Record<string, unknown> | undefined
      const request = vi.fn(async (url: string, init?: unknown) => {
        const method = (init as { method?: string })?.method ?? "GET"
        if (method === "POST" && url.endsWith("/generate")) {
          generateBody = (init as { body?: Record<string, unknown> }).body
          return {
            name: "cs101-actions-lab-alice",
            full_name: "cs50/cs101-actions-lab-alice",
            html_url: "https://github.com/cs50/cs101-actions-lab-alice",
            default_branch: "main",
          }
        }
        // Later provisioning requests are irrelevant to the generate-body check.
        throw new Error(`unexpected request: ${method} ${url}`)
      })
      await createAssignmentRepo({
        client: { request } as unknown as GitHubClient,
        templateOwner: "acme",
        templateRepo: "starter",
        owner: "cs50",
        name: "cs101-actions-lab-alice",
        fallbackBranch: "main",
        includeAllBranches: want,
      }).catch(() => {
        // Full templated flow makes further requests this minimal mock omits.
      })
      expect(generateBody).toMatchObject({ include_all_branches: want })
    }
  })
})

// Issue #413: GitHub refuses the create because the *destination* org doesn't let
// its members create repositories, but the old code classified every 403/404 by
// where the template lived — so the student got the in-org template message and
// its "ask your teacher to re-run assignment setup" remedy, which cannot fix it.
describe("createAssignmentRepo destination-org refusal (#413)", () => {
  const ORG_DENIED =
    "You need admin access to the organization before adding a repository to it."

  const forbidden = (
    path: string,
    message: string,
    over: Partial<{ remaining: number | null; status: number }> = {},
  ) =>
    new GitHubAPIError({
      status: over.status ?? 403,
      url: path,
      message,
      body: null,
      rateLimit: {
        limit: null,
        remaining: over.remaining ?? null,
        used: null,
        reset: null,
        resource: null,
        retryAfter: null,
      },
    })

  // Rejects the create call, resolves the confirming GET (the 422 path needs it).
  const clientRejecting = (createPath: string, err: unknown): GitHubClient =>
    ({
      request: <T>(path: string) => {
        if (path === createPath) return Promise.reject(err) as Promise<T>
        return Promise.resolve({
          name: "hw1-alice",
          default_branch: "main",
        } as T)
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
      fetchArchive: () => Promise.reject(new Error("unexpected fetchArchive")),
    }) as GitHubClient

  const generatePath = "/repos/tpl/starter/generate"
  const orgReposPath = "/orgs/cs50/repos"

  const acceptTemplated = (templateOwner: string, err: unknown) =>
    createAssignmentRepo({
      client: clientRejecting(`/repos/${templateOwner}/starter/generate`, err),
      templateOwner,
      templateRepo: "starter",
      owner: "cs50",
      name: "hw1-alice",
      fallbackBranch: "main",
    })

  const acceptTemplateless = (err: unknown, bare: boolean) =>
    createAssignmentRepo({
      client: clientRejecting(orgReposPath, err),
      owner: "cs50",
      name: "hw1-alice",
      fallbackBranch: "main",
      bare,
    })

  // The whole point of the fix: the destination classification wins regardless of
  // where the template lives, because the refusal is about the destination org.
  it.each([
    ["an in-org template", "cs50"],
    ["an out-of-org template", "tpl"],
  ])("names the destination org for %s", async (_label, templateOwner) => {
    await expect(
      acceptTemplated(
        templateOwner,
        forbidden(`/repos/${templateOwner}/starter/generate`, ORG_DENIED),
      ),
    ).rejects.toMatchObject({
      name: "TemplateAccessError",
      localized: {
        key: "accept.templateErrors.orgRepoCreationDenied",
        params: { org: "cs50", status: 403 },
      },
    })
  })

  it.each([
    ["auto_init", false],
    ["bare", true],
  ])(
    "classifies the refusal on the template-less %s path",
    async (_l, bare) => {
      await expect(
        acceptTemplateless(forbidden(orgReposPath, ORG_DENIED), bare),
      ).rejects.toMatchObject({
        name: "TemplateAccessError",
        localized: { key: "accept.templateErrors.orgRepoCreationDenied" },
      })
    },
  )

  it("still yields the in-org template message for a plain 403", async () => {
    await expect(
      acceptTemplated(
        "cs50",
        forbidden(generatePath, "Must have admin rights"),
      ),
    ).rejects.toMatchObject({
      localized: { key: "accept.templateErrors.inOrg" },
    })
  })

  // Issue #468: an in-org template that 403s on generate but is a fork of a repo
  // in ANOTHER org is the parent org's OAuth-App restriction, not a missing team
  // grant. Name the parent org and its approval, not the useless "re-run setup".
  it("names the parent org for an in-org 403 on a cross-org fork template", async () => {
    const genPath = "/repos/cs50/starter/generate"
    const client = {
      request: <T>(path: string, init?: { method?: string }) => {
        if (path === genPath && (init?.method ?? "GET") === "POST") {
          return Promise.reject(
            forbidden(genPath, "OAuth App access restrictions"),
          ) as Promise<T>
        }
        // The post-403 template probe: an in-org fork of a private cross-org
        // parent.
        return Promise.resolve({
          name: "starter",
          full_name: "cs50/starter",
          fork: true,
          parent: { full_name: "upstream-org/starter", private: true },
          default_branch: "main",
        } as T)
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
      fetchArchive: () => Promise.reject(new Error("unexpected fetchArchive")),
    } as unknown as GitHubClient

    await expect(
      createAssignmentRepo({
        client,
        templateOwner: "cs50",
        templateRepo: "starter",
        owner: "cs50",
        name: "hw1-alice",
        fallbackBranch: "main",
      }),
    ).rejects.toMatchObject({
      name: "TemplateAccessError",
      localized: {
        key: "accept.templateErrors.forkParentRestricted",
        params: { parentOwner: "upstream-org", owner: "cs50", repo: "starter" },
      },
    })
  })

  // Issue #468, the real revoked-parent case: the fork read is ALSO blocked by
  // the parent org's OAuth restriction, so the repo probe can't see the parent.
  // GitHub's 403 body still names the restricting org in backticks, so the
  // parent org is recovered from the message and named without a readable repo.
  it("names the parent org from the 403 body when the fork read is also blocked", async () => {
    const genPath = "/repos/cs50/starter/generate"
    const restrictionMsg =
      "Although you appear to have the correct authorization credentials, the `upstream-org` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited."
    const client = {
      request: <T>(path: string, init?: { method?: string }) => {
        if (path === genPath && (init?.method ?? "GET") === "POST") {
          return Promise.reject(
            forbidden(genPath, restrictionMsg),
          ) as Promise<T>
        }
        // The follow-up fork read is blocked by the SAME upstream restriction.
        return Promise.reject(
          forbidden(`/repos/cs50/starter`, restrictionMsg),
        ) as Promise<T>
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
      fetchArchive: () => Promise.reject(new Error("unexpected fetchArchive")),
    } as unknown as GitHubClient

    await expect(
      createAssignmentRepo({
        client,
        templateOwner: "cs50",
        templateRepo: "starter",
        owner: "cs50",
        name: "hw1-alice",
        fallbackBranch: "main",
      }),
    ).rejects.toMatchObject({
      name: "TemplateAccessError",
      localized: {
        key: "accept.templateErrors.forkParentRestricted",
        params: { parentOwner: "upstream-org", owner: "cs50", repo: "starter" },
      },
    })
  })

  // A same-org fork (parent lives in the classroom org) is not the #468 case, so
  // it stays the plain in-org message rather than naming a bogus parent org.
  it("keeps the in-org message for a same-org fork template", async () => {
    const genPath = "/repos/cs50/starter/generate"
    const client = {
      request: <T>(path: string, init?: { method?: string }) => {
        if (path === genPath && (init?.method ?? "GET") === "POST") {
          return Promise.reject(
            forbidden(genPath, "Must have admin rights"),
          ) as Promise<T>
        }
        return Promise.resolve({
          name: "starter",
          full_name: "cs50/starter",
          fork: true,
          parent: { full_name: "cs50/upstream", private: true },
          default_branch: "main",
        } as T)
      },
      requestRaw: () => Promise.reject(new Error("unexpected requestRaw")),
      fetchArchive: () => Promise.reject(new Error("unexpected fetchArchive")),
    } as unknown as GitHubClient

    await expect(
      createAssignmentRepo({
        client,
        templateOwner: "cs50",
        templateRepo: "starter",
        owner: "cs50",
        name: "hw1-alice",
        fallbackBranch: "main",
      }),
    ).rejects.toMatchObject({
      localized: { key: "accept.templateErrors.inOrg" },
    })
  })

  it("still yields the out-of-org template message for a 404", async () => {
    await expect(
      acceptTemplated(
        "tpl",
        forbidden(generatePath, "Not Found", { status: 404 }),
      ),
    ).rejects.toMatchObject({
      localized: { key: "accept.templateErrors.outOfOrg" },
    })
  })

  // A throttled 403 must keep surfacing as a rate limit ("wait a minute"), not as
  // "your org blocks repo creation" — the exact mislabeling this change removes.
  it("rethrows a rate-limited 403 raw on both paths", async () => {
    await expect(
      acceptTemplated(
        "cs50",
        forbidden(generatePath, ORG_DENIED, { remaining: 0 }),
      ),
    ).rejects.toMatchObject({ name: "GitHubAPIError", status: 403 })

    await expect(
      acceptTemplateless(
        forbidden(orgReposPath, ORG_DENIED, { remaining: 0 }),
        false,
      ),
    ).rejects.toMatchObject({ name: "GitHubAPIError", status: 403 })
  })

  it("still returns already-accepted on a 422 for both paths", async () => {
    const templated = await createAssignmentRepo({
      client: clientRejecting(
        generatePath,
        new GitHubAPIError({
          status: 422,
          url: generatePath,
          message: "Unprocessable",
          body: null,
          rateLimit: {
            limit: null,
            remaining: null,
            used: null,
            reset: null,
            resource: null,
            retryAfter: null,
          },
        }),
      ),
      templateOwner: "tpl",
      templateRepo: "starter",
      owner: "cs50",
      name: "hw1-alice",
      fallbackBranch: "main",
    })
    expect(templated.kind).toBe("already-accepted")

    const templateless = await createAssignmentRepo({
      client: clientRejecting(
        orgReposPath,
        new GitHubAPIError({
          status: 422,
          url: orgReposPath,
          message: "Unprocessable",
          body: null,
          rateLimit: {
            limit: null,
            remaining: null,
            used: null,
            reset: null,
            resource: null,
            retryAfter: null,
          },
        }),
      ),
      owner: "cs50",
      name: "hw1-alice",
      fallbackBranch: "main",
      bare: true,
    })
    expect(templateless.kind).toBe("already-accepted")
  })
})

// The Pages-backed accept steps (assignment, autograder) read GitHub Pages via
// plain fetch, so every failure there is a non-GitHubAPIError. Their advice is
// actionable and NOT retryable — an unpublished or malformed autograder never
// resolves by trying again — so withAcceptStep must relay the error's own
// descriptor rather than collapsing it to the step-level "safe to retry" line.
describe("withAcceptStep on a non-GitHubAPIError", () => {
  const label = { key: "accept.steps.autograder" }
  const actions = { key: "accept.stepActions.autograder" }

  it("relays a descriptor the thrown error already names", async () => {
    const updates: unknown[] = []
    const named = {
      key: "pagesErrors.autograderMalformed",
      params: { autograderName: "checks" },
    }

    await expect(
      withAcceptStep(
        {
          id: "autograder",
          label,
          actions,
          onStepUpdate: (u) => updates.push(u),
        },
        () => Promise.reject(localizedError(named)),
      ),
    ).rejects.toMatchObject({ localized: named })

    expect(updates.at(-1)).toMatchObject({
      id: "autograder",
      status: "error",
      error: named,
    })
  })

  it("falls back to the step-level message for an unnamed throw", async () => {
    const updates: unknown[] = []

    await expect(
      withAcceptStep(
        {
          id: "autograder",
          label,
          actions,
          onStepUpdate: (u) => updates.push(u),
        },
        () => Promise.reject(new TypeError("Failed to fetch")),
      ),
    ).rejects.toBeInstanceOf(TypeError)

    expect(updates.at(-1)).toMatchObject({
      status: "error",
      error: { key: "accept.stepErrors.unexpected", params: { label } },
    })
  })
})

// The Pages readers are the source of those descriptors, so assert them here
// rather than only through the step wrapper.
describe("resolveAutograderWorkflow Pages failures", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const stubFetch = (init: { status: number; body?: string }) => {
    globalThis.fetch = (() =>
      Promise.resolve({
        status: init.status,
        ok: init.status >= 200 && init.status < 300,
        text: () => Promise.resolve(init.body ?? ""),
      })) as unknown as typeof fetch
  }

  const resolve = () =>
    resolveAutograderWorkflow({
      org: "cs50",
      classroom: "cs101",
      autograder: "checks",
      branch: "main",
      configBranch: "main",
    })

  it("names the not-published remedy on a 404", async () => {
    stubFetch({ status: 404 })
    await expect(resolve()).rejects.toMatchObject({
      localized: { key: "pagesErrors.notPublished" },
    })
  })

  it("names the malformed-YAML remedy when the workflow has no jobs", async () => {
    stubFetch({ status: 200, body: "name: not a workflow\n" })
    await expect(resolve()).rejects.toMatchObject({
      localized: {
        key: "pagesErrors.autograderMalformed",
        params: { autograderName: "checks" },
      },
    })
  })

  it("names the deploy-in-flight remedy for an empty body", async () => {
    stubFetch({ status: 200, body: "   " })
    await expect(resolve()).rejects.toMatchObject({
      localized: { key: "pagesErrors.deployInFlight" },
    })
  })
})

// These throw inside a step, so before they named their message the unexpected
// branch relabeled them "safe to retry" — actively wrong, since neither a
// version mismatch nor a malformed manifest resolves by retrying.
describe("extractAssignments manifest guards", () => {
  it("names the unsupported-version remedy", () => {
    try {
      extractAssignments({ version: 2, assignments: [] } as never)
      expect.unreachable("expected a throw")
    } catch (err) {
      expect(localizedMessageOf(err)).toEqual({
        key: "pagesErrors.manifestVersionUnsupported",
        params: { version: "2" },
      })
    }
  })

  it("names the invalid-shape remedy", () => {
    try {
      extractAssignments({ version: 1, assignments: "nope" } as never)
      expect.unreachable("expected a throw")
    } catch (err) {
      expect(localizedMessageOf(err)).toEqual({
        key: "pagesErrors.manifestInvalidShape",
      })
    }
  })

  it("passes a bare v1 array and a valid v1 object through", () => {
    const entry = { slug: "hw1" } as never
    expect(extractAssignments([entry] as never)).toEqual([entry])
    expect(
      extractAssignments({ version: 1, assignments: [entry] } as never),
    ).toEqual([entry])
  })
})

describe("setAssignmentLock", () => {
  const ORG = "cs50"
  const CLASSROOM = "cs50"
  const SLUG = "hw1"
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")

  afterEach(() => vi.restoreAllMocks())

  // A fake config repo serving the lock read-modify-commit flow plus the
  // student-team template DELETE (lock) / GET+PUT (unlock). Records every
  // team-repo mutation and the committed blob so a test can assert both the
  // flag flip and the (student-only) access change.
  function makeLockClient(opts: {
    locked?: boolean
    template?: { owner: string; repo: string; branch: string } | null
    templatePrivate?: boolean
    team?: { id: number; slug: string } | null
    onDeleteThrows?: boolean
  }): {
    client: GitHubClient
    revokes: () => string[]
    grants: () => string[]
    committed: () => string | undefined
  } {
    const revokes: string[] = []
    const grants: string[] = []
    let committed: string | undefined
    const templatePrivate = opts.templatePrivate ?? true
    const template =
      opts.template === undefined
        ? { owner: ORG, repo: "tmpl", branch: "main" }
        : opts.template
    const team =
      opts.team === undefined ? { id: 7, slug: "classroom50-cs50" } : opts.team

    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [
        {
          slug: SLUG,
          name: "Homework 1",
          mode: "individual",
          autograder: "default",
          ...(opts.locked ? { locked: true } : {}),
          ...(template ? { template } : {}),
        },
      ],
    }
    const classroomJson: Record<string, unknown> = {
      schema: "classroom50/classroom/v1",
      short_name: CLASSROOM,
      ...(team ? { team } : {}),
    }

    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET"
      const teamRepo = url.match(/\/orgs\/[^/]+\/teams\/([^/]+)\/repos\//)
      if (teamRepo && method === "DELETE") {
        if (opts.onDeleteThrows) {
          throw new GitHubAPIError({
            status: 500,
            url,
            message: "boom",
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
        revokes.push(teamRepo[1])
        return {}
      }
      if (teamRepo && method === "GET") {
        // No existing grant, so unlock's grant path PUTs.
        throw new GitHubAPIError({
          status: 404,
          url,
          message: "not found",
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
      if (teamRepo && method === "PUT") {
        grants.push(teamRepo[1])
        return {}
      }
      if (/\/repos\/[^/]+\/classroom50$/.test(url))
        return { default_branch: "main" }
      if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
      if (url.includes("/git/commits/s")) return { tree: { sha: "t" } }
      if (url.includes(`/contents/${CLASSROOM}/classroom.json`)) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(JSON.stringify(classroomJson)),
        }
      }
      if (url.includes(`/contents/${CLASSROOM}/assignments.json`)) {
        return {
          type: "file",
          encoding: "base64",
          content: b64(JSON.stringify(assignmentsFile)),
        }
      }
      if (/\/repos\/[^/]+\/tmpl(\?|$)/.test(url)) {
        return {
          name: "tmpl",
          private: templatePrivate,
          default_branch: "main",
        }
      }
      if (url.endsWith("/git/trees")) return { sha: "newtree" }
      if (url.endsWith("/git/commits")) return { sha: "newcommit" }
      if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
        return { object: { sha: "newcommit" } }
      }
      if (method === "POST" && url.endsWith("/git/blobs"))
        return { sha: "blob" }
      throw new Error(`unexpected request: ${method} ${url}`)
    })

    // Capture the committed tree content (the blob is inlined in the tree).
    const requestWithCapture = vi.fn(
      async (url: string, init?: { method?: string; body?: unknown }) => {
        if (url.endsWith("/git/trees") && init?.body) {
          const body = init.body as { tree?: { content?: string }[] }
          committed = body.tree?.[0]?.content
        }
        return request(url, init)
      },
    )

    // getClassroomJson + the archive guard both read classroom.json via
    // requestRaw (raw JSON string), independent of the typed `request` path.
    const requestRaw = vi.fn(async () => JSON.stringify(classroomJson))

    return {
      client: {
        request: requestWithCapture,
        requestRaw,
      } as unknown as GitHubClient,
      revokes: () => revokes,
      grants: () => grants,
      committed: () => committed,
    }
  }

  it("locks a private in-org template: flips the flag and revokes ONLY the student team", async () => {
    const { client, revokes, committed } = makeLockClient({ locked: false })
    const result = await setAssignmentLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      locked: true,
    })
    expect(result.locked).toBe(true)
    expect(result.templateAccessWarning).toBeUndefined()
    expect(committed()).toContain(`"locked": true`)
    // Only the student team (classroom50-cs50) — never a staff team.
    expect(revokes()).toEqual(["classroom50-cs50"])
  })

  it("unlocks: clears the flag and re-grants the student team read", async () => {
    const { client, grants, committed } = makeLockClient({ locked: true })
    const result = await setAssignmentLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      locked: false,
    })
    expect(result.locked).toBe(false)
    // Unlock collapses to absent-is-false: no `"locked"` key in the wire.
    expect(committed()).not.toContain(`"locked"`)
    expect(grants()).toContain("classroom50-cs50")
  })

  it("makes a public template a UX-gate-only lock (no access change)", async () => {
    const { client, revokes } = makeLockClient({
      locked: false,
      templatePrivate: false,
    })
    await setAssignmentLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      locked: true,
    })
    expect(revokes()).toEqual([])
  })

  it("refuses to touch a team outside the classroom50- namespace (fail closed)", async () => {
    const { client, revokes } = makeLockClient({
      locked: false,
      team: { id: 7, slug: "some-foreign-team" },
    })
    const result = await setAssignmentLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      locked: true,
    })
    // Flag still flips, but no destructive DELETE fires, and a warning explains.
    expect(result.locked).toBe(true)
    expect(revokes()).toEqual([])
    expect(result.templateAccessWarning).toContain("classroom50- namespace")
  })

  it("downgrades a template-revoke failure to a non-fatal warning (commit already landed)", async () => {
    const { client } = makeLockClient({ locked: false, onDeleteThrows: true })
    const result = await setAssignmentLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      locked: true,
    })
    // The lock itself succeeds; the access failure is surfaced as a warning.
    expect(result.locked).toBe(true)
    expect(result.templateAccessWarning).toBeDefined()
    expect(result.templateAccessWarning).toContain("tmpl")
  })
})

describe("setAssignmentClosed", () => {
  const ORG = "cs50"
  const CLASSROOM = "cs50"
  const SLUG = "hw1"
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")

  afterEach(() => vi.restoreAllMocks())

  // A fake config repo serving the closed read-modify-commit flow. Unlike the
  // lock client it must see NO team-repo mutation: closing has no template
  // access side effect. Any team-repo request throws to prove that.
  function makeClosedClient(opts: { closed?: boolean }): {
    client: GitHubClient
    committed: () => string | undefined
    teamCalls: () => number
  } {
    let committed: string | undefined
    let teamCalls = 0

    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [
        {
          slug: SLUG,
          name: "Homework 1",
          mode: "individual",
          autograder: "default",
          template: { owner: ORG, repo: "tmpl", branch: "main" },
          ...(opts.closed ? { closed: true } : {}),
        },
      ],
    }
    const classroomJson: Record<string, unknown> = {
      schema: "classroom50/classroom/v1",
      short_name: CLASSROOM,
    }

    const request = vi.fn(
      async (url: string, init?: { method?: string; body?: unknown }) => {
        const method = init?.method ?? "GET"
        if (/\/orgs\/[^/]+\/teams\//.test(url)) {
          teamCalls += 1
          throw new Error(`closed must not touch team access: ${method} ${url}`)
        }
        if (url.endsWith("/git/trees") && init?.body) {
          const body = init.body as { tree?: { content?: string }[] }
          committed = body.tree?.[0]?.content
        }
        if (/\/repos\/[^/]+\/classroom50$/.test(url))
          return { default_branch: "main" }
        if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
        if (url.includes("/git/commits/s")) return { tree: { sha: "t" } }
        if (url.includes(`/contents/${CLASSROOM}/classroom.json`)) {
          return {
            type: "file",
            encoding: "base64",
            content: b64(JSON.stringify(classroomJson)),
          }
        }
        if (url.includes(`/contents/${CLASSROOM}/assignments.json`)) {
          return {
            type: "file",
            encoding: "base64",
            content: b64(JSON.stringify(assignmentsFile)),
          }
        }
        if (url.endsWith("/git/trees")) return { sha: "newtree" }
        if (url.endsWith("/git/commits")) return { sha: "newcommit" }
        if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
          return { object: { sha: "newcommit" } }
        }
        throw new Error(`unexpected request: ${method} ${url}`)
      },
    )
    const requestRaw = vi.fn(async () => JSON.stringify(classroomJson))

    return {
      client: {
        request,
        requestRaw,
      } as unknown as GitHubClient,
      committed: () => committed,
      teamCalls: () => teamCalls,
    }
  }

  it("closes: flips the flag and touches no template team access", async () => {
    const { client, committed, teamCalls } = makeClosedClient({ closed: false })
    const result = await setAssignmentClosed(client, {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      closed: true,
    })
    expect(result.closed).toBe(true)
    expect(committed()).toContain(`"closed": true`)
    expect(teamCalls()).toBe(0)
  })

  it("reopens: clears the flag (absent-is-false wire shape)", async () => {
    const { client, committed } = makeClosedClient({ closed: true })
    const result = await setAssignmentClosed(client, {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      closed: false,
    })
    expect(result.closed).toBe(false)
    expect(committed()).not.toContain(`"closed"`)
  })

  it("no-ops when already in the requested state (no commit)", async () => {
    const { client, committed } = makeClosedClient({ closed: true })
    const result = await setAssignmentClosed(client, {
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      closed: true,
    })
    expect(result.closed).toBe(true)
    // Already closed: the commit is skipped, so no tree content was captured.
    expect(committed()).toBeUndefined()
    expect(result.updatedRef).toBeUndefined()
  })
})

describe("migrateClassroomAssignments", () => {
  const ORG = "cs50"
  const CLASSROOM = "cs50"
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")

  afterEach(() => vi.restoreAllMocks())

  // A fake config repo serving the classroom-wide migration read-modify-commit
  // flow. `assignments` is the raw entry array the served assignments.json
  // carries.
  function makeMigrateClient(assignments: Record<string, unknown>[]): {
    client: GitHubClient
    committed: () => string | undefined
  } {
    let committed: string | undefined
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments,
    }
    const classroomJson = {
      schema: "classroom50/classroom/v1",
      short_name: CLASSROOM,
    }

    const request = vi.fn(
      async (url: string, init?: { method?: string; body?: unknown }) => {
        const method = init?.method ?? "GET"
        if (url.endsWith("/git/trees") && init?.body) {
          const body = init.body as { tree?: { content?: string }[] }
          committed = body.tree?.[0]?.content
        }
        if (/\/repos\/[^/]+\/classroom50$/.test(url))
          return { default_branch: "main" }
        if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
        if (url.includes("/git/commits/s")) return { tree: { sha: "t" } }
        if (url.includes(`/contents/${CLASSROOM}/classroom.json`)) {
          return {
            type: "file",
            encoding: "base64",
            content: b64(JSON.stringify(classroomJson)),
          }
        }
        if (url.includes(`/contents/${CLASSROOM}/assignments.json`)) {
          return {
            type: "file",
            encoding: "base64",
            content: b64(JSON.stringify(assignmentsFile)),
          }
        }
        if (url.endsWith("/git/trees")) return { sha: "newtree" }
        if (url.endsWith("/git/commits")) return { sha: "newcommit" }
        if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
          return { object: { sha: "newcommit" } }
        }
        throw new Error(`unexpected request: ${method} ${url}`)
      },
    )
    const requestRaw = vi.fn(async () => JSON.stringify(classroomJson))

    return {
      client: {
        request,
        requestRaw,
      } as unknown as GitHubClient,
      committed: () => committed,
    }
  }

  const legacyEntry = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug,
    name: slug,
    mode: "individual",
    autograder: "default",
    template: { owner: ORG, repo: "tmpl", branch: "main" },
    ...extra,
  })

  it("writes explicit submission_mode + grading:auto onto every legacy entry in one commit", async () => {
    const { client, committed } = makeMigrateClient([
      legacyEntry("hw1"),
      legacyEntry("hw2"),
      legacyEntry("hw3"),
    ])
    const result = await migrateClassroomAssignments(client, {
      org: ORG,
      classroom: CLASSROOM,
    })
    expect(result.migratedCount).toBe(3)
    expect(result.alreadyMigratedCount).toBe(0)
    const written = committed()!
    // Every entry now carries an explicit tag mode (preserving pre-1.28
    // submit/*-release counting) and auto grading.
    expect(written.match(/"submission_mode": "tag"/g)).toHaveLength(3)
    expect(written.match(/"mode": "auto"/g)).toHaveLength(3)
  })

  it("no-ops when every entry is already migrated (no commit)", async () => {
    const { client, committed } = makeMigrateClient([
      legacyEntry("hw1", { submission_mode: "every-push" }),
      legacyEntry("hw2", { submission_mode: "tag" }),
    ])
    const result = await migrateClassroomAssignments(client, {
      org: ORG,
      classroom: CLASSROOM,
    })
    expect(result.migratedCount).toBe(0)
    expect(result.alreadyMigratedCount).toBe(2)
    expect(committed()).toBeUndefined()
    expect(result.updatedRef).toBeUndefined()
  })

  it("migrates only the legacy entries, leaving already-migrated ones untouched", async () => {
    const { client, committed } = makeMigrateClient([
      legacyEntry("hw1", { submission_mode: "every-push" }),
      legacyEntry("hw2"),
    ])
    const result = await migrateClassroomAssignments(client, {
      org: ORG,
      classroom: CLASSROOM,
    })
    expect(result.migratedCount).toBe(1)
    expect(result.alreadyMigratedCount).toBe(1)
    const written = committed()!
    // The pre-migrated every-push entry keeps its mode; the legacy one gains
    // tag mode (the pre-1.28-preserving default), so both survive distinctly.
    expect(written).toContain(`"submission_mode": "every-push"`)
    expect(written.match(/"submission_mode": "tag"/g)).toHaveLength(1)
  })

  it("preserves an entry's grading and unknown fields verbatim", async () => {
    const { client, committed } = makeMigrateClient([
      legacyEntry("hw1", {
        grading: { mode: "manual", max_points: 10 },
        future_field: "v2-only",
      }),
    ])
    const result = await migrateClassroomAssignments(client, {
      org: ORG,
      classroom: CLASSROOM,
    })
    expect(result.migratedCount).toBe(1)
    const written = committed()!
    // Existing grading is not overwritten with auto; unknown keys round-trip.
    expect(written).toContain(`"mode": "manual"`)
    expect(written).toContain(`"max_points": 10`)
    expect(written).toContain(`"future_field": "v2-only"`)
    expect(written).not.toContain(`"mode": "auto"`)
  })

  it("does not bump the schema sentinel", async () => {
    const { client, committed } = makeMigrateClient([legacyEntry("hw1")])
    await migrateClassroomAssignments(client, {
      org: ORG,
      classroom: CLASSROOM,
    })
    expect(committed()).toContain(`"schema": "classroom50/assignments/v1"`)
  })
})

describe("defaultAutograderWorkflow — milestone submission_tags", () => {
  it("widens the tags trigger to the union with submit/*", () => {
    const yaml = defaultAutograderWorkflow("cs50", "main", "main", undefined, [
      "phase1",
      "v*",
    ])
    expect(yaml).toContain('tags: ["phase1", "v*", "submit/*"]')
    expect(yaml).toContain('branches: ["main"]')
  })

  it("tag mode + patterns drops branches and widens tags", () => {
    const yaml = defaultAutograderWorkflow("cs50", "main", "main", "tag", [
      "phase1",
    ])
    expect(yaml).not.toContain("branches:")
    expect(yaml).toContain('tags: ["phase1", "submit/*"]')
  })

  it("no patterns renders byte-identical output (empty and undefined)", () => {
    const base = defaultAutograderWorkflow("cs50", "main", "main")
    expect(
      defaultAutograderWorkflow("cs50", "main", "main", undefined, []),
    ).toBe(base)
    expect(
      defaultAutograderWorkflow("cs50", "main", "main", undefined, undefined),
    ).toBe(base)
  })
})

// CLI-vs-web shim trigger parity: both accept clients must render the SAME
// on: block for the same inputs — the retrofit rewriters (Go shimTriggerBlock
// and the TS SHIM_TRIGGER_BLOCK) do line surgery on this exact shape, so a
// drift on either side would make one client's shims "unrecognized" to the
// retrofit. The CLI side is pinned against the embed by
// TestShimTagsTriggerLine_MatchesEmbed / TestShimBranchTriggerLine_MatchesEmbed;
// this pins the web render against the embed file itself.
describe("web shim trigger block parity with the CLI embed", () => {
  const embedUrl = new URL(
    "../../../cli/gh-student/embed/autograde-shim.yaml",
    import.meta.url,
  )
  const embed = readFileSync(fileURLToPath(embedUrl), "utf-8")

  function triggerBlock(yaml: string): string {
    const match =
      /^on:\n {2}push:\n(?: {4}branches: \[[^\n]*\]\n)?(?: {4}tags: \[[^\n]*\]\n)/m.exec(
        yaml,
      )
    if (!match) throw new Error(`no trigger block in:\n${yaml}`)
    return match[0]
  }

  it("default render matches the embed's trigger block (branch substituted)", () => {
    const embedBlock = triggerBlock(embed).replace("{{BRANCH}}", "main")
    expect(triggerBlock(defaultAutograderWorkflow("o", "main", "main"))).toBe(
      embedBlock,
    )
  })

  it("tags render matches the embed's block with only the tags line widened", () => {
    const embedBlock = triggerBlock(embed)
      .replace("{{BRANCH}}", "main")
      .replace('tags: ["submit/*"]', 'tags: ["phase1", "submit/*"]')
    expect(
      triggerBlock(
        defaultAutograderWorkflow("o", "main", "main", undefined, ["phase1"]),
      ),
    ).toBe(embedBlock)
  })
})
