// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Card, CardBody, CardTitle, CardActions } from "./Card"

afterEach(cleanup)

// Card is the one surface recipe every panel renders through, so these lock the
// border/shadow/radius toggles and the subcomponent classes.
describe("Card", () => {
  it("renders the default bordered + shadow box recipe", () => {
    const { container } = render(<Card>body</Card>)
    const cls = container.firstElementChild?.className ?? ""
    expect(cls).toContain("card")
    expect(cls).toContain("bg-base-100")
    expect(cls).toContain("border-base-300")
    expect(cls).toContain("shadow-sm")
    expect(cls).not.toContain("rounded-")
  })

  it("drops border and shadow when disabled", () => {
    const { container } = render(
      <Card bordered={false} shadow={false}>
        x
      </Card>,
    )
    const cls = container.firstElementChild?.className ?? ""
    expect(cls).not.toContain("border")
    expect(cls).not.toContain("shadow")
  })

  it("applies the dashed border variant", () => {
    const { container } = render(<Card dashed>x</Card>)
    expect(container.firstElementChild?.className).toContain("border-dashed")
  })

  it("maps the radius prop", () => {
    const { container } = render(<Card radius="2xl">x</Card>)
    expect(container.firstElementChild?.className).toContain("rounded-2xl")
  })

  it("appends the className escape hatch last", () => {
    const { container } = render(<Card className="col-span-12">x</Card>)
    expect(container.firstElementChild?.className.endsWith("col-span-12")).toBe(
      true,
    )
  })

  it("renders the element from the `as` prop", () => {
    const { container } = render(
      <Card as="section" id="settings">
        x
      </Card>,
    )
    const root = container.firstElementChild
    expect(root?.tagName).toBe("SECTION")
    expect(root?.id).toBe("settings")
  })

  it("renders subcomponents with their daisyUI classes", () => {
    render(
      <Card>
        <CardBody>
          <CardTitle>Title</CardTitle>
          <CardActions>
            <button type="button">Do</button>
          </CardActions>
        </CardBody>
      </Card>,
    )
    expect(screen.getByRole("heading", { name: "Title" }).className).toContain(
      "card-title",
    )
    expect(
      screen.getByRole("button", { name: "Do" }).parentElement?.className,
    ).toContain("card-actions")
  })
})
