// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

import FreePlanInfoModal from "./FreePlanInfoModal"

afterEach(cleanup)

describe("FreePlanInfoModal", () => {
  it("renders the org login and the GitHub Education link", () => {
    render(<FreePlanInfoModal open orgLogin="acme" onClose={vi.fn()} />)
    expect(screen.getByText("acme")).toBeTruthy()
    const link = screen
      .getByText("orgs.newOrg.freePlanInfo.educationCta")
      .closest("a")
    expect(link?.getAttribute("href")).toBe("https://github.com/education")
    expect(link?.getAttribute("target")).toBe("_blank")
  })

  it("omits the org-name line when orgLogin is null", () => {
    render(<FreePlanInfoModal open orgLogin={null} onClose={vi.fn()} />)
    // The plan-requirement body still renders; only the mono org name is gone.
    expect(screen.getByText("orgs.newOrg.freePlanInfo.body")).toBeTruthy()
    expect(screen.queryByText("acme")).toBeNull()
  })

  it("calls onClose when the dismiss button is clicked", () => {
    const onClose = vi.fn()
    render(<FreePlanInfoModal open orgLogin="acme" onClose={onClose} />)
    fireEvent.click(screen.getByText("orgs.newOrg.freePlanInfo.dismiss"))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
