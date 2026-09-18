// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useSyncExternalStore } from "react"

import { LoginLanguageMenu } from "./LoginLanguageMenu"

// The registry mock is a real external store, like the hook it replaces: the
// menu rows live in a child that owns the hook call, and under the React
// Compiler a re-render of the root does not reach a child whose props did not
// change. Only a subscription (as in production) re-renders it.
let registry = { refreshing: false, refreshed: false }
const listeners = new Set<() => void>()
const setRegistry = (next: Partial<typeof registry>) =>
  act(() => {
    registry = { ...registry, ...next }
    listeners.forEach((listener) => listener())
  })
const refresh = vi.fn(async () => null)

vi.mock("@/hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "en",
    availableLangs: ["en"],
    setLang: vi.fn(),
  }),
}))

vi.mock("@/hooks/useLanguageRegistry", () => ({
  useLanguageRegistry: () => {
    const { refreshing, refreshed } = useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => registry,
    )
    return {
      offered: [{ code: "ca" }],
      loading: false,
      refreshing,
      refreshed,
      error: false,
      loadRegistry: vi.fn(),
      refresh,
      installAndActivate: vi.fn(),
    }
  },
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe("LoginLanguageMenu refresh row", () => {
  afterEach(() => {
    cleanup()
    registry = { refreshing: false, refreshed: false }
    refresh.mockClear()
  })

  const refreshButton = () =>
    screen.getByRole("button", { name: /language\.refresh/ })

  it("never takes the disabled attribute while refreshing, so focus stays in the menu and it does not close", () => {
    render(<LoginLanguageMenu />)
    const button = refreshButton()
    button.focus()
    fireEvent.click(button)
    expect(refresh).toHaveBeenCalledTimes(1)

    setRegistry({ refreshing: true })

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
    registry = { refreshing: true, refreshed: false }
    render(<LoginLanguageMenu />)
    fireEvent.click(refreshButton())
    expect(refresh).not.toHaveBeenCalled()

    setRegistry({ refreshing: false, refreshed: true })
    expect(
      screen.getByRole("button", { name: "language.refreshDone" }),
    ).toBeTruthy()
  })
})
