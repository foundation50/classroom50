// Trigger a browser "save file" for an in-memory blob: the object-URL +
// hidden-anchor + revoke dance, in one place so the CSV export and the
// submission-archive downloads share a single recipe.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")

  link.href = url
  link.download = filename
  link.click()

  URL.revokeObjectURL(url)
}
