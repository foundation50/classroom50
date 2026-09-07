// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

import { LoginLanguageMenu } from "./LoginLanguageMenu"

let refreshing = false
let refreshed = false
const refresh = vi.fn(async () => null)

vi.mock("@/hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "en",
    availableLangs: ["en"],
    setLang: vi.fn(),
  }),
}))

vi.mock("@/hooks/useLanguageRegistry", () => ({
  useLanguageRegistry: () => ({
    offered: [{ code: "ca" }],
    loading: false,
    get refreshing() {
      return refreshing
    },
    get refreshed() {
      return refreshed
    },
    error: false,
    loadRegistry: vi.fn(),
    refresh,
    installAndActivate: vi.fn(),
  }),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe("LoginLanguageMenu refresh row", () => {
  afterEach(() => {
    cleanup()
    refreshing = false
    refreshed = false
    refresh.mockClear()
  })

  const refreshButton = () =>
    screen.getByRole("button", { name: /language\.refresh/ })

  it("never takes the disabled attribute while refreshing, so the focus-driven menu stays open", () => {
    const { rerender } = render(<LoginLanguageMenu />)
    const button = refreshButton()
    button.focus()
    fireEvent.click(button)
    expect(refresh).toHaveBeenCalledTimes(1)

    refreshing = true
    rerender(<LoginLanguageMenu />)

    // A disabled element loses focus, which is what closed the menu. The row
    // and the language items go inert via aria-disabled instead.
    const busy = refreshButton()
    expect(busy.hasAttribute("disabled")).toBe(false)
    expect(busy.getAttribute("aria-disabled")).toBe("true")
    expect(document.activeElement).toBe(busy)
    for (const item of screen.getAllByRole("button")) {
      expect(item.hasAttribute("disabled")).toBe(false)
    }
  })

  it("ignores clicks while inert and shows the done state afterwards", () => {
    refreshing = true
    const { rerender } = render(<LoginLanguageMenu />)
    fireEvent.click(refreshButton())
    expect(refresh).not.toHaveBeenCalled()

    refreshing = false
    refreshed = true
    act(() => rerender(<LoginLanguageMenu />))
    expect(
      screen.getByRole("button", { name: "language.refreshDone" }),
    ).toBeTruthy()
  })
})
