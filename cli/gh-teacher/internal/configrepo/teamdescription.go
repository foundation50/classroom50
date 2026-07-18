package configrepo

import (
	"encoding/json"
	"fmt"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// TeamDescription is the bootstrap record written into a classroom's SECRET
// student-team description (`classroom50-<short>`). A plain org member can't read
// the private config repo, but CAN list their own teams (GET /user/teams
// returns secret teams they belong to, with the description), so this lets the
// web GUI enumerate a student's classrooms and — for an unlisted classroom —
// recover the capability secret without any config-repo access.
//
// Mirrors schemas/classroom-team-v1.schema.json and the web reader
// (web/src/util/teamDescription.ts) with no compile-time link — keep in
// lockstep. Kept small (well under ~250 chars): per-assignment data lives on
// Pages, never here. Only ever written to a `secret` team so the secret isn't
// exposed beyond the classroom's own members.
type TeamDescription struct {
	Schema string `json:"schema"`
	// Human-readable classroom name; omitted when empty.
	Name string `json:"name,omitempty"`
	// Free-form term label; omitted when empty.
	Term string `json:"term,omitempty"`
	// Capability secret, present only for an unlisted classroom.
	Secret string `json:"secret,omitempty"`
	// Lifecycle flag; omitted when active (the default) to save bytes.
	Active *bool `json:"active,omitempty"`
}

// MarshalTeamDescription encodes the bootstrap record for a student team's
// description. `secret` is included only when non-empty AND valid (a malformed
// secret is dropped rather than persisted into a URL segment). `active` is
// omitted when true (readers default absent -> active). Returns "" for a record
// with no populated fields beyond the schema is still valid — the schema
// sentinel alone lets a reader recognize a v1 record.
func MarshalTeamDescription(name, term, secret string, active bool) (string, error) {
	desc := TeamDescription{
		Schema: contract.TeamSchemaV1,
		Name:   name,
		Term:   term,
	}
	if secret != "" {
		// Defensive: never persist a malformed secret. A listed classroom
		// passes "" and skips this entirely.
		if err := ValidateSecret(secret); err != nil {
			return "", fmt.Errorf("team description secret: %w", err)
		}
		desc.Secret = secret
	}
	if !active {
		desc.Active = &active
	}
	out, err := json.Marshal(desc)
	if err != nil {
		return "", fmt.Errorf("encode team description: %w", err)
	}
	return string(out), nil
}
