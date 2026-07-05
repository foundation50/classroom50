// Package scores is the shared scores-gradebook schema seam: the on-disk shape
// of scores.json, written by collect_scores.py and read by the download
// command. The classroom command scaffolds an empty file from these types; the
// download command parses the populated gradebook. No internal/* dependencies.
package scores

// SchemaV1 is the scores.json schema sentinel; schema-aware readers MUST branch
// on it first. Teacher-written only, so it lives here, not in the contract.
const SchemaV1 = "classroom50/scores/v1"

// File is the gradebook written by collect_scores.py. Assignments is keyed by
// slug; each value is an AssignmentBucket. Non-nil (`{}`, not null) at scaffold
// time.
type File struct {
	Schema      string                      `json:"schema"`
	Assignments map[string]AssignmentBucket `json:"assignments"`
}

// AssignmentBucket is one assignment's gradebook — its mode (`type`) plus
// per-repo entries. Each entry decodes as a tolerant map[string]any (download
// reads only a few well-known keys).
type AssignmentBucket struct {
	Type    string           `json:"type"`
	Entries []map[string]any `json:"entries"`
}
