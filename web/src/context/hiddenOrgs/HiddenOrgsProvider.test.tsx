// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { HiddenOrgsProvider, useHiddenOrgs } from "./HiddenOrgsProvider"
import { HIDDEN_ORGS_STORAGE_KEY } from "@/lib/hiddenOrgsStore"

// happy-dom (v15) doesn't back window.localStorage here, so install a minimal
// in-memory store — the same shape the useTheme / unresolvedStore tests use.
function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size
      },
    },
    configurable: true,
  })
}

beforeEach(installLocalStorage)
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <HiddenOrgsProvider>{children}</HiddenOrgsProvider>
)

describe("HiddenOrgsProvider", () => {
  it("hides an org and reports it as hidden, persisting to storage", () => {
    const { result } = renderHook(useHiddenOrgs, { wrapper })
    act(() => result.current.hide("acme"))
    expect(result.current.isHidden("acme")).toBe(true)
    expect(result.current.hidden).toEqual(new Set(["acme"]))
    expect(window.localStorage.getItem(HIDDEN_ORGS_STORAGE_KEY)).toContain(
      "acme",
    )
  })

  it("unhides only the target org", () => {
    const { result } = renderHook(useHiddenOrgs, { wrapper })
    act(() => {
      result.current.hide("acme")
      result.current.hide("globex")
    })
    act(() => result.current.unhide("acme"))
    expect(result.current.isHidden("acme")).toBe(false)
    expect(result.current.isHidden("globex")).toBe(true)
  })

  it("seeds initial state from storage", () => {
    window.localStorage.setItem(
      HIDDEN_ORGS_STORAGE_KEY,
      JSON.stringify(["seeded"]),
    )
    const { result } = renderHook(useHiddenOrgs, { wrapper })
    expect(result.current.isHidden("seeded")).toBe(true)
  })

  it("hiding the same org twice is idempotent", () => {
    const { result } = renderHook(useHiddenOrgs, { wrapper })
    act(() => result.current.hide("acme"))
    act(() => result.current.hide("acme"))
    expect(result.current.hidden).toEqual(new Set(["acme"]))
  })
})
