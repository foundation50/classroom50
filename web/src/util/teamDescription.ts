import { z } from "zod"
import { SECRET_PATTERN, isValidSecret } from "./secret"

// Schema sentinel for the classroom50/team/v1 bootstrap record stored in a
// classroom's secret student-team description. Byte-mirror of the CLI's
// contract.TeamSchemaV1 and schemas/classroom-team-v1.schema.json — a cross-tool
// contract with no compile-time link, so keep in lockstep.
export const TEAM_DESCRIPTION_SCHEMA = "classroom50/team/v1"

// The bootstrap record a plain student reads from GET /user/teams to enumerate
// their classrooms (and, for an unlisted classroom, recover the capability
// secret) without config-repo access. All fields optional except the record is
// only recognized when the schema sentinel matches; unknown fields are ignored
// (tolerate-only: the record is a projection of classroom.json, re-derived on
// every write, so an unknown field is dropped on the next rewrite — not
// preserved, unlike the read-modify-write files classroom.json/assignments.json).
const TeamDescriptionSchema = z.object({
  schema: z.literal(TEAM_DESCRIPTION_SCHEMA),
  name: z.string().optional(),
  term: z.string().optional(),
  active: z.boolean().optional(),
  // A hand-edited/desynced value can't reach a Pages URL segment: it's
  // pattern-checked and degrades to "no secret" rather than failing the parse
  // (mirrors the .classroom50.yaml secret handling).
  secret: z.string().regex(SECRET_PATTERN).optional().catch(undefined),
})

export type TeamDescription = z.infer<typeof TeamDescriptionSchema>

// parseTeamDescription reads a team's `description` string into the bootstrap
// record, or {} when it's absent, non-JSON, or not a v1 record. Never throws —
// an older team (plain-text or empty description) simply yields no bootstrap
// data, and callers fall back to other secret sources.
export function parseTeamDescription(
  description: string | null | undefined,
): Partial<TeamDescription> {
  if (!description) return {}
  let raw: unknown
  try {
    raw = JSON.parse(description)
  } catch {
    return {}
  }
  const parsed = TeamDescriptionSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

// marshalTeamDescription encodes the classroom50/team/v1 bootstrap record for a
// student team's description — the inverse of parseTeamDescription and a
// byte-for-byte mirror of the Go MarshalTeamDescription
// (cli/gh-teacher/internal/configrepo/teamdescription.go). Compact JSON, empty
// name/term omitted, `secret` included only when valid ([a-z0-9]{4,64}; a
// malformed value is dropped, not persisted into a URL segment), and `active`
// omitted when true (readers default absent -> active) to save bytes. Kept small
// (well under ~250 chars): per-assignment data lives on Pages, never here.
export function marshalTeamDescription(input: {
  name?: string
  term?: string
  secret?: string
  active: boolean
}): string {
  const record: Record<string, unknown> = { schema: TEAM_DESCRIPTION_SCHEMA }
  if (input.name) record.name = input.name
  if (input.term) record.term = input.term
  if (input.secret && isValidSecret(input.secret)) record.secret = input.secret
  if (!input.active) record.active = false
  // Match Go's json.Marshal, which HTML-escapes <, >, & AND the U+2028/U+2029
  // line/paragraph separators by default (no SetEscapeHTML(false) on the CLI
  // writer). JSON.stringify escapes none of these, so without this the two tools
  // would produce different bytes for a name/term containing them and perpetually
  // overwrite each other's description (the reconcile compares strings for exact
  // equality).
  return JSON.stringify(record)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}
