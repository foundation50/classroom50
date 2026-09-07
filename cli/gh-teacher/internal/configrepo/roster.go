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

// ResolveConfigRepoBranch fetches <org>/classroom50's default branch.
// 404 → "run `gh teacher init` first".
func ResolveConfigRepoBranch(client githubapi.Client, org string) (string, error) {
	repoPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), ConfigRepoName)
	var repo ConfigRepo
	if err := client.Get(repoPath, &repo); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return "", fmt.Errorf("%s/%s not found: run `gh teacher init %s` first", org, ConfigRepoName, org)
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
// callback's read stays consistent across rebase attempts. Missing →
// points the teacher at `gh teacher classroom add`. Parses strictly;
// read-only callers use this, write callers use LoadRosterLenient.
func LoadRoster(client githubapi.Client, org, classroom, parentSHA string) ([]RosterRow, error) {
	return loadRoster(client, org, classroom, parentSHA, false)
}

// LoadRosterLenient is LoadRoster for the read-modify-write path: it parses
// leniently (ParseRosterLenient) so a pre-existing malformed row can't block a
// legitimate edit of another and round-trips untouched. Write commands
// (add/update/remove/import) use it; read-only callers stay strict.
func LoadRosterLenient(client githubapi.Client, org, classroom, parentSHA string) ([]RosterRow, error) {
	return loadRoster(client, org, classroom, parentSHA, true)
}

func loadRoster(client githubapi.Client, org, classroom, parentSHA string, lenient bool) ([]RosterRow, error) {
	path := RosterFilePath(classroom)
	data, ok, err := ReadFileContents(client, org, ConfigRepoName, path, parentSHA)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%s/%s/%s not found: run `gh teacher classroom add %s %s` first, or restore the file if it was deleted",
			org, ConfigRepoName, path, org, classroom)
	}
	parse := ParseRoster
	if lenient {
		parse = ParseRosterLenient
	}
	parsed, err := parse(data)
	if err != nil {
		return nil, fmt.Errorf("%s/%s/%s: %w", org, ConfigRepoName, path, err)
	}
	return parsed, nil
}

// RosterWriteChange builds the tree change that writes the updated rows to
// roster.csv.
func RosterWriteChange(classroom string, rows []RosterRow) (gittree.Change, error) {
	data, err := EncodeRoster(rows)
	if err != nil {
		return gittree.Change{}, err
	}
	return gittree.Change{
		Upserts: map[string]string{RosterFilePath(classroom): string(data)},
	}, nil
}

// DedupeByUsername collapses repeated usernames (last-wins, matching
// UpsertRosterRow). Preserves first-seen order; no input mutation.
func DedupeByUsername(rows []RosterRow) []RosterRow {
	latest := make(map[string]RosterRow, len(rows))
	order := make([]string, 0, len(rows))
	var rawRows []RosterRow
	for _, row := range rows {
		if row.isRaw() {
			// Preserved rows have no username to key on; keep each distinct.
			rawRows = append(rawRows, row)
			continue
		}
		key := strings.ToLower(row.Username)
		if _, seen := latest[key]; !seen {
			order = append(order, key)
		}
		latest[key] = row
	}
	out := make([]RosterRow, 0, len(order)+len(rawRows))
	for _, key := range order {
		out = append(out, latest[key])
	}
	return append(out, rawRows...)
}
