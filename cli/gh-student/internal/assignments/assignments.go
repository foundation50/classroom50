// Package assignments owns the read side of the published classroom manifest:
// the token-less GitHub Pages fetch of `assignments.json` and the autograder
// workflow shim, plus the typed manifest shapes the student CLI consumes. The
// Pages site is public by design, so this uses a plain net/http client (no
// go-gh, no token) and depends only on the shared contract package + stdlib.
// Consumed by accept (entry + autograder fetch) and invite (entry, for the
// group-size cap).
package assignments

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// configRepoName is the fixed per-org classroom config repo created by
// `gh teacher init`. Hardcoded so the Pages URL builder stays aligned with the
// teacher CLI. Single-sourced in the shared contract package.
const configRepoName = contract.ConfigRepoName

// PagesFetchTimeout bounds Pages GETs; without it http.Client would hang on a
// slow CDN. Exported so callers running their own context-bounded work (e.g.
// invite's group-size check) can match it.
const PagesFetchTimeout = 15 * time.Second

// Entry mirrors `gh teacher assignment add`'s on-disk shape. Only the fields
// the student CLI needs are typed; unrecognized fields decode silently so
// future shape additions work without a flag day.
type Entry struct {
	Slug         string       `json:"slug"`
	Name         string       `json:"name"`
	Mode         string       `json:"mode"`
	MaxGroupSize int          `json:"max_group_size,omitempty"`
	Template     *TemplateRef `json:"template,omitempty"`
	Autograder   string       `json:"autograder"`
	AllowedFiles []string     `json:"allowed_files,omitempty"`

	// EmptyRepo marks a truly-bare assignment: accept creates the repo with
	// no initial commit and lands NO control files (no .classroom50.yaml, no
	// autograde shim), so the assignment never autogrades. Absent reads as
	// false (the teacher CLI omits it when false).
	EmptyRepo bool `json:"empty_repo,omitempty"`
}

// defaultAutograderName is the fallback when Entry.Autograder is empty.
// Single-sourced in the shared contract package.
const defaultAutograderName = contract.DefaultAutograderName

// ResolveAutograder returns the entry's autograder identifier with the
// default applied. Centralized so accept and submit can't drift.
func (e Entry) ResolveAutograder() string {
	if e.Autograder == "" {
		return defaultAutograderName
	}
	return e.Autograder
}

// HasTemplate reports whether the assignment has a complete starter-repo
// template. A template-less assignment (Template nil) is accepted as an
// empty repo carrying only the autograder shim.
func (e Entry) HasTemplate() bool {
	return e.Template != nil &&
		e.Template.Owner != "" && e.Template.Repo != "" && e.Template.Branch != ""
}

// TemplateRef is the assignment's starter-code source. All three fields are
// populated by `gh teacher assignment add` when a template is supplied; a
// template-less assignment omits the block (Template is nil).
type TemplateRef struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
}

// assignmentsFile is the top-level shape of assignments.json. Schema is
// checked first so a future v2 file surfaces "this CLI handles only v1" rather
// than silently dropping unknown entries.
type assignmentsFile struct {
	Schema      string  `json:"schema"`
	Assignments []Entry `json:"assignments"`
}

// assignmentsSchemaV1 is the only sentinel this CLI accepts. Single-sourced in
// the shared contract package.
const assignmentsSchemaV1 = contract.AssignmentsSchemaV1

// classroomPathSegment returns the per-classroom Pages path prefix:
// `<classroom>/<secret>` for a protected (unlisted) classroom, else the
// plain `<classroom>`. Empty secret means unprotected.
func classroomPathSegment(classroom, secret string) string {
	if secret == "" {
		return classroom
	}
	return classroom + "/" + secret
}

// pagesAssignmentsURL builds the Pages URL for a classroom's
// assignments.json, served under `<org>.github.io/classroom50/` per
// publish-pages.yaml. Secret-aware.
func pagesAssignmentsURL(org, classroom, secret string) string {
	return fmt.Sprintf("https://%s.github.io/%s/%s/assignments.json", org, configRepoName, classroomPathSegment(classroom, secret))
}

// pagesAutograderURL builds the Pages URL for a classroom's autograder
// workflow. Mirrors publish-pages.yaml's allow-list pattern (secret-aware).
func pagesAutograderURL(org, classroom, secret, name string) string {
	return fmt.Sprintf("https://%s.github.io/%s/%s/autograders/%s.yaml", org, configRepoName, classroomPathSegment(classroom, secret), name)
}

// FetchEntry finds the entry by slug in the Pages `assignments.json`. No auth
// — the Pages site is public. secret is the optional capability-URL segment
// (empty for an unprotected classroom). Thin wrapper around fetchEntryFromURL
// so tests can inject an httptest URL.
func FetchEntry(ctx context.Context, org, classroom, secret, assignment string) (Entry, error) {
	entry, err := fetchEntryFromURL(ctx, pagesAssignmentsURL(org, classroom, secret), assignment)
	if nf := new(NotFoundError); errors.As(err, &nf) {
		// Fill the org/classroom hints the inner function can't include in
		// its "run `gh teacher assignment add ...`" message.
		nf.Org = org
		nf.Classroom = classroom
		return entry, nf
	}
	// A whole-manifest 404 on a protected classroom is usually a wrong or
	// missing --key (the manifest lives at <classroom>/<secret>/), not a Pages
	// problem. The inner 404 can't tell; augment it here where the key is in
	// scope.
	if errors.Is(err, errManifestNotFound) {
		if secret != "" {
			return entry, fmt.Errorf("%w; the access key (--key) may be wrong — double-check the key your instructor gave you", err)
		}
		return entry, fmt.Errorf("%w; if this is an unlisted classroom, you must pass the access key your instructor gave you with `--key <key>`", err)
	}
	return entry, err
}

// fetchEntryFromURL is the HTTP-bearing core. Returns actionable messages for
// network failures, 404, and schema mismatches; a missing slug returns a typed
// NotFoundError. Mode rejection happens at the call site.
func fetchEntryFromURL(ctx context.Context, rawURL, assignment string) (Entry, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return Entry{}, fmt.Errorf("build GET %s: %w", rawURL, err)
	}
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: PagesFetchTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return Entry{}, fmt.Errorf("GET %s: %w (the classroom50 Pages site may not be deployed yet — ask your instructor to verify `publish-pages.yaml` has run successfully)", rawURL, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return Entry{}, fmt.Errorf("%s returned 404 — the classroom may not exist yet, or `publish-pages.yaml` may not have run; ask your instructor to confirm the Pages site has deployed: %w", rawURL, errManifestNotFound)
	}
	if resp.StatusCode != http.StatusOK {
		return Entry{}, fmt.Errorf("GET %s: unexpected status %d", rawURL, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if err != nil {
		return Entry{}, fmt.Errorf("read %s: %w", rawURL, err)
	}

	var file assignmentsFile
	if err := json.Unmarshal(body, &file); err != nil {
		return Entry{}, fmt.Errorf("parse %s: %w", rawURL, err)
	}
	if file.Schema != assignmentsSchemaV1 {
		return Entry{}, fmt.Errorf("%s: schema = %q, want %q — this gh-student version is older than the assignments.json shape; update gh-student and try again",
			rawURL, file.Schema, assignmentsSchemaV1)
	}

	for _, entry := range file.Assignments {
		if entry.Slug == assignment {
			return entry, nil
		}
	}
	return Entry{}, &NotFoundError{
		Assignment: assignment,
		URL:        rawURL,
	}
}

// errManifestNotFound flags a whole-manifest 404 (vs NotFoundError, which
// means the manifest loaded but lacks the slug) so FetchEntry can add a
// key-aware hint. Matched via errors.Is.
var errManifestNotFound = errors.New("assignments manifest not found (404)")

// NotFoundError means the Pages fetch succeeded but the requested slug isn't
// in the manifest. Typed so callers can branch without matching error text.
type NotFoundError struct {
	Org        string
	Classroom  string
	Assignment string
	URL        string
}

func (e *NotFoundError) Error() string {
	if e.Org != "" && e.Classroom != "" {
		return fmt.Sprintf("assignment %q is not registered in %s — ask your instructor to run `gh teacher assignment add %s %s %s`",
			e.Assignment, e.URL, e.Org, e.Classroom, e.Assignment)
	}
	return fmt.Sprintf("assignment %q is not registered in %s — ask your instructor to run `gh teacher assignment add`",
		e.Assignment, e.URL)
}

// IsNotFound reports whether err wraps NotFoundError.
func IsNotFound(err error) bool {
	var nf *NotFoundError
	return errors.As(err, &nf)
}

// AutogradeWorkflow is the result of a Pages autograder fetch. Content is the
// raw workflow shim body dropped at `.github/workflows/autograde.yaml`. The
// shim is intentionally stable — it `uses:` the reusable autograde-runner
// workflow in the config repo, which fetches the runner-side bootstrap
// (runner.py) and the autograder fresh on every submission, so a stale shim
// still grades against the latest teacher-side logic.
type AutogradeWorkflow struct {
	Content string
}

// FetchAutograderWorkflow fetches `<classroom>/autograders/<name>.yaml` from
// Pages. Unauth — the publish-pages allow-list keeps the directory public.
// Thin wrapper around fetchAutograderWorkflowFromURL for testability.
func FetchAutograderWorkflow(ctx context.Context, org, classroom, secret, name string) (AutogradeWorkflow, error) {
	return fetchAutograderWorkflowFromURL(ctx, pagesAutograderURL(org, classroom, secret, name), name)
}

// fetchAutograderWorkflowFromURL is the HTTP-bearing core. Actionable shapes:
// 404 → "not published yet", network/unexpected status → wrapped, empty body →
// "deployment still in flight, retry". YAML is validated before returning so
// malformed bodies fail at fetch time instead of inside Actions logs.
func fetchAutograderWorkflowFromURL(ctx context.Context, rawURL, name string) (AutogradeWorkflow, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return AutogradeWorkflow{}, fmt.Errorf("build GET %s: %w", rawURL, err)
	}
	req.Header.Set("Accept", "text/yaml, text/plain, */*;q=0.5")

	client := &http.Client{Timeout: PagesFetchTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return AutogradeWorkflow{}, fmt.Errorf("GET %s: %w (the classroom50 Pages site may not be deployed yet — ask your instructor to verify `publish-pages.yaml` has run successfully)", rawURL, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return AutogradeWorkflow{}, fmt.Errorf("autograder %q not published yet (%s returned 404) — ask your instructor to confirm that file exists in the config repo and that `publish-pages.yaml` has run", name, rawURL)
	}
	if resp.StatusCode != http.StatusOK {
		return AutogradeWorkflow{}, fmt.Errorf("GET %s: unexpected status %d", rawURL, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if err != nil {
		return AutogradeWorkflow{}, fmt.Errorf("read %s: %w", rawURL, err)
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return AutogradeWorkflow{}, fmt.Errorf("GET %s: empty body — the Pages deployment may still be in flight; retry in a minute", rawURL)
	}

	// Decode into `any` to validate YAML well-formedness without imposing
	// schema on the workflow body. Teachers can write any shape that
	// satisfies the autograder contract (submit-tag trigger, `result.json`
	// release asset, `classroom50/autograde` commit status).
	var sink any
	if err := yaml.Unmarshal(body, &sink); err != nil {
		return AutogradeWorkflow{}, fmt.Errorf("autograder %q is malformed YAML (parsed from %s) — ask your instructor to check the file in the config repo: %w", name, rawURL, err)
	}

	return AutogradeWorkflow{Content: string(body)}, nil
}
