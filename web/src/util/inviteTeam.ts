import { z } from "zod"

// Schema sentinel for the classroom50/invite/v1 record stored in a per-invite
// secret team's description. Byte-mirror of schemas/invite-v1.schema.json.
// Web-only today (email invites exist only in the web app), so there is no Go
// contract constant yet; if a CLI email-invite path is added, this becomes a
// cross-tool contract and must be kept in lockstep.
export const INVITE_DESCRIPTION_SCHEMA = "classroom50/invite/v1"

// Team-name prefix for a per-invite metadata team. GitHub derives a team's slug
// from its name (lowercase, hyphenated, special chars stripped); an
// `invite-<hex>` name is already slug-safe, so name === slug and the team is
// locatable by prefix (GET /orgs/{org}/teams filtered on this) as well as by
// recomputing the hash from a roster row's classroom + email.
export const INVITE_TEAM_PREFIX = "invite-"

// SHA-256 prefix length (hex chars) used in the team name. 16 hex = 64 bits —
// ample collision resistance for a class-sized roster; total name length is
// `invite-` (7) + 16 = 23 chars, well within GitHub's limit.
const INVITE_HASH_HEX_LEN = 16

// Byte budget for the encoded description. GitHub caps a team description near
// 250 chars; a writer over budget drops the optional display fields
// (first_name/last_name/section) first, always preserving schema/email/classroom
// (the fields recovery depends on). Kept below the hard cap for safety margin.
const INVITE_DESCRIPTION_BUDGET = 240

// The invite record. `email` and `classroom` are required (the recovery join and
// per-classroom scoping); the display fields are optional and best-effort.
// Unknown fields are ignored (tolerate-only, additive evolution) — the record is
// re-derived on write, never read-modify-written.
const InviteDescriptionSchema = z.object({
  schema: z.literal(INVITE_DESCRIPTION_SCHEMA),
  email: z.string(),
  classroom: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  section: z.string().optional(),
})

export type InviteDescription = z.infer<typeof InviteDescriptionSchema>

export type InviteMetadata = {
  email: string
  classroom: string
  first_name?: string
  last_name?: string
  section?: string
}

// Normalize an email for hashing and storage: trim + lowercase. A single source
// so the name-hash and the stored `email` can't diverge (a mismatch would make
// the team unlocatable from the roster row).
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase()
}

// The deterministic team name for an (classroom, email) invite:
// `invite-<sha256(classroom \0 email)[:16 hex]>`. Scoping by classroom keeps the
// same email invited to two classrooms in one org on two distinct teams. Async
// because it uses the Web Crypto digest (mirrors auth/pkce deriveChallenge);
// the separator byte prevents ("ab","c") and ("a","bc") colliding.
export async function inviteTeamName(
  classroom: string,
  email: string,
): Promise<string> {
  const normalized = normalizeInviteEmail(email)
  const encoded = new TextEncoder().encode(`${classroom}\u0000${normalized}`)
  const digest = await crypto.subtle.digest("SHA-256", encoded)
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `${INVITE_TEAM_PREFIX}${hex.slice(0, INVITE_HASH_HEX_LEN)}`
}

// True when a team slug is one this feature owns (an `invite-` metadata team),
// so a GC/enumeration pass can filter org teams to only the ones it may touch.
export function isInviteTeamSlug(slug: string): boolean {
  return slug.startsWith(INVITE_TEAM_PREFIX)
}

// parseInviteDescription reads a team description string into the invite record,
// or null when absent, non-JSON, or not a valid v1 record. Never throws — a
// team with a hand-edited or empty description simply yields no record, and the
// caller skips it rather than crashing the reconcile pass. Because the accepted
// invitee can edit their own team's description, this is the trust boundary:
// callers additionally verify `email` hashes back to the team name before use.
export function parseInviteDescription(
  description: string | null | undefined,
): InviteDescription | null {
  if (!description) return null
  let raw: unknown
  try {
    raw = JSON.parse(description)
  } catch {
    return null
  }
  const parsed = InviteDescriptionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// marshalInviteDescription encodes the classroom50/invite/v1 record for a team
// description — the inverse of parseInviteDescription. Compact JSON, empty
// display fields omitted. When the full record would exceed the byte budget, the
// optional display fields are dropped (section, then last_name, then first_name)
// until it fits, always preserving schema/email/classroom so recovery still
// works. Applies the same escaping as marshalTeamDescription so the bytes would
// match a Go json.Marshal writer if one is ever added.
export function marshalInviteDescription(input: InviteMetadata): string {
  const email = normalizeInviteEmail(input.email)
  const base: Record<string, unknown> = {
    schema: INVITE_DESCRIPTION_SCHEMA,
    email,
    classroom: input.classroom,
  }
  const first = input.first_name?.trim()
  const last = input.last_name?.trim()
  const section = input.section?.trim()

  // Try full, then progressively drop optional display fields to fit the budget.
  const candidates: Array<Record<string, unknown>> = [
    { ...base, first_name: first, last_name: last, section },
    { ...base, first_name: first, last_name: last },
    { ...base, first_name: first },
    { ...base },
  ]
  for (const candidate of candidates) {
    // Drop undefined/empty optional fields so they never serialize.
    const record: Record<string, unknown> = { ...base }
    if (candidate.first_name) record.first_name = candidate.first_name
    if (candidate.last_name) record.last_name = candidate.last_name
    if (candidate.section) record.section = candidate.section
    const encoded = escapeForGoParity(JSON.stringify(record))
    if (encoded.length <= INVITE_DESCRIPTION_BUDGET) return encoded
  }
  // Even the minimal record exceeds the budget (a pathological email/classroom);
  // return it anyway — a too-long description is GitHub's error to surface, and
  // the minimal record is still the most useful thing to attempt.
  return escapeForGoParity(JSON.stringify(base))
}

// Match Go's json.Marshal, which HTML-escapes <, >, & and the U+2028/U+2029
// line/paragraph separators by default. JSON.stringify escapes none; matching
// keeps the bytes identical to a future Go writer (see marshalTeamDescription).
function escapeForGoParity(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}
