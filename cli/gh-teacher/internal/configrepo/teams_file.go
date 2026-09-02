package configrepo

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/output"
)

// TeamsFile is the typed on-disk shape of <classroom>/teams.json
// (schemas/teams-v1.schema.json): the teacher-committed snapshot of INTENDED
// group-team membership for team-mode assignments, keyed by assignment slug.
// A SNAPSHOT, not live state — GitHub Teams stay authoritative for who can
// push; this file exists so intent survives membership drift and so cleanup
// can attribute teams after they are deleted.
//
// Every level tolerates and round-trips unknown fields via Extra (the
// AssignmentEntry pattern): the file may be written by newer releases, and a
// read-modify-write must never drop what it doesn't understand.
type TeamsFile struct {
	Schema      string                     `json:"schema"`
	Assignments map[string]AssignmentTeams `json:"assignments"`

	// Extra holds unknown top-level keys, re-emitted verbatim.
	Extra map[string]json.RawMessage `json:"-"`
}

// AssignmentTeams is one assignment's bucket: its team records plus any
// unknown sibling fields a newer writer added.
type AssignmentTeams struct {
	Teams []TeamRecord `json:"teams"`

	Extra map[string]json.RawMessage `json:"-"`
}

// TeamRecord is one group team's snapshot row. ID is the live team's numeric
// id recorded at creation (0 when unknown — e.g. a planned import); Name is
// display metadata; Members are the INTENDED usernames, lowercased;
// Formation records who founded the team ("" when unknown).
type TeamRecord struct {
	Slug      string   `json:"slug"`
	ID        int64    `json:"id,omitempty"`
	Name      string   `json:"name,omitempty"`
	Members   []string `json:"members"`
	Formation string   `json:"formation,omitempty"`

	Extra map[string]json.RawMessage `json:"-"`
}

// TeamsFilePath is the config-repo-relative path to a classroom's teams.json.
func TeamsFilePath(classroom string) string {
	return classroom + "/" + contract.TeamsFilename
}

// NewTeamsFile is the empty scaffold a classroom without teams.json reads as.
func NewTeamsFile() TeamsFile {
	return TeamsFile{
		Schema:      contract.TeamsSchemaV1,
		Assignments: map[string]AssignmentTeams{},
	}
}

// splitKnown diverts raw's unknown keys (anything not in known) into an Extra
// map and returns the remaining known subset re-marshalled for a strict
// decode. Shared by the three (Un)MarshalJSON levels below.
func splitKnown(raw map[string]json.RawMessage, known map[string]struct{}) (knownBytes []byte, extra map[string]json.RawMessage, err error) {
	kept := make(map[string]json.RawMessage, len(raw))
	for k, v := range raw {
		if _, ok := known[k]; ok {
			kept[k] = v
			continue
		}
		if extra == nil {
			extra = map[string]json.RawMessage{}
		}
		extra[k] = v
	}
	knownBytes, err = json.Marshal(kept)
	return knownBytes, extra, err
}

// spliceExtra appends extra's members (sorted, defensively skipping known
// keys) before known's closing brace, preserving the struct field order the
// alias marshal produced. Mirrors AssignmentEntry.MarshalJSON.
func spliceExtra(knownJSON []byte, extra map[string]json.RawMessage, known map[string]struct{}) ([]byte, error) {
	if len(extra) == 0 {
		return knownJSON, nil
	}
	keys := make([]string, 0, len(extra))
	for k := range extra {
		if _, isKnown := known[k]; isKnown {
			continue // never let Extra override a known field
		}
		keys = append(keys, k)
	}
	if len(keys) == 0 {
		return knownJSON, nil
	}
	sort.Strings(keys)
	var buf bytes.Buffer
	trimmed := bytes.TrimSpace(knownJSON)
	buf.Write(trimmed[:len(trimmed)-1])
	for _, k := range keys {
		if buf.Len() > 1 { // "{" alone means no leading comma
			buf.WriteByte(',')
		}
		keyJSON, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(keyJSON)
		buf.WriteByte(':')
		buf.Write(extra[k])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

var (
	teamsFileKnownKeys       = map[string]struct{}{"schema": {}, "assignments": {}}
	assignmentTeamsKnownKeys = map[string]struct{}{"teams": {}}
	teamRecordKnownKeys      = map[string]struct{}{
		"slug": {}, "id": {}, "name": {}, "members": {}, "formation": {},
	}
)

func (f *TeamsFile) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	knownBytes, extra, err := splitKnown(raw, teamsFileKnownKeys)
	if err != nil {
		return err
	}
	type fileAlias TeamsFile
	var typed fileAlias
	if err := json.Unmarshal(knownBytes, &typed); err != nil {
		return err
	}
	*f = TeamsFile(typed)
	f.Extra = extra
	return nil
}

func (f TeamsFile) MarshalJSON() ([]byte, error) {
	type fileAlias TeamsFile
	known, err := json.Marshal(fileAlias(f))
	if err != nil {
		return nil, err
	}
	return spliceExtra(known, f.Extra, teamsFileKnownKeys)
}

func (a *AssignmentTeams) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	knownBytes, extra, err := splitKnown(raw, assignmentTeamsKnownKeys)
	if err != nil {
		return err
	}
	type bucketAlias AssignmentTeams
	var typed bucketAlias
	if err := json.Unmarshal(knownBytes, &typed); err != nil {
		return err
	}
	*a = AssignmentTeams(typed)
	a.Extra = extra
	return nil
}

func (a AssignmentTeams) MarshalJSON() ([]byte, error) {
	type bucketAlias AssignmentTeams
	out := bucketAlias(a)
	if out.Teams == nil {
		out.Teams = []TeamRecord{} // `teams` is required; never emit null
	}
	known, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	return spliceExtra(known, a.Extra, assignmentTeamsKnownKeys)
}

func (r *TeamRecord) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	knownBytes, extra, err := splitKnown(raw, teamRecordKnownKeys)
	if err != nil {
		return err
	}
	type recordAlias TeamRecord
	var typed recordAlias
	if err := json.Unmarshal(knownBytes, &typed); err != nil {
		return err
	}
	*r = TeamRecord(typed)
	r.Extra = extra
	return nil
}

func (r TeamRecord) MarshalJSON() ([]byte, error) {
	type recordAlias TeamRecord
	out := recordAlias(r)
	if out.Members == nil {
		out.Members = []string{} // `members` is required; never emit null
	}
	known, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	return spliceExtra(known, r.Extra, teamRecordKnownKeys)
}

// ParseTeamsFile decodes teams.json, checking the schema sentinel first so a
// future v2 surfaces "this CLI handles only v1" instead of a shape error.
func ParseTeamsFile(data []byte) (TeamsFile, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return TeamsFile{}, errors.New("teams.json is empty")
	}
	var probe struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return TeamsFile{}, fmt.Errorf("parse teams.json: %w", err)
	}
	if probe.Schema != contract.TeamsSchemaV1 {
		return TeamsFile{}, fmt.Errorf("teams.json schema = %q, want %q (this CLI handles only v1)",
			probe.Schema, contract.TeamsSchemaV1)
	}
	var file TeamsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return TeamsFile{}, fmt.Errorf("parse teams.json: %w", err)
	}
	if file.Assignments == nil {
		file.Assignments = map[string]AssignmentTeams{}
	}
	return file, nil
}

// ReadTeamsFile reads <classroom>/teams.json at `ref` (a commit SHA inside a
// CommitTree build, or a branch name for read-only paths). A missing file is
// NOT an error — it reads as the empty scaffold, since a classroom has no
// teams.json until its first team-mode write.
func ReadTeamsFile(client githubapi.Client, org, classroom, ref string) (TeamsFile, error) {
	path := TeamsFilePath(classroom)
	data, ok, err := ReadFileContents(client, org, ConfigRepoName, path, ref)
	if err != nil {
		return TeamsFile{}, err
	}
	if !ok {
		return NewTeamsFile(), nil
	}
	file, err := ParseTeamsFile(data)
	if err != nil {
		return TeamsFile{}, fmt.Errorf("%s/%s/%s: %w", org, ConfigRepoName, path, err)
	}
	return file, nil
}

// normalizeTeamRecord lowercases and dedupes the intended member list (the
// schema's "stored lowercased" rule), preserving first-seen order.
func normalizeTeamRecord(record TeamRecord) TeamRecord {
	seen := map[string]bool{}
	members := make([]string, 0, len(record.Members))
	for _, m := range record.Members {
		m = strings.ToLower(strings.TrimSpace(m))
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		members = append(members, m)
	}
	record.Members = members
	return record
}

// UpsertTeam replaces the record with a matching slug in `assignment`'s
// bucket (or appends it), normalizing members to the stored lowercase form.
// Unknown bucket/file fields are untouched. Returns whether a row was
// replaced.
func UpsertTeam(file *TeamsFile, assignment string, record TeamRecord) (replaced bool) {
	if file.Assignments == nil {
		file.Assignments = map[string]AssignmentTeams{}
	}
	record = normalizeTeamRecord(record)
	bucket := file.Assignments[assignment]
	for i := range bucket.Teams {
		if bucket.Teams[i].Slug == record.Slug {
			// Preserve a prior row's unknown fields: the upsert re-derives
			// only the known ones.
			record.Extra = bucket.Teams[i].Extra
			bucket.Teams[i] = record
			file.Assignments[assignment] = bucket
			return true
		}
	}
	bucket.Teams = append(bucket.Teams, record)
	file.Assignments[assignment] = bucket
	return false
}

// RemoveTeam drops the record with a matching slug from `assignment`'s
// bucket. The bucket itself stays (an empty `teams` list is a valid "no teams
// yet" state that preserves any unknown bucket fields). Returns whether a row
// was removed.
func RemoveTeam(file *TeamsFile, assignment, slug string) (removed bool) {
	bucket, ok := file.Assignments[assignment]
	if !ok {
		return false
	}
	for i := range bucket.Teams {
		if bucket.Teams[i].Slug == slug {
			bucket.Teams = append(bucket.Teams[:i], bucket.Teams[i+1:]...)
			file.Assignments[assignment] = bucket
			return true
		}
	}
	return false
}

// ValidateTeamsFile enforces the rules JSON Schema cannot express before a
// write: every slug matches the full group-team shape AND hashes back to its
// bucket's (classroom, assignment); slugs are unique within an assignment;
// member lists are disjoint within an assignment. Read paths stay tolerant —
// only writes go through this, so a hand-edited file can't wedge reads.
func ValidateTeamsFile(file TeamsFile, classroom string) error {
	for assignment, bucket := range file.Assignments {
		slugs := map[string]bool{}
		memberOf := map[string]string{}
		for _, team := range bucket.Teams {
			if _, ok := contract.ParseGroupTeamCounter(team.Slug, classroom, assignment); !ok {
				return fmt.Errorf("teams.json: %s: team slug %q does not belong to %s/%s (its hash segment must be GroupTeamHash of the classroom and assignment)",
					assignment, team.Slug, classroom, assignment)
			}
			if slugs[team.Slug] {
				return fmt.Errorf("teams.json: %s: duplicate team slug %q", assignment, team.Slug)
			}
			slugs[team.Slug] = true
			if team.Formation != "" && !contract.IsValidTeamFormation(team.Formation) {
				return fmt.Errorf("teams.json: %s: team %q has invalid formation %q (must be one of %v)",
					assignment, team.Slug, team.Formation, contract.TeamFormations)
			}
			for _, m := range team.Members {
				key := strings.ToLower(m)
				if other, taken := memberOf[key]; taken && other != team.Slug {
					return fmt.Errorf("teams.json: %s: %s is on both %q and %q (one student, one team)",
						assignment, key, other, team.Slug)
				}
				memberOf[key] = team.Slug
			}
		}
	}
	return nil
}

// EncodeTeamsFile validates (ValidateTeamsFile) and serializes via
// output.JSONPretty (2-space, trailing newline) so diffs stay stable.
// Normalizes an empty schema/assignments to the scaffold shape.
func EncodeTeamsFile(file TeamsFile, classroom string) ([]byte, error) {
	if file.Schema == "" {
		file.Schema = contract.TeamsSchemaV1
	}
	if file.Assignments == nil {
		file.Assignments = map[string]AssignmentTeams{}
	}
	if err := ValidateTeamsFile(file, classroom); err != nil {
		return nil, err
	}
	return output.JSONPretty(file)
}
