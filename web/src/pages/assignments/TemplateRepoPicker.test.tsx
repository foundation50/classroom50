// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, useState, type PropsWithChildren } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      // Echo interpolation params so count/query assertions can see them.
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key} ${JSON.stringify(params)}` : key,
    }),
  }
})

const listOrgTemplateRepos = vi.fn()
vi.mock("@/github-core/queries", async (importOriginal) => {
  // filterTemplateRepos is pure and under test elsewhere — exercise the real one
  // so these tests prove the wiring, not a reimplementation of the filter.
  const actual = await importOriginal<typeof import("@/github-core/queries")>()
  return {
    filterTemplateRepos: actual.filterTemplateRepos,
    orgTemplateReposQuery: (
      _client: unknown,
      args: { org?: string; enabled?: boolean },
    ) => ({
      queryKey: ["org-template-repos", args.org],
      queryFn: () => listOrgTemplateRepos(args),
      enabled: Boolean(args.org) && (args.enabled ?? true),
      retry: false,
    }),
  }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => ({ request: vi.fn() }),
}))

import { TemplateRepoPicker } from "./TemplateRepoPicker"
import type { StringField } from "./formFieldHelpers"

const ORG = "cs50"

const ITEMS = [
  {
    fullName: "cs50/starter",
    name: "starter",
    description: "Problem set starter",
    private: false,
    updatedAt: "2026-08-01T00:00:00Z",
  },
  { fullName: "cs50/ap-cs", name: "ap-cs", private: true },
]

const listResult = (over: Record<string, unknown> = {}) => ({
  items: ITEMS,
  scanned: ITEMS.length,
  truncated: false,
  templateFlagPresent: true,
  ...over,
})

const handleChange = vi.fn()

function fakeField(value = ""): StringField {
  return {
    name: "template_repo",
    state: { value },
    handleChange,
    handleBlur: vi.fn(),
  } as unknown as StringField
}

// A stateful host, so typing actually narrows the list — a frozen stub field
// would let the local-filter tests pass without any filtering happening.
function StatefulPicker(props: {
  initialValue?: string
  org?: string
  canonicalRef?: string | null
}) {
  const [value, setValue] = useState(props.initialValue ?? "")
  const field = {
    name: "template_repo",
    state: { value },
    handleChange: (next: string) => {
      handleChange(next)
      setValue(next)
    },
    handleBlur: vi.fn(),
  } as unknown as StringField
  return createElement(TemplateRepoPicker, {
    field,
    id: "template_repo",
    org: "org" in props ? props.org : ORG,
    placeholder: "placeholder",
    canonicalRef: props.canonicalRef,
  })
}

function queryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function renderPicker(
  props: { value?: string; org?: string; canonicalRef?: string | null } = {},
) {
  return render(
    createElement(TemplateRepoPicker, {
      field: fakeField(props.value ?? ""),
      id: "template_repo",
      org: "org" in props ? props.org : ORG,
      placeholder: "placeholder",
      canonicalRef: props.canonicalRef,
    }),
    { wrapper: queryWrapper() },
  )
}

function renderStateful(
  props: {
    initialValue?: string
    org?: string
    canonicalRef?: string | null
  } = {},
) {
  return render(createElement(StatefulPicker, props), {
    wrapper: queryWrapper(),
  })
}

const input = () => screen.getByRole("combobox") as HTMLInputElement

beforeEach(() => {
  handleChange.mockClear()
  listOrgTemplateRepos.mockReset()
  listOrgTemplateRepos.mockResolvedValue(listResult())
})

afterEach(cleanup)

describe("TemplateRepoPicker", () => {
  it("does not load the org's repos until the picker is opened", () => {
    renderPicker()
    // Listing an org is many requests; an idle form must not pay for them.
    expect(listOrgTemplateRepos).not.toHaveBeenCalled()
  })

  it("lists the org's templates on open", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    await waitFor(() => expect(listOrgTemplateRepos).toHaveBeenCalled())
    expect(listOrgTemplateRepos.mock.calls[0][0]).toMatchObject({ org: ORG })
    expect(await screen.findByText("cs50/starter")).toBeTruthy()
  })

  it("writes the selected repo's owner/repo into the field", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())
    await user.click(await screen.findByText("cs50/ap-cs"))

    expect(handleChange).toHaveBeenCalledWith("cs50/ap-cs")
  })

  it("filters locally as the teacher types, without re-fetching", async () => {
    const user = userEvent.setup()
    renderStateful()

    await user.click(input())
    await screen.findByText("cs50/starter")
    await user.type(input(), "ap")

    await waitFor(() => expect(screen.queryByText("cs50/starter")).toBeNull())
    expect(screen.getByText("cs50/ap-cs")).toBeTruthy()
    // The whole point of listing once: narrowing costs no requests.
    expect(listOrgTemplateRepos).toHaveBeenCalledTimes(1)
  })

  it("marks a private template so a teacher knows students need a grant", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    expect(
      await screen.findByLabelText("assignments.template.search.privateRepo"),
    ).toBeTruthy()
  })

  it("says how many of the org's templates are currently shown", async () => {
    const user = userEvent.setup()
    renderStateful()

    await user.click(input())
    await screen.findByText("cs50/starter")
    await user.type(input(), "ap")

    const footer = await screen.findByText(
      /assignments\.template\.search\.showing/,
    )
    expect(footer.textContent).toContain('"shown":1')
    expect(footer.textContent).toContain('"total":2')
  })

  it("omits the count when every template is shown", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())
    await screen.findByText("cs50/starter")

    expect(
      screen.queryByText(/assignments\.template\.search\.showing/),
    ).toBeNull()
  })

  it("discloses that the org was too large to list fully", async () => {
    listOrgTemplateRepos.mockResolvedValue(
      listResult({ truncated: true, scanned: 1000 }),
    )
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    const note = await screen.findByText(
      /assignments\.template\.search\.truncated/,
    )
    expect(note.textContent).toContain("1000")
  })

  it("offers manual entry when the listing fails", async () => {
    listOrgTemplateRepos.mockRejectedValue(new Error("boom"))
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    expect(
      await screen.findByText("assignments.template.search.unavailable"),
    ).toBeTruthy()
    expect(
      screen.getByText("assignments.template.search.typeInstead"),
    ).toBeTruthy()
  })

  it("shows the no-matches hint naming the query", async () => {
    const user = userEvent.setup()
    renderStateful()

    await user.click(input())
    await screen.findByText("cs50/starter")
    await user.type(input(), "nope")

    const empty = await screen.findByText(
      /assignments\.template\.search\.noMatches/,
    )
    expect(empty.textContent).toContain("nope")
  })

  it("discloses when GitHub never said which repos are templates", async () => {
    // The list is unfiltered in that case, so the teacher must be told rather
    // than shown every org repo as if it were a template.
    listOrgTemplateRepos.mockResolvedValue(
      listResult({ templateFlagPresent: false }),
    )
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    expect(
      await screen.findByText("assignments.template.search.unfiltered"),
    ).toBeTruthy()
  })

  it("says nothing about filtering when GitHub did report templates", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())
    await screen.findByText("cs50/starter")

    expect(
      screen.queryByText("assignments.template.search.unfiltered"),
    ).toBeNull()
  })

  it("shows the no-templates hint when the org has none", async () => {
    listOrgTemplateRepos.mockResolvedValue(listResult({ items: [] }))
    const user = userEvent.setup()
    renderPicker()

    await user.click(input())

    expect(
      await screen.findByText("assignments.template.search.noTemplates"),
    ).toBeTruthy()
  })

  it("never lists without an org", async () => {
    const user = userEvent.setup()
    renderPicker({ org: undefined })

    await user.click(input())

    expect(listOrgTemplateRepos).not.toHaveBeenCalled()
  })

  it("keeps hand-typing working, reporting each keystroke to the form", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.type(input(), "a")

    expect(handleChange).toHaveBeenCalledWith("a")
  })
})

describe("TemplateRepoPicker — verified normalization", () => {
  it("does not rewrite an untouched field, so opening an edit form stays clean", async () => {
    // Mounting with a stored ref must not dirty the form; only an edit should.
    renderPicker({ value: "cs50/starter", canonicalRef: "cs50/Starter" })

    await waitFor(() => expect(handleChange).not.toHaveBeenCalled())
  })

  it("rewrites to the confirmed canonical ref after the teacher edits and blurs", async () => {
    const user = userEvent.setup()
    render(
      createElement(
        "div",
        null,
        createElement(StatefulPicker, { canonicalRef: "cs50/starter" }),
        createElement("button", { type: "button" }, "elsewhere"),
      ),
      { wrapper: queryWrapper() },
    )

    await user.click(input())
    await user.type(input(), "starter")
    handleChange.mockClear()
    await user.click(screen.getByRole("button", { name: "elsewhere" }))

    await waitFor(() =>
      expect(handleChange).toHaveBeenCalledWith("cs50/starter"),
    )
  })

  it("does not rewrite while the teacher is still typing", async () => {
    const user = userEvent.setup()
    renderStateful({ canonicalRef: "cs50/starter" })

    await user.click(input())
    await user.type(input(), "starter")
    handleChange.mockClear()

    // Focused: rewriting here would fight the cursor.
    expect(handleChange).not.toHaveBeenCalledWith("cs50/starter")
  })

  it("leaves the text alone when nothing was confirmed", async () => {
    renderPicker({ canonicalRef: null })

    await waitFor(() => expect(handleChange).not.toHaveBeenCalled())
  })
})
