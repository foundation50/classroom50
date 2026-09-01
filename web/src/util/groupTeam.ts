import { z } from "zod"
import type { TranslateFn } from "@/types/localizedMessage"
import { escapeForGoJsonParity } from "./goJsonEscape"
import {
  groupTeamHash,
  GROUP_HASH_HEX_LEN,
  GROUP_TEAM_PREFIX,
  isGroupTeamSlug,
} from "./teamSlug"

// Schema sentinel for the classroom50/group/v1 record stored in a
// per-assignment group team's description. Byte-mirror of
// schemas/group-team-v1.schema.json and contract.GroupSchemaV1 (cli/shared)
// with no compile-time link — keep in lockstep. The hash in the team name is
// one-way, so this record is what makes a group team attributable (and safely
// deletable) after assignments.json is gone, mirroring the invite record's
// role for invite teams.
export const GROUP_DESCRIPTION_SCHEMA = "classroom50/group/v1"

// The group record: `classroom` + `assignment` (the attribution the record
// exists to retain — together they hash back to the team name) and an optional
// display `name` the founding students chose. Unknown fields are ignored
// (tolerate-only, additive evolution) — the record is re-derived on write,
// never read-modify-written.
const GroupDescriptionSchema = z.object({
  schema: z.literal(GROUP_DESCRIPTION_SCHEMA),
  classroom: z.string(),
  assignment: z.string(),
  name: z.string().optional(),
})

export type GroupDescription = z.infer<typeof GroupDescriptionSchema>

export type GroupMetadata = {
  classroom: string
  assignment: string
  name?: string
}

// parseGroupDescription reads a team description string into the group record,
// or null when absent, non-JSON, or not a valid v1 record. Never throws — a
// team with a hand-edited or empty description simply yields no record, and
// the caller skips it rather than crashing an enumeration pass. Because a
// student-formed team's maintainer can edit their own team's description, this
// is the trust boundary: callers additionally verify the record hashes back to
// the team name (verifyGroupDescription) before trusting it.
export function parseGroupDescription(
  description: string | null | undefined,
): GroupDescription | null {
  if (!description) return null
  let raw: unknown
  try {
    raw = JSON.parse(description)
  } catch {
    return null
  }
  const parsed = GroupDescriptionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

// verifyGroupDescription confirms a parsed record's classroom+assignment hash
// back to the team slug's hex segment — the check that makes a maintainer-
// edited description unable to re-attribute a team to another classroom or
// assignment (the equivalent of the invite record's email re-hash check).
export async function verifyGroupDescription(
  slug: string,
  record: GroupDescription,
): Promise<boolean> {
  if (!isGroupTeamSlug(slug)) return false
  const hash = slug.slice(
    GROUP_TEAM_PREFIX.length,
    GROUP_TEAM_PREFIX.length + GROUP_HASH_HEX_LEN,
  )
  return (await groupTeamHash(record.classroom, record.assignment)) === hash
}

// marshalGroupDescription encodes the classroom50/group/v1 record for a team
// description — the inverse of parseGroupDescription. Compact JSON in
// schema/classroom/assignment/name order with the same escaping as the invite
// record so the bytes match the Go json.Marshal writer in the CLIs. An empty
// (after-trim) display name is omitted, never written as "".
export function marshalGroupDescription(input: GroupMetadata): string {
  const name = input.name?.trim()
  return escapeForGoJsonParity(
    JSON.stringify({
      schema: GROUP_DESCRIPTION_SCHEMA,
      classroom: input.classroom,
      assignment: input.assignment,
      ...(name ? { name } : {}),
    }),
  )
}

// The numbered fallback name every surface shows for a group without a
// display name ("Group <n>"). One key, one helper, so student and teacher
// surfaces can never drift apart on the fallback.
export function groupDefaultName(n: number, t: TranslateFn): string {
  return t("groupTeams.defaultName", { n })
}

// A group team's display name: the students' chosen name when the record
// carries one, else the numbered fallback.
export function groupDisplayName(
  team: { name?: string; n: number },
  t: TranslateFn,
): string {
  return team.name || groupDefaultName(team.n, t)
}
