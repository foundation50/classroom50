package configrepo

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/gittree"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// ConfigRepo is the subset of the GitHub repo object the config-repo
// helpers read (default branch for the rebase loop; id/url for setup).
type ConfigRepo struct {
	ID            int64  `json:"id"`
	HTMLURL       string `json:"html_url"`
	DefaultBranch string `json:"default_branch"`
}

// RosterFilePath: on-repo path to a classroom's roster.csv.
func RosterFilePath(classroom string) string {
	return classroom + "/" + contract.RosterFilename
}

// LegacyRosterFilePath: on-repo path to a classroom's pre-rename students.csv.
// Readers fall back to this so classrooms bootstrapped before the rename keep
// working until `gh teacher roster migrate` converges them.
func LegacyRosterFilePath(classroom string) string {
	return classroom + "/" + contract.LegacyRosterFilename
}

// ResolveConfigRepoBranch fetches <org>/classroom50's default branch.
// 404 → "run `gh teacher init` first".
func ResolveConfigRepoBranch(client githubapi.Client, org string) (string, error) {
	repoPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), ConfigRepoName)
	var repo ConfigRepo
	if err := client.Get(repoPath, &repo); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return "", fmt.Errorf("%s/%s not found — run `gh teacher init %s` first", org, ConfigRepoName, org)
		}
		return "", fmt.Errorf("GET %s: %w", repoPath, err)
	}
	branch := repo.DefaultBranch
	if branch == "" {
		branch = "main"
	}
	return branch, nil
}

// LoadRoster reads the roster at a specific commit SHA so the build
// callback's read stays consistent across rebase attempts. Tries roster.csv
// first, then falls back to the legacy name (LegacyRosterFilePath) so a
// classroom bootstrapped before the rename still reads. Missing both → points
// the teacher at `gh teacher classroom add`.
//
// Read-only callers use this; write callers use LoadRosterWithSource so they
// can converge the legacy file onto roster.csv in the same commit.
func LoadRoster(client githubapi.Client, org, classroom, parentSHA string) ([]RosterRow, error) {
	rows, _, err := LoadRosterWithSource(client, org, classroom, parentSHA)
	return rows, err
}

// LoadRosterWithSource is LoadRoster plus the repo-root-relative path the rows
// were actually read from — RosterFilePath normally, or LegacyRosterFilePath
// when only the legacy file exists. Write paths use the source to decide
// whether the same commit must also delete the legacy file (see
// RosterWriteChange), so a first edit of an un-migrated classroom converges it
// onto roster.csv rather than leaving a stale legacy copy behind.
func LoadRosterWithSource(client githubapi.Client, org, classroom, parentSHA string) (rows []RosterRow, sourcePath string, err error) {
	path := RosterFilePath(classroom)
	data, ok, err := ReadFileContents(client, org, ConfigRepoName, path, parentSHA)
	if err != nil {
		return nil, "", err
	}
	if !ok {
		// Legacy fallback: an un-migrated classroom only has the legacy file.
		legacyPath := LegacyRosterFilePath(classroom)
		legacyData, legacyOK, legacyErr := ReadFileContents(client, org, ConfigRepoName, legacyPath, parentSHA)
		if legacyErr != nil {
			return nil, "", legacyErr
		}
		if !legacyOK {
			return nil, "", fmt.Errorf("%s/%s/%s not found — run `gh teacher classroom add %s %s` first, or restore the file if it was deleted",
				org, ConfigRepoName, path, org, classroom)
		}
		path, data = legacyPath, legacyData
	}
	parsed, err := ParseRoster(data)
	if err != nil {
		return nil, "", fmt.Errorf("%s/%s/%s: %w", org, ConfigRepoName, path, err)
	}
	return parsed, path, nil
}

// RosterWriteChange builds the tree change that writes the updated rows to
// roster.csv, and — when sourcePath is the legacy file (LegacyRosterFilePath) —
// deletes it in the same commit, so a first edit of an un-migrated classroom
// converges it (matching `gh teacher roster migrate`). Pass the sourcePath
// returned by LoadRosterWithSource.
func RosterWriteChange(classroom, sourcePath string, rows []RosterRow) (gittree.Change, error) {
	data, err := EncodeRoster(rows)
	if err != nil {
		return gittree.Change{}, err
	}
	change := gittree.Change{
		Upserts: map[string]string{RosterFilePath(classroom): string(data)},
	}
	if sourcePath == LegacyRosterFilePath(classroom) {
		change.Deletes = []string{sourcePath}
	}
	return change, nil
}

// DedupeByUsername collapses repeated usernames (last-wins, matching
// UpsertRosterRow). Preserves first-seen order; no input mutation.
func DedupeByUsername(rows []RosterRow) []RosterRow {
	latest := make(map[string]RosterRow, len(rows))
	order := make([]string, 0, len(rows))
	for _, row := range rows {
		key := strings.ToLower(row.Username)
		if _, seen := latest[key]; !seen {
			order = append(order, key)
		}
		latest[key] = row
	}
	out := make([]RosterRow, 0, len(order))
	for _, key := range order {
		out = append(out, latest[key])
	}
	return out
}
