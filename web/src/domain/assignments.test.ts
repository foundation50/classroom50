import { describe, expect, it, vi } from "vitest"

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
  verifyTemplateAccess,
} from "./assignments"
import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"

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
  runtime: { "runs-on": "ubuntu-latest", container: { image: "python:3.12" } },
  allowed_files: ["src/*.py", "!src/secret.py"],
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
    expect(entry.tests).not.toBe(fullSource.tests)
    expect(entry.tests?.[0]).not.toBe(fullSource.tests?.[0])

    // Mutating the copy must not leak back into the source.
    entry.allowed_files?.push("extra")
    entry.tests?.push({ type: "run", name: "x", run: "x", points: 0 })
    expect(fullSource.allowed_files).toHaveLength(2)
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
        python: "3.12",
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
      python: "3.12",
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
  function makeClient(): {
    client: GitHubClient
    committedContent: () => string
  } {
    const assignmentsFile = {
      schema: "classroom50/assignments/v1",
      assignments: [existingEntry],
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

    // The edit form round-trips the language fields (python bumped to 3.12,
    // node/apt kept). `rust` is not a schema sub-key, so it must be dropped.
    await editAssignment(
      client,
      editInput({
        runtime_python: "3.12",
        runtime_node: "20",
        runtime_apt: "cmake",
      }),
    )

    const written = JSON.parse(capturedContent) as {
      assignments: Assignment[]
    }
    const edited = written.assignments.find((a) => a.slug === SLUG)!
    expect(edited.runtime).toEqual({
      python: "3.12",
      node: "20",
      apt: ["cmake"],
    })
    // The foreign runtime sub-key self-heals away (closed contract object).
    expect("rust" in (edited.runtime ?? {})).toBe(false)
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
      editAssignment(client, editInput({ runtime_python: "3.12 bad" })),
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

  it("rejects flipping empty_repo on after creation (immutable)", async () => {
    // existingEntry has no empty_repo (false); the edit tries to enable it.
    const { client } = makeClient()
    await expect(
      editAssignment(client, editInput({ empty_repo: true })),
    ).rejects.toThrow(/empty_repo cannot be changed after creation/)
  })

  it("rejects flipping empty_repo off after creation (immutable)", async () => {
    const bareEntry: Assignment = {
      slug: SLUG,
      name: "Homework 1",
      mode: "individual",
      autograder: "default",
      feedback_pr: false,
      empty_repo: true,
    }
    const { client } = makeBareClient(bareEntry)
    // Form sends empty_repo: false (or omits it) — either way it's a flip.
    await expect(
      editAssignment(client, editInput({ empty_repo: false })),
    ).rejects.toThrow(/empty_repo cannot be changed after creation/)
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
      [{ setup_command: "make" }, /never autogrades/],
      [{ feedback_pr: true }, /no baseline commit/],
      [{ allowed_files: "*.py" }, /restrict allowed files/],
      [{ pass_threshold: 70 }, /passing threshold/],
    ]
    for (const [overrides, want] of cases) {
      const { client } = makeBareClient(bareEntry)
      await expect(
        editAssignment(client, editInput({ empty_repo: true, ...overrides })),
      ).rejects.toThrow(want)
    }
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

  it("re-validates an unchanged stored ref and blocks a now-cross-org private fork", async () => {
    // An assignment whose stored template is an in-org private fork of a private
    // cross-org upstream (created before the fork guard shipped, or a parent
    // that went private after create). Editing WITHOUT changing the ref must
    // still trip the fork guard rather than trusting the stored block.
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

    const request = vi.fn(async (url: string) => {
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

    await expect(
      // Same ref as stored (bare repo -> owner defaults to org, branch omitted
      // -> unchanged), so the unchanged-ref short-circuit is exercised.
      editAssignment(
        client,
        editInput({ slug: SLUG, template_repo: "hw1-fork" }),
      ),
    ).rejects.toThrow(/other-org\/secret-upstream in another org/)
  })
})

describe("grantTeamTemplateRead (TA staff team eager grant)", () => {
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
      tests: [],
    } as unknown as Parameters<typeof editAssignment>[1]
  }

  it("grants both the student team and the TA staff team on a private in-org template", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: { ta: { id: 9, slug: "classroom50-cs50-ta" } },
      },
    })

    const result = await editAssignment(client, editInput())

    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual(["classroom50-cs50", "classroom50-cs50-ta"])
  })

  it("grants only the student team when no TA team is recorded", async () => {
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

  it("keeps the edit successful when the TA grant fails (non-blocking)", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: { ta: { id: 9, slug: "classroom50-cs50-ta" } },
      },
      taGrantThrows: true,
    })

    const result = await editAssignment(client, editInput())

    // Student grant landed; TA failure did not surface as a save warning.
    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual(["classroom50-cs50"])
  })

  it("re-affirms the grant on an UNCHANGED in-org private template ref", async () => {
    const { client, grants } = makeGrantClient({
      classroomJson: {
        schema: "classroom50/classroom/v1",
        short_name: CLASSROOM,
        team: { id: 7, slug: "classroom50-cs50" },
        teams: { ta: { id: 9, slug: "classroom50-cs50-ta" } },
      },
    })

    // Same owner/repo/branch as the stored template (tmpl) — the unchanged-ref
    // branch. It must still re-affirm both teams so a dropped grant is repaired.
    const result = await editAssignment(client, editInput("tmpl"))

    expect(result.templateGrantWarning).toBeUndefined()
    expect(grants()).toEqual(["classroom50-cs50", "classroom50-cs50-ta"])
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
})

describe("copyAssignmentToClassroom (reuse fork guard)", () => {
  const ORG = "acme"
  const emptyRateLimit = {
    limit: null,
    remaining: null,
    used: null,
    reset: null,
    resource: null,
    retryAfter: null,
  }

  // Answers the three pre-commit reads copyAssignmentToClassroom runs in
  // parallel (archive guard via requestRaw 404, getRepo, getBranchRef). The fork
  // guard throws before any commit, so no write routes are needed.
  function makeClient(repo: unknown): GitHubClient {
    const request = vi.fn(async (url: string) => {
      if (/\/repos\/[^/]+\/classroom50$/.test(url))
        return { default_branch: "main" }
      if (url.includes("/git/ref/heads/main")) return { object: { sha: "s" } }
      if (url.includes("/repos/")) return repo
      throw new Error(`unexpected request: ${url}`)
    })
    const requestRaw = vi.fn(async () => {
      throw new GitHubAPIError({
        status: 404,
        url: "classroom.json",
        message: "Not Found",
        body: null,
        rateLimit: emptyRateLimit,
      })
    })
    return { request, requestRaw } as unknown as GitHubClient
  }

  const forkSource: Assignment = {
    slug: "hw1",
    name: "Homework 1",
    mode: "individual",
    autograder: "default",
    feedback_pr: true,
    template: { owner: ORG, repo: "hw1-fork", branch: "main" },
  }

  it("blocks reusing a cross-org private fork (parity with resolveTemplate)", async () => {
    const client = makeClient({
      name: "hw1-fork",
      full_name: `${ORG}/hw1-fork`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "other-org/secret-upstream", private: true },
      default_branch: "main",
    })

    await expect(
      copyAssignmentToClassroom(client, {
        org: ORG,
        source: forkSource,
        targetClassroom: "cs51",
      }),
    ).rejects.toThrow(/other-org\/secret-upstream in another org/)
  })

  it("blocks reusing a private fork with an unknown (absent) parent", async () => {
    const client = makeClient({
      name: "hw1-fork",
      full_name: `${ORG}/hw1-fork`,
      private: true,
      is_template: true,
      fork: true,
      default_branch: "main",
    })

    await expect(
      copyAssignmentToClassroom(client, {
        org: ORG,
        source: forkSource,
        targetClassroom: "cs51",
      }),
    ).rejects.toThrow(/private upstream isn't accessible/)
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
  function clientReturning(result: unknown | (() => never)): GitHubClient {
    const request = vi.fn(async () => {
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

  function clientReturning(result: unknown): GitHubClient {
    const request = vi.fn(async () => result)
    return { request } as unknown as GitHubClient
  }

  it("blocks a cross-org private fork (private upstream in another org)", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      parent: { full_name: "other-org/secret-upstream", private: true },
      default_branch: "main",
    })

    await expect(
      resolveTemplate(client, ORG, ref(ORG, "tmpl")),
    ).rejects.toThrow(/other-org\/secret-upstream in another org/)
  })

  it("blocks a private fork with an unknown (absent) parent", async () => {
    const client = clientReturning({
      name: "tmpl",
      full_name: `${ORG}/tmpl`,
      private: true,
      is_template: true,
      fork: true,
      default_branch: "main",
    })

    await expect(
      resolveTemplate(client, ORG, ref(ORG, "tmpl")),
    ).rejects.toThrow(/private upstream isn't accessible/)
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

  it("rejects a group-shaped size with a non-group mode", () => {
    expect(() => assertAssignmentModeCoherent("hw", "individual", 2)).toThrow(
      /max_group_size 2 but mode "individual"/,
    )
  })
})

// permissionSatisfies decides whether the read-back after the grant matches the
// role we set, accounting for GitHub collapsing push -> legacy "write". Guards
// the verified self-demotion (a repo creator is admin until this downgrades it).
describe("permissionSatisfies — verified founder demotion", () => {
  it("accepts a push grant that reads back as legacy write", () => {
    expect(permissionSatisfies("write", "write", "push")).toBe(true)
    expect(permissionSatisfies("write", "push", "push")).toBe(true)
  })

  it("accepts an admin grant that reads back as admin", () => {
    expect(permissionSatisfies("admin", "admin", "admin")).toBe(true)
  })

  it("rejects a still-admin read-back after a push grant (downgrade ignored)", () => {
    expect(permissionSatisfies("admin", "admin", "push")).toBe(false)
  })

  it("rejects a maintain read-back for a push target (the guard's boundary)", () => {
    // GitHub collapses maintain->legacy "write", so legacy alone would pass;
    // the authoritative role_name must catch the still-over-privileged founder.
    expect(permissionSatisfies("write", "maintain", "push")).toBe(false)
  })

  it("rejects a push read-back for an admin target (group under-grant)", () => {
    expect(permissionSatisfies("write", "push", "admin")).toBe(false)
  })

  it("falls back to the legacy field when role_name is absent", () => {
    expect(permissionSatisfies("write", undefined, "push")).toBe(true)
    expect(permissionSatisfies("admin", undefined, "admin")).toBe(true)
    expect(permissionSatisfies("write", undefined, "admin")).toBe(false)
  })

  it("rejects an under-grant (read only) for a push target", () => {
    expect(permissionSatisfies("read", "read", "push")).toBe(false)
  })

  it("tolerates an owner's unavoidable admin for a push target when isOwner", () => {
    expect(permissionSatisfies("admin", "admin", "push", true)).toBe(true)
    expect(permissionSatisfies("admin", undefined, "push", true)).toBe(true)
  })

  it("still rejects a maintain read-back for a push target even for an owner", () => {
    expect(permissionSatisfies("write", "maintain", "push", true)).toBe(false)
  })

  it("does not let isOwner leak into an admin target", () => {
    expect(permissionSatisfies("write", "maintain", "admin", true)).toBe(false)
  })
})

// Drives addFounderCollaborator end-to-end (PUT grant -> read-back -> throw),
// the web mirror of gh-student's TestInviteFounder / _VerificationFails.
describe("addFounderCollaborator — grant + read-back verification", () => {
  const owner = "cs50"
  const repo = "cs50-fall-2026-hello-alice"
  const username = "alice"
  const collabPath = `/repos/${owner}/${repo}/collaborators/${username}`
  const permPath = `${collabPath}/permission`

  // A mock client that records the collaborator PUT body and answers the
  // permission read-back with `readback`.
  function makeClient(readback: { permission?: string; role_name?: string }) {
    const put = vi.fn()
    const request = vi.fn(async (path: string, opts?: { method?: string }) => {
      if (path === collabPath && opts?.method === "PUT") {
        put(opts)
        return undefined
      }
      if (path === permPath) return readback
      throw new Error(`unexpected request: ${opts?.method ?? "GET"} ${path}`)
    })
    return { client: { request } as unknown as GitHubClient, request, put }
  }

  it("PUTs push and succeeds when the read-back satisfies", async () => {
    const { client, request } = makeClient({
      permission: "write",
      role_name: "push",
    })
    await expect(
      addFounderCollaborator({
        client,
        owner,
        repo,
        username,
        permission: "push",
      }),
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith(collabPath, {
      method: "PUT",
      body: { permission: "push" },
    })
  })

  it("PUTs admin for a group founder", async () => {
    const { client, request } = makeClient({
      permission: "admin",
      role_name: "admin",
    })
    await addFounderCollaborator({
      client,
      owner,
      repo,
      username,
      permission: "admin",
    })
    expect(request).toHaveBeenCalledWith(collabPath, {
      method: "PUT",
      body: { permission: "admin" },
    })
  })

  it("throws when the read-back still reports admin after a push grant", async () => {
    const { client } = makeClient({ permission: "admin", role_name: "admin" })
    await expect(
      addFounderCollaborator({
        client,
        owner,
        repo,
        username,
        permission: "push",
      }),
    ).rejects.toThrow(/"push"/)
  })

  it("throws when the read-back is maintain for a push grant (the guard's boundary)", async () => {
    const { client } = makeClient({
      permission: "write",
      role_name: "maintain",
    })
    await expect(
      addFounderCollaborator({
        client,
        owner,
        repo,
        username,
        permission: "push",
      }),
    ).rejects.toThrow(/"push"/)
  })

  it("resolves for an org owner whose read-back stays admin after a push grant", async () => {
    const { client, request } = makeClient({
      permission: "admin",
      role_name: "admin",
    })
    await expect(
      addFounderCollaborator({
        client,
        owner,
        repo,
        username,
        permission: "push",
        isOwner: true,
      }),
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith(collabPath, {
      method: "PUT",
      body: { permission: "push" },
    })
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
})
