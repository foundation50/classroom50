// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key} ${JSON.stringify(vars)}` : key,
    }),
  }
})

const notify = vi.fn()
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify, dismiss: vi.fn() }),
}))

const mutateAsync = vi.fn()
let isPending = false
let isError = false
let error: unknown = null
vi.mock("@/hooks/mutations/useSubmitAssignment", () => ({
  useSubmitAssignment: () => ({ mutateAsync, isPending, isError, error }),
}))

// happy-dom lacks HTMLDialogElement.showModal/close; stub them so <Modal> renders.
beforeEach(() => {
  const proto = window.HTMLDialogElement?.prototype
  if (proto) {
    proto.showModal = function () {
      this.open = true
    }
    proto.close = function () {
      this.open = false
      this.dispatchEvent(new Event("close"))
    }
  }
})

import { SubmitUpload } from "./SubmitUpload"

const drop = (name: string, content = "x") =>
  new File([content], name, { type: "text/plain" })

// The active dropzone element: the big zone (via its prompt) when empty, else the
// compact add bar (via its hint).
function dropzone(): HTMLElement {
  const prompt = screen.queryByText("submissions.student.upload.dropPrompt")
  if (prompt) return prompt.parentElement as HTMLElement
  return screen.getByText("submissions.student.upload.addHint")
    .parentElement as HTMLElement
}

// Fire a flat-file drop (no entry API — the happy-dom path falls back to files).
function dropFlat(files: File[]) {
  fireEvent.drop(dropzone(), { dataTransfer: { files, items: [] } })
}

// Fire a folder drop via the webkitGetAsEntry directory-entry API.
function dropFolder(tree: Record<string, string>) {
  // Build a single directory entry whose recursive reader yields file entries.
  const fileEntries = Object.entries(tree).map(([fullPath, content]) => ({
    isFile: true,
    isDirectory: false,
    fullPath,
    file: (cb: (f: File) => void) =>
      cb(drop(fullPath.split("/").pop() ?? fullPath, content)),
  }))
  let served = false
  const dirEntry = {
    isFile: false,
    isDirectory: true,
    fullPath: "/solution",
    createReader: () => ({
      readEntries: (cb: (e: unknown[]) => void) => {
        // First call returns children, second returns [] to end the drain.
        if (served) return cb([])
        served = true
        cb(fileEntries)
      },
    }),
  }
  const items = [
    { webkitGetAsEntry: () => dirEntry },
  ] as unknown as DataTransferItem[]
  // items must be array-like with a webkitGetAsEntry on [0].
  fireEvent.drop(dropzone(), {
    dataTransfer: { items, files: [] as unknown as FileList },
  })
}

function openModal() {
  fireEvent.click(screen.getByText("submissions.student.upload.open"))
}

beforeEach(() => {
  notify.mockReset()
  mutateAsync.mockReset()
  mutateAsync.mockResolvedValue({
    commitSha: "s",
    branch: "main",
    fileCount: 1,
  })
  isPending = false
  isError = false
  error = null
})

afterEach(cleanup)

describe("SubmitUpload", () => {
  it("opens a modal, lists dropped files in a table, and uploads with normalized paths", async () => {
    render(<SubmitUpload org="acme" repo="cs101-hw1-s" assignment="hw1" />)
    openModal()
    dropFlat([drop("main.py"), drop("util.py")])

    expect(screen.getByText("main.py")).toBeTruthy()
    expect(screen.getByText("util.py")).toBeTruthy()

    fireEvent.click(
      screen.getByText("submissions.student.upload.confirmSubmit"),
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(mutateAsync).toHaveBeenCalledTimes(1)
    const payload = mutateAsync.mock.calls[0][0] as { path: string }[]
    expect(payload.map((f) => f.path).sort()).toEqual(["main.py", "util.py"])
  })

  it("expands a dropped folder to its files, preserving their paths", async () => {
    render(<SubmitUpload org="acme" repo="r" assignment="hw" />)
    openModal()
    dropFolder({
      "/solution/main.c": "int main(){}",
      "/solution/src/util.c": "// util",
    })

    // Paths are folder-relative (leading slash stripped). Async entry traversal,
    // so await the rows appearing.
    expect(await screen.findByText("solution/main.c")).toBeTruthy()
    expect(await screen.findByText("solution/src/util.c")).toBeTruthy()
  })

  it("rejects a reserved control path with a warning toast", () => {
    render(<SubmitUpload org="acme" repo="r" assignment="hw" />)
    openModal()
    dropFlat([drop(".classroom50.yaml"), drop("ok.py")])

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "warning" }),
    )
    expect(screen.getByText("ok.py")).toBeTruthy()
    expect(screen.queryByText(".classroom50.yaml")).toBeNull()
  })

  it("removes a file from the table", () => {
    render(<SubmitUpload org="acme" repo="r" assignment="hw" />)
    openModal()
    dropFlat([drop("a.py"), drop("b.py")])
    expect(screen.getByText("a.py")).toBeTruthy()

    fireEvent.click(
      screen.getByLabelText(
        'submissions.student.upload.remove {"path":"a.py"}',
      ),
    )
    expect(screen.queryByText("a.py")).toBeNull()
    expect(screen.getByText("b.py")).toBeTruthy()
  })

  it("dedupes a re-dropped path (last pick wins, one row)", () => {
    render(<SubmitUpload org="acme" repo="r" assignment="hw" />)
    openModal()
    dropFlat([drop("main.py", "v1")])
    dropFlat([drop("main.py", "v2")])
    expect(screen.getAllByText("main.py")).toHaveLength(1)
  })

  it("clears all selected files in one click", () => {
    render(<SubmitUpload org="acme" repo="r" assignment="hw" />)
    openModal()
    dropFlat([drop("a.py"), drop("b.py")])
    expect(screen.getByText("a.py")).toBeTruthy()

    fireEvent.click(screen.getByText("submissions.student.upload.clearAll"))

    // Table is gone; the empty-state drop zone is back.
    expect(screen.queryByText("a.py")).toBeNull()
    expect(screen.queryByText("b.py")).toBeNull()
    expect(
      screen.getByText("submissions.student.upload.dropPrompt"),
    ).toBeTruthy()
  })
})
