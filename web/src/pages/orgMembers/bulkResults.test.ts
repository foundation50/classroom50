// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"

import { buildInviteResult } from "./bulkResults"

// Key-echo t: keys and their options stay visible in the assertions.
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts && Object.keys(opts).length > 0
    ? `${key}:${JSON.stringify(opts)}`
    : key) as unknown as TFunction

describe("buildInviteResult", () => {
  it("renders one section per outcome bucket, with the rate-limit note leading the warnings", () => {
    const view = buildInviteResult(
      {
        invitedCount: 1,
        rateLimited: true,
        outcomes: [
          { key: "a", label: "ada", status: "invited" },
          {
            key: "b",
            label: "bob",
            status: "skipped",
            detail: "already-pending",
          },
          { key: "c", label: "cy", status: "failed", detail: "boom" },
          { key: "d", label: "dee", status: "deferred" },
          { key: "e", label: "eve", status: "deferred" },
        ],
      },
      t,
    )

    expect(view.headline).toBe('orgMembers.bulk.invitedHeadline:{"count":1}')
    expect(view.sections.map((s) => s.title)).toEqual([
      "orgMembers.bulk.resultSkipped",
      "orgMembers.bulk.resultFailed",
      "orgMembers.bulk.resultWarnings",
    ])
    expect(view.sections[0]!.rows).toEqual([
      {
        key: "b",
        label: "bob",
        detail:
          'orgMembers.bulk.inviteSkipReason.already-pending:{"defaultValue":"already-pending"}',
      },
    ])
    expect(view.sections[1]!.rows).toEqual([
      { key: "c", label: "cy", detail: "boom" },
    ])
    expect(view.sections[2]!.rows).toEqual([
      {
        key: "rate-limited",
        label: 'orgMembers.bulk.inviteRateLimited:{"sent":1}',
      },
      { key: "d", label: "dee" },
      { key: "e", label: "eve" },
    ])
  })

  it("omits empty sections", () => {
    const view = buildInviteResult(
      {
        invitedCount: 2,
        rateLimited: false,
        outcomes: [
          { key: "a", label: "ada", status: "invited" },
          { key: "b", label: "bob", status: "invited" },
        ],
      },
      t,
    )
    expect(view.sections).toEqual([])
  })
})
