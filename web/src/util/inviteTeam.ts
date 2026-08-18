import { z } from "zod"
import { escapeForGoJsonParity } from "./goJsonEscape"

// Schema sentinel for the classroom50/invite/v1 record stored in a per-invite
// secret team's description. Byte-mirror of schemas/invite-v1.schema.json.
// TWO tools write this record and each reads the other's — the web app and
// `gh teacher roster invite` — so INVITE_DESCRIPTION_SCHEMA, INVITE_TEAM_PREFIX
// and INVITE_HASH_HEX_LEN below are a cross-tool contract mirrored in
// cli/shared/contract (InviteSchemaV1 / InviteTeamPrefix / InviteHashHexLen)
// with no compile-time link. Keep them in lockstep; both sides pin their own
// half, and the shared vectors in cli/shared/testdata/invite_vectors.json pin
// that both writers emit the same bytes.
export const INVITE_DESCRIPTION_SCHEMA = "classroom50/invite/v1"

// Team-name prefix for a per-invite metadata team. GitHub derives a team's slug
// from its name (lowercase, hyphenated, special chars stripped); an
// `invite-<hex>` name is already slug-safe, so name === slug and the team is
// locatable by prefix (GET /orgs/{org}/teams filtered on this) as well as by
// recomputing the hash from a roster row's classroom + email.
export const INVITE_TEAM_PREFIX = "invite-"

// SHA-256 prefix length (hex chars) used in the team name. 16 hex = 64 bits —
// ample collision resistance for a class-sized roster; total name length is
// `invite-` (7) + 16 = 23 chars, well within GitHub's limit. Exported because
// the prefix alone is too loose to identify one of these teams — a human team
// named "Invite Only" also slugs to `invite-…` — so the CLI's sweep matches the
// full `invite-<16 hex>` shape and pins this length.
export const INVITE_HASH_HEX_LEN = 16

// The email-only record stays far under GitHub's ~250-char team-description
// cap for any RFC-length email; there is no drop-fields fallback because there
// is nothing optional left to drop (PII-minimal by design).

// The invite record: `email` (the value the record exists to retain) and
// `classroom` (the recovery scope). Deliberately PII-minimal — display metadata
// (names/sections) belongs in roster.csv, joined by email, never here. Unknown
// fields are ignored (tolerate-only, additive evolution) — the record is
// re-derived on write, never read-modify-written.
const InviteDescriptionSchema = z.object({
  schema: z.literal(INVITE_DESCRIPTION_SCHEMA),
  email: z.string(),
  classroom: z.string(),
})

export type InviteDescription = z.infer<typeof InviteDescriptionSchema>

export type InviteMetadata = {
  email: string
  classroom: string
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

// True when a slug is in the `invite-` NAMESPACE, so an enumeration pass can
// narrow the org team list to candidates. Looser than the shape this feature
// writes (`invite-<16 hex>`) and looser than the CLI's IsInviteTeamSlug, so a
// caller that DELETES must also require a valid v1 record — a human team named
// "Invite Only" slugs into this namespace.
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
// description — the inverse of parseInviteDescription. Compact JSON with the
// same escaping as marshalTeamDescription so the bytes match the Go
// json.Marshal writer in the teacher CLI (which writes this same record).
export function marshalInviteDescription(input: InviteMetadata): string {
  return escapeForGoJsonParity(
    JSON.stringify({
      schema: INVITE_DESCRIPTION_SCHEMA,
      email: normalizeInviteEmail(input.email),
      classroom: input.classroom,
    }),
  )
}
