// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

import {
  BannerStackProvider,
  useBannerSlot,
  type BannerId,
} from "./BannerStackProvider"

afterEach(cleanup)

function FakeBanner({ id, visible }: { id: BannerId; visible: boolean }) {
  const granted = useBannerSlot(id, visible)
  return granted ? <div data-testid={`banner-${id}`} /> : null
}

describe("BannerStackProvider", () => {
  it("caps visible banners at two, by priority", () => {
    render(
      <BannerStackProvider>
        <FakeBanner id="offline" visible />
        <FakeBanner id="scope-warning" visible />
        <FakeBanner id="budget-created" visible />
      </BannerStackProvider>,
    )
    expect(screen.getByTestId("banner-offline")).toBeTruthy()
    expect(screen.getByTestId("banner-scope-warning")).toBeTruthy()
    // Third claimant waits for a slot.
    expect(screen.queryByTestId("banner-budget-created")).toBeNull()
  })

  it("slides the next claimant in when a higher-priority banner clears", () => {
    const view = render(
      <BannerStackProvider>
        <FakeBanner id="offline" visible />
        <FakeBanner id="scope-warning" visible />
        <FakeBanner id="budget-created" visible />
      </BannerStackProvider>,
    )
    view.rerender(
      <BannerStackProvider>
        <FakeBanner id="offline" visible={false} />
        <FakeBanner id="scope-warning" visible />
        <FakeBanner id="budget-created" visible />
      </BannerStackProvider>,
    )
    expect(screen.queryByTestId("banner-offline")).toBeNull()
    expect(screen.getByTestId("banner-scope-warning")).toBeTruthy()
    expect(screen.getByTestId("banner-budget-created")).toBeTruthy()
  })

  it("grants the wish outside a provider (isolated banner tests)", () => {
    render(<FakeBanner id="budget-created" visible />)
    expect(screen.getByTestId("banner-budget-created")).toBeTruthy()
  })
})
