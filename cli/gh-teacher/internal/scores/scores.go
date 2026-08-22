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
// reads only a few well-known keys). CollectedAt is the optional per-bucket
// freshness stamp written by collect_scores.py; empty when absent.
//
// Detected carries presence/count records for an assignment that SKIPS GRADING
// (empty_repo or no_autograder): those repos publish no submit/* release, so
// Entries stays empty and this is their only submission signal. It never carries
// a score, so `download` (which reports grades) ignores it — the field exists so
// this reader mirrors scores-v1 rather than silently dropping it. Decoded as
// tolerant maps for the same reason Entries is.
type AssignmentBucket struct {
	Type        string           `json:"type"`
	Entries     []map[string]any `json:"entries"`
	CollectedAt string           `json:"collected_at,omitempty"`
	Detected    []map[string]any `json:"detected,omitempty"`
}
