// Package assignment is the pure data layer for a single assignments.json
// entry (plus its tests[] and runtime{} sub-objects): parse, validate,
// re-encode, no GitHub I/O.
//
// Security invariant: assignments.json is untrusted, hand-editable, so the
// runtime/container blocks are validated on the parse path (not only at write
// time). Callers must obtain entries through these entry points and must not
// emit a RuntimeRef/ContainerSpec into a workflow without ValidateRuntime/
// ValidateContainer having run — the validators are the anti-injection trust
// boundary (see runtime.go).
package assignment

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// Assignment modes, single-sourced from the shared contract: `individual`
// (one repo per student) and `group` (a shared repo, bounded by
// max_group_size).
const (
	ModeIndividual = contract.ModeIndividual
	ModeGroup      = contract.ModeGroup
)

// AssignmentModes is the allow-list, sorted so error messages stay stable.
var AssignmentModes = []string{ModeGroup, ModeIndividual}

func IsValidAssignmentMode(m string) bool {
	for _, allowed := range AssignmentModes {
		if m == allowed {
			return true
		}
	}
	return false
}

// LargeAssignmentsWarnBytes is the encoded-size threshold above which
// `assignment add` warns on stderr. Set well below GitHub's ~1 MiB
// contents-API limit (past which encoding flips to "none", wedging every
// future read/write). Diagnostic only — no hard cap.
const LargeAssignmentsWarnBytes = 700 * 1024

// AssignmentsJSON is the typed on-disk shape of assignments.json. Schema
// sentinel first so readers can branch before the rest. Assignments always
// serializes as `[]` (never null).
type AssignmentsJSON struct {
	Schema      string            `json:"schema"`
	Assignments []AssignmentEntry `json:"assignments"`
}

// AssignmentEntry is one row in assignments.json. Field order reads
// top-to-bottom for a teacher inspecting the file. Mode and Autograder always
// serialize (no omitempty) so consumers don't disambiguate "absent → default"
// from "explicit default".
//
// Tests is the optional declarative-grading layer (see tests.go), materialized
// into the Pages bundle as tests.json. Grade-time entrypoint precedence:
// per-assignment autograder.py > tests.json > classroom default autograder.py
// > vacuous pass. See wiki/Autograders.md.
//
// MaxGroupSize bounds collaborators on a group repo: required (>= 2) for group
// mode, must be 0 for individual. Enforced at join time in the CLI — direct
// GitHub-UI invites can exceed it (documented limitation).
//
// FeedbackPR opts into one long-lived per-repo Feedback PR (base = frozen
// baseline branch, head = default branch) for inline diff review. Product
// default is on, but omitempty drops it when false, so absent reads as false.
//
// AllowedFiles is ordered .gitignore-style patterns for which files belong to
// the submission (last match wins, `!` re-includes); empty/absent allows all.
// The runner enforces it by removing disallowed files before grading.
//
// EmptyRepo opts into truly bare student repos: accept creates the repo with
// no initial commit and lands NO control files (no README, no
// .classroom50.yaml marker, no autograde shim), so autograding and the
// Feedback PR never run. Mutually exclusive with Template, Tests, FeedbackPR,
// AllowedFiles, and PassThreshold, and IMMUTABLE once the entry exists —
// flipping it later would mean retrofitting every already-accepted repo.
// Mirrors FeedbackPR's wire shape: omitempty, absent reads as false.
type AssignmentEntry struct {
	Slug          string           `json:"slug"`
	Name          string           `json:"name"`
	Description   string           `json:"description,omitempty"`
	Template      *TemplateRef     `json:"template,omitempty"`
	Due           string           `json:"due,omitempty"`
	DueMeta       *DueMeta         `json:"due_meta,omitempty"`
	Mode          string           `json:"mode"`
	Autograder    string           `json:"autograder"`
	MaxGroupSize  int              `json:"max_group_size,omitempty"`
	Runtime       *RuntimeRef      `json:"runtime,omitempty"`
	Tests         []TestSpec       `json:"tests,omitempty"`
	FeedbackPR    bool             `json:"feedback_pr,omitempty"`
	EmptyRepo     bool             `json:"empty_repo,omitempty"`
	AllowedFiles  []string         `json:"allowed_files,omitempty"`
	PassThreshold *int             `json:"pass_threshold,omitempty"`
	MigratedFrom  *MigratedFromRef `json:"migrated_from,omitempty"`

	// Extra holds unknown top-level entry keys, re-emitted verbatim so a
	// read-modify-write never drops a field a newer binary/GUI added.
	// Merged in/out by the custom (Un)MarshalJSON below.
	Extra map[string]json.RawMessage `json:"-"`
}

// knownEntryKeys is the entry keys this binary understands; any other key is
// diverted to Extra. Keep in lockstep with AssignmentEntry's json tags.
var knownEntryKeys = map[string]struct{}{
	"slug": {}, "name": {}, "description": {}, "template": {}, "due": {},
	"due_meta": {}, "mode": {}, "autograder": {}, "max_group_size": {},
	"runtime": {}, "tests": {}, "feedback_pr": {}, "empty_repo": {},
	"allowed_files": {}, "pass_threshold": {}, "migrated_from": {},
}

// UnmarshalJSON captures unknown top-level keys into Extra, then strictly
// decodes the known subset. Unknown keys must be stripped first because
// DisallowUnknownFields is all-or-nothing per decoder — stripping lets the
// typed sub-objects stay strict (a typo inside tests/template/runtime/due_meta
// is still a hard error).
func (e *AssignmentEntry) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	known := make(map[string]json.RawMessage, len(raw))
	var extra map[string]json.RawMessage
	for k, v := range raw {
		if _, ok := knownEntryKeys[k]; ok {
			known[k] = v
			continue
		}
		if extra == nil {
			extra = make(map[string]json.RawMessage)
		}
		extra[k] = v
	}

	knownBytes, err := json.Marshal(known)
	if err != nil {
		return err
	}
	type entryAlias AssignmentEntry // avoid recursion into this method
	var typed entryAlias
	dec := json.NewDecoder(bytes.NewReader(knownBytes))
	dec.DisallowUnknownFields() // still strict on the known sub-objects
	if err := dec.Decode(&typed); err != nil {
		return err
	}
	*e = AssignmentEntry(typed)
	e.Extra = extra
	return nil
}

// MarshalJSON emits the known fields via the alias, then byte-splices any
// sorted Extra keys before the closing brace. The splice (vs a map round-trip)
// preserves the known fields' struct order.
func (e AssignmentEntry) MarshalJSON() ([]byte, error) {
	type entryAlias AssignmentEntry
	known, err := json.Marshal(entryAlias(e))
	if err != nil {
		return nil, err
	}
	if len(e.Extra) == 0 {
		return known, nil
	}
	keys := make([]string, 0, len(e.Extra))
	for k := range e.Extra {
		if _, isKnown := knownEntryKeys[k]; isKnown {
			continue // defensive: never let Extra override a known field
		}
		keys = append(keys, k)
	}
	if len(keys) == 0 {
		return known, nil
	}
	sort.Strings(keys) // deterministic output

	// Splice Extra members before `known`'s closing brace. The alias always
	// emits slug/name/mode/autograder, so `known` is never "{}" and the
	// leading comma is always correct.
	var buf bytes.Buffer
	trimmed := bytes.TrimSpace(known)
	buf.Write(trimmed[:len(trimmed)-1]) // everything up to the final '}'
	for _, k := range keys {
		buf.WriteByte(',')
		keyJSON, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(keyJSON)
		buf.WriteByte(':')
		buf.Write(e.Extra[k])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// MaxGroupSizeCap bounds max_group_size (when set; 0 = unset).
const MaxGroupSizeCap = 100

func ValidateMaxGroupSize(n int) error {
	if n < 0 || n > MaxGroupSizeCap {
		return fmt.Errorf("max_group_size %d out of range (0 = unset/individual, or 2..%d for group mode)", n, MaxGroupSizeCap)
	}
	return nil
}

// PassThreshold is an opt-in advisory passing bar: the integer percentage of
// max score (0..100) at/above which a gradebook client shows "passing". A
// pointer, not int+omitempty, because 0 is a legal threshold, so unset must
// stay distinct from 0 (absent = feature OFF). CLI-unenforced: only clients
// like the GUI read it.
const (
	PassThresholdMin = 0
	PassThresholdMax = 100
)

// ValidatePassThreshold checks an optional pass_threshold. A nil pointer
// (absent) is valid — the feature is off; a present value must be 0..100.
func ValidatePassThreshold(n *int) error {
	if n == nil {
		return nil
	}
	if *n < PassThresholdMin || *n > PassThresholdMax {
		return fmt.Errorf("pass_threshold %d out of range (%d..%d)", *n, PassThresholdMin, PassThresholdMax)
	}
	return nil
}

// AllowedFilesCap bounds the number of allowed_files patterns, a sanity
// ceiling mirroring the tests[] maxItems bound.
const AllowedFilesCap = 100

// ValidateAllowedFiles rejects empty/whitespace-only patterns and ones
// containing NUL or newline (they're written one-per-line into a .gitignore,
// where a newline would smuggle an extra rule). A nil/empty list is valid.
func ValidateAllowedFiles(patterns []string) error {
	if len(patterns) > AllowedFilesCap {
		return fmt.Errorf("allowed_files has %d patterns (max %d)", len(patterns), AllowedFilesCap)
	}
	for i, p := range patterns {
		if strings.TrimSpace(p) == "" {
			return fmt.Errorf("allowed_files[%d] must not be empty", i)
		}
		if strings.ContainsAny(p, "\x00\n") {
			return fmt.Errorf("allowed_files[%d] %q must not contain NUL or newline", i, p)
		}
	}
	return nil
}

// DueMeta is write-side provenance for `due`. Because `due` is normalized to a
// UTC instant (losing the teacher's wall-clock and offset), this records what
// was supplied so a wrong-zone deadline can be audited. Advisory only.
//
// Input is the supplied value, whitespace-trimmed but otherwise verbatim.
// Offset is the zone offset applied at normalization ([+-]HH:MM). Zone is the
// best-effort IANA/local zone name, set only when the offset was auto-detected.
// Source records how the zone was determined.
type DueMeta struct {
	Input  string `json:"input"`
	Zone   string `json:"zone,omitempty"`
	Offset string `json:"offset"`
	Source string `json:"source"`
}

// due_meta.source values: the offset came from the input itself, was
// auto-detected from the machine's local zone, or was carried in from
// a migrated source deadline.
const (
	DueSourceExplicit = "explicit-offset"
	DueSourceAuto     = "auto-detected"
	DueSourceMigrated = "migrated"
)

// dueMetaOffsetRe matches the [+-]HH:MM offset written into due_meta.offset,
// kept in lockstep with the schema's pattern.
var dueMetaOffsetRe = regexp.MustCompile(`^[+-]([01]\d|2[0-3]):[0-5]\d$`)

// NewDueMeta builds the provenance block for the --due and migrate paths.
// Callers set Zone separately when the offset was auto-detected.
func NewDueMeta(input string, t time.Time, source string) *DueMeta {
	return &DueMeta{Input: input, Offset: t.Format("-07:00"), Source: source}
}

// ValidateDueMeta checks a due_meta block against the same shape the schema
// enforces, so a malformed block from a GUI or hand-edit is rejected here too.
// Presence is not required; callers only invoke this when the block exists.
func ValidateDueMeta(m *DueMeta) error {
	if m.Input == "" {
		return errors.New("due_meta.input must not be empty")
	}
	if !dueMetaOffsetRe.MatchString(m.Offset) {
		return fmt.Errorf("due_meta.offset %q must be a [+-]HH:MM zone offset", m.Offset)
	}
	switch m.Source {
	case DueSourceExplicit, DueSourceAuto, DueSourceMigrated:
	default:
		return fmt.Errorf("due_meta.source %q must be one of %q, %q, %q",
			m.Source, DueSourceExplicit, DueSourceAuto, DueSourceMigrated)
	}
	return nil
}

// dueNaiveLayout is the RFC 3339 local-datetime shape with no zone. A
// zone-less --due is parsed with this layout in the machine's local zone, then
// normalized to UTC.
const dueNaiveLayout = "2006-01-02T15:04:05"

// ParseDueTime parses a due value as either a full RFC 3339 timestamp (offset
// present → hadOffset true) or a zone-less local datetime interpreted in loc
// (hadOffset false). Callers normalize to UTC for storage. Sub-second
// precision is accepted but dropped on the UTC re-format.
func ParseDueTime(raw string, loc *time.Location) (parsed time.Time, hadOffset bool, err error) {
	if parsed, err = time.Parse(time.RFC3339, raw); err == nil {
		return parsed, true, nil
	}
	if parsed, err = time.ParseInLocation(dueNaiveLayout, raw, loc); err == nil {
		return parsed, false, nil
	}
	return time.Time{}, false, fmt.Errorf(
		"due %q is not a valid date/time; use an RFC 3339 timestamp "+
			"(2026-09-15T23:59:00-04:00) or a local time (2026-09-15T23:59:00)", raw)
}

// ValidateDueDate guards the stored form: empty (no deadline) or an RFC 3339
// timestamp with an offset — anything the CLI produces. Stays strict on read:
// a hand-edited zone-less value is rejected rather than guessed, since there's
// no knowable machine zone to attach. Naive-input tolerance lives only in
// ParseDueTime.
func ValidateDueDate(due string) error {
	if due == "" {
		return nil
	}
	if _, err := time.Parse(time.RFC3339, due); err != nil {
		return fmt.Errorf("due %q is not an RFC 3339 timestamp with timezone (e.g. 2026-09-15T23:59:00-04:00)", due)
	}
	return nil
}

// MigratedFromRef records where an assignment originated when imported by
// `classroom migrate`. Hand-authored entries never carry it. OriginalSlug is
// set only when it differs from Slug; StarterRepo is the legacy "owner/repo"
// before re-templating; InviteLink is diagnostic.
type MigratedFromRef struct {
	Source       string `json:"source"`
	ClassroomID  int64  `json:"classroom_id"`
	AssignmentID int64  `json:"assignment_id"`
	OriginalSlug string `json:"original_slug,omitempty"`
	StarterRepo  string `json:"starter_repo,omitempty"`
	InviteLink   string `json:"invite_link,omitempty"`
	MigratedAt   string `json:"migrated_at"`
}

// TemplateRef is the assignment's starter-code source. Three explicit fields
// (not "owner/repo@branch") so consumers don't re-parse; Branch is resolved to
// the template's default_branch when `@branch` is omitted. Optional: a
// template-less assignment omits the block (Template is nil), and `student
// accept` creates an empty repo carrying only the autograder shim.
type TemplateRef struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
}

// RuntimeRef captures the autograde job's runtime environment, dispatched into
// the runner's `runs-on` / `container` / toolchain / apt steps.
//
// Two mutually-exclusive paths:
//
//  1. Host runner — set RunsOn plus optional language fields and Apt packages.
//  2. Container image — set Container.Image; the image owns the environment,
//     so Apt is forbidden. Language fields still apply (setup-X runs inside).
//
// RunsOn mirrors Actions' `runs-on`: a single label or an array for
// custom/self-hosted runners. No value allow-list — the teacher owns the
// label; each is only injection-checked (RunsOnLabelPattern) since it flows
// verbatim into the workflow.
//
// All fields optional; an absent RuntimeRef means defaults (ubuntu-latest +
// Python 3.12, no extra packages).
type RuntimeRef struct {
	RunsOn    RunsOn         `json:"runs-on,omitempty"`
	Container *ContainerSpec `json:"container,omitempty"`
	Python    string         `json:"python,omitempty"`
	Node      string         `json:"node,omitempty"`
	Java      string         `json:"java,omitempty"`
	Go        string         `json:"go,omitempty"`
	Rust      string         `json:"rust,omitempty"`
	Apt       []string       `json:"apt,omitempty"`
}

// RunsOn models Actions' polymorphic `runs-on` (single label or array),
// normalized to a []string. Empty means default (ubuntu-latest) and is
// omitted. MarshalJSON preserves the author's shape: one label round-trips as
// a string, many as an array.
type RunsOn []string

func (r RunsOn) MarshalJSON() ([]byte, error) {
	if len(r) == 1 {
		return json.Marshal(r[0])
	}
	return json.Marshal([]string(r))
}

// UnmarshalJSON accepts a string, array of strings, or null/absent (= default).
// The present-but-empty shapes ("" and []) are rejected so this parser, the
// runner's inline validator, and the schema all agree that only an OMITTED
// runs-on means default. Any other shape is a hard error.
func (r *RunsOn) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		*r = nil
		return nil
	}
	switch trimmed[0] {
	case '"':
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return err
		}
		if s == "" {
			return errors.New(`runtime.runs-on must not be an empty string; omit the field to use the default (ubuntu-latest)`)
		}
		*r = RunsOn{s}
		return nil
	case '[':
		var labels []string
		if err := json.Unmarshal(trimmed, &labels); err != nil {
			return fmt.Errorf("runtime.runs-on array must contain only strings: %w", err)
		}
		if len(labels) == 0 {
			return errors.New(`runtime.runs-on must not be an empty array; omit the field to use the default (ubuntu-latest)`)
		}
		*r = RunsOn(labels)
		return nil
	default:
		return fmt.Errorf("runtime.runs-on must be a label string or an array of label strings, got %s", string(trimmed))
	}
}

// ContainerSpec is the `runtime.container` block: the image to grade in, plus
// an optional User.
//
// The image must be publicly pullable: the grade job runs inside the
// student-admin'd repo, where Actions offers no safe way to deliver a
// private-registry pull secret, so private images are out of scope.
//
// User is translated to `container.options: --user <value>` — Actions rejects
// `container.user` directly, but a non-root image (cs50/cli) hits EACCES when
// actions/checkout writes under `/__w/_temp/`; `user: root` is the workaround.
type ContainerSpec struct {
	Image string `json:"image"`
	User  string `json:"user,omitempty"`
}

// AssignmentsFilePath is the config-repo-relative path to a classroom's
// assignments.json. Single-sourced so read and write paths agree.
func AssignmentsFilePath(classroom string) string {
	return classroom + "/assignments.json"
}

// ParseAssignments decodes assignments.json in two passes: a lenient pass
// reads only the schema sentinel (so a future v2 surfaces "this CLI handles
// only v1" instead of "json: unknown field"); the strict pass runs on v1.
//
// The top-level envelope stays strict (DisallowUnknownFields), but each entry
// tolerates and round-trips unknown keys via Extra — the forward-compat path a
// newer binary/GUI relies on. Known sub-objects stay strictly typed.
// Per-entry validation still runs on every known field so a hand-edited entry
// can't re-bless itself.
//
// No hard size cap: per-assignment tests live as files, not inlined, so
// manifests stay under the ~1 MiB contents-API threshold; `assignment add`
// warns past LargeAssignmentsWarnBytes.
func ParseAssignments(data []byte) (AssignmentsJSON, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return AssignmentsJSON{}, errors.New("assignments.json is empty")
	}
	var probe struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return AssignmentsJSON{}, fmt.Errorf("parse assignments.json: %w", err)
	}
	if probe.Schema != contract.AssignmentsSchemaV1 {
		return AssignmentsJSON{}, fmt.Errorf("assignments.json schema = %q, want %q (this CLI handles only v1)",
			probe.Schema, contract.AssignmentsSchemaV1)
	}
	var file AssignmentsJSON
	dec := json.NewDecoder(bytes.NewReader(data))
	// Strict at the ENVELOPE level only (rejects unknown top-level keys). It
	// doesn't recurse into entries: AssignmentEntry.UnmarshalJSON does its own
	// strict decode and captures unknown keys into Extra.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		return AssignmentsJSON{}, fmt.Errorf("parse assignments.json: %w", err)
	}
	// Reject trailing content; otherwise the next re-encode silently drops it.
	if err := expectEOF(dec); err != nil {
		return AssignmentsJSON{}, fmt.Errorf("parse assignments.json: %w", err)
	}
	// `"template": null` decodes to a nil *TemplateRef ("template-less"), but
	// the schema types template as an object and rejects null. Keep the two
	// contracts in lockstep: template-less OMITS the key; explicit null fails.
	if err := rejectExplicitNullTemplates(data); err != nil {
		return AssignmentsJSON{}, fmt.Errorf("parse assignments.json: %w", err)
	}
	// Callers depend on Assignments marshaling as `[]`, not `null`. Empty
	// Autograder normalizes to "default" for a uniform downstream shape.
	if file.Assignments == nil {
		file.Assignments = []AssignmentEntry{}
	}
	for i, entry := range file.Assignments {
		if err := ValidateExistingEntry(entry); err != nil {
			return AssignmentsJSON{}, fmt.Errorf("assignments[%d]: %w", i, err)
		}
		if file.Assignments[i].Autograder == "" {
			file.Assignments[i].Autograder = contract.DefaultAutograderName
		}
	}
	return file, nil
}

// rejectExplicitNullTemplates fails when any assignment carries an explicit
// `"template": null`. The struct decode collapses null and absent to a nil
// *TemplateRef, but the schema types template as an object and rejects null, so
// accepting null would diverge CLI from GUI. Template-less must omit the key.
func rejectExplicitNullTemplates(data []byte) error {
	var raw struct {
		Assignments []map[string]json.RawMessage `json:"assignments"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		// The strict decode already succeeded, so a re-parse failure here
		// would be surprising; surface it rather than skipping the check.
		return fmt.Errorf("re-scan for null template: %w", err)
	}
	for i, entry := range raw.Assignments {
		tmpl, present := entry["template"]
		if present && string(bytes.TrimSpace(tmpl)) == "null" {
			return fmt.Errorf("assignments[%d]: template must be an object or omitted, not null", i)
		}
	}
	return nil
}

// EncodeAssignments serializes via output.JSONPretty (2-space, trailing
// newline) so diffs stay stable. Normalizes nil → [] and empty Autograder →
// default. Per-entry validation is the caller's job. Normalization runs on a
// local copy so callers never observe slice mutation.
func EncodeAssignments(file AssignmentsJSON) ([]byte, error) {
	out := file
	if out.Schema == "" {
		out.Schema = contract.AssignmentsSchemaV1
	}
	if len(out.Assignments) == 0 {
		out.Assignments = []AssignmentEntry{}
	} else {
		// Copy the backing array so normalization doesn't leak into the
		// caller's slice.
		copied := make([]AssignmentEntry, len(out.Assignments))
		copy(copied, out.Assignments)
		out.Assignments = copied
		for i := range out.Assignments {
			if out.Assignments[i].Autograder == "" {
				out.Assignments[i].Autograder = contract.DefaultAutograderName
			}
		}
	}
	return output.JSONPretty(out)
}

// UpsertAssignment replaces by Slug (case-sensitive: the slug validator is
// lowercase-only, so case-insensitive matching would just hide typos).
// Position preserved on replace; new slugs append. Returns the slice and
// whether a row was replaced.
func UpsertAssignment(entries []AssignmentEntry, entry AssignmentEntry) ([]AssignmentEntry, bool) {
	for i := range entries {
		if entries[i].Slug == entry.Slug {
			entries[i] = entry
			return entries, true
		}
	}
	return append(entries, entry), false
}

// FindAssignment returns the index of the entry with matching Slug
// (case-sensitive, mirroring UpsertAssignment) and whether it was found.
func FindAssignment(entries []AssignmentEntry, slug string) (int, bool) {
	for i := range entries {
		if entries[i].Slug == slug {
			return i, true
		}
	}
	return -1, false
}

// SlugExistsFold reports whether any entry's slug equals `slug`
// case-insensitively. Slugs become GitHub repo path segments, which GitHub
// treats case-insensitively, so a case-only difference still collides.
func SlugExistsFold(entries []AssignmentEntry, slug string) bool {
	for i := range entries {
		if strings.EqualFold(entries[i].Slug, slug) {
			return true
		}
	}
	return false
}

// slugMaxLen is the max slug length validate.ShortName accepts (39 chars).
// Duplicated here (not imported) so the pure data layer stays free of the
// command seam.
const slugMaxLen = 39

// slugSuffixRe splits a slug into base + optional trailing `-N` (N >= 1):
// `hello` → ("hello", 0); `hello-2` → ("hello", 2).
var slugSuffixRe = regexp.MustCompile(`^(.*)-([1-9][0-9]*)$`)

// NextAvailableSlug returns a slug that doesn't collide (case-insensitively),
// auto-suffixing `-2`, `-3`, …; a base already ending in `-N` increments from
// N+1. Returns the input unchanged when already free.
//
// A candidate overflowing slugMaxLen returns an actionable error rather than
// an over-long slug. A free-but-over-cap input is returned unchanged (the
// caller's validation surfaces it).
func NextAvailableSlug(entries []AssignmentEntry, slug string) (string, error) {
	if !SlugExistsFold(entries, slug) {
		return slug, nil
	}
	base := slug
	start := 2
	if m := slugSuffixRe.FindStringSubmatch(slug); m != nil {
		base = m[1]
		// m[2] is a non-empty digit run with no leading zero, so Atoi always
		// succeeds; start one past it.
		n, _ := strconv.Atoi(m[2])
		start = n + 1
	}
	for n := start; ; n++ {
		candidate := fmt.Sprintf("%s-%d", base, n)
		if len(candidate) > slugMaxLen {
			return "", fmt.Errorf("cannot auto-suffix slug %q: every candidate (e.g. %q) exceeds the %d-character slug cap — pass an explicit, shorter --slug",
				slug, candidate, slugMaxLen)
		}
		if !SlugExistsFold(entries, candidate) {
			return candidate, nil
		}
	}
}

// RemoveAssignment drops by Slug (case-sensitive, mirroring
// UpsertAssignment). Returns the slice and whether a row was removed.
func RemoveAssignment(entries []AssignmentEntry, slug string) ([]AssignmentEntry, bool) {
	for i := range entries {
		if entries[i].Slug == slug {
			return append(entries[:i], entries[i+1:]...), true
		}
	}
	return entries, false
}

// ValidateAssignmentEntry is the write-path check. Same structural bar as
// ValidateExistingEntry; only wording differs — write errors reference CLI
// flags, parse errors reference the file. Field order is cheapest-first.
func ValidateAssignmentEntry(entry AssignmentEntry) error {
	if entry.Slug == "" {
		return errors.New("slug must not be empty")
	}
	if err := validate.ShortName(entry.Slug, "slug"); err != nil {
		return err
	}
	if entry.Name == "" {
		return errors.New("name must not be empty (use --name)")
	}
	if entry.Mode == "" {
		return errors.New("mode must not be empty")
	}
	if !IsValidAssignmentMode(entry.Mode) {
		return fmt.Errorf("invalid mode %q: must be one of %v", entry.Mode, AssignmentModes)
	}
	// Template is optional; when present, all three fields must be set.
	if entry.Template != nil {
		if entry.Template.Owner == "" || entry.Template.Repo == "" {
			return errors.New("template owner/repo must not be empty")
		}
		if entry.Template.Branch == "" {
			return errors.New("template branch must not be empty")
		}
	}
	if err := ValidateDueDate(entry.Due); err != nil {
		return err
	}
	if entry.DueMeta != nil {
		if err := ValidateDueMeta(entry.DueMeta); err != nil {
			return err
		}
	}
	if entry.Autograder == "" {
		return fmt.Errorf("autograder must not be empty (default is %q)", contract.DefaultAutograderName)
	}
	if err := validate.ShortName(entry.Autograder, "autograder"); err != nil {
		return err
	}
	if err := ValidateMaxGroupSize(entry.MaxGroupSize); err != nil {
		return err
	}
	// Group must carry a usable limit (>= 2); individual must carry none.
	switch entry.Mode {
	case ModeGroup:
		if entry.MaxGroupSize < 2 {
			return fmt.Errorf("group assignment %q must set max_group_size >= 2 (got %d)", entry.Slug, entry.MaxGroupSize)
		}
	case ModeIndividual:
		if entry.MaxGroupSize != 0 {
			return fmt.Errorf("individual assignment %q must not set max_group_size (got %d)", entry.Slug, entry.MaxGroupSize)
		}
	}
	if entry.Runtime != nil {
		if err := ValidateRuntime(*entry.Runtime); err != nil {
			return err
		}
	}
	if len(entry.Tests) > 0 {
		if err := ValidateTests(entry.Tests); err != nil {
			return err
		}
	}
	if err := ValidateAllowedFiles(entry.AllowedFiles); err != nil {
		return err
	}
	if err := ValidatePassThreshold(entry.PassThreshold); err != nil {
		return err
	}
	if entry.EmptyRepo {
		if err := validateEmptyRepoExclusions(entry); err != nil {
			return err
		}
	}
	return nil
}

// validateEmptyRepoExclusions rejects the combinations empty_repo rules out.
// A bare repo never carries the autograde shim, so every grading-adjacent
// field is meaningless alongside it. Error wording references CLI flags
// (write-path convention); the parse path wraps with the entry context.
func validateEmptyRepoExclusions(entry AssignmentEntry) error {
	if entry.Template != nil {
		return errors.New("empty_repo is mutually exclusive with template (--empty-repo vs --template)")
	}
	if len(entry.Tests) > 0 {
		return errors.New("empty_repo is mutually exclusive with tests (--empty-repo vs --tests): a bare repo never autogrades")
	}
	if entry.FeedbackPR {
		return errors.New("empty_repo is mutually exclusive with feedback_pr (--empty-repo vs --feedback-pr): a bare repo has no baseline for the Feedback PR")
	}
	if len(entry.AllowedFiles) > 0 {
		return errors.New("empty_repo is mutually exclusive with allowed_files (--empty-repo vs --allowed-files): a bare repo never autogrades")
	}
	if entry.PassThreshold != nil {
		return errors.New("empty_repo is mutually exclusive with pass_threshold (--empty-repo vs --pass-threshold): a bare repo never autogrades")
	}
	return nil
}

// ValidateEmptyRepoUnchanged enforces empty_repo's immutability on upsert:
// student repos are provisioned (or not) at accept time, so flipping the flag
// after creation would strand every already-accepted repo on the old
// behavior. Callers run it before UpsertAssignment when replacing an entry.
func ValidateEmptyRepoUnchanged(existing, updated AssignmentEntry) error {
	if existing.EmptyRepo != updated.EmptyRepo {
		return fmt.Errorf("empty_repo cannot be changed after creation (assignment %q): student repos already accepted under the old setting are not retrofitted — remove the assignment and add it under a new slug instead", existing.Slug)
	}
	return nil
}

// ValidateExistingEntry is the parse-path twin of ValidateAssignmentEntry.
// Same structural bar; errors frame the file context. Once v1, v1 holds
// strictly — version drift lives in the sentinel, not per-entry laxness.
func ValidateExistingEntry(entry AssignmentEntry) error {
	if entry.Slug == "" {
		return errors.New("entry has empty slug")
	}
	if err := validate.ShortName(entry.Slug, "slug"); err != nil {
		return fmt.Errorf("entry: %w", err)
	}
	if entry.Name == "" {
		return fmt.Errorf("entry %q has empty name", entry.Slug)
	}
	if entry.Mode == "" {
		return fmt.Errorf("entry %q has empty mode", entry.Slug)
	}
	if !IsValidAssignmentMode(entry.Mode) {
		return fmt.Errorf("entry %q has invalid mode %q (must be one of %v)", entry.Slug, entry.Mode, AssignmentModes)
	}
	// Template is optional; a nil block is template-less. When present, all
	// three fields must round-trip.
	if entry.Template != nil {
		if entry.Template.Owner == "" || entry.Template.Repo == "" {
			return fmt.Errorf("entry %q has empty template owner/repo", entry.Slug)
		}
		if entry.Template.Branch == "" {
			return fmt.Errorf("entry %q has empty template branch", entry.Slug)
		}
	}
	if err := ValidateDueDate(entry.Due); err != nil {
		return fmt.Errorf("entry %q: %w", entry.Slug, err)
	}
	if entry.DueMeta != nil {
		if err := ValidateDueMeta(entry.DueMeta); err != nil {
			return fmt.Errorf("entry %q: %w", entry.Slug, err)
		}
	}
	// Empty Autograder normalizes to "default" so older entries parse; the
	// pattern check still runs so a hand-edit can't round-trip a bad name.
	if entry.Autograder == "" {
		entry.Autograder = contract.DefaultAutograderName
	}
	if err := validate.ShortName(entry.Autograder, "autograder"); err != nil {
		return fmt.Errorf("entry %q: %w", entry.Slug, err)
	}
	if err := ValidateMaxGroupSize(entry.MaxGroupSize); err != nil {
		return fmt.Errorf("entry %q: %w", entry.Slug, err)
	}
	switch entry.Mode {
	case ModeGroup:
		// Pre-launch: no files predate group support, so the parser rejects
		// an unset/too-small group size rather than tolerating it (>= 2).
		if entry.MaxGroupSize < 2 {
			return fmt.Errorf("entry %q is group mode but max_group_size is %d (must be >= 2)", entry.Slug, entry.MaxGroupSize)
		}
	case ModeIndividual:
		if entry.MaxGroupSize != 0 {
			return fmt.Errorf("entry %q is individual mode but sets max_group_size %d", entry.Slug, entry.MaxGroupSize)
		}
	}
	if entry.Runtime != nil {
		if err := ValidateRuntime(*entry.Runtime); err != nil {
			return fmt.Errorf("entry %q: %w", entry.Slug, err)
		}
	}
	if len(entry.Tests) > 0 {
		if err := ValidateTests(entry.Tests); err != nil {
			return fmt.Errorf("entry %q: %w", entry.Slug, err)
		}
	}
	if err := ValidateAllowedFiles(entry.AllowedFiles); err != nil {
		return fmt.Errorf("entry %q: %w", entry.Slug, err)
	}
	if err := ValidatePassThreshold(entry.PassThreshold); err != nil {
		return fmt.Errorf("entry %q: %w", entry.Slug, err)
	}
	if entry.EmptyRepo {
		if err := validateEmptyRepoExclusions(entry); err != nil {
			return fmt.Errorf("entry %q: %w", entry.Slug, err)
		}
	}
	return nil
}

// expectEOF rejects trailing content after the top-level Decode. A second
// Decode returning io.EOF confirms exactly one JSON value; anything else would
// be silently dropped on re-encode.
func expectEOF(dec *json.Decoder) error {
	var rest json.RawMessage
	err := dec.Decode(&rest)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("unexpected trailing content after JSON value (expected end of file)")
	}
	return fmt.Errorf("trailing content after JSON value: %w", err)
}
