// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState, type ReactNode } from "react"

// Importing the shared helper also registers the `toHaveNoViolations` matcher.
import { renderAndAxe } from "@/test/axe"
import { Combobox } from "./Combobox"

afterEach(cleanup)

type Repo = { id: string; label: string }

const REPOS: Repo[] = [
  { id: "1", label: "starter" },
  { id: "2", label: "starter-python" },
  { id: "3", label: "starter-c" },
]

// A controlled host, since Combobox owns neither the text nor the open state —
// these tests must prove it delegates both rather than shadowing them.
function Harness({
  items = REPOS,
  onSelect = () => {},
  initialValue = "",
  ...rest
}: {
  items?: Repo[]
  onSelect?: (item: Repo) => void
  initialValue?: string
  emptyState?: ReactNode
  footer?: ReactNode
  status?: ReactNode
}) {
  const [value, setValue] = useState(initialValue)
  const [open, setOpen] = useState(false)
  return (
    <Combobox
      id="tmpl"
      label="Template repository"
      value={value}
      onInputChange={setValue}
      open={open}
      onOpenChange={setOpen}
      items={items}
      getItemKey={(item) => item.id}
      getItemLabel={(item) => item.label}
      renderItem={(item) => <span>{item.label}</span>}
      onSelect={onSelect}
      {...rest}
    />
  )
}

const comboboxInput = () => screen.getByRole("combobox") as HTMLInputElement

describe("Combobox", () => {
  it("exposes the combobox role and collapsed state before opening", () => {
    render(<Harness />)
    expect(comboboxInput().getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("opens on focus and lists the items", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(comboboxInput())

    expect(comboboxInput().getAttribute("aria-expanded")).toBe("true")
    expect(screen.getAllByRole("option")).toHaveLength(3)
  })

  it("reports typing to the caller instead of owning the text", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(comboboxInput(), "sta")

    // The value only changed because the harness fed it back.
    expect(comboboxInput().value).toBe("sta")
  })

  it("moves the active option with ArrowDown and marks it via aria-activedescendant", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(comboboxInput())
    await user.keyboard("{ArrowDown}")

    const first = screen.getAllByRole("option")[0]
    expect(comboboxInput().getAttribute("aria-activedescendant")).toBe(first.id)
    expect(first.getAttribute("aria-selected")).toBe("true")
  })

  it("wraps from the last option to the first", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(comboboxInput())
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}")

    expect(comboboxInput().getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[0].id,
    )
  })

  it("wraps backwards from the first option to the last with ArrowUp", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(comboboxInput())
    await user.keyboard("{ArrowUp}")

    const options = screen.getAllByRole("option")
    expect(comboboxInput().getAttribute("aria-activedescendant")).toBe(
      options[options.length - 1].id,
    )
  })

  it("selects the active option on Enter", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)

    await user.click(comboboxInput())
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}")

    expect(onSelect).toHaveBeenCalledWith(REPOS[1])
  })

  it("does not select on Enter when no option is active", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)

    await user.click(comboboxInput())
    await user.keyboard("{Enter}")

    // Enter with nothing active must do nothing, never guess the first row — a
    // teacher who typed a full ref would otherwise get a different repo.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("selects on click", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)

    await user.click(comboboxInput())
    await user.click(screen.getByText("starter-c"))

    expect(onSelect).toHaveBeenCalledWith(REPOS[2])
  })

  it("closes on Escape and keeps the typed text", async () => {
    const user = userEvent.setup()
    render(<Harness initialValue="sta" />)

    await user.click(comboboxInput())
    await user.keyboard("{Escape}")

    expect(screen.queryByRole("listbox")).toBeNull()
    expect(comboboxInput().value).toBe("sta")
  })

  it("resets the active option when reopened so Enter can't fire a stale row", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)

    await user.click(comboboxInput())
    await user.keyboard("{ArrowDown}{Escape}")
    await user.click(comboboxInput())
    await user.keyboard("{Enter}")

    expect(onSelect).not.toHaveBeenCalled()
  })

  it("closes when focus leaves the widget", async () => {
    const user = userEvent.setup()
    render(
      <>
        <Harness />
        <button type="button">elsewhere</button>
      </>,
    )

    await user.click(comboboxInput())
    expect(screen.getByRole("listbox")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "elsewhere" }))

    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("renders the empty state rather than an empty listbox", async () => {
    const user = userEvent.setup()
    render(<Harness items={[]} emptyState={<span>No templates</span>} />)

    await user.click(comboboxInput())

    expect(screen.getByText("No templates")).toBeTruthy()
    expect(screen.queryByRole("option")).toBeNull()
  })

  it("renders the footer and status slots when open", async () => {
    const user = userEvent.setup()
    render(
      <Harness
        footer={<span>30 of 4213</span>}
        status={<span>Searching</span>}
      />,
    )

    await user.click(comboboxInput())

    expect(screen.getByText("30 of 4213")).toBeTruthy()
    expect(screen.getByText("Searching")).toBeTruthy()
  })

  it("does not clip the panel, which would truncate it inside a card", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)

    await user.click(comboboxInput())

    expect(container.querySelector(".overflow-hidden")).toBeNull()
  })

  it("drops the highlight when the active row leaves the result set", async () => {
    // A debounced search resolving mid-navigation must not leave Enter pointed
    // at whatever row slid into that position.
    const user = userEvent.setup()
    const onSelect = vi.fn()

    function Swapping() {
      const [items, setItems] = useState(REPOS)
      return (
        <>
          <Harness items={items} onSelect={onSelect} />
          <button
            type="button"
            onClick={() => setItems([{ id: "9", label: "other" }])}
          >
            new results
          </button>
        </>
      )
    }

    render(<Swapping />)
    await user.click(comboboxInput())
    await user.keyboard("{ArrowDown}")
    await user.click(screen.getByRole("button", { name: "new results" }))

    expect(comboboxInput().getAttribute("aria-activedescendant")).toBeNull()
  })

  it("has no axe violations closed", async () => {
    const { results } = await renderAndAxe(<Harness />)
    expect(results).toHaveNoViolations()
  })

  it("has no axe violations open", async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    await user.click(comboboxInput())
    const { axe } = await import("vitest-axe")
    expect(await axe(container)).toHaveNoViolations()
  })
})
