package configrepo

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// ClassroomJSON is the typed shape of a classroom's classroom.json metadata.
type ClassroomJSON struct {
	Schema    string `json:"schema"`
	Name      string `json:"name"`
	ShortName string `json:"short_name"`
	Term      string `json:"term"`
	Org       string `json:"org"`
	// Secret is the optional capability-URL path segment. When set,
	// publish-pages serves resources under `<classroom>/<secret>/...`; empty =
	// plain path. Opt-in, so omitted on unprotected classrooms.
	Secret string `json:"secret,omitempty"`
	// Team is the per-classroom team granting rostered students read on
	// private org-owned templates. Omitted on pre-feature classrooms.
	Team *TeamRef `json:"team,omitempty"`
	// Teams: per-classroom staff teams backing the web GUI's in-app roles.
	// Web-authored; the CLI tolerates and round-trips it.
	Teams *StaffTeamsRef `json:"teams,omitempty"`
	// Active is the lifecycle flag: false = archived, true or ABSENT = active.
	// A pointer so "archived" stays distinct from "legacy that never wrote the
	// key"; omitempty so it's stamped only on archive/unarchive.
	Active       *bool            `json:"active,omitempty"`
	MigratedFrom *MigratedFromRef `json:"migrated_from,omitempty"`

	// Extra holds unknown top-level keys, re-emitted verbatim so
	// archive/unarchive/edit never drop a field a newer binary/GUI added.
	Extra map[string]json.RawMessage `json:"-"`
}

// knownClassroomKeys is the classroom.json keys this binary understands; any
// other key is diverted to Extra. Keep in lockstep with ClassroomJSON's tags.
var knownClassroomKeys = map[string]struct{}{
	"schema": {}, "name": {}, "short_name": {}, "term": {}, "org": {},
	"secret": {}, "team": {}, "teams": {}, "active": {}, "migrated_from": {},
}

// UnmarshalJSON captures unknown top-level keys into Extra, then decodes
// the known subset into the typed fields.
func (c *ClassroomJSON) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	known := make(map[string]json.RawMessage, len(raw))
	var extra map[string]json.RawMessage
	for k, v := range raw {
		if _, ok := knownClassroomKeys[k]; ok {
			known[k] = v
			continue
		}
		if extra == nil {
			extra = make(map[string]json.RawMessage)
		}
		extra[k] = v
	}

	knownBytes, err := json.Marshal(known)
	if err != nil {
		return err
	}
	type classroomAlias ClassroomJSON // avoid recursion into this method
	var typed classroomAlias
	if err := json.Unmarshal(knownBytes, &typed); err != nil {
		return err
	}
	*c = ClassroomJSON(typed)
	c.Extra = extra
	return nil
}

// MarshalJSON emits the known fields via the alias, then byte-splices any
// sorted Extra keys before the closing brace, preserving struct order.
func (c ClassroomJSON) MarshalJSON() ([]byte, error) {
	type classroomAlias ClassroomJSON
	known, err := json.Marshal(classroomAlias(c))
	if err != nil {
		return nil, err
	}
	if len(c.Extra) == 0 {
		return known, nil
	}
	keys := make([]string, 0, len(c.Extra))
	for k := range c.Extra {
		if _, isKnown := knownClassroomKeys[k]; isKnown {
			continue // defensive: never let Extra override a known field
		}
		keys = append(keys, k)
	}
	if len(keys) == 0 {
		return known, nil
	}
	sort.Strings(keys) // deterministic output

	// Splice Extra members before `known`'s closing brace. The alias always
	// emits schema/name/short_name/term/org, so `known` is never "{}".
	var buf bytes.Buffer
	trimmed := bytes.TrimSpace(known)
	buf.Write(trimmed[:len(trimmed)-1]) // everything up to the final '}'
	for _, k := range keys {
		buf.WriteByte(',')
		keyJSON, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(keyJSON)
		buf.WriteByte(':')
		buf.Write(c.Extra[k])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// IsArchived reports whether a classroom is archived: `active` present and
// false. Absent (legacy) or explicit true both read as active. Mirrors the
// web's `isClassroomArchived(cl) = cl.active === false`.
func (c *ClassroomJSON) IsArchived() bool {
	return c != nil && c.Active != nil && !*c.Active
}

// MigratedFromRef records where a classroom originated when imported by
// `classroom migrate`. Hand-authored classrooms never carry it.
type MigratedFromRef struct {
	Source           string `json:"source"`
	ClassroomID      int64  `json:"classroom_id"`
	OriginalName     string `json:"original_name"`
	OriginalOrgLogin string `json:"original_org_login"`
	URL              string `json:"url,omitempty"`
	MigratedAt       string `json:"migrated_at"`
}

// ClassroomFilePath: on-repo path to a classroom's classroom.json.
func ClassroomFilePath(shortName string) string {
	return shortName + "/classroom.json"
}

// LoadClassroom reads + parses <short-name>/classroom.json at ref.
// Missing file → (nil, false, nil) so callers shape their own
// "not found" message.
func LoadClassroom(client githubapi.Client, org, shortName, ref string) (*ClassroomJSON, bool, error) {
	path := ClassroomFilePath(shortName)
	data, ok, err := ReadFileContents(client, org, ConfigRepoName, path, ref)
	if err != nil {
		return nil, false, err
	}
	if !ok {
		return nil, false, nil
	}
	var c ClassroomJSON
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, false, fmt.Errorf("%s/%s/%s: %w", org, ConfigRepoName, path, err)
	}
	return &c, true, nil
}
