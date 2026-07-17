// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"

import { Toolbar } from "./Toolbar"

afterEach(cleanup)

describe("Toolbar shell", () => {
  it("renders the filter-bar container recipe by default", () => {
    render(
      <Toolbar data-testid="bar">
        <span>x</span>
      </Toolbar>,
    )
    const cls = screen.getByTestId("bar").className
    expect(cls).toContain("flex")
    expect(cls).toContain("flex-wrap")
    expect(cls).toContain("items-center")
    expect(cls).toContain("gap-2")
    expect(cls).not.toContain("border-b")
  })

  it("merges a caller className with the default recipe", () => {
    render(
      <Toolbar data-testid="bar" className="mt-6">
        <span>x</span>
      </Toolbar>,
    )
    const cls = screen.getByTestId("bar").className
    expect(cls).toContain("gap-2")
    expect(cls).toContain("mt-6")
  })

  it("lets a caller gap override the default gap-2", () => {
    render(
      <Toolbar data-testid="bar" className="gap-3">
        <span>x</span>
      </Toolbar>,
    )
    const cls = screen.getByTestId("bar").className
    expect(cls).not.toContain("gap-2")
    expect(cls).toContain("gap-3")
  })

  it("switches to the header chrome and wider gap when header is set", () => {
    render(
      <Toolbar data-testid="bar" header>
        <span>x</span>
      </Toolbar>,
    )
    const cls = screen.getByTestId("bar").className
    expect(cls).toContain("border-b")
    expect(cls).toContain("border-base-300")
    expect(cls).toContain("px-6")
    expect(cls).toContain("py-3")
    expect(cls).toContain("gap-x-4")
    expect(cls).toContain("gap-y-3")
    expect(cls).not.toContain("gap-2")
  })
})

describe("Toolbar.Search", () => {
  it("renders a bordered search input with the label on the inner input", () => {
    render(
      <Toolbar.Search
        value=""
        onChange={() => {}}
        ariaLabel="Search"
        placeholder="Find"
      />,
    )
    const input = screen.getByLabelText("Search")
    expect(input.getAttribute("type")).toBe("search")
    expect(input.getAttribute("placeholder")).toBe("Find")
    // leadingIcon: the input is a bare grower, the label owns the border + width.
    const label = input.closest("label")!
    expect(label.className).toContain("input-bordered")
    expect(label.className).toContain("input-sm")
  })

  it("fires onChange with the raw string value", () => {
    const onChange = vi.fn()
    render(<Toolbar.Search value="" onChange={onChange} ariaLabel="Search" />)
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "abc" },
    })
    expect(onChange).toHaveBeenCalledWith("abc")
  })

  it("lets a caller width override the default and applies inputSize", () => {
    render(
      <Toolbar.Search
        value=""
        onChange={() => {}}
        ariaLabel="Search"
        inputSize="md"
        className="w-full sm:max-w-xs"
      />,
    )
    const label = screen.getByLabelText("Search").closest("label")!
    expect(label.className).toContain("w-full")
    expect(label.className).not.toContain("min-w-[12rem]")
    // md maps to no size modifier.
    expect(label.className).not.toContain("input-sm")
  })

  it("suppresses the default w-full when a caller passes w-auto with flex utilities", () => {
    render(
      <Toolbar.Search
        value=""
        onChange={() => {}}
        ariaLabel="Search"
        inputSize="md"
        className="w-auto min-w-0 flex-1"
      />,
    )
    const label = screen.getByLabelText("Search").closest("label")!
    expect(label.className).not.toContain("w-full")
    expect(label.className).toContain("w-auto")
    expect(label.className).toContain("flex-1")
  })

  it("applies an icon className override", () => {
    const { container } = render(
      <Toolbar.Search
        value=""
        onChange={() => {}}
        ariaLabel="Search"
        iconClassName="opacity-50"
      />,
    )
    const icon = container.querySelector("svg")!
    expect(icon.getAttribute("class")).toContain("opacity-50")
  })
})

describe("Toolbar.FilterSelect", () => {
  it("renders a labelled join select with the prefix", () => {
    render(
      <Toolbar.FilterSelect
        label="Type"
        aria-label="Type filter"
        value="all"
        onChange={() => {}}
      >
        <option value="all">All</option>
        <option value="a" disabled>
          A
        </option>
      </Toolbar.FilterSelect>,
    )
    const select = screen.getByLabelText("Type filter")
    expect(select.className).toContain("join-item")
    expect(screen.getByText("Type")).not.toBeNull()
    // Per-option disabled state rides through the wrapper.
    const opt = screen.getByText("A") as HTMLOptionElement
    expect(opt.disabled).toBe(true)
  })

  it("renders a bare select with no prefix or join when label is absent", () => {
    render(
      <Toolbar.FilterSelect aria-label="Status" value="all" onChange={() => {}}>
        <option value="all">All</option>
      </Toolbar.FilterSelect>,
    )
    const select = screen.getByLabelText("Status")
    expect(select.className).not.toContain("join-item")
    // No LabeledControl join wrapper.
    expect(select.closest(".join")).toBeNull()
  })

  it("lets a caller width override the default on the label-less variant", () => {
    render(
      <Toolbar.FilterSelect
        aria-label="Status"
        value="all"
        onChange={() => {}}
        selectSize="md"
        className="w-full sm:w-auto"
      >
        <option value="all">All</option>
      </Toolbar.FilterSelect>,
    )
    const select = screen.getByLabelText("Status")
    expect(select.className).toContain("w-full")
    expect(select.className).not.toContain("select-sm")
  })
})

describe("Toolbar.Trailing", () => {
  it("renders an ms-auto group with children", () => {
    render(
      <Toolbar.Trailing data-testid="tr">
        <button>Go</button>
      </Toolbar.Trailing>,
    )
    expect(screen.getByTestId("tr").className).toContain("ms-auto")
  })

  it("renders nothing when it has no children", () => {
    const { container } = render(<Toolbar.Trailing>{null}</Toolbar.Trailing>)
    expect(container.firstChild).toBeNull()
  })
})

describe("Toolbar.Selection", () => {
  const base = {
    onToggleSelectAll: () => {},
    selectAllAriaLabel: "Select all",
    label: "3 selected",
  }

  it("reflects allSelected and fires onToggleSelectAll", () => {
    const onToggle = vi.fn()
    render(
      <Toolbar.Selection
        {...base}
        allSelected
        someSelected={false}
        onToggleSelectAll={onToggle}
      />,
    )
    const checkbox = screen.getByLabelText("Select all") as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(onToggle).toHaveBeenCalled()
    expect(screen.getByText("3 selected")).not.toBeNull()
  })

  it("sets indeterminate when partially selected", () => {
    render(<Toolbar.Selection {...base} allSelected={false} someSelected />)
    const checkbox = screen.getByLabelText("Select all") as HTMLInputElement
    expect(checkbox.indeterminate).toBe(true)
  })

  it("shows children (selected actions) and hides idleActions when selected", () => {
    render(
      <Toolbar.Selection
        {...base}
        allSelected={false}
        someSelected
        aux={<span>aux-toggle</span>}
        idleActions={<span>idle-actions</span>}
      >
        <button>Remove</button>
      </Toolbar.Selection>,
    )
    expect(screen.getByText("Remove")).not.toBeNull()
    expect(screen.getByText("aux-toggle")).not.toBeNull()
    expect(screen.queryByText("idle-actions")).toBeNull()
  })

  it("shows idleActions and aux when nothing is selected", () => {
    render(
      <Toolbar.Selection
        {...base}
        label="10 members"
        allSelected={false}
        someSelected={false}
        aux={<span>aux-toggle</span>}
        idleActions={<span>idle-actions</span>}
      />,
    )
    expect(screen.getByText("idle-actions")).not.toBeNull()
    expect(screen.getByText("aux-toggle")).not.toBeNull()
  })
})
