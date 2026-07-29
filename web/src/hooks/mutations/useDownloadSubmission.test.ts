// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

const fetchRepoArchive =
  vi.fn<
    (
      ...args: unknown[]
    ) => Promise<{ bytes: ArrayBuffer; filename: string } | null>
  >()
const downloadBlob = vi.fn<(blob: Blob, filename: string) => void>()
const supportsSaveFilePicker = vi.fn<() => boolean>()
const pickSaveFile =
  vi.fn<(name: string) => Promise<FileSystemFileHandle | null>>()
const writeToFileHandle =
  vi.fn<(h: FileSystemFileHandle, d: BlobPart) => Promise<void>>()

vi.mock("@/github-core/repoArchiveReads", () => ({
  fetchRepoArchive: (...args: unknown[]) => fetchRepoArchive(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/util/downloadBlob", () => ({
  downloadBlob: (blob: Blob, filename: string) => downloadBlob(blob, filename),
}))
vi.mock("@/util/fileSystemAccess", () => ({
  supportsSaveFilePicker: () => supportsSaveFilePicker(),
  pickSaveFile: (name: string) => pickSaveFile(name),
  writeToFileHandle: (h: FileSystemFileHandle, d: BlobPart) =>
    writeToFileHandle(h, d),
}))

import { useDownloadSubmission } from "./useDownloadSubmission"

const bytes = new Uint8Array([80, 75]).buffer

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } })
}

const input = {
  org: "cs50",
  classroom: "cs101",
  assignment: "hw1",
  owner: "alice",
}

beforeEach(() => {
  vi.clearAllMocks()
  supportsSaveFilePicker.mockReturnValue(false)
  fetchRepoArchive.mockResolvedValue({ bytes, filename: "x.zip" })
})

describe("useDownloadSubmission", () => {
  it("auto-downloads with the derived filename when the picker is unsupported", async () => {
    const { result } = renderHook(() => useDownloadSubmission(), {
      wrapper: wrapperWith(freshClient()),
    })

    result.current.mutate(input)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(pickSaveFile).not.toHaveBeenCalled()
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      "cs101-hw1-alice.zip",
    )
  })

  it("writes to the picked file handle when supported", async () => {
    supportsSaveFilePicker.mockReturnValue(true)
    const handle = {} as FileSystemFileHandle
    pickSaveFile.mockResolvedValue(handle)
    const { result } = renderHook(() => useDownloadSubmission(), {
      wrapper: wrapperWith(freshClient()),
    })

    result.current.mutate(input)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(pickSaveFile).toHaveBeenCalledWith("cs101-hw1-alice.zip")
    expect(writeToFileHandle).toHaveBeenCalledWith(handle, bytes)
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it("no-ops (no fetch) when the save picker is cancelled", async () => {
    supportsSaveFilePicker.mockReturnValue(true)
    pickSaveFile.mockResolvedValue(null)
    const { result } = renderHook(() => useDownloadSubmission(), {
      wrapper: wrapperWith(freshClient()),
    })

    result.current.mutate(input)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(fetchRepoArchive).not.toHaveBeenCalled()
    expect(writeToFileHandle).not.toHaveBeenCalled()
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it("throws no-submission for a missing/empty repo", async () => {
    supportsSaveFilePicker.mockReturnValue(false)
    fetchRepoArchive.mockResolvedValue(null)
    const { result } = renderHook(() => useDownloadSubmission(), {
      wrapper: wrapperWith(freshClient()),
    })

    result.current.mutate(input)
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe("no-submission")
  })
})
