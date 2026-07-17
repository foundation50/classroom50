// Package classroomcfg owns the `.classroom50.yaml` on-disk contract and the
// write path that drops a freshly-accepted assignment repo's initial files.
// The config types (Config/Source) are read by every gh-student command; the
// write helpers (DropFiles/CommitFiles/WaitForStableBranch) are the
// accept-side seam that lands `.classroom50.yaml` + the autograde workflow in
// one Tree commit. Depends on internal/githubapi and the shared gittree/ghutil
// helpers, never on package main.
package classroomcfg

import (
	"bytes"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/gh-student/internal/githubapi"
)

// MetadataPath is the in-repo path read by both the student CLI and the
// autograde-runner workflow's bootstrap step.
//
// It also serves as the runner's accept-commit marker: the runner resolves the
// Feedback-PR baseline as "the commit that introduced .classroom50.yaml", not
// by matching the commit subject. Every accept client (this CLI, the web GUI,
// any future client) MUST create this file in its accept commit; the commit
// subject carries no contract. Mirrored runner-side as
// runner.ACCEPT_MARKER_PATH (cli/gh-teacher/skeleton/dotgithub/scripts/runner.py).
const MetadataPath = ".classroom50.yaml"

// AutogradeWorkflowPath is the in-repo destination for the autograde shim
// written at accept time.
const AutogradeWorkflowPath = ".github/workflows/autograde.yaml"

// SchemaRepoConfigV1 is the versioned sentinel stamped into `.classroom50.yaml`
// at accept time. Readers treat it as optional — pre-v1 files predate it — but
// new accepts always write it so future shape changes are detectable. Mirrors
// the web GUI's emitted value.
const SchemaRepoConfigV1 = "classroom50/repo-config/v1"

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
// accept commit; the owner is the acceptor, so it lives here.
type Identity struct {
	Username   string `yaml:"username"`
	ID         *int64 `yaml:"id"`
	AcceptedAt string `yaml:"accepted_at,omitempty"`
}

// Source is the source.* block (template repo). Submit reads teacher-side
// `.gitignore` / `.github/` from here. Absent for a template-less assignment.
// OwnerID is the template owner's immutable id (org or user), resolved
// best-effort at accept time and null when the lookup failed.
type Source struct {
	Owner   string `yaml:"owner"`
	OwnerID *int64 `yaml:"owner_id,omitempty"`
	Repo    string `yaml:"repo"`
	Branch  string `yaml:"branch"`
}

// Render serializes cfg as double-quoted YAML. Used by accept to drop the
// initial file; submit doesn't re-render since the shape is stable.
func Render(cfg Config) ([]byte, error) {
	yamlBytes, err := marshalQuotedYAML(cfg)
	if err != nil {
		return nil, fmt.Errorf("marshal classroom metadata: %w", err)
	}
	return yamlBytes, nil
}

// DropFiles commits `.classroom50.yaml` + the autograde workflow in one Tree
// commit so the repo's initial shape lands atomically. This is the accept
// commit; creating `.classroom50.yaml` here is what the runner uses to resolve
// the Feedback-PR baseline (see MetadataPath). The commit message is
// human-readable only. WaitForStableBranch polls first because GitHub doesn't
// propagate the post-templated-repo commit ref synchronously (the contents API
// briefly returns 409 "Git Repository is empty" otherwise).
func DropFiles(client githubapi.Client, owner, repo, branch string, cfg Config, workflowContent string) error {
	if err := WaitForStableBranch(client, owner, repo, branch); err != nil {
		return err
	}

	metadataBytes, err := Render(cfg)
	if err != nil {
		return err
	}

	files := map[string]string{
		MetadataPath:          string(metadataBytes),
		AutogradeWorkflowPath: workflowContent,
	}
	return CommitFiles(client, owner, repo, branch,
		contract.PrefixCommit("Initialize .classroom50.yaml and autograde workflow (gh student accept)"),
		files)
}

// WaitForStableBranch polls until a freshly-created branch's ref
// propagates. Thin wrapper over the shared ghutil helper.
func WaitForStableBranch(client githubapi.Client, owner, repo, branch string) error {
	return githubapi.WaitForStableBranch(client, owner, repo, branch)
}

// EscapeContentPath URL-encodes each path segment, preserving slashes.
func EscapeContentPath(path string) string {
	parts := strings.Split(path, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

// marshalQuotedYAML renders double-quoted string scalars at 2-space indent,
// defending against auto-typing of slugs like "yes" or "2026".
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

// quoteStringValues forces DoubleQuotedStyle on every string-tagged
// scalar. Keys, numbers, and booleans pass through.
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

// IsHTTPNotFound reports whether err is a 404 githubapi.HTTPError. Thin
// wrapper over the shared ghutil helper.
func IsHTTPNotFound(err error) bool {
	return ghutil.IsHTTPNotFound(err)
}

// ReadConfig reads and validates a `.classroom50.yaml` at path. The
// classroom/assignment identity is always required. The source.* template
// block is optional (a template-less assignment has none); when present, only
// source.owner is required — matching the published repo-config-v1 JSON Schema
// and the web GUI reader. submit guards on Source != nil and degrades
// gracefully if repo/branch are absent, so the reader need not reject such a file.
func ReadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	if config.Classroom == "" {
		return nil, fmt.Errorf("missing classroom in %s", path)
	}
	if config.Assignment == "" {
		return nil, fmt.Errorf("missing assignment in %s", path)
	}
	if config.Source != nil && config.Source.Owner == "" {
		return nil, fmt.Errorf("source block present but missing source.owner (omit the whole source block for a template-less assignment): %s", path)
	}
	// Re-validate the optional secret in lockstep with every other consumer
	// (same ^[a-z0-9]{4,64}$ rule) before submit/invite compose it into a URL:
	// empty = unprotected; a present-but-malformed value fails fast here
	// instead of building a 404-ing path.
	if config.Secret != "" {
		if err := ValidateSecret(config.Secret); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}

	return &config, nil
}

// ValidateSecret checks a --key access key against secretPattern. Empty is
// rejected; callers allowing "no key" (unprotected) must branch on emptiness
// first. Mirrors the teacher-side configrepo.ValidateSecret.
func ValidateSecret(secret string) error {
	if !secretPattern.MatchString(secret) {
		return fmt.Errorf("invalid --key %q: must be %s", secret, secretPatternDescription)
	}
	return nil
}

// secretPattern / secretPatternDescription are compiled from the
// single-sourced contract.SecretPattern so the teacher and student halves
// can't drift; the non-importable copies (runner.py, the workflow YAMLs, the
// JSON Schemas, the web GUI) are pinned by contract_test.go's change-detector.
var secretPattern = regexp.MustCompile(contract.SecretPattern)

const secretPatternDescription = contract.SecretPatternDescription
