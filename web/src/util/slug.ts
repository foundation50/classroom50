// Normalize a free-text value into a URL/repo-safe slug: lowercase, punctuation
// stripped, runs of non-alphanumerics collapsed to single hyphens, no leading/
// trailing hyphens. Used for classroom and assignment slugs (which become
// GitHub repo path segments), so it must stay deterministic and lossless on
// already-slugified input.
export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// Max slug length, mirroring validate.ShortNamePattern's cap. A derived `-<n>`
// suffix must not push a candidate past it, so the stem is trimmed to fit.
const SLUG_MAX_LEN = 100

// First slug not in `taken`, suffixing `-2`, `-3`, … A base ending in `-<n>`
// continues from n+1 ("hw1-2" -> "hw1-3", not "hw1-2-2"). Case-insensitive, to
// match GitHub repo naming and the server-side check. Pure; prefills both the
// reuse modals and the create-form auto-slug — the write path re-checks
// authoritatively.
export function nextAvailableSlug(
  base: string,
  taken: Iterable<string>,
): string {
  const takenSet = new Set(Array.from(taken, (s) => s.trim().toLowerCase()))
  const isFree = (candidate: string) => !takenSet.has(candidate.toLowerCase())

  if (isFree(base)) return base

  // Split off a trailing "-<n>" so we increment it rather than append again.
  const match = /^(.*?)-(\d+)$/.exec(base)
  const stem = match ? match[1] : base
  let n = match ? Number(match[2]) + 1 : 2

  // Bounded defensively; a classroom never has thousands of same-stem slugs.
  for (let i = 0; i < 10000; i++) {
    const suffix = `-${n}`
    // Trim the stem to leave room for the suffix; drop a hyphen the trim exposes.
    const room = SLUG_MAX_LEN - suffix.length
    const trimmedStem = stem.slice(0, room).replace(/-+$/g, "")
    const candidate = `${trimmedStem}${suffix}`
    if (isFree(candidate)) return candidate
    n++
  }
  // Unreachable in practice, but never silently return a taken slug.
  return `${stem}-${Date.now()}`.slice(0, SLUG_MAX_LEN).replace(/-+$/g, "")
}
