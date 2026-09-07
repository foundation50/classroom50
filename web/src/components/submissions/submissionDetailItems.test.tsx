import { describe, expect, it } from "vitest"

import {
  buildSubmissionDetailItems,
  collectedTagDetailItems,
  commitDetailItems,
  submissionEmptyState,
  tagDetailItems,
} from "./submissionDetailItems"
import { detailItemsCount } from "./SubmissionDetailsModal"

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

  it("omits the author unless asked (an individual repo's author is the student)", () => {
    const commits = [
      {
        key: "c",
        author: { login: "alice", avatarUrl: "https://avatars/alice" },
      },
    ]
    expect(commitDetailItems(commits, t)[0].author).toBeUndefined()
    expect(
      commitDetailItems(commits, t, { showAuthors: true })[0].author,
    ).toEqual({ label: "alice", avatarUrl: "https://avatars/alice" })
  })

  it("names an unlinked commit by its git author, without an avatar", () => {
    const [item] = commitDetailItems(
      [{ key: "c", author: { name: "Alice Git" } }],
      t,
      { showAuthors: true },
    )
    expect(item.author).toEqual({ label: "Alice Git", avatarUrl: undefined })
  })

  it("prefers the roster name for a linked login, falling back to the login", () => {
    const roster: Record<string, string> = { alice: "Alice Anderson" }
    const items = commitDetailItems(
      [
        {
          key: "a",
          author: { login: "alice", avatarUrl: "https://avatars/alice" },
        },
        {
          key: "b",
          author: { login: "bob", avatarUrl: "https://avatars/bob" },
        },
        // An unlinked commit has no login to resolve, so the resolver is skipped
        // and the git author name stands.
        { key: "c", author: { name: "Carol Git" } },
      ],
      t,
      { showAuthors: true, authorName: (login) => roster[login] },
    )
    expect(items[0].author).toEqual({
      label: "Alice Anderson",
      avatarUrl: "https://avatars/alice",
    })
    expect(items[1].author).toEqual({
      label: "bob",
      avatarUrl: "https://avatars/bob",
    })
    expect(items[2].author).toEqual({
      label: "Carol Git",
      avatarUrl: undefined,
    })
  })

  it("treats an empty resolved name as unavailable", () => {
    const [item] = commitDetailItems(
      [{ key: "a", author: { login: "alice" } }],
      t,
      { showAuthors: true, authorName: () => "" },
    )
    expect(item.author?.label).toBe("alice")
  })

  it("guards the avatar URL and skips an authorless commit", () => {
    const items = commitDetailItems(
      [
        { key: "a", author: { login: "alice", avatarUrl: "javascript:x" } },
        { key: "b" },
      ],
      t,
      { showAuthors: true },
    )
    expect(items[0].author).toEqual({ label: "alice", avatarUrl: undefined })
    expect(items[1].author).toBeUndefined()
  })
})

describe("buildSubmissionDetailItems", () => {
  it("labels pushes with their author on a shared repo", () => {
    const items = buildSubmissionDetailItems(
      {
        tags: [],
        commits: [
          { key: "c", author: { login: "bob" } },
          { key: "d", author: { login: "dan" } },
        ],
        showAuthors: true,
        authorName: (login) => (login === "bob" ? "Bob Brown" : undefined),
      },
      "every-push",
      "acme",
      "cs101-hw1-group-1",
      t,
    )
    expect(items[0].author?.label).toBe("Bob Brown")
    expect(items[1].author?.label).toBe("dan")
  })
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

  it("carries a glob group's match count so the header can sum to the chip", () => {
    const items = tagDetailItems(
      [{ kind: "tag-group", label: "v*", count: 3, sha: "bbb2222" }],
      "acme",
      "cs101-hw1-alice",
      t,
    )
    // One row, but it represents 3 submissions — detailItemsCount sums them so
    // the modal header matches the count chip (fixes chip/modal divergence).
    expect(items).toHaveLength(1)
    expect(items[0].count).toBe(3)
    expect(detailItemsCount(items)).toBe(3)
  })
})

describe("detailItemsCount", () => {
  it("sums per-item counts (a glob group contributes its matches)", () => {
    const items = tagDetailItems(
      [
        { kind: "tag", label: "phase1", count: 1, sha: "aaa1111" },
        { kind: "tag-group", label: "v*", count: 3, sha: "bbb2222" },
      ],
      "acme",
      "cs101-hw1-alice",
      t,
    )
    expect(items).toHaveLength(2)
    expect(detailItemsCount(items)).toBe(4)
  })
})

describe("collectedTagDetailItems", () => {
  it("numbers collected tag submissions newest-first, prefers the release href, count 1", () => {
    const items = collectedTagDetailItems(
      [
        {
          key: "t1",
          datetime: "2026-06-21T10:00:00Z",
          commitHref: "https://github.com/x/y/commit/bbb",
          releaseHref: "https://github.com/x/y/releases/tag/z",
        },
        {
          key: "t2",
          datetime: "2026-06-20T10:00:00Z",
          commitHref: "https://github.com/x/y/commit/aaa",
          releaseHref: null,
        },
      ],
      t,
    )
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.kind === "tag")).toBe(true)
    // Newest first is #2, oldest #1.
    expect(items[0].label).toBe("submissions.details.tagEntry")
    // Release href preferred; falls back to the commit href when absent.
    expect(items[0].href).toBe("https://github.com/x/y/releases/tag/z")
    expect(items[1].href).toBe("https://github.com/x/y/commit/aaa")
    expect(detailItemsCount(items)).toBe(2)
  })

  it("drops unsafe hrefs", () => {
    const items = collectedTagDetailItems(
      [{ key: "t", releaseHref: "javascript:alert(1)", commitHref: null }],
      t,
    )
    expect(items[0].href).toBeUndefined()
  })
})

describe("buildSubmissionDetailItems tag fallback", () => {
  it("falls back to collected tags when no detection overlay is present", () => {
    // A non-owner viewer: detectedEntries (tags) is empty, but collected
    // submissions exist. The modal must list them, not render a false empty
    // state that contradicts the positive count chip.
    const items = buildSubmissionDetailItems(
      {
        tags: [],
        commits: [],
        collectedTags: [
          {
            key: "t1",
            datetime: "2026-06-21T10:00:00Z",
            releaseHref: "https://github.com/x/y/releases/tag/z",
          },
        ],
      },
      "tag",
      "acme",
      "cs101-hw1-alice",
      t,
    )
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe("tag")
    expect(items[0].href).toBe("https://github.com/x/y/releases/tag/z")
  })

  it("prefers detected tag entries over the collected fallback", () => {
    const items = buildSubmissionDetailItems(
      {
        tags: [{ kind: "tag", label: "phase1", count: 1, sha: "aaa1111" }],
        commits: [],
        collectedTags: [{ key: "t1", releaseHref: "https://x/releases/tag/z" }],
      },
      "tag",
      "acme",
      "cs101-hw1-alice",
      t,
    )
    expect(items).toHaveLength(1)
    expect(items[0].href).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/phase1",
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
