import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import { CONFIG_REPO } from "@/util/configRepo"
import type { AssignmentsFile } from "@/domain/queries/assignments"
import type { TeamsFile } from "@/domain/teams/teamsFile"
import type { Assignment } from "@/types/classroom"

import {
  githubKeys,
  invalidateRepoCollaborators,
  invalidateViewerOrgs,
  seedAssignments,
  seedJsonFile,
  seedTeamsFile,
} from "./keys"

const invalidated = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState(key)?.isInvalidated ?? false

describe("invalidateRepoCollaborators", () => {
  it("drops the repo's list and the org's group fan-out, and nothing else", () => {
    const client = new QueryClient()
    const seeded: Record<string, readonly unknown[]> = {
      repo: githubKeys.collaborators("acme", "cs101-hw1-alice"),
      // The fan-out is keyed by the whole repo set, so any set under the org
      // must refresh: a manual grade credits a legacy group's members from it.
      fanOut: [
        ...githubKeys.groupCollaboratorsAll("acme"),
        "cs101-hw1-alice,cs101-hw1-bob",
      ],
    }
    const untouched: Record<string, readonly unknown[]> = {
      otherRepo: githubKeys.collaborators("acme", "cs101-hw1-bob"),
      otherOrg: [...githubKeys.groupCollaboratorsAll("other"), "x"],
      teamMembers: [...githubKeys.all, "group-team-members", "acme", "slug"],
    }
    Object.values({ ...seeded, ...untouched }).forEach((key) =>
      client.setQueryData(key, { ok: true }),
    )

    invalidateRepoCollaborators(client, "acme", "cs101-hw1-alice")

    Object.entries(seeded).forEach(([name, key]) =>
      expect(invalidated(client, key), name).toBe(true),
    )
    Object.entries(untouched).forEach(([name, key]) =>
      expect(invalidated(client, key), name).toBe(false),
    )
  })
})

describe("invalidateViewerOrgs", () => {
  it("drops every cache the org list derives, and nothing else", () => {
    const client = new QueryClient()
    const seeded: Record<string, readonly unknown[]> = {
      memberships: ["orgs", "memberships"],
      summaries: ["orgs", "active-summaries"],
      // Plan name: its own cache, so a Free -> Team upgrade needs this too.
      details: githubKeys.orgDetails("acme"),
      // "Updated …" line / last-modified sort.
      configRepo: githubKeys.repo("acme", CONFIG_REPO),
    }
    // The per-org member lists also live under the ["orgs"] prefix, and
    // orgMembersAll pages to exhaustion — a home-page refresh must not bill it.
    const untouched: Record<string, readonly unknown[]> = {
      orgMembers: githubKeys.orgMembers("acme"),
      orgMembersAll: githubKeys.orgMembersAll("acme"),
      orgAdmins: githubKeys.orgAdmins("acme"),
      otherRepo: githubKeys.repo("acme", "some-assignment"),
      viewer: githubKeys.viewer(),
    }
    Object.values({ ...seeded, ...untouched }).forEach((key) =>
      client.setQueryData(key, { ok: true }),
    )

    invalidateViewerOrgs(client)

    Object.entries(seeded).forEach(([name, key]) =>
      expect(invalidated(client, key), name).toBe(true),
    )
    Object.entries(untouched).forEach(([name, key]) =>
      expect(invalidated(client, key), name).toBe(false),
    )
  })
})

describe("seedJsonFile", () => {
  const key = githubKeys.classroomFile("acme", "cs101")

  it("replaces the cached body with the written document, fresh and not invalidated", () => {
    const client = new QueryClient()
    client.setQueryData(key, { short_name: "cs101", name: "old" })

    seedJsonFile(client, key, { short_name: "cs101", name: "new" })

    expect(client.getQueryData(key)).toEqual({
      short_name: "cs101",
      name: "new",
    })
    expect(invalidated(client, key)).toBe(false)
    expect(client.getQueryState(key)?.status).toBe("success")
  })

  it("stores what parsing the committed JSON yields, not the in-memory object", () => {
    // jsonFileQuery hands consumers JSON.parse output, so a seed must match it:
    // an `undefined` member is absent on the wire and must be absent here too.
    const client = new QueryClient()
    const written = { short_name: "cs101", pages_base_url: undefined }

    seedJsonFile(client, key, written)

    const cached = client.getQueryData(key) as Record<string, unknown>
    expect("pages_base_url" in cached).toBe(false)
    expect(cached).not.toBe(written)
  })

  it("cancels an in-flight read so a late stale response cannot overwrite the seed", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let resolveRead!: (value: unknown) => void
    const fetching = client.fetchQuery({
      queryKey: key,
      queryFn: () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    })
    await Promise.resolve()

    seedJsonFile(client, key, { name: "written" })
    // The stale pre-write body arrives after the seed.
    resolveRead({ name: "stale" })
    await fetching.catch(() => undefined)

    expect(client.getQueryData(key)).toEqual({ name: "written" })
  })

  // Writers resolve after their post-commit work, so a second write that
  // committed on top of the first can seed first. The first must then lose.
  describe("commit ordering", () => {
    const c = (previousCommitSha: string, newCommitSha: string) => ({
      previousCommitSha,
      newCommitSha,
    })

    it("skips a seed whose commit a later seed already built on", () => {
      const client = new QueryClient()
      // B (C1 -> C2) resolves before A (C0 -> C1).
      seedJsonFile(client, key, { name: "B" }, c("C1", "C2"))
      seedJsonFile(client, key, { name: "A" }, c("C0", "C1"))

      expect(client.getQueryData(key)).toEqual({ name: "B" })
    })

    it("seeds in order when writes resolve in commit order", () => {
      const client = new QueryClient()
      seedJsonFile(client, key, { name: "A" }, c("C0", "C1"))
      seedJsonFile(client, key, { name: "B" }, c("C1", "C2"))

      expect(client.getQueryData(key)).toEqual({ name: "B" })
    })

    it("seeds a write built on a head it never saw (another client wrote)", () => {
      const client = new QueryClient()
      seedJsonFile(client, key, { name: "A" }, c("C0", "C1"))
      // Someone else committed C2; our next write reads C2 and commits C3.
      seedJsonFile(client, key, { name: "ours" }, c("C2", "C3"))

      expect(client.getQueryData(key)).toEqual({ name: "ours" })
    })

    it("tracks ordering per key and per client", () => {
      const client = new QueryClient()
      const other = githubKeys.jsonFile("acme", CONFIG_REPO, "cs102/x.json")
      seedJsonFile(client, key, { name: "B" }, c("C1", "C2"))
      seedJsonFile(client, other, { name: "A" }, c("C0", "C1"))
      expect(client.getQueryData(other)).toEqual({ name: "A" })

      const fresh = new QueryClient()
      seedJsonFile(fresh, key, { name: "A" }, c("C0", "C1"))
      expect(fresh.getQueryData(key)).toEqual({ name: "A" })
    })

    it("always seeds when the writer carries no commit", () => {
      const client = new QueryClient()
      seedJsonFile(client, key, { name: "B" }, c("C1", "C2"))
      seedJsonFile(client, key, { name: "plain" })

      expect(client.getQueryData(key)).toEqual({ name: "plain" })
    })
  })
})

describe("seedAssignments", () => {
  const written: AssignmentsFile = {
    schema: "classroom50/assignments/v1",
    assignments: [],
  }

  it("seeds the same key the assignments read uses", () => {
    const client = new QueryClient()

    seedAssignments(client, "acme", "cs101", written)

    expect(
      client.getQueryData(
        githubKeys.jsonFile("acme", CONFIG_REPO, "cs101/assignments.json"),
      ),
    ).toEqual(written)
  })

  it("orders by commit like seedJsonFile", () => {
    const client = new QueryClient()
    const later: AssignmentsFile = {
      ...written,
      assignments: [{ slug: "hw1", name: "HW1" } as Assignment],
    }
    seedAssignments(client, "acme", "cs101", later, {
      previousCommitSha: "C1",
      newCommitSha: "C2",
    })
    seedAssignments(client, "acme", "cs101", written, {
      previousCommitSha: "C0",
      newCommitSha: "C1",
    })

    expect(
      client.getQueryData(githubKeys.assignmentsFile("acme", "cs101")),
    ).toEqual(later)
  })
})

describe("seedTeamsFile", () => {
  const teamsFile: TeamsFile = {
    schema: "classroom50/teams/v1",
    assignments: {},
  }
  const teamsKey = githubKeys.teamsFile("acme", "cs101")

  it("seeds the same key useTeamsSnapshot reads", () => {
    const client = new QueryClient()

    seedTeamsFile(client, "acme", "cs101", {
      previousCommitSha: "C0",
      newCommitSha: "C1",
      teamsFile,
    })

    expect(client.getQueryData(teamsKey)).toEqual(teamsFile)
    expect(invalidated(client, teamsKey)).toBe(false)
  })

  // A best-effort snapshot write that did not land leaves the file as it was,
  // so the cache is refetched rather than seeded with a guess.
  it("invalidates instead when the write did not land", () => {
    const client = new QueryClient()
    client.setQueryData(teamsKey, teamsFile)

    seedTeamsFile(client, "acme", "cs101", undefined)

    expect(invalidated(client, teamsKey)).toBe(true)
  })
})
