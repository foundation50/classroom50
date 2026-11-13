// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { createElement, type PropsWithChildren } from "react"

import {
  ActionActivityProvider,
  useActionActivityRegistry,
} from "./ActionActivityProvider"

const wrapper = ({ children }: PropsWithChildren) =>
  createElement(ActionActivityProvider, null, children)

const renderRegistry = () =>
  renderHook(() => useActionActivityRegistry(), { wrapper })

describe("ActionActivityProvider", () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it("keeps a dismissed discovered run hidden across a new registration", () => {
    const { result } = renderRegistry()
    act(() => result.current.dismissRun(42))
    expect(result.current.isRunDismissed(42)).toBe(true)

    // register() prunes op dismissals against live ops; a run dismissal has no
    // op and must not be pruned with them.
    act(() => {
      result.current.register({
        org: "acme",
        label: "Collecting scores",
        anchor: { kind: "sinceRunId", workflow: "collect.yaml", sinceRunId: 1 },
      })
    })
    expect(result.current.isRunDismissed(42)).toBe(true)
    expect(result.current.isRunDismissed(43)).toBe(false)
  })

  it("persists dismissed runs in sessionStorage for the next mount", () => {
    const first = renderRegistry()
    act(() => first.result.current.dismissRun(42))
    first.unmount()

    const second = renderRegistry()
    expect(second.result.current.isRunDismissed(42)).toBe(true)
  })

  it("tolerates a persisted state written before dismissedRuns existed", () => {
    sessionStorage.setItem(
      "cl50:action-activity",
      JSON.stringify({ ops: [], dismissed: [] }),
    )
    const { result } = renderRegistry()
    expect(result.current.isRunDismissed(42)).toBe(false)
    act(() => result.current.dismissRun(42))
    expect(result.current.isRunDismissed(42)).toBe(true)
  })
})
