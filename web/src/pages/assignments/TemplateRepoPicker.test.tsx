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

  it("filters locally without re-fetching as the teacher types", async () => {
    const user = userEvent.setup()
    renderPicker({ value: "ap" })

    await user.click(input())
    await screen.findByText("cs50/ap-cs")

    // The whole point of listing once: narrowing costs no requests.
    expect(screen.queryByText("cs50/starter")).toBeNull()
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
    renderPicker({ value: "ap" })

    await user.click(input())

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
    renderPicker({ value: "nope" })

    await user.click(input())

    const empty = await screen.findByText(
      /assignments\.template\.search\.noMatches/,
    )
    expect(empty.textContent).toContain("nope")
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
  it("rewrites the field to the confirmed canonical ref when unfocused", () => {
    renderPicker({ canonicalRef: "cs50/starter" })

    expect(handleChange).toHaveBeenCalledWith("cs50/starter")
  })

  it("does not rewrite while the teacher is still typing", async () => {
    const user = userEvent.setup()
    // Render focused first, then let the verdict arrive: rewriting mid-typing
    // would fight the cursor.
    const { rerender } = renderPicker()
    await user.click(input())
    handleChange.mockClear()

    rerender(
      createElement(TemplateRepoPicker, {
        field: fakeField("starter"),
        id: "template_repo",
        org: ORG,
        placeholder: "placeholder",
        canonicalRef: "cs50/starter",
      }),
    )

    expect(handleChange).not.toHaveBeenCalledWith("cs50/starter")
  })

  it("rewrites once the field loses focus", async () => {
    const user = userEvent.setup()
    render(
      createElement(
        "div",
        null,
        createElement(TemplateRepoPicker, {
          field: fakeField("starter"),
          id: "template_repo",
          org: ORG,
          placeholder: "placeholder",
          canonicalRef: "cs50/starter",
        }),
        createElement("button", { type: "button" }, "elsewhere"),
      ),
      { wrapper: queryWrapper() },
    )

    await user.click(input())
    handleChange.mockClear()
    await user.click(screen.getByRole("button", { name: "elsewhere" }))

    expect(handleChange).toHaveBeenCalledWith("cs50/starter")
  })

  it("leaves the text alone when nothing was confirmed", () => {
    renderPicker({ canonicalRef: null })

    expect(handleChange).not.toHaveBeenCalled()
  })
})
