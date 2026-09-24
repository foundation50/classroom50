// Package classroomcfg re-exports the shared `.classroom50.yaml` contract
// (repoconfig) and owns the write path that drops a freshly-accepted
// assignment repo's initial files. The config types are read by every
// gh-student command; the write helpers (DropFiles/CommitFiles/
// WaitForStableBranch) are the accept-side seam that lands `.classroom50.yaml`
// + the autograde workflow in one Tree commit. Depends on internal/githubapi
// and the shared gittree/ghutil helpers, never on package main.
package classroomcfg

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/classroom50-cli-shared/repoconfig"
	"github.com/foundation50/gh-student/internal/githubapi"
)

// MetadataPath aliases contract.MetadataPath (the accept marker and baseline
// anchor; see its doc and contract/baseline.go for the resolution rule) so the
// runner's ACCEPT_MARKER_PATH and the teacher CLI can't drift from it.
const MetadataPath = contract.MetadataPath

// AutogradeWorkflowPath is the in-repo destination for the autograde shim
// written at accept time.
const AutogradeWorkflowPath = contract.AutogradeShimPath

// SeededReadmePath is the README GitHub's auto_init seeds at repo creation.
const SeededReadmePath = "README.md"

// SchemaRepoConfigV1 aliases repoconfig.SchemaV1.
const SchemaRepoConfigV1 = repoconfig.SchemaV1

// Config, Identity, and Source alias the shared repoconfig document so both
// CLIs render the marker through repoconfig.Render.
type (
	Config   = repoconfig.Config
	Identity = repoconfig.Identity
	Source   = repoconfig.Source
)

// DropFiles commits `.classroom50.yaml` + the autograde workflow in one Tree
// commit so the repo's initial shape lands atomically (removing the auto_init
// README in the same commit for an init_shim accept), returning the accept
// commit's SHA (the Feedback-PR baseline the `feedback` branch freezes at).
// Creating `.classroom50.yaml` here is what the runner uses to resolve that
// same baseline (see MetadataPath). The commit message is human-readable only.
// WaitForStableBranch polls first because GitHub doesn't propagate the
// post-templated-repo commit ref synchronously (the contents API briefly
// returns 409 "Git Repository is empty" otherwise).
func DropFiles(client githubapi.Client, owner, repo, branch string, cfg Config, workflowContent string, removeSeededReadme bool) (string, error) {
	if err := WaitForStableBranch(client, owner, repo, branch); err != nil {
		return "", err
	}

	metadataBytes, err := repoconfig.Render(cfg)
	if err != nil {
		return "", err
	}

	files := map[string]string{
		MetadataPath: string(metadataBytes),
	}
	// An empty shim commits only the marker, never an empty
	// .github/workflows/autograde.yaml (a stray empty workflow file would make
	// the runner shape ambiguous). Unreachable today; kept as a guard.
	if workflowContent != "" {
		files[AutogradeWorkflowPath] = workflowContent
	}
	// An init_shim accept creates the repo with auto_init (GitHub needs an
	// initial commit to write against), which seeds a README the assignment
	// contract says must not exist — remove it in the same accept commit so
	// the repo's initial shape lands atomically. Probe first: the Trees API
	// rejects deleting a path absent from base_tree (possible on a heal
	// re-run), and an absent README just means nothing to remove.
	var deletePaths []string
	if removeSeededReadme {
		exists, err := FileExists(client, owner, repo, SeededReadmePath)
		if err != nil {
			return "", err
		}
		if exists {
			deletePaths = append(deletePaths, SeededReadmePath)
		}
	}
	return CommitFiles(client, owner, repo, branch,
		contract.PrefixCommit("Initialize .classroom50.yaml and autograde workflow (gh student accept)"),
		files, deletePaths...)
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

// IsHTTPNotFound reports whether err is a 404 githubapi.HTTPError. Thin
// wrapper over the shared ghutil helper.
func IsHTTPNotFound(err error) bool {
	return ghutil.IsHTTPNotFound(err)
}

// FileExists reports whether `path` is readable on owner/repo's default branch
// via the contents API. 404 → false; other errors propagate so a transient
// failure isn't misread as "missing".
func FileExists(client githubapi.Client, owner, repo, path string) (bool, error) {
	apiPath := fmt.Sprintf("repos/%s/%s/contents/%s",
		url.PathEscape(owner), url.PathEscape(repo), EscapeContentPath(path))
	if err := client.Get(apiPath, nil); err != nil {
		if IsHTTPNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("GET %s: %w", apiPath, err)
	}
	return true, nil
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
