// File System Access API helpers (Chromium-only): let the teacher choose where
// a download lands. Callers must feature-detect and fall back to
// util/downloadBlob elsewhere.
//
// Pickers require a user gesture, so call pickSaveFile / pickDirectory BEFORE
// any long `await` (fetch, write) — the transient activation must still be live.

// The DOM lib in this TS version ships the handle interfaces but not the
// window entry points, so declare just what we use.
declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string
      types?: Array<{ description?: string; accept: Record<string, string[]> }>
    }) => Promise<FileSystemFileHandle>
    showDirectoryPicker?: (options?: {
      id?: string
      mode?: "read" | "readwrite"
    }) => Promise<FileSystemDirectoryHandle>
  }
}

export function supportsSaveFilePicker(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window
}

// A cancelled picker rejects with an AbortError; callers treat that as a benign
// no-op rather than an error.
function isPickerAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

// Save-file picker for a `.zip`. Returns the handle, or null if cancelled.
export async function pickSaveFile(
  suggestedName: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker!({
      suggestedName,
      types: [
        {
          description: "Zip archive",
          accept: { "application/zip": [".zip"] },
        },
      ],
    })
  } catch (err) {
    if (isPickerAbort(err)) return null
    throw err
  }
}

// Directory picker (readwrite). Returns the handle, or null if cancelled.
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker!({ mode: "readwrite" })
  } catch (err) {
    if (isPickerAbort(err)) return null
    throw err
  }
}

// Stream bytes to a picked file handle, then close it.
export async function writeToFileHandle(
  handle: FileSystemFileHandle,
  data: BlobPart,
): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(data)
  } finally {
    await writable.close()
  }
}

// Write a file into a picked directory, streaming to disk. Overwrites any
// same-named entry.
export async function writeFileToDirectory(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: BlobPart,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  await writeToFileHandle(handle, data)
}
