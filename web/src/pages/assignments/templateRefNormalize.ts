import {
  formatTemplateRef,
  parseTemplateRef,
  type TemplateAccessVerification,
} from "@/domain/assignments"

// Verdict kinds that got a repo object back from GitHub, and therefore carry a
// canonical `owner`/`repo` worth writing into the field. The excluded kinds
// (`not-visible`, `restricted`, `rate-limited`, `unknown`, `invalid`, `empty`)
// only echo what the teacher typed — rewriting from those would either be a
// no-op or would launder a typo into something that looks resolved.
const CONFIRMED_KINDS = new Set<TemplateAccessVerification["kind"]>([
  "ok",
  "ok-verify",
  "private-fork",
  "not-template",
  "empty-template",
  "no-branch",
  "private-out-of-org",
])

// The canonical `{owner}/{repo}` text for a field whose value GitHub has
// confirmed, or null when there's nothing to rewrite.
//
// This is what turns a typed bare name into `{org}/{name}`: the org default
// already happens inside parseTemplateRef, but the field kept showing the bare
// text, so what a teacher saw wasn't what the assignment would store. Gating on
// a confirmed verdict is deliberate — an unverified guess would rewrite a typo
// into a confident-looking ref for a repo that doesn't exist.
export function canonicalTemplateRef(
  verification: TemplateAccessVerification | null | undefined,
  typed: string,
): string | null {
  if (!verification || !CONFIRMED_KINDS.has(verification.kind)) return null
  // Narrow to the verdicts carrying owner/repo (every CONFIRMED_KINDS member).
  if (!("owner" in verification) || !("repo" in verification)) return null

  const trimmed = typed.trim()
  if (!trimmed) return null

  let typedBranch: string | undefined
  try {
    // The branch comes from what was typed, never from the verdict: a verdict's
    // `branch` may be the repo's resolved default, and echoing that back would
    // silently pin the assignment to today's default branch (#673).
    typedBranch = parseTemplateRef(trimmed, verification.owner).branch
  } catch {
    return null
  }

  const canonical = formatTemplateRef({
    owner: verification.owner,
    repo: verification.repo,
    branch: typedBranch,
  })
  // Returning null when nothing changes keeps callers from writing the value
  // back to the form on every render.
  return canonical === trimmed ? null : canonical
}
