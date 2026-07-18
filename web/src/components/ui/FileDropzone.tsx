import { useEffect, useId, useRef, useState } from "react"
import { Upload } from "lucide-react"

import { Button } from "./Button"
import { cx } from "./cx"

// A picked file plus its intended repo-relative path. For a dropped folder the
// path is the path WITHIN the dropped folder (e.g. "src/main.c"); for a flat
// file it's just the name. The path is carried alongside the File because a
// drag-drop traversal can't write to the read-only File.webkitRelativePath.
export type PickedFile = {
  file: File
  relativePath: string
}

export type FileDropzoneProps = {
  // Fired with every file added via drop or the picker (dropped folders are
  // expanded to their files). The caller owns the accumulated list
  // (dedup/remove), so a second drop appends rather than replaces.
  onFiles: (files: PickedFile[]) => void
  prompt: string
  hint?: string
  buttonLabel: string
  // Forwarded to the file <input accept>. Omit to accept any type.
  accept?: string
  disabled?: boolean
  className?: string
  // "zone" (default) = the full dashed drop area. "compact" = a slim bar (browse
  // button + drop target) for adding more files when a list is already shown.
  variant?: "zone" | "compact"
}

// A minimal slice of the non-standard FileSystem entry API (webkitGetAsEntry).
type FileSystemEntryLike = {
  isFile: boolean
  isDirectory: boolean
  fullPath: string
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void
  createReader?: () => {
    readEntries: (
      cb: (entries: FileSystemEntryLike[]) => void,
      err?: (e: unknown) => void,
    ) => void
  }
}

const readEntryFile = (entry: FileSystemEntryLike): Promise<File> =>
  new Promise((resolve, reject) => entry.file?.(resolve, reject))

// readEntries returns at most 100 entries per call, so drain it in a loop.
const readAllChildren = (
  reader: ReturnType<NonNullable<FileSystemEntryLike["createReader"]>>,
): Promise<FileSystemEntryLike[]> =>
  new Promise((resolve, reject) => {
    const all: FileSystemEntryLike[] = []
    const pump = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        pump()
      }, reject)
    pump()
  })

// Recursively collect every file under a dropped entry, keeping its path within
// the drop (fullPath minus the leading slash). A dropped folder yields its whole
// subtree; a dropped file yields itself.
async function collectEntry(entry: FileSystemEntryLike): Promise<PickedFile[]> {
  const relativePath = entry.fullPath.replace(/^\/+/, "")
  if (entry.isFile) {
    const file = await readEntryFile(entry)
    return [{ file, relativePath }]
  }
  if (entry.isDirectory && entry.createReader) {
    const children = await readAllChildren(entry.createReader())
    const nested = await Promise.all(children.map(collectEntry))
    return nested.flat()
  }
  return []
}

// Reusable multi-file drag-and-drop + click-to-pick zone. The browse button
// picks loose files; a dropped FOLDER is expanded to its files via the entry
// API, so one zone handles both. Emits PickedFile[] (File + repo-relative path).
export function FileDropzone({
  onFiles,
  prompt,
  hint,
  buttonLabel,
  accept,
  disabled = false,
  className,
  variant = "zone",
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const inputId = useId()

  // A folder drop's entry traversal is async and can outlive this node (modal
  // closed, or the component unmounted by a parent re-render). Gate the trailing
  // onFiles on liveness so a late resolve can't push files onto a torn-down zone.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Flat picker / drop with no directory structure: path is the bare name (or
  // webkitRelativePath when the browser supplies one).
  const emitFlat = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const picked = Array.from(list).map((file) => ({
      file,
      relativePath:
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
        file.name,
    }))
    onFiles(picked)
  }

  // Drop handler: prefer the entry API (expands folders); fall back to the flat
  // FileList when it's unavailable (older browsers), which handles files.
  const handleDrop = async (e: React.DragEvent) => {
    if (disabled) return
    e.preventDefault()
    setDragActive(false)

    const items = e.dataTransfer.items
    const entries: FileSystemEntryLike[] = []
    if (items && items.length > 0 && "webkitGetAsEntry" in items[0]) {
      for (const item of Array.from(items)) {
        const entry = (
          item as DataTransferItem & {
            webkitGetAsEntry?: () => FileSystemEntryLike | null
          }
        ).webkitGetAsEntry?.()
        if (entry) entries.push(entry)
      }
    }

    if (entries.length === 0) {
      emitFlat(e.dataTransfer.files)
      return
    }
    const collected = (await Promise.all(entries.map(collectEntry))).flat()
    if (alive.current && collected.length > 0) onFiles(collected)
  }

  const openPicker = () => {
    if (!disabled) inputRef.current?.click()
  }

  const hiddenInput = (
    <input
      ref={inputRef}
      id={inputId}
      type="file"
      multiple
      className="hidden"
      accept={accept}
      disabled={disabled}
      onChange={(e) => {
        emitFlat(e.target.files)
        e.target.value = ""
      }}
    />
  )

  const dragProps = {
    onDragOver: (e: React.DragEvent) => {
      if (disabled) return
      e.preventDefault()
      setDragActive(true)
    },
    onDragLeave: () => setDragActive(false),
    onDrop: (e: React.DragEvent) => void handleDrop(e),
  }

  if (variant === "compact") {
    return (
      <>
        {hiddenInput}
        <div
          {...dragProps}
          className={cx(
            "flex flex-wrap items-center gap-2 rounded-box border border-dashed px-3 py-2 text-sm transition-colors",
            dragActive ? "border-primary bg-primary/5" : "border-base-300",
            className,
          )}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={openPicker}
          >
            <Upload aria-hidden="true" className="size-4" />
            {buttonLabel}
          </Button>
          {hint && <span className="text-base-content/60">{hint}</span>}
        </div>
      </>
    )
  }

  return (
    <>
      {hiddenInput}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            openPicker()
          }
        }}
        {...dragProps}
        className={cx(
          "flex flex-col items-center justify-center gap-2 rounded-box border-2 border-dashed px-6 py-10 text-center transition-colors",
          disabled
            ? "cursor-not-allowed border-base-300 opacity-60"
            : "cursor-pointer",
          !disabled &&
            (dragActive
              ? "border-primary bg-primary/5"
              : "border-base-300 hover:border-primary/50 hover:bg-base-200"),
          className,
        )}
      >
        <Upload aria-hidden="true" className="size-8 opacity-50" />
        <p className="font-medium">{prompt}</p>
        {hint && <p className="text-sm opacity-70">{hint}</p>}
        <Button
          variant="primary"
          size="sm"
          className="mt-2"
          disabled={disabled}
        >
          {buttonLabel}
        </Button>
      </div>
    </>
  )
}

export default FileDropzone
