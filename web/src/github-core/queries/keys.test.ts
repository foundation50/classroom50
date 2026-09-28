import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import { CONFIG_REPO } from "@/util/configRepo"

import {
  githubKeys,
  invalidateRepoCollaborators,
  invalidateViewerOrgs,
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
