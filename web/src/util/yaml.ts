import { parseDocument } from "yaml"
import { z } from "zod"
import { SECRET_PATTERN } from "./secret"

const IdentitySchema = z.object({
  username: z.string().min(1),
  // Immutable numeric GitHub user id; nullable when unresolved.
  id: z.number().nullable().optional(),
  // UTC instant of the accept commit (the owner is the acceptor).
  accepted_at: z.string().optional(),
})

const Classroom50YamlSchema = z.object({
  // All fields except classroom/assignment are optional for back-compat with
  // pre-v1 files (CLI-authored files may omit schema/owner/source).
  schema: z.string().optional(),
  classroom: z.string().min(1),
  assignment: z.string().min(1),
  // Optional capability-URL secret, present only for a protected classroom.
  // Mirrors the CLI's repo-config-v1 schema. Pattern-checked at the read
  // boundary so a hand-edited/desynced value can't reach a Pages URL segment;
  // an invalid value degrades to "no secret" rather than failing the parse.
  secret: z.string().regex(SECRET_PATTERN).optional().catch(undefined),
  owner: IdentitySchema.optional(),
  source: z
    .object({
      owner: z.string().min(1),
      // Template owner's immutable id (org or user); nullable when unresolved.
      owner_id: z.number().nullable().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
    })
    .optional(),
})

export type Classroom50Yaml = z.infer<typeof Classroom50YamlSchema>

export function parseClassroom50Yaml(source: string): Classroom50Yaml {
  const doc = parseDocument(source, {
    schema: "core",
    prettyErrors: true,
  })

  if (doc.errors.length > 0) {
    throw new Error(doc.errors.map((e) => e.message).join("\n"))
  }

  const raw = doc.toJS()

  return Classroom50YamlSchema.parse(raw)
}
