// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type PropsWithChildren } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      // Echo interpolation params so a count/query assertion can see them.
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key} ${JSON.stringify(params)}` : key,
    }),
  }
})

const searchOrgTemplateRepos = vi.fn()
vi.mock("@/github-core/queries", () => ({
  orgTemplateRepoSearchQuery: (
    _client: unknown,
    args: { org?: string; query: string; enabled?: boolean },
  ) => ({
    queryKey: ["template-search", args.org, args.query],
    queryFn: () => searchOrgTemplateRepos(args),
    enabled: Boolean(args.org) && (args.enabled ?? true),
    retry: false,
  }),
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => ({ request: vi.fn() }),
}))

import { TemplateRepoPicker } from "./TemplateRepoPicker"
import type { StringField } from "./formFieldHelpers"
import { GitHubAPIError } from "@/github-core/errors"

const ORG = "cs50"

const ITEMS = [
  {
    fullName: "cs50/starter",
    name: "starter",
    description: "Problem set starter",
    private: false,
    updatedAt: "2026-08-01T00:00:00Z",
  },
  {
    fullName: "cs50/starter-python",
    name: "starter-python",
    private: true,
  },
]

const handleChange = vi.fn()

function fakeField(value = ""): StringField {
  return {
    name: "template_repo",
    state: { value },
    handleChange,
    handleBlur: vi.fn(),
  } as unknown as StringField
}

function renderPicker(props: { value?: string; org?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return render(
    createElement(TemplateRepoPicker, {
      field: fakeField(props.value ?? ""),
      id: "template_repo",
      org: "org" in props ? props.org : ORG,
      placeholder: "placeholder",
    }),
    { wrapper },
  )
}

const input = () => screen.getByRole("combobox") as HTMLInputElement

beforeEach(() => {
  handleChange.mockClear()
  searchOrgTemplateRepos.mockReset()
  searchOrgTemplateRepos.mockResolvedValue({
    items: ITEMS,
    totalCount: 2,
    incomplete: false,
  })
})

afterEach(cleanup)

describe("TemplateRepoPicker", () => {
  it("does not search until the picker is opened", () => {
    renderPicker()
    // An assignment form sitting idle must not spend the search budget.
    expect(searchOrgTemplateRepos).not.toHaveBeenCalled()
  })

  it("searches with an empty query on open, listing recent templates", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    await waitFor(() => expect(searchOrgTemplateRepos).toHaveBeenCalled())
    expect(searchOrgTemplateRepos.mock.calls[0][0]).toMatchObject({
      org: ORG,
      query: "",
    })
    expect(await screen.findByText("cs50/starter")).toBeTruthy()
  })

  it("writes the selected repo's owner/repo into the field", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())
    await user.click(await screen.findByText("cs50/starter-python"))

    expect(handleChange).toHaveBeenCalledWith("cs50/starter-python")
  })

  it("marks a private template so a teacher knows students need a grant", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    expect(
      await screen.findByLabelText("assignments.template.search.privateRepo"),
    ).toBeTruthy()
  })

  it("tells the teacher to keep typing when the org has more matches than one page", async () => {
    searchOrgTemplateRepos.mockResolvedValue({
      items: ITEMS,
      totalCount: 4213,
      incomplete: false,
    })
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    const footer = await screen.findByText(
      /assignments\.template\.search\.narrow/,
    )
    expect(footer.textContent).toContain("4213")
  })

  it("omits the narrowing footer when every match is shown", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())
    await screen.findByText("cs50/starter")

    expect(
      screen.queryByText(/assignments\.template\.search\.narrow/),
    ).toBeNull()
  })

  it("offers manual entry instead of retrying when search is rate-limited", async () => {
    // Search has its own 30/min bucket, so a throttle must degrade to typing.
    searchOrgTemplateRepos.mockRejectedValue(
      new GitHubAPIError({
        status: 403,
        url: "https://api.github.com/search/repositories",
        message: "API rate limit exceeded",
        body: null,
        rateLimit: {
          limit: 30,
          remaining: 0,
          used: 30,
          reset: null,
          resource: "search",
          retryAfter: null,
        },
      }),
    )
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    expect(
      await screen.findByText("assignments.template.search.throttled"),
    ).toBeTruthy()
    expect(
      screen.getByText("assignments.template.search.typeInstead"),
    ).toBeTruthy()
    expect(searchOrgTemplateRepos).toHaveBeenCalledTimes(1)
  })

  it("shows the no-matches hint naming the query", async () => {
    searchOrgTemplateRepos.mockResolvedValue({
      items: [],
      totalCount: 0,
      incomplete: false,
    })
    const user = userEvent.setup()
    renderPicker({ value: "nope" })

    await user.click(input())

    const empty = await screen.findByText(
      /assignments\.template\.search\.noMatches/,
    )
    expect(empty.textContent).toContain("nope")
  })

  it("shows the no-templates hint when the org has none and nothing was typed", async () => {
    searchOrgTemplateRepos.mockResolvedValue({
      items: [],
      totalCount: 0,
      incomplete: false,
    })
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    expect(
      await screen.findByText("assignments.template.search.noTemplates"),
    ).toBeTruthy()
  })

  it("surfaces a partial index answer", async () => {
    searchOrgTemplateRepos.mockResolvedValue({
      items: ITEMS,
      totalCount: 2,
      incomplete: true,
    })
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    expect(
      await screen.findByText("assignments.template.search.incomplete"),
    ).toBeTruthy()
  })

  it("never searches without an org", async () => {
    const user = userEvent.setup()
    renderPicker({ org: undefined })

    await user.click(input())

    expect(searchOrgTemplateRepos).not.toHaveBeenCalled()
  })

  it("keeps hand-typing working, reporting each keystroke to the form", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.type(input(), "a")

    expect(handleChange).toHaveBeenCalledWith("a")
  })
})
