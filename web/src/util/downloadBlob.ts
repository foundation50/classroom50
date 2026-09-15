// Trigger a browser "save file" for an in-memory blob: the object-URL +
// hidden-anchor + revoke dance, in one place so the CSV export and the
// submission-archive downloads share a single recipe.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")

  link.href = url
  link.download = filename
  // Firefox/Safari start the download asynchronously, so the anchor has to be
  // in the document and the URL must outlive the next task: revoking on a 0 ms
  // timer is a known cause of failed or empty multi-MB downloads there.
  link.style.display = "none"
  document.body.appendChild(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}

const REVOKE_DELAY_MS = 60_000
