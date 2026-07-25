import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import { CONFIG_REPO } from "@/util/configRepo"

import { githubKeys, invalidateViewerOrgs } from "./keys"

const invalidated = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState(key)?.isInvalidated ?? false

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
    const untouched: Record<string, readonly unknown[]> = {
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
