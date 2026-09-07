// Backing store for the app's one persistent polite live region. A live region
// only announces changes inside an element assistive tech is already watching,
// so a `role="status"` mounted together with its text (the old `<Spinner>`
// shape) is announced by some browser/AT pairs and not others. Callers register
// presence-shaped text (a spinner is mounted, a pass is syncing) and the region
// shows the most recently registered or changed one, so several spinners
// announce once.

const listeners = new Set<() => void>()
const entries = new Map<number, { text: string; seq: number }>()
let nextId = 1
let nextSeq = 1
let snapshot = ""
let clearTimer: ReturnType<typeof setTimeout> | null = null

// When the last registration leaves, the text stays this long so a remount
// with the same text (a route change swapping one spinner for another) is not
// re-announced.
export const ANNOUNCE_LINGER_MS = 500

function emit() {
  for (const listener of listeners) listener()
}

function publish(text: string) {
  if (text === snapshot) return
  snapshot = text
  emit()
}

function latestText(): string {
  let latest: { text: string; seq: number } | undefined
  for (const entry of entries.values()) {
    if (!latest || entry.seq > latest.seq) latest = entry
  }
  return latest?.text ?? ""
}

function reconcile() {
  const text = latestText()
  if (text) {
    if (clearTimer) {
      clearTimeout(clearTimer)
      clearTimer = null
    }
    publish(text)
    return
  }
  if (clearTimer || snapshot === "") return
  clearTimer = setTimeout(() => {
    clearTimer = null
    publish("")
  }, ANNOUNCE_LINGER_MS)
}

export function addAnnouncement(text: string): number {
  const id = nextId++
  entries.set(id, { text, seq: nextSeq++ })
  reconcile()
  return id
}

export function updateAnnouncement(id: number, text: string): void {
  const entry = entries.get(id)
  if (!entry || entry.text === text) return
  entries.set(id, { text, seq: nextSeq++ })
  reconcile()
}

export function removeAnnouncement(id: number): void {
  if (!entries.delete(id)) return
  reconcile()
}

export function subscribeLiveAnnouncer(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getLiveAnnouncement(): string {
  return snapshot
}

export function __resetLiveAnnouncerForTest(): void {
  entries.clear()
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = null
  snapshot = ""
  listeners.clear()
}
