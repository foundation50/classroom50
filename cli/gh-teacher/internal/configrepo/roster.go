package configrepo

import (
	"errors"
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

// ErrConfigRepoMissing marks the 404 from ResolveConfigRepoBranch so callers
// that tolerate a fresh org (no `gh teacher init` yet) can tell it from a
// real failure with errors.Is. The user-facing message stays the plain
// "run init first" hint.
var ErrConfigRepoMissing = errors.New("classroom50 repository not found")

type configRepoMissingError struct{ msg string }

func (e *configRepoMissingError) Error() string        { return e.msg }
func (e *configRepoMissingError) Is(target error) bool { return target == ErrConfigRepoMissing }

// ResolveConfigRepoBranch fetches <org>/classroom50's default branch.
// 404 → "run `gh teacher init` first" (matches ErrConfigRepoMissing).
func ResolveConfigRepoBranch(client githubapi.Client, org string) (string, error) {
	repoPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), ConfigRepoName)
	var repo ConfigRepo
	if err := client.Get(repoPath, &repo); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return "", &configRepoMissingError{fmt.Sprintf("%s/%s not found: run `gh teacher init %s` first", org, ConfigRepoName, org)}
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

// LoginKey is the case-insensitive join key for a GitHub login. Every roster
// index is both built and read with it; deriving the key any other way makes
// a lookup silently miss.
func LoginKey(login string) string {
	return strings.ToLower(strings.TrimSpace(login))
}

// RosterIndex is the first-wins identity index over a roster. It records WHICH
// row each identity is on because every helper keyed on a username or an id
// touches the FIRST match: planning against a later duplicate plans an edit
// that then applies to nothing. Resolution order (id-first or login-first) is
// the caller's, so the two surfaces that join differently share one index.
type RosterIndex struct {
	FirstByID    map[int64]int
	FirstByLogin map[string]int
}

func IndexRosterRows(rows []RosterRow) RosterIndex {
	out := RosterIndex{FirstByID: map[int64]int{}, FirstByLogin: map[string]int{}}
	for i, row := range rows {
		if row.GitHubID != 0 {
			if _, seen := out.FirstByID[row.GitHubID]; !seen {
				out.FirstByID[row.GitHubID] = i
			}
		}
		if key := LoginKey(row.Username); key != "" {
			if _, seen := out.FirstByLogin[key]; !seen {
				out.FirstByLogin[key] = i
			}
		}
	}
	return out
}
