// Package repoconfig owns the `.classroom50.yaml` document shape and its
// renderer, shared by every Go writer of the marker: the student CLI's accept
// and the teacher CLI's enable-autograder backfill (a no_autograder accept
// writes no marker, so turning the built-in autograder on later has to). One
// renderer keeps the two byte-identical; schemas/repo-config-v1.schema.json is
// the cross-tool source of truth and the web GUI hand-mirrors it.
package repoconfig

import (
	"bytes"
	"fmt"

	"gopkg.in/yaml.v3"
)

// SchemaV1 is the versioned sentinel stamped into `.classroom50.yaml` at
// accept time. Readers treat it as optional (pre-v1 files predate it), but new
// writes always include it so future shape changes are detectable. Mirrors the
// web GUI's emitted value.
const SchemaV1 = "classroom50/repo-config/v1"

// Config is the on-disk shape of `.classroom50.yaml`. classroom + assignment
// identify the submission; source.* records the template repo so
// `gh student submit` can re-fetch the latest teacher `.gitignore` /
// `.github/` on each push. source is omitted for a template-less assignment.
//
// Secret is the optional capability-URL path segment, written here at accept so
// submit and the runner can rebuild the `<classroom>/<secret>/...` Pages URLs
// without an org read. Omitted (plain path) for an unprotected classroom.
//
// The runner derives its config-repo coordinates from the calling repo's org
// (security-pinned at workflow runtime) and the classroom slug, so no
// `config:` block is needed on disk.
type Config struct {
	Schema     string    `yaml:"schema,omitempty"`
	Classroom  string    `yaml:"classroom"`
	Assignment string    `yaml:"assignment"`
	Secret     string    `yaml:"secret,omitempty"`
	Owner      *Identity `yaml:"owner,omitempty"`
	Source     *Source   `yaml:"source,omitempty"`
}

// Identity records a GitHub account by both its mutable login and its
// immutable numeric id, so a username rename never breaks the repo<->student
// binding. ID is a pointer so it renders as a YAML number (or null when
// unresolved), never a quoted string. AcceptedAt is the UTC instant of the
// accept commit; the owner is the acceptor, so it lives here. Empty for a
// marker written after the fact (the enable-autograder backfill).
type Identity struct {
	Username   string `yaml:"username"`
	ID         *int64 `yaml:"id"`
	AcceptedAt string `yaml:"accepted_at,omitempty"`
}

// Source is the source.* block (template repo). Submit reads teacher-side
// `.gitignore` / `.github/` from here. Absent for a template-less assignment.
// OwnerID is the template owner's immutable id (org or user), resolved
// best-effort at write time and null when the lookup failed.
type Source struct {
	Owner   string `yaml:"owner"`
	OwnerID *int64 `yaml:"owner_id,omitempty"`
	Repo    string `yaml:"repo"`
	Branch  string `yaml:"branch"`
}

// Render serializes cfg as double-quoted YAML at 2-space indent. Quoting every
// string scalar defends against auto-typing of slugs like "yes" or "2026";
// numbers and nulls (the ids) pass through unquoted.
func Render(cfg Config) ([]byte, error) {
	out, err := marshalQuotedYAML(cfg)
	if err != nil {
		return nil, fmt.Errorf("marshal classroom metadata: %w", err)
	}
	return out, nil
}

func marshalQuotedYAML(v any) ([]byte, error) {
	var node yaml.Node
	if err := node.Encode(v); err != nil {
		return nil, err
	}
	quoteStringValues(&node)

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&node); err != nil {
		_ = enc.Close()
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// quoteStringValues forces DoubleQuotedStyle on every string-tagged scalar
// value. Keys, numbers, and nulls pass through.
func quoteStringValues(n *yaml.Node) {
	if n == nil {
		return
	}
	switch n.Kind {
	case yaml.DocumentNode, yaml.SequenceNode:
		for _, c := range n.Content {
			quoteStringValues(c)
		}
	case yaml.MappingNode:
		// Content alternates [key, value, ...]; quote values only.
		for i := 0; i+1 < len(n.Content); i += 2 {
			quoteStringValues(n.Content[i+1])
		}
	case yaml.ScalarNode:
		if n.Tag == "!!str" {
			n.Style = yaml.DoubleQuotedStyle
		}
	}
}
