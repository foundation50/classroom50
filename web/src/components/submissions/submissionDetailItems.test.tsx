import { describe, expect, it } from "vitest"

import {
  buildSubmissionDetailItems,
  commitDetailItems,
  submissionEmptyState,
  tagDetailItems,
} from "./submissionDetailItems"

// The test i18n stand-in: echoes the key so assertions can match on it.
const t = (key: string) => key

describe("commitDetailItems", () => {
  it("numbers push submissions newest-first and guards hrefs", () => {
    const items = commitDetailItems(
      [
        {
          key: "bbb",
          commitHref: "https://github.com/x/y/commit/bbb",
          datetime: "2026-06-21T10:00:00Z",
          releaseHref: "https://github.com/x/y/releases/tag/z",
        },
        {
          key: "aaa",
          commitHref: "javascript:alert(1)",
          datetime: "2026-06-20T10:00:00Z",
        },
      ],
      t,
    )
    expect(items).toHaveLength(2)
    expect(items[0].kind).toBe("commit")
    expect(items[0].href).toBe("https://github.com/x/y/commit/bbb")
    expect(items[0].releaseHref).toBe("https://github.com/x/y/releases/tag/z")
    // Unsafe href is dropped; item without a release carries no releaseHref.
    expect(items[1].href).toBeUndefined()
    expect(items[1].releaseHref).toBeUndefined()
  })
})

describe("buildSubmissionDetailItems", () => {
  it("uses tag entries in tag mode", () => {
    const items = buildSubmissionDetailItems(
      {
        tags: [{ kind: "tag", label: "phase1", count: 1, sha: "aaa1111" }],
        commits: [{ key: "c", commitHref: "https://x/commit/c" }],
      },
      "tag",
      "acme",
      "cs101-hw1-alice",
      t,
    )
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe("tag")
    expect(items[0].href).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/phase1",
    )
  })

  it("uses commit submissions in every-push (and absent) mode", () => {
    const items = buildSubmissionDetailItems(
      {
        tags: [{ kind: "tag", label: "phase1", count: 1, sha: "aaa1111" }],
        commits: [{ key: "c", commitHref: "https://x/commit/c" }],
      },
      undefined,
      "acme",
      "cs101-hw1-alice",
      t,
    )
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe("commit")
  })
})

describe("tagDetailItems", () => {
  it("labels a glob group by pattern + count and drops commit entries", () => {
    const items = tagDetailItems(
      [
        { kind: "commit", label: "abc1234", count: 1, sha: "abc1234" },
        { kind: "tag-group", label: "v*", count: 3, sha: "bbb2222" },
      ],
      "acme",
      "cs101-hw1-alice",
      t,
    )
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe("submissions.type.tagGroupCount")
    expect(items[0].href).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/bbb2222",
    )
  })
})

describe("submissionEmptyState", () => {
  it("points at the tags page in tag mode", () => {
    const state = submissionEmptyState(
      "tag",
      "acme",
      "cs101-hw1-alice",
      "https://github.com/acme/cs101-hw1-alice",
      t,
    )
    expect(state.emptyLabel).toBe("submissions.details.emptyTag")
    expect(state.emptyLinkHref).toBe(
      "https://github.com/acme/cs101-hw1-alice/tags",
    )
  })

  it("points at the default branch (repoHref) in every-push mode", () => {
    const state = submissionEmptyState(
      "every-push",
      "acme",
      "cs101-hw1-alice",
      "https://github.com/acme/cs101-hw1-alice",
      t,
    )
    expect(state.emptyLabel).toBe("submissions.details.emptyEveryPush")
    expect(state.emptyLinkHref).toBe("https://github.com/acme/cs101-hw1-alice")
  })
})
