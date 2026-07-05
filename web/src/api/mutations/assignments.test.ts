import { describe, expect, it, vi } from "vitest"

import {
  buildReusedEntry,
  copyAssignmentToClassroom,
  editAssignment,
  nextAvailableSlug,
  preserveUnmanagedAssignmentKeys,
  resolveTemplate,
  verifyTemplateAccess,
} from "./assignments"
import type { GitHubClient } from "@/hooks/github/client"
import { GitHubAPIError } from "@/hooks/github/errors"
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
    // An empty array is truthy, so the omitempty cleanup must NOT delete it —
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
  // migrated_from block (the form never manages it) and a managed `due` the
  // edit clears.
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

  // Wire up a route-table GitHubClient covering exactly the endpoints
  // editAssignment hits on the template-less path: ref read, commit read,
  // assignments.json contents read, then tree/commit/ref writes. classroom.json
  // is absent (404) so the archive guard reads the classroom as active.
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

  it("re-validates an unchanged stored ref and blocks a now-cross-org private fork", async () => {
    // An assignment whose stored template is an in-org private fork of a
    // private cross-org upstream (created before the fork guard shipped, or a
    // parent that went private after create). Editing WITHOUT changing the ref
    // must still trip the fork guard rather than trusting the stored block.
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

  // A client that answers the three pre-commit reads copyAssignmentToClassroom
  // runs in parallel (archive guard via requestRaw 404, getRepo, getBranchRef).
  // The fork guard throws before any commit, so no write routes are needed.
  function makeClient(repo: unknown): GitHubClient {
    const request = vi.fn(async (url: string) => {
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
