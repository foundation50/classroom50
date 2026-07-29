// File System Access API helpers (Chromium-only). Where supported, these let
// the teacher choose exactly where a download lands — a single file's path via
// the save picker, or a folder to extract many submissions into — instead of
// everything dropping into the browser's default Downloads folder. Callers must
// feature-detect first and fall back to util/downloadBlob elsewhere (Firefox
// and Safari do not implement these APIs).
//
// The picker calls must run inside a user gesture (a click handler), and must
// be invoked before any long `await` so the gesture's transient activation is
// still valid — call pickSaveFile / pickDirectory first, then fetch, then
// write.

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

// A user cancelling a picker rejects with an AbortError; callers treat that as
// a benign no-op rather than an error.
export function isPickerAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

// Open the save-file picker for a `.zip`. Returns the handle, or null if the
// user cancelled. Throws only on a genuine (non-abort) failure. Caller must
// have checked supportsSaveFilePicker().
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

// Open the directory picker (readwrite). Returns the handle, or null if the
// user cancelled. Caller must have checked supportsDirectoryPicker().
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

// Write a file directly into a picked directory, streaming to disk so nothing
// accumulates in memory. Overwrites an existing same-named entry.
export async function writeFileToDirectory(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: BlobPart,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  await writeToFileHandle(handle, data)
}
