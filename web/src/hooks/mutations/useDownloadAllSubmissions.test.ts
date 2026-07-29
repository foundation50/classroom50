// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import type { DownloadAllSummary } from "@/domain/assignments"

const downloadAllSubmissions =
  vi.fn<
    (...args: unknown[]) => Promise<{ blob: Blob; summary: DownloadAllSummary }>
  >()
const streamSubmissionsToDirectory =
  vi.fn<(...args: unknown[]) => Promise<DownloadAllSummary>>()
const downloadBlob = vi.fn<(blob: Blob, filename: string) => void>()
const supportsDirectoryPicker = vi.fn<() => boolean>()
const pickDirectory = vi.fn<() => Promise<FileSystemDirectoryHandle | null>>()

vi.mock("@/domain/assignments", () => ({
  downloadAllSubmissions: (...args: unknown[]) =>
    downloadAllSubmissions(...args),
  streamSubmissionsToDirectory: (...args: unknown[]) =>
    streamSubmissionsToDirectory(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/util/downloadBlob", () => ({
  downloadBlob: (blob: Blob, filename: string) => downloadBlob(blob, filename),
}))
vi.mock("@/util/fileSystemAccess", () => ({
  supportsDirectoryPicker: () => supportsDirectoryPicker(),
  pickDirectory: () => pickDirectory(),
}))

import { useDownloadAllSubmissions } from "./useDownloadAllSubmissions"

const ORG = "cs50"

const summary = (
  over: Partial<DownloadAllSummary> = {},
): DownloadAllSummary => ({
  total: 2,
  fetched: 2,
  empty: [],
  failed: [],
  results: [],
  ...over,
})

const result = (over: Partial<DownloadAllSummary> = {}) => ({
  blob: new Blob(["z"]),
  summary: summary(over),
})

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no File System Access API — the combined-zip fallback path.
  supportsDirectoryPicker.mockReturnValue(false)
})

describe("useDownloadAllSubmissions", () => {
  it("surfaces progress and downloads the combined zip on success", async () => {
    downloadAllSubmissions.mockImplementation(async (...args: unknown[]) => {
      const { onProgress } = args[0] as { onProgress?: (p: unknown) => void }
      onProgress?.({ done: 2, total: 2 })
      return result()
    })
    const queryClient = freshClient()
    const { result: hook } = renderHook(() => useDownloadAllSubmissions(), {
      wrapper: wrapperWith(queryClient),
    })

    hook.current.mutate({
      org: ORG,
      classroom: "cs101",
      assignment: "hw1",
      owners: ["alice", "bob"],
    })
    await waitFor(() => expect(hook.current.isSuccess).toBe(true))

    expect(hook.current.progress).toEqual({ done: 2, total: 2 })
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      "cs101-hw1-submissions.zip",
    )
  })

  it("does not download when nothing was fetched", async () => {
    downloadAllSubmissions.mockResolvedValue(
      result({
        total: 1,
        fetched: 0,
        empty: [{ owner: "a", outcome: "empty" }],
      }),
    )
    const queryClient = freshClient()
    const { result: hook } = renderHook(() => useDownloadAllSubmissions(), {
      wrapper: wrapperWith(queryClient),
    })

    hook.current.mutate({
      org: ORG,
      classroom: "cs101",
      assignment: "hw1",
      owners: ["a"],
    })
    await waitFor(() => expect(hook.current.isSuccess).toBe(true))

    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it("passes org/classroom/assignment/owners to the domain batch", async () => {
    downloadAllSubmissions.mockResolvedValue(result())
    const queryClient = freshClient()
    const { result: hook } = renderHook(() => useDownloadAllSubmissions(), {
      wrapper: wrapperWith(queryClient),
    })

    hook.current.mutate({
      org: ORG,
      classroom: "cs101",
      assignment: "hw1",
      owners: ["alice", "bob"],
    })
    await waitFor(() => expect(hook.current.isSuccess).toBe(true))

    expect(downloadAllSubmissions).toHaveBeenCalledWith(
      expect.objectContaining({
        org: ORG,
        classroom: "cs101",
        assignment: "hw1",
        owners: ["alice", "bob"],
        onProgress: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it("exposes a cancel that aborts the in-flight run's signal", async () => {
    let captured: AbortSignal | undefined
    downloadAllSubmissions.mockImplementation(async (...args: unknown[]) => {
      captured = (args[0] as { signal?: AbortSignal }).signal
      return result()
    })
    const queryClient = freshClient()
    const { result: hook } = renderHook(() => useDownloadAllSubmissions(), {
      wrapper: wrapperWith(queryClient),
    })

    hook.current.mutate({
      org: ORG,
      classroom: "cs101",
      assignment: "hw1",
      owners: ["alice"],
    })
    await waitFor(() => expect(hook.current.isSuccess).toBe(true))
    expect(captured?.aborted).toBe(false)

    hook.current.cancel()
    expect(captured?.aborted).toBe(true)
  })

  it("streams to the picked directory when the API is supported", async () => {
    supportsDirectoryPicker.mockReturnValue(true)
    const dir = {} as FileSystemDirectoryHandle
    pickDirectory.mockResolvedValue(dir)
    streamSubmissionsToDirectory.mockResolvedValue(summary())
    const queryClient = freshClient()
    const { result: hook } = renderHook(() => useDownloadAllSubmissions(), {
      wrapper: wrapperWith(queryClient),
    })

    hook.current.mutate({
      org: ORG,
      classroom: "cs101",
      assignment: "hw1",
      owners: ["alice", "bob"],
    })
    await waitFor(() => expect(hook.current.isSuccess).toBe(true))

    expect(streamSubmissionsToDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: dir,
        signal: expect.any(AbortSignal),
      }),
    )
    // Directory path streams to disk — no combined zip, no auto-download.
    expect(downloadAllSubmissions).not.toHaveBeenCalled()
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(hook.current.data).toEqual({
      status: "done",
      summary: summary(),
      toDirectory: true,
    })
  })

  it("returns cancelled (and does nothing) when the directory picker is dismissed", async () => {
    supportsDirectoryPicker.mockReturnValue(true)
    pickDirectory.mockResolvedValue(null)
    const queryClient = freshClient()
    const { result: hook } = renderHook(() => useDownloadAllSubmissions(), {
      wrapper: wrapperWith(queryClient),
    })

    hook.current.mutate({
      org: ORG,
      classroom: "cs101",
      assignment: "hw1",
      owners: ["alice"],
    })
    await waitFor(() => expect(hook.current.isSuccess).toBe(true))

    expect(hook.current.data).toEqual({ status: "cancelled" })
    expect(streamSubmissionsToDirectory).not.toHaveBeenCalled()
    expect(downloadAllSubmissions).not.toHaveBeenCalled()
  })
})
