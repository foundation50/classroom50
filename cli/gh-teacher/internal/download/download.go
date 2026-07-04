// Package download implements the `gh teacher download` command: cloning
// every student submission repo for an assignment under <org>/classroom50
// (roster-driven by default, or --by-pattern), refreshing each repo's
// result.json/results.json from its submit-tag releases, and writing a
// scores.csv summary. It is an extracted command package (mirrors the
// other internal/<command> packages): only NewCmd is exported; the
// run* orchestration, the release-asset fetcher, and the scores.csv
// writer are package-private. It is a read-only consumer of the config
// repo. It depends only on the internal/* substrate seams (assignment,
// configrepo, githubapi, orgrepos, scores, cliutil) plus the shared
// contract package, never on package main.
package download

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/cli/go-gh/v2/pkg/auth"
	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/ghui"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/orgrepos"
	scoresschema "github.com/foundation50/gh-teacher/internal/scores"
)

// dirTimestampFormat: filesystem-safe and lexicographically sortable.
const dirTimestampFormat = "2006_01_02_T_15_04_05"

// Cross-binary contract with collect_scores.py and
// autograde-runner.yaml (which creates the submit-tag releases):
// asset name, submit-tag prefix, and per-asset size cap. Keep aligned
// with `RESULT_ASSET_NAME`, `SUBMIT_TAG_PREFIX`, and `MAX_RESULT_BYTES`
// in skeleton/dotgithub/scripts/collect_scores.py.
const (
	resultAssetName = "result.json"
	submitTagPrefix = "submit/"
	maxResultBytes  = 10 * 1024 * 1024
)

// resultsAssetName: the per-repo history file written alongside the
// clone. Holds every submit-tag submission's result.json (newest
// first), not just the latest — `result.json` keeps the single
// latest payload for back-compat.
const resultsAssetName = "results.json"

// allReleasesPerPage / allReleasesPagesMax bound the full
// releases walk used to collect every submission. 100×100 = 10k
// releases per repo — far beyond any plausible push history;
// exhausting the cap errors loudly rather than silently dropping
// older submissions.
const (
	allReleasesPerPage  = 100
	allReleasesPagesMax = 100
)

// assetDownloadTimeout caps the asset GET. Long enough for a slow
// CDN; short enough that a hang doesn't wedge the whole download.
const assetDownloadTimeout = 30 * time.Second

// scoresCSVHeader: stable column order. `late` and `override` are tri-state
// ("true" / "false" / "") so spreadsheet readers can distinguish
// an explicit flag from a non-submission or older score row.
var scoresCSVHeader = []string{
	"username",
	"first_name",
	"last_name",
	"email",
	"section",
	"score",
	"max_score",
	"datetime",
	"submission_tag",
	"submitted_by",
	"review_url",
	"late",
	"override",
}

func NewCmd() *cobra.Command {
	var (
		dir       string
		quiet     bool
		byPattern bool
	)

	cmd := &cobra.Command{
		Use:   "download <org> <classroom> <assignment>",
		Short: "Clone every student submission repo for an assignment",
		Long: "Clone every student submission repo for an assignment under <org>/classroom50.\n\n" +
			"Default (roster-driven): reads <classroom>/students.csv from the config\n" +
			"repo, derives the expected <classroom>-<assignment>-<username> repo for\n" +
			"each row, clones whichever ones exist, and refreshes <repo>/result.json\n" +
			"and <repo>/results.json from the repo's submit-tag releases alongside\n" +
			"the clone — results.json holds every submission (newest first), result.json\n" +
			"the latest. Roster entries\n" +
			"with no repo on the org are reported as `not yet accepted` and don't\n" +
			"fail the run. A scores.csv summary is written at the destination root\n" +
			"with one row per roster entry — submitters carry their score columns,\n" +
			"non-submitters get blanks.\n\n" +
			"Pass --by-pattern to skip the roster lookup and clone every <org> repo\n" +
			"whose name starts with <classroom>-<assignment>-. No result.json fetch,\n" +
			"no scores.csv summary — useful when the config repo isn't bootstrapped\n" +
			"yet or when you want every matching repo regardless of the roster.\n\n" +
			"Clones go through `gh repo clone`, so authentication flows through the\n" +
			"current gh session. The default destination is\n" +
			"<classroom>-<assignment>_submissions_<timestamp>/. Pass -d/--dir to\n" +
			"override (value used literally, no timestamp). Existing clones on disk\n" +
			"are skipped on the clone step, but result.json is still refreshed so a\n" +
			"re-run after the nightly collect picks up the newest scores.",
		Example: "  gh teacher download cs50-fall-2026 cs-principles hello\n" +
			"  gh teacher download -d submissions cs50-fall-2026 cs-principles hello\n" +
			"  gh teacher download --by-pattern cs50-fall-2026 cs-principles hello",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true

			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			assignment := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || assignment == "" {
				return fmt.Errorf("invalid arguments: org, classroom, and assignment must all be non-empty")
			}

			// Empty -d → timestamped default; explicit -d is literal.
			dir = strings.TrimSpace(dir)
			if dir == "" {
				dir = fmt.Sprintf("%s-%s_submissions_%s",
					strings.ToLower(classroom),
					strings.ToLower(assignment),
					time.Now().Format(dirTimestampFormat))
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}

			out := cmd.OutOrStdout()
			errOut := cmd.ErrOrStderr()

			// verbose is registered as a persistent flag on the root
			// command (main.go); read it here and thread it down rather
			// than reaching for a package global, so this command package
			// has no dependency on package main.
			verbose, _ := cmd.Flags().GetBool("verbose")

			if byPattern {
				return downloadByPattern(client, out, errOut, org, classroom, assignment, dir, quiet, verbose)
			}
			return downloadByRoster(client, out, errOut, org, classroom, assignment, dir, quiet, verbose)
		},
	}

	cmd.Flags().StringVarP(&dir, "dir", "d", "", "Directory to clone repos into (default: <classroom>-<assignment>_submissions_<timestamp>)")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress informational output and pass --quiet to git clone (errors still go to stderr)")
	cmd.Flags().BoolVar(&byPattern, "by-pattern", false, "Skip the roster lookup and clone every <org> repo matching <classroom>-<assignment>-* (no scores.csv, no result.json fetch)")
	return cmd
}

// downloadByRoster: roster × assignment Cartesian, clone the
// existing repos, refresh each repo's result.json from the latest
// submit-tag release, write a scores.csv summary at the dir root.
// Roster entries without a repo on the org are reported as missing
// — not a hard failure.
func downloadByRoster(client githubapi.Client, out, errOut io.Writer, org, classroom, assignment, dir string, quiet, verbose bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	assignments, err := configrepo.LoadAssignments(client, org, classroom, branch)
	if err != nil {
		return err
	}
	if !assignmentRegistered(assignments, assignment) {
		return fmt.Errorf("assignment %q is not registered in %s/%s/%s — run `gh teacher assignment add %s %s %s --name <name> --template <owner>/<repo>` first, or pass --by-pattern to skip the roster lookup",
			assignment, org, configrepo.ConfigRepoName, assignmentsPath(classroom), org, classroom, assignment)
	}

	isGroup := assignmentIsGroup(assignments, assignment)

	scores, err := loadScores(client, org, classroom, branch)
	if err != nil {
		return err
	}
	credited := creditedUsernames(scores, assignment)

	// Team-driven username source: the classroom GitHub team is authoritative
	// for who is enrolled. Resolve the slug the same way the web view and the
	// Python collector do (classroom.json team.slug, fallback classroom50-<c>).
	teamSlug, err := configrepo.ResolveClassroomTeamSlug(client, org, classroom, branch)
	if err != nil {
		return err
	}
	teamLogins, err := configrepo.ListTeamMembers(client, org, teamSlug)
	if err != nil {
		return fmt.Errorf("list team %q members: %w", teamSlug, err)
	}

	if len(teamLogins) == 0 {
		if !quiet {
			_, _ = fmt.Fprintf(out, "%s: classroom team %q has no members — nothing to download\n", classroom, teamSlug)
		}
		return nil
	}

	// students.csv is optional display metadata now — a missing/unreadable CSV
	// yields blank metadata, never a skipped student. Load best-effort and index
	// by github_id then login for the scores.csv join.
	metaByLogin := loadRosterMetadata(client, org, classroom, branch, errOut)

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}

	host, _ := auth.DefaultHost()
	if host == "" {
		host = "github.com"
	}
	token, _ := auth.TokenForHost(host)
	apiBase := apiBaseURL(host)

	var (
		clonedNew       []string
		skippedExisting []string
		missing         []string // enrolled but no repo on the org yet
		failed          []string
		assetErrs       int
	)
	for _, username := range teamLogins {
		repoName := assignmentRepoName(classroom, assignment, username)
		target := filepath.Join(dir, repoName)

		switch existsOnDisk, statErr := targetExists(target); {
		case statErr != nil:
			_, _ = fmt.Fprintf(errOut, "%s: stat %s: %v\n", repoName, target, statErr)
			failed = append(failed, repoName)
			continue
		case existsOnDisk:
			if !quiet {
				_, _ = fmt.Fprintf(out, "Skipped %s (already exists)\n", repoName)
			}
			skippedExisting = append(skippedExisting, repoName)
			if err := refreshResultJSON(client, token, apiBase, org, repoName, target); err != nil {
				_, _ = fmt.Fprintf(errOut, "%s: result.json: %v\n", repoName, err)
				assetErrs++
			}
			continue
		}

		// Probe before cloning so an enrolled-but-not-accepted student
		// surfaces as "missing" instead of a generic clone fatal.
		exists, err := repoExistsOnOrg(client, org, repoName)
		if err != nil {
			_, _ = fmt.Fprintf(errOut, "%s: probe failed: %v\n", repoName, err)
			failed = append(failed, repoName)
			continue
		}
		if !exists {
			if isGroup {
				if _, ok := credited[strings.ToLower(username)]; ok {
					// Joined a teammate's repo: owns no derived repo,
					// but already credited via the owner's fanned-out
					// scores.json row. Expected — not a miss.
					if verbose && !quiet {
						_, _ = fmt.Fprintf(out, "Credited via group repo: %s (no own repo)\n", username)
					}
					continue
				}
				// Group assignment, no own repo, and not credited in
				// scores.json — a genuine non-participant. Still report.
				if !quiet {
					_, _ = fmt.Fprintf(out, "Missing: %s (group assignment — no own repo and not yet credited via a teammate)\n", username)
				}
				missing = append(missing, username)
				continue
			}
			if !quiet {
				_, _ = fmt.Fprintf(out, "Missing: %s (no repo at %s/%s — not accepted yet?)\n", username, org, repoName)
			}
			missing = append(missing, username)
			continue
		}

		if err := cloneWithProgress(out, errOut, org, repoName, target, quiet, verbose); err != nil {
			failed = append(failed, repoName)
			continue
		}
		clonedNew = append(clonedNew, repoName)

		if err := refreshResultJSON(client, token, apiBase, org, repoName, target); err != nil {
			_, _ = fmt.Fprintf(errOut, "%s: result.json: %v\n", repoName, err)
			assetErrs++
		}
	}

	csvPath := filepath.Join(dir, "scores.csv")
	csvErr := writeScoresCSV(csvPath, scores, assignment, teamLogins, metaByLogin)
	if csvErr != nil {
		_, _ = fmt.Fprintf(errOut, "scores.csv: %v\n", csvErr)
	} else if !quiet {
		_, _ = fmt.Fprintf(out, "Wrote %s\n", csvPath)
	}

	if !quiet {
		_, _ = fmt.Fprintf(out, "%s: %d cloned, %d already on disk, %d missing, %d failed (of %d team member(s))\n",
			org, len(clonedNew), len(skippedExisting), len(missing), len(failed), len(teamLogins))
		if assetErrs > 0 {
			_, _ = fmt.Fprintf(errOut, "Warning: %d result.json fetches failed; see stderr above.\n", assetErrs)
		}
	}

	switch {
	case len(failed) > 0 && csvErr != nil:
		return fmt.Errorf("%d of %d repo(s) failed to clone (%s); scores.csv write also failed: %w",
			len(failed), len(teamLogins), strings.Join(failed, ", "), csvErr)
	case len(failed) > 0:
		return fmt.Errorf("%d of %d repo(s) failed to clone: %s", len(failed), len(teamLogins), strings.Join(failed, ", "))
	case csvErr != nil:
		return fmt.Errorf("scores.csv: %w", csvErr)
	}
	return nil
}

// RosterMeta is the optional display metadata joined into scores.csv from
// students.csv (blank when the CSV is absent/partial).
type RosterMeta struct {
	FirstName string
	LastName  string
	Email     string
	Section   string
}

// loadRosterMetadata reads students.csv best-effort and indexes it by
// lowercased login for the scores.csv metadata join. A missing/unreadable CSV
// is NOT fatal (the team drives enrollment; the CSV is only metadata) — it
// warns and returns an empty map so every team member still gets a row, just
// with blank name/section/email.
func loadRosterMetadata(client githubapi.Client, org, classroom, branch string, errOut io.Writer) map[string]RosterMeta {
	rows, err := configrepo.LoadRoster(client, org, classroom, branch)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "students.csv metadata unavailable (%v); scores.csv name/section/email will be blank\n", err)
		return map[string]RosterMeta{}
	}
	byLogin := make(map[string]RosterMeta, len(rows))
	for _, r := range rows {
		login := strings.ToLower(strings.TrimSpace(r.Username))
		if login == "" {
			continue
		}
		byLogin[login] = RosterMeta{
			FirstName: r.FirstName,
			LastName:  r.LastName,
			Email:     r.Email,
			Section:   r.Section,
		}
	}
	return byLogin
}

// downloadByPattern: page through <org>'s repos and clone every
// one whose name starts with <classroom>-<assignment>-. Skips the
// roster lookup, result.json refresh, and scores.csv summary —
// those all depend on the config repo being bootstrapped.
func downloadByPattern(client githubapi.Client, out, errOut io.Writer, org, classroom, assignment, dir string, quiet, verbose bool) error {
	// Deterministic head of assignmentRepoName — cross-binary
	// contract with cli/gh-student/accept.go.
	prefix := strings.ToLower(classroom) + "-" + strings.ToLower(assignment) + "-"

	repos, err := orgrepos.ListNames(client, org)
	if err != nil {
		return err
	}

	var matched []string
	for _, name := range repos {
		if strings.HasPrefix(strings.ToLower(name), prefix) {
			matched = append(matched, name)
		}
	}

	if len(matched) == 0 {
		if !quiet {
			_, _ = fmt.Fprintf(out, "%s: no repos matching %s*\n", org, prefix)
		}
		return nil
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}

	var failed []string
	for _, name := range matched {
		target := filepath.Join(dir, name)

		// "Skipped" only — no preceding "Cloning..." since we didn't start one.
		if _, err := os.Stat(target); err == nil {
			if !quiet {
				_, _ = fmt.Fprintf(out, "Skipped %s (already exists)\n", name)
			}
			continue
		} else if !os.IsNotExist(err) {
			_, _ = fmt.Fprintf(errOut, "%s: stat %s: %v\n", name, target, err)
			failed = append(failed, name)
			continue
		}

		if err := cloneWithProgress(out, errOut, org, name, target, quiet, verbose); err != nil {
			failed = append(failed, name)
			continue
		}
	}

	if !quiet {
		_, _ = fmt.Fprintf(out, "%s: %d/%d cloned\n", org, len(matched)-len(failed), len(matched))
	}

	if len(failed) > 0 {
		return fmt.Errorf("%d of %d repo(s) failed to clone: %s", len(failed), len(matched), strings.Join(failed, ", "))
	}
	return nil
}

// assignmentRegistered: case-insensitive slug membership check. The
// slug flows into repo names lowercased, so a mixed-case argument
// still matches.
// assignmentsPath returns the config-repo-relative assignments.json
// path, wrapping the seam helper so call sites inside functions that
// shadow the `assignment` package (with an `assignment` slug param) can
// still reach it.
func assignmentsPath(classroom string) string {
	return assignment.AssignmentsFilePath(classroom)
}

func assignmentRegistered(assignments assignment.AssignmentsJSON, slug string) bool {
	for _, entry := range assignments.Assignments {
		if strings.EqualFold(entry.Slug, slug) {
			return true
		}
	}
	return false
}

// assignmentIsGroup reports whether the registered assignment slug is a
// group assignment. For a group assignment only the first accepter owns
// a derived repo (`<classroom>-<assignment>-<owner>`); teammates join
// that repo, so their own derived repo legitimately doesn't exist and a
// 404 on it is not a "missing submission".
func assignmentIsGroup(assignments assignment.AssignmentsJSON, slug string) bool {
	for _, entry := range assignments.Assignments {
		if strings.EqualFold(entry.Slug, slug) {
			return strings.EqualFold(entry.Mode, assignment.ModeGroup)
		}
	}
	return false
}

// assignmentRepoName: canonical lowercased
// <classroom>-<assignment>-<username> repo name. Cross-binary
// contract — mirrors reponame.Name in cli/gh-student/internal/reponame.
// The two modules don't share symbols (separate go.mod); the formula's
// shape IS the contract.
func assignmentRepoName(classroom, assignment, username string) string {
	return fmt.Sprintf("%s-%s-%s",
		strings.ToLower(classroom),
		strings.ToLower(assignment),
		strings.ToLower(username),
	)
}

// targetExists distinguishes "missing" from "other error" so a
// permission-denied stat doesn't get reported as a skip.
func targetExists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// repoExistsOnOrg returns true iff GET /repos/{org}/{repo} returns
// 200. 404 → false. Other errors propagate so a network or auth
// failure doesn't get silently treated as "student didn't accept".
func repoExistsOnOrg(client githubapi.Client, org, repo string) (bool, error) {
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(repo))
	if err := client.Get(path, nil); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("GET %s: %w", path, err)
	}
	return true, nil
}

// loadScores reads scores.json at `ref`. Absent file → empty
// (non-nil) container so a fresh classroom still produces a
// roster-shaped scores.csv with every row blank.
func loadScores(client githubapi.Client, org, classroom, ref string) (scoresschema.File, error) {
	path := scoresFilePath(classroom)
	data, ok, err := configrepo.ReadFileContents(client, org, configrepo.ConfigRepoName, path, ref)
	if err != nil {
		return scoresschema.File{}, err
	}
	if !ok {
		return scoresschema.File{Schema: scoresschema.SchemaV1, Assignments: map[string]scoresschema.AssignmentBucket{}}, nil
	}
	scores, err := parseScores(data)
	if err != nil {
		return scoresschema.File{}, fmt.Errorf("%s/%s/%s: %w", org, configrepo.ConfigRepoName, path, err)
	}
	return scores, nil
}

// scoresFilePath: classroom-relative path to scores.json.
func scoresFilePath(classroom string) string {
	return classroom + "/scores.json"
}

// parseScores enforces the schema sentinel before trusting any other
// field, then decodes the root `assignments` map. Only the canonical
// object shape is accepted; legacy shapes are not migrated (backward
// compatibility is intentionally dropped), so a non-canonical file errors
// loudly. Entries stay as map[string]any -- download reads only a handful
// of well-known keys (owner, member_usernames, submissions).
func parseScores(data []byte) (scoresschema.File, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return scoresschema.File{Schema: scoresschema.SchemaV1, Assignments: map[string]scoresschema.AssignmentBucket{}}, nil
	}
	var raw struct {
		Schema      string          `json:"schema"`
		Assignments json.RawMessage `json:"assignments"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return scoresschema.File{}, fmt.Errorf("parse: %w", err)
	}
	if raw.Schema != scoresschema.SchemaV1 {
		return scoresschema.File{}, fmt.Errorf("schema mismatch: got %q, want %q (this CLI handles only v1)", raw.Schema, scoresschema.SchemaV1)
	}
	assignments, err := decodeAssignments(raw.Assignments)
	if err != nil {
		return scoresschema.File{}, err
	}
	return scoresschema.File{Schema: raw.Schema, Assignments: assignments}, nil
}

// decodeAssignments decodes the root `assignments` field as the canonical
// slug-keyed map of `{type, entries}` buckets. Only an object (or
// null/absent → empty) is accepted; legacy shapes are NOT migrated —
// backward compatibility with pre-canonical scores.json is intentionally
// dropped, so a non-canonical file errors loudly. Mirrors
// normalize_assignments in collect_scores.py.
func decodeAssignments(raw json.RawMessage) (map[string]scoresschema.AssignmentBucket, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return map[string]scoresschema.AssignmentBucket{}, nil
	}
	if trimmed[0] != '{' {
		return nil, fmt.Errorf("assignments must be an object keyed by assignment slug, got %s", string(trimmed))
	}
	var m map[string]scoresschema.AssignmentBucket
	if err := json.Unmarshal(trimmed, &m); err != nil {
		return nil, fmt.Errorf("parse assignments: %w", err)
	}
	if m == nil {
		m = map[string]scoresschema.AssignmentBucket{}
	}
	// Validate each bucket's `type` so the Go reader rejects the same
	// non-canonical shapes Python's normalize_assignments does (parity):
	// a bucket must declare type "individual" or "group". (A bucket whose
	// `entries` isn't a JSON array already fails the Unmarshal above.)
	for slug, bucket := range m {
		if bucket.Type != "individual" && bucket.Type != "group" {
			return nil, fmt.Errorf("assignments[%q].type must be \"individual\" or \"group\", got %q", slug, bucket.Type)
		}
	}
	return m, nil
}

// writeScoresCSV writes a per-assignment summary. One CSV line per
// submission, grouped by roster entry in roster order: a student who
// pushed N times contributes N lines (newest first, matching the
// stored submissions order); a non-submitter contributes a single
// blank line so teachers see the whole class at a glance. Per-test
// breakdowns are intentionally omitted — that detail lives in the
// per-repo result.json / results.json.
func writeScoresCSV(path string, scores scoresschema.File, assignment string, teamLogins []string, metaByLogin map[string]RosterMeta) error {
	entries := entriesForAssignment(scores, assignment)
	// Map each credited student (lowercased) -> their gradebook entry.
	// Group entries credit every member in member_usernames; individual
	// entries credit the sole owner.
	byStudent := make(map[string]map[string]any, len(entries))
	for _, entry := range entries {
		for _, u := range entryCreditedUsernames(entry) {
			byStudent[strings.ToLower(u)] = entry
		}
	}

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	if err := w.Write(scoresCSVHeader); err != nil {
		return fmt.Errorf("write header: %w", err)
	}
	for _, username := range teamLogins {
		meta := metaByLogin[strings.ToLower(username)]
		for _, record := range scoresCSVRows(username, meta, byStudent[strings.ToLower(username)]) {
			if err := w.Write(record); err != nil {
				return fmt.Errorf("write %s: %w", username, err)
			}
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return fmt.Errorf("flush: %w", err)
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

// scoresCSVRows renders the CSV lines for one team student. A nil
// `entry` (non-submitter) yields a single blank-scored line. Otherwise it
// yields one line per submission in the entry's `submissions` list
// (newest first), each carrying that submission's score columns; the
// entry-level `override` flag is repeated on every line. An entry with no
// usable `submissions` list still yields one blank-scored line so the
// student isn't dropped from the summary. `meta` is the best-effort
// students.csv join (blank when the CSV is absent/partial).
func scoresCSVRows(username string, meta RosterMeta, entry map[string]any) [][]string {
	// Display metadata is teacher/student-controllable free text, so guard it
	// against spreadsheet formula injection like the other string cells.
	firstName := csvSafeCell(meta.FirstName)
	lastName := csvSafeCell(meta.LastName)
	email := csvSafeCell(meta.Email)
	section := csvSafeCell(meta.Section)
	metaCells := func(rest ...string) []string {
		return append([]string{csvSafeCell(username), firstName, lastName, email, section}, rest...)
	}
	if entry == nil {
		return [][]string{metaCells("", "", "", "", "", "", "", "")}
	}
	override := csvSafeCell(stringifyOverride(entry["override"]))
	subs := submissionRecords(entry)
	if len(subs) == 0 {
		return [][]string{metaCells("", "", "", "", "", "", "", override)}
	}
	out := make([][]string, 0, len(subs))
	for _, sub := range subs {
		// Student-controllable string cells are run through csvSafeCell to
		// neutralize spreadsheet formula injection — a student owns their
		// repo and can publish a result.json with e.g. review="=HYPERLINK(..)".
		// encoding/csv quotes structural chars but does NOT defang a leading
		// =,+,-,@. score/max-score are typed numbers (never injectable), but
		// `late` and `override` go through stringifyOverride, which passes a
		// hand-edited STRING through verbatim — so they're guarded too (a
		// no-due assignment never overwrites a student-supplied `late`).
		out = append(out, metaCells(
			stringifyNumber(sub["score"]),
			stringifyNumber(sub["max-score"]),
			csvSafeCell(stringifyString(sub["datetime"])),
			csvSafeCell(stringifyString(sub["submission"])),
			csvSafeCell(submittedByUsername(sub)),
			csvSafeCell(stringifyString(sub["review"])),
			csvSafeCell(stringifyOverride(sub["late"])),
			override,
		))
	}
	return out
}

// csvSafeCell neutralizes CSV formula injection. A spreadsheet (Excel,
// Sheets, LibreOffice) evaluates a cell whose first character is one of
// = + - @ (or a leading tab / carriage return) as a formula. Several
// scores.csv columns carry student-controlled strings (a student owns
// their assignment repo and publishes the graded result.json), so a
// crafted value like "=HYPERLINK(\"http://evil\",\"click\")" would execute
// when the teacher opens the sheet. Go's encoding/csv quotes structural
// characters (comma, quote, newline) but does nothing about formulas, so
// we prefix a single quote to any at-risk cell. An empty cell is left
// untouched so blank columns stay blank.
func csvSafeCell(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}

// submittedByUsername returns the pusher login from a submission
// record's `submitted_by` block, or "" when absent/malformed. For a
// group submission the entry's `member_usernames` lists everyone
// credited, but this column shows who actually pushed each submission.
func submittedByUsername(sub map[string]any) string {
	by, ok := sub["submitted_by"].(map[string]any)
	if !ok {
		return ""
	}
	return stringifyString(by["username"])
}

// submissionRecords returns an entry's `submissions` history as a slice
// of maps (newest first). Tolerant of a hand-edited file: a missing
// or non-array `submissions`, or non-object entries, yield an empty
// slice / are skipped rather than erroring.
func submissionRecords(entry map[string]any) []map[string]any {
	raw, _ := entry["submissions"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, v := range raw {
		if m, ok := v.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// entriesForAssignment returns the entries for an assignment's bucket.
// The lookup is case-insensitive -- `assignment add` lowercases slugs on
// write and the CLI lowercases its argument, but a hand-edited scores.json
// key might not match exactly.
func entriesForAssignment(scores scoresschema.File, assignment string) []map[string]any {
	if bucket, ok := scores.Assignments[assignment]; ok {
		return bucket.Entries
	}
	for slug, bucket := range scores.Assignments {
		if strings.EqualFold(slug, assignment) {
			return bucket.Entries
		}
	}
	return nil
}

// creditedUsernames returns the lowercased set of usernames that already
// have a gradebook entry for the assignment in scores.json. Used so a
// group teammate who was fanned a score (but owns no derived repo) is not
// mistaken for a non-participant.
func creditedUsernames(scores scoresschema.File, assignment string) map[string]struct{} {
	out := make(map[string]struct{})
	for _, entry := range entriesForAssignment(scores, assignment) {
		for _, u := range entryCreditedUsernames(entry) {
			out[strings.ToLower(u)] = struct{}{}
		}
	}
	return out
}

// entryCreditedUsernames returns every student credited by a gradebook
// entry: a group entry's `member_usernames`, or — when that's absent
// (an individual entry) — the sole `owner`.
func entryCreditedUsernames(entry map[string]any) []string {
	if raw, ok := entry["member_usernames"].([]any); ok {
		out := make([]string, 0, len(raw))
		for _, v := range raw {
			if s, ok := v.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	if owner, ok := entry["owner"].(string); ok && owner != "" {
		return []string{owner}
	}
	return nil
}

// stringifyNumber: integer string for whole numbers, decimal
// otherwise. "" for nil/non-numeric so an absent or hand-typed
// entry round-trips cleanly into the CSV.
func stringifyNumber(v any) string {
	switch x := v.(type) {
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%v", x)
	case int:
		return fmt.Sprintf("%d", x)
	case int64:
		return fmt.Sprintf("%d", x)
	}
	return ""
}

// stringifyString returns "" for nil or non-string values.
func stringifyString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// stringifyOverride collapses bool/null/missing into "true" /
// "false" / "". A hand-edited string passes through so a teacher
// extending the schema (e.g. `"override": "verified"`) stays
// readable in the CSV.
func stringifyOverride(v any) string {
	switch x := v.(type) {
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return x
	}
	return ""
}

// refreshResultJSON writes the per-repo submission artifacts from the
// repo's submit-tag releases. It writes two files into <target>:
//
//   - results.json: a JSON array of every submit-tag submission
//     (newest first), each element {"submission_tag": <tag>,
//     "result": <result.json payload, or null when the release had no
//     result.json asset>}. This is the "collect all submissions"
//     artifact.
//   - result.json: the latest submission's result.json payload (the
//     historical single-latest behavior, preserved for back-compat
//     with anything reading <repo>/result.json directly).
//
// Silent no-op for: no releases, or no submit-tag release at all.
// Network/5xx/decode failures propagate so the caller can warn.
//
// Token and apiBase are resolved once in downloadByRoster — passing
// them in avoids per-row keyring/env lookups, and apiBase lets
// rewriteAssetURL retarget the asset host on GHES or test setups
// where the asset URL doesn't match the configured API.
func refreshResultJSON(client githubapi.Client, token, apiBase, org, repo, target string) error {
	releases, err := listAllSubmitReleases(client, org, repo)
	if err != nil {
		return err
	}
	if len(releases) == 0 {
		return nil
	}

	// Releases come back newest-first from the API; preserve that
	// order so results.json[0] is the most recent submission.
	history := make([]submissionRecord, 0, len(releases))
	for _, rel := range releases {
		assetURL, err := selectResultAsset(rel)
		if err != nil {
			return err
		}
		var payload json.RawMessage
		if assetURL != "" {
			body, err := downloadAssetBytes(token, rewriteAssetURL(assetURL, apiBase))
			if err != nil {
				return err
			}
			payload = json.RawMessage(body)
		}
		history = append(history, submissionRecord{
			SubmissionTag: rel.TagName,
			Result:        payload,
		})
	}

	historyBytes, err := json.MarshalIndent(history, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", resultsAssetName, err)
	}
	if err := os.WriteFile(filepath.Join(target, resultsAssetName), historyBytes, 0o644); err != nil {
		return err
	}

	// Back-compat: keep <repo>/result.json pointed at the latest
	// submission's payload (the first history entry with an asset).
	for _, rec := range history {
		if len(rec.Result) > 0 {
			return os.WriteFile(filepath.Join(target, resultAssetName), rec.Result, 0o644)
		}
	}
	return nil
}

// submissionRecord is one entry in <repo>/results.json: a submit-tag
// release and its result.json payload (null when the release carried
// no result.json asset). Result is held as RawMessage so the original
// bytes round-trip verbatim — download never needs to inspect them.
type submissionRecord struct {
	SubmissionTag string          `json:"submission_tag"`
	Result        json.RawMessage `json:"result"`
}

// release / releaseAsset: only the fields download consumes. Other
// keys (name, body, etc.) are intentionally absent so a malformed
// release doesn't fail decode for a key we don't use.
type release struct {
	TagName string         `json:"tag_name"`
	Assets  []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// listAllSubmitReleases returns every submit-tag release for a repo,
// newest first, walking the full /releases pagination. This is the
// "collect all submissions" walk: a student who pushed N times has N
// submit-tag releases, and all N are returned. Non-submit releases
// (e.g. a student's hand-created tag) are filtered out. Mirrors
// `all_submit_releases` in collect_scores.py.
func listAllSubmitReleases(client githubapi.Client, owner, repo string) ([]release, error) {
	all, err := githubapi.PaginateAll[release](client, allReleasesPerPage, allReleasesPagesMax,
		func(page int) string {
			return fmt.Sprintf("repos/%s/%s/releases?per_page=%d&page=%d",
				url.PathEscape(owner), url.PathEscape(repo), allReleasesPerPage, page)
		}, func(path string, err error) error {
			// A repo with no releases (or not accepted yet) 404s; treat
			// it as "no submissions" rather than a hard failure.
			if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
				return errNoReleases
			}
			return fmt.Errorf("GET %s: %w", path, err)
		})
	if errors.Is(err, errNoReleases) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	submits := make([]release, 0, len(all))
	for _, rel := range all {
		if strings.HasPrefix(rel.TagName, submitTagPrefix) {
			submits = append(submits, rel)
		}
	}
	return submits, nil
}

// errNoReleases signals a 404 on the releases walk (no releases yet
// or repo not accepted) so listAllSubmitReleases can map it to an
// empty result instead of a hard error.
var errNoReleases = errors.New("no releases")

// selectResultAsset returns the result.json asset URL. Empty when
// absent; error when the release carries more than one. Matches
// collect_scores.py's ambiguity rejection — the library uploads
// with --clobber, so normal releases have exactly one.
func selectResultAsset(rel release) (string, error) {
	var matches []string
	for _, a := range rel.Assets {
		if strings.EqualFold(a.Name, resultAssetName) {
			matches = append(matches, a.URL)
		}
	}
	switch len(matches) {
	case 0:
		return "", nil
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("release has %d %s assets (expected exactly one)", len(matches), resultAssetName)
	}
}

// apiBaseURL returns the REST base URL for `host`, matching go-gh's
// internal routing. github.com → https://api.github.com; everything
// else assumed to be GHES at https://<host>/api/v3.
func apiBaseURL(host string) string {
	host = strings.TrimSpace(host)
	if host == "" || host == "github.com" {
		return "https://api.github.com"
	}
	return "https://" + host + "/api/v3"
}

// rewriteAssetURL retargets an asset URL to the configured API
// host. GitHub's release JSON returns asset URLs on api.github.com
// even when the client is talking to a GHES box or a test server,
// so swap scheme+host (preserving any /api/v3 path prefix on the
// target) before downloading. Relative or otherwise-malformed
// inputs are returned unchanged so the caller still sees the
// original — defensive fallback for fixtures that don't include a
// host. Mirrors `rewrite_asset_url` in collect_scores.py.
func rewriteAssetURL(assetURL, apiBase string) string {
	parsedAsset, err := url.Parse(assetURL)
	if err != nil || parsedAsset.Scheme == "" || parsedAsset.Host == "" {
		return assetURL
	}
	parsedAPI, err := url.Parse(apiBase)
	if err != nil || parsedAPI.Scheme == "" || parsedAPI.Host == "" {
		return assetURL
	}
	path := parsedAsset.Path
	apiPrefix := strings.TrimRight(parsedAPI.Path, "/")
	if apiPrefix != "" && path != apiPrefix && !strings.HasPrefix(path, apiPrefix+"/") {
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		path = apiPrefix + path
	}
	out := url.URL{
		Scheme:   parsedAPI.Scheme,
		Host:     parsedAPI.Host,
		Path:     path,
		RawQuery: parsedAsset.RawQuery,
		Fragment: parsedAsset.Fragment,
	}
	return out.String()
}

// downloadAssetBytes fetches the asset body. The release-asset
// endpoint 302s to a signed storage URL when called with
// Accept: application/octet-stream. Go's stdlib strips
// Authorization on cross-host redirects; the explicit CheckRedirect
// is belt-and-suspenders defense, mirroring
// collect_scores.py's `_AuthStrippingRedirect`.
func downloadAssetBytes(token, assetURL string) ([]byte, error) {
	if token == "" {
		return nil, errors.New("no GitHub token available — run `gh auth login` or `gh teacher login`")
	}
	c := &http.Client{
		Timeout: assetDownloadTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 0 && req.URL.Host != via[0].URL.Host {
				req.Header.Del("Authorization")
			}
			return nil
		},
	}
	req, err := http.NewRequest(http.MethodGet, assetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "gh-teacher")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", assetURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d", assetURL, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResultBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", assetURL, err)
	}
	if int64(len(body)) > maxResultBytes {
		return nil, fmt.Errorf("asset exceeds %d byte ceiling", maxResultBytes)
	}
	return body, nil
}

// stderrTailCap bounds non-verbose stderr capture; the error lives
// at the tail.
const stderrTailCap = 8 * 1024

// cloneWithProgress clones one repo, rendering progress on the human
// channel. Interactive: a spinner (a single large repo can take many
// seconds). Non-TTY / --quiet: the historical stable stdout lines
// ("Cloning X... Done"), unchanged for piped/CI readers. Verbose: streams
// git's output with per-line "Cloning X" / "X: done".
//
// Returns the clone error (nil on success) so the caller records the
// failure and continues.
func cloneWithProgress(out, errOut io.Writer, org, repo, target string, quiet, verbose bool) error {
	sp := ghui.NewSpinner(errOut, "Cloning "+repo)
	interactive := sp.Active() && !quiet && !verbose

	// Skip the stdout lines when animating — the spinner shows the same
	// thing on stderr, and both would duplicate on a shared terminal.
	if !quiet && !interactive {
		if verbose {
			_, _ = fmt.Fprintf(out, "Cloning %s\n", repo)
		} else {
			_, _ = fmt.Fprintf(out, "Cloning %s... ", repo)
		}
	}
	if interactive {
		sp.Start()
	}

	err := cloneOrgRepo(out, errOut, org, repo, target, quiet, verbose)
	if err != nil {
		if interactive {
			sp.Fail("Cloning " + repo)
		} else if quiet {
			_, _ = fmt.Fprintf(errOut, "%s: clone failed: %v\n", repo, err)
		} else if verbose {
			_, _ = fmt.Fprintf(out, "%s: failed: %v\n", repo, err)
		} else {
			_, _ = fmt.Fprintf(out, "Failed: %v\n", err)
		}
		return err
	}
	if interactive {
		sp.Stop("Cloned " + repo)
	} else if !quiet {
		if verbose {
			_, _ = fmt.Fprintf(out, "%s: done\n", repo)
		} else {
			_, _ = fmt.Fprintln(out, "Done")
		}
	}
	return nil
}

// cloneOrgRepo shells out to `gh repo clone`. Verbose streams git's
// output; otherwise stdout is discarded and the tail of stderr is
// captured so failures carry git's diagnostic, not just
// "exit status 1".
func cloneOrgRepo(out, errOut io.Writer, org, repo, target string, quiet, verbose bool) error {
	args := []string{"repo", "clone", fmt.Sprintf("%s/%s", org, repo), target}
	if quiet {
		args = append(args, "--", "--quiet")
	}
	cmd := exec.Command("gh", args...)

	var stderrTail *tailWriter
	if verbose {
		cmd.Stdout = out
		cmd.Stderr = errOut
	} else {
		cmd.Stdout = io.Discard
		stderrTail = newTailWriter(stderrTailCap)
		cmd.Stderr = stderrTail
	}

	if err := cmd.Run(); err != nil {
		if stderrTail != nil {
			// Last line is git's actionable error (e.g. `fatal: ...`).
			if msg := lastNonEmptyLine(stderrTail.String()); msg != "" {
				return fmt.Errorf("%w: %s", err, msg)
			}
		}
		return err
	}
	return nil
}

// tailWriter retains only the last `cap` bytes written, to bound
// memory when capturing chatty stderr.
type tailWriter struct {
	buf []byte
	cap int
}

func newTailWriter(cap int) *tailWriter {
	return &tailWriter{cap: cap}
}

func (w *tailWriter) Write(p []byte) (int, error) {
	n := len(p)
	switch {
	case n >= w.cap:
		w.buf = append(w.buf[:0], p[n-w.cap:]...)
	case len(w.buf)+n <= w.cap:
		w.buf = append(w.buf, p...)
	default:
		drop := len(w.buf) + n - w.cap
		w.buf = append(w.buf[:0], w.buf[drop:]...)
		w.buf = append(w.buf, p...)
	}
	return n, nil
}

func (w *tailWriter) String() string {
	return string(w.buf)
}

// lastNonEmptyLine returns the last non-empty trimmed line.
func lastNonEmptyLine(s string) string {
	for i := len(s); i > 0; {
		j := strings.LastIndexByte(s[:i], '\n')
		line := strings.TrimSpace(s[j+1 : i])
		if line != "" {
			return line
		}
		if j < 0 {
			return ""
		}
		i = j
	}
	return ""
}
