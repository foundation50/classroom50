import { z } from "zod"
import { SECRET_PATTERN } from "./secret"

// Schema sentinel for the classroom50/team/v1 bootstrap record stored in a
// classroom's secret student-team description. Byte-mirror of the CLI's
// contract.TeamSchemaV1 and schemas/classroom-team-v1.schema.json — a cross-tool
// contract with no compile-time link, so keep in lockstep.
export const TEAM_DESCRIPTION_SCHEMA = "classroom50/team/v1"

// The bootstrap record a plain student reads from GET /user/teams to enumerate
// their classrooms (and, for an unlisted classroom, recover the capability
// secret) without config-repo access. All fields optional except the record is
// only recognized when the schema sentinel matches; unknown fields are ignored
// (tolerate-and-preserve, additive evolution).
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
