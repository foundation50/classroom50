// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query"

import { KeepTabOpenGuard } from "./KeepTabOpenGuard"

// Fires one mutation on mount that settles only when the test resolves `run`,
// flagged (or not) with the tab-hold meta the guard reads.
const Writer = ({ flagged, run }: { flagged: boolean; run: Promise<void> }) => {
  const { mutate } = useMutation({
    ...(flagged ? { meta: { keepTabOpen: true } } : {}),
    mutationFn: () => run,
  })
  useEffect(() => mutate(), [mutate])
  return null
}

const deferred = () => {
  let finish = () => {}
  const run = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { run, finish }
}

const fire = () => {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

const mount = (flagged: boolean) => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const { run, finish } = deferred()
  const view = render(
    <QueryClientProvider client={client}>
      <KeepTabOpenGuard />
      <Writer flagged={flagged} run={run} />
    </QueryClientProvider>,
  )
  return { client, finish, view }
}

afterEach(cleanup)

describe("KeepTabOpenGuard", () => {
  it("blocks beforeunload only while a keepTabOpen mutation is pending", async () => {
    const { client, finish } = mount(true)
    await waitFor(() => expect(client.isMutating()).toBe(1))
    expect(fire()).toBe(true)

    act(finish)
    await waitFor(() => expect(fire()).toBe(false))
  })

  it("ignores a pending mutation without the flag", async () => {
    const { client, finish } = mount(false)
    await waitFor(() => expect(client.isMutating()).toBe(1))
    expect(fire()).toBe(false)
    act(finish)
  })

  it("keeps holding after the component that started the write unmounts", async () => {
    const { client, finish, view } = mount(true)
    await waitFor(() => expect(fire()).toBe(true))

    // In-app navigation unmounts the page, not the mutation: the chain is still
    // running in the cache, so the hold must stay.
    view.rerender(
      <QueryClientProvider client={client}>
        <KeepTabOpenGuard />
      </QueryClientProvider>,
    )
    expect(client.isMutating()).toBe(1)
    expect(fire()).toBe(true)

    act(finish)
    await waitFor(() => expect(fire()).toBe(false))
  })
})
