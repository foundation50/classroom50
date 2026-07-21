package classroom

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// migrateTestServer serves the four endpoints discovery hits:
// GET /classrooms, GET /classrooms/{id},
// GET /classrooms/{id}/assignments, GET /assignments/{id}.
func migrateTestServer(t *testing.T, classroom classroomDetail, assignments []classroomAssignmentDetail) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/classrooms":
			writeJSON(t, w, []classroomListItem{{ID: classroom.ID, Name: classroom.Name, Archived: classroom.Archived, URL: classroom.URL}})
		case r.URL.Path == fmt.Sprintf("/classrooms/%d", classroom.ID):
			writeJSON(t, w, classroom)
		case r.URL.Path == fmt.Sprintf("/classrooms/%d/assignments", classroom.ID):
			page := r.URL.Query().Get("page")
			if page != "1" {
				writeJSON(t, w, []classroomAssignmentListItem{})
				return
			}
			out := make([]classroomAssignmentListItem, len(assignments))
			for i, a := range assignments {
				out[i] = classroomAssignmentListItem{ID: a.ID, Title: a.Title, Slug: a.Slug, Type: a.Type}
			}
			writeJSON(t, w, out)
		case strings.HasPrefix(r.URL.Path, "/assignments/"):
			var id int64
			_, _ = fmt.Sscanf(r.URL.Path[len("/assignments/"):], "%d", &id)
			for _, a := range assignments {
				if a.ID == id {
					writeJSON(t, w, a)
					return
				}
			}
			http.NotFound(w, r)
		default:
			t.Errorf("unexpected request path %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
}

// realExportClassroom mirrors the shape from a real
// classroom-export-utility dump.
func realExportClassroom() classroomDetail {
	return classroomDetail{
		ID:       95884,
		Name:     "classroom50test",
		Archived: false,
		URL:      "https://classroom.github.com/classrooms/90273123-classroom50test",
		Organization: classroomDetailOrganization{
			ID:    90273123,
			Login: "classroom50test",
		},
	}
}

// realExportReadabilityAssignment mirrors the single assignment in
// the real export.
func realExportReadabilityAssignment() classroomAssignmentDetail {
	return classroomAssignmentDetail{
		ID:         239897,
		PublicRepo: false,
		Title:      "readability",
		Slug:       "readability",
		Type:       "individual",
		InviteLink: "https://classroom.github.com/a/9Bxg5uYu",
		Deadline:   nil,
		StarterCodeRepo: &classroomStarterCodeRepo{
			ID:            404158217,
			Name:          "readability",
			FullName:      "classroom50test/readability",
			Private:       true,
			DefaultBranch: "main",
		},
	}
}

func TestRunMigrate_DryRun_HappyPath(t *testing.T) {
	server := migrateTestServer(t, realExportClassroom(), []classroomAssignmentDetail{realExportReadabilityAssignment()})
	defer server.Close()

	var (
		stdout bytes.Buffer
		stderr bytes.Buffer
	)
	err := runMigrate(githubtest.NewTestClient(t, server), &stdout, &stderr, migrateOptions{
		Source: "95884",
		Target: "cs50-fall-2026",
		DryRun: true,
	})
	if err != nil {
		t.Fatalf("runMigrate(--dry-run): %v\nstdout:\n%s\nstderr:\n%s", err, stdout.String(), stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "cs50-fall-2026/classroom50/classroom50test: planned migration from classroom 95884") {
		t.Errorf("stdout missing planned-migration status line:\n%s", out)
	}
	if !strings.Contains(out, "(1 assignment)") {
		t.Errorf("stdout should use singular 'assignment' for count of 1:\n%s", out)
	}
	if !strings.Contains(out, "modes:         1 individual, 0 group") {
		t.Errorf("stdout missing modes summary:\n%s", out)
	}
	if !strings.Contains(out, "- readability") {
		t.Errorf("stdout missing assignment entry:\n%s", out)
	}
	if !strings.Contains(out, "classroom50test/readability @ main (private)") {
		t.Errorf("stdout missing starter ref + privacy:\n%s", out)
	}
	if strings.Contains(out, "deadline=") {
		t.Errorf("stdout should not print deadline= when source has no deadline:\n%s", out)
	}
	if strings.Contains(out, "archived:") {
		t.Errorf("stdout should not print 'archived:' line when archived=false:\n%s", out)
	}
	if !strings.Contains(stderr.String(), "Dry-run complete — no API writes performed.") {
		t.Errorf("stderr missing dry-run footer:\n%s", stderr.String())
	}
	if !strings.Contains(stderr.String(), "re-run without --dry-run") {
		t.Errorf("stderr missing next-step hint:\n%s", stderr.String())
	}
}

func TestRunMigrate_DryRun_EmptyClassroom(t *testing.T) {
	// A classroom with zero assignments still produces a clean
	// discovery plan.
	classroom := classroomDetail{
		ID:           95885,
		Name:         "CS50 Stress Test-classroom-1",
		Organization: classroomDetailOrganization{Login: "stresstest50"},
	}
	server := migrateTestServer(t, classroom, nil)
	defer server.Close()

	var stdout, stderr bytes.Buffer
	err := runMigrate(githubtest.NewTestClient(t, server), &stdout, &stderr, migrateOptions{
		Source: "95885",
		Target: "cs50-fall-2026",
		DryRun: true,
	})
	if err != nil {
		t.Fatalf("runMigrate(empty classroom): %v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, "(0 assignments)") {
		t.Errorf("stdout missing 0-count summary:\n%s", out)
	}
	if !strings.Contains(out, "(none)") {
		t.Errorf("stdout should list '(none)' for empty assignments:\n%s", out)
	}
	if !strings.Contains(out, "short_name:    cs50-stress-test-classroom-1") {
		t.Errorf("stdout missing derived short-name:\n%s", out)
	}
}

func TestRunMigrate_NonDryRun_HappyPath(t *testing.T) {
	state := newMigrateE2EState(realExportClassroom(), []classroomAssignmentDetail{realExportReadabilityAssignment()})
	server := httptest.NewServer(state.handler(t))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	err := runMigrate(githubtest.NewTestClient(t, server), &stdout, &stderr, migrateOptions{
		Source: "95884",
		Target: "cs50-fall-2026",
		DryRun: false,
	})
	if err != nil {
		t.Fatalf("runMigrate: %v\nstdout:\n%s\nstderr:\n%s", err, stdout.String(), stderr.String())
	}

	// Template copy: source verified, target probed, generate
	// + PATCH for is_template.
	if !state.generated["cs50-fall-2026/readability"] {
		t.Errorf("expected target /cs50-fall-2026/readability to be generated; got generated=%v", state.generated)
	}
	if !state.markedAsTemplate["cs50-fall-2026/readability"] {
		t.Errorf("expected target /cs50-fall-2026/readability to be PATCHed is_template:true; got marked=%v", state.markedAsTemplate)
	}

	// Commit landed on the config repo with the four scaffold files.
	if state.commitsCreated != 1 {
		t.Errorf("commits created = %d, want 1", state.commitsCreated)
	}
	for _, want := range []string{"classroom50test/classroom.json", "classroom50test/assignments.json", "classroom50test/roster.csv", "classroom50test/scores.json"} {
		if _, ok := state.uploadedFiles[want]; !ok {
			t.Errorf("missing uploaded file %q (uploaded: %v)", want, mapKeys(state.uploadedFiles))
		}
	}

	// assignments.json content carries the migrated_from block
	// pointing at the source.
	var assigns assignment.AssignmentsJSON
	body := state.uploadedFiles["classroom50test/assignments.json"]
	if err := json.Unmarshal([]byte(body), &assigns); err != nil {
		t.Fatalf("decode assignments.json: %v\nbody:\n%s", err, body)
	}
	if len(assigns.Assignments) != 1 {
		t.Fatalf("assignments.json entries = %d, want 1", len(assigns.Assignments))
	}
	entry := assigns.Assignments[0]
	if entry.Slug != "readability" || entry.Mode != "individual" {
		t.Errorf("entry = {Slug:%q Mode:%q}, want {Slug:readability Mode:individual}", entry.Slug, entry.Mode)
	}
	wantTpl := assignment.TemplateRef{Owner: "cs50-fall-2026", Repo: "readability", Branch: "main"}
	if entry.Template == nil || *entry.Template != wantTpl {
		t.Errorf("entry.Template = %+v, want %+v", entry.Template, wantTpl)
	}
	if entry.MigratedFrom == nil {
		t.Fatalf("entry missing migrated_from block")
	}
	if entry.MigratedFrom.ClassroomID != 95884 || entry.MigratedFrom.AssignmentID != 239897 {
		t.Errorf("migrated_from = %+v, want classroom_id=95884 assignment_id=239897", *entry.MigratedFrom)
	}
	if entry.MigratedFrom.StarterRepo != "classroom50test/readability" {
		t.Errorf("migrated_from.starter_repo = %q, want classroom50test/readability", entry.MigratedFrom.StarterRepo)
	}

	// classroom.json carries its own provenance block.
	var classroom configrepo.ClassroomJSON
	if err := json.Unmarshal([]byte(state.uploadedFiles["classroom50test/classroom.json"]), &classroom); err != nil {
		t.Fatalf("decode classroom.json: %v", err)
	}
	if classroom.MigratedFrom == nil || classroom.MigratedFrom.ClassroomID != 95884 {
		t.Errorf("classroom.json missing migrated_from.classroom_id=95884, got %+v", classroom.MigratedFrom)
	}
	// The migrate path seeds + records the staff teams, same as add.
	if classroom.Teams == nil || classroom.Teams.Teacher == nil || classroom.Teams.TA == nil {
		t.Errorf("classroom.json missing teams.{teacher,ta}, got %+v", classroom.Teams)
	} else {
		if classroom.Teams.Teacher.Slug != "classroom50-classroom50test-teacher" {
			t.Errorf("teacher team slug = %q, want classroom50-classroom50test-teacher", classroom.Teams.Teacher.Slug)
		}
		if classroom.Teams.TA.Slug != "classroom50-classroom50test-ta" {
			t.Errorf("ta team slug = %q, want classroom50-classroom50test-ta", classroom.Teams.TA.Slug)
		}
	}

	// The private migrated template grants read to the student classroom team
	// plus the non-owner staff teams (HTA + TA) — the eager grant at migrate, not
	// only at collect-scores.
	if got := state.templateGrants["classroom50-classroom50test"]; got != "cs50-fall-2026/readability" {
		t.Errorf("student team template grant = %q, want cs50-fall-2026/readability", got)
	}
	if got := state.templateGrants["classroom50-classroom50test-hta"]; got != "cs50-fall-2026/readability" {
		t.Errorf("HTA team template grant = %q, want cs50-fall-2026/readability", got)
	}
	if got := state.templateGrants["classroom50-classroom50test-ta"]; got != "cs50-fall-2026/readability" {
		t.Errorf("TA team template grant = %q, want cs50-fall-2026/readability", got)
	}
	// Only the non-owner staff teams are eagerly granted (StaffTeamRepoPermissions
	// gate); the teacher team must NOT get template read (owners have it already).
	if got, ok := state.templateGrants["classroom50-classroom50test-teacher"]; ok {
		t.Errorf("teacher team must not be granted template read, got %q", got)
	}

	// The creator is dropped from the students + non-teacher staff teams (HTA,
	// TA — mixed roles aren't allowed) but NEVER the teacher team — the owner's
	// only role.
	sort.Strings(state.membershipDeleted)
	wantDropped := []string{"classroom50-classroom50test", "classroom50-classroom50test-hta", "classroom50-classroom50test-ta"}
	if !reflect.DeepEqual(state.membershipDeleted, wantDropped) {
		t.Errorf("membership DELETEs = %v, want %v (students + hta + ta, never teacher)", state.membershipDeleted, wantDropped)
	}

	// Final stdout line is parseable; commit SHA appears.
	if !strings.Contains(stdout.String(), "cs50-fall-2026/classroom50/classroom50test: migrated from classroom 95884") {
		t.Errorf("stdout missing parseable migration result line:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "1 generated, 0 reused, 0 skipped") {
		t.Errorf("stdout missing action counts:\n%s", stdout.String())
	}
}

// TestRunMigrate_NonDryRun_TAGrantFailureIsNonFatal: when the student grant
// succeeds but the TA staff-team grant PUT fails, migrate still succeeds
// (student success stands) and only warns — the TA failure must never add to
// grantFailures or flip the exit code. Mirrors the reuse/web non-blocking tests.
func TestRunMigrate_NonDryRun_TAGrantFailureIsNonFatal(t *testing.T) {
	state := newMigrateE2EState(realExportClassroom(), []classroomAssignmentDetail{realExportReadabilityAssignment()})
	state.failTAGrant = true
	server := httptest.NewServer(state.handler(t))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	err := runMigrate(githubtest.NewTestClient(t, server), &stdout, &stderr, migrateOptions{
		Source: "95884",
		Target: "cs50-fall-2026",
		DryRun: false,
	})
	if err != nil {
		t.Fatalf("runMigrate must not fail on a TA-grant error: %v\nstderr:\n%s", err, stderr.String())
	}
	// Student grant still landed; migration completed.
	if got := state.templateGrants["classroom50-classroom50test"]; got != "cs50-fall-2026/readability" {
		t.Errorf("student team grant = %q, want cs50-fall-2026/readability", got)
	}
	if state.commitsCreated != 1 {
		t.Errorf("commits created = %d, want 1 (migration still completes)", state.commitsCreated)
	}
	if !strings.Contains(stderr.String(), "could not grant ta staff team") {
		t.Errorf("expected a TA-grant warning on stderr, got:\n%s", stderr.String())
	}
}

func TestRunMigrate_NonDryRun_AlreadyExists(t *testing.T) {
	state := newMigrateE2EState(realExportClassroom(), []classroomAssignmentDetail{realExportReadabilityAssignment()})
	state.existingDirs["classroom50test"] = true // pretend the target dir already exists
	server := httptest.NewServer(state.handler(t))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	err := runMigrate(githubtest.NewTestClient(t, server), &stdout, &stderr, migrateOptions{
		Source: "95884",
		Target: "cs50-fall-2026",
		DryRun: false,
	})
	if err == nil {
		t.Fatalf("expected already-exists error")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Errorf("err = %v, want 'already exists' substring", err)
	}
	// Pre-flight must fire BEFORE template copy: no generate
	// attempts, no commits.
	if len(state.generated) != 0 {
		t.Errorf("expected no template generated when pre-flight fails, got %v", state.generated)
	}
	if state.commitsCreated != 0 {
		t.Errorf("expected zero commits, got %d", state.commitsCreated)
	}
}

func TestRunMigrate_NonDryRun_SkipsSourceNotTemplate(t *testing.T) {
	a := realExportReadabilityAssignment()
	state := newMigrateE2EState(realExportClassroom(), []classroomAssignmentDetail{a})
	state.sourceIsTemplate["classroom50test/readability"] = false // source no longer templated
	server := httptest.NewServer(state.handler(t))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	err := runMigrate(githubtest.NewTestClient(t, server), &stdout, &stderr, migrateOptions{
		Source: "95884",
		Target: "cs50-fall-2026",
		DryRun: false,
	})
	if err == nil {
		t.Fatalf("expected non-zero exit when an assignment is skipped")
	}
	if !strings.Contains(err.Error(), "skipped") {
		t.Errorf("err = %v, want 'skipped' substring", err)
	}
	// The commit still lands (with zero entries) — best-effort
	// commits-what-it-can contract.
	if state.commitsCreated != 1 {
		t.Errorf("commits created = %d, want 1 (commit still lands with the entries that succeeded)", state.commitsCreated)
	}
	// assignments.json on disk has zero entries.
	var assigns assignment.AssignmentsJSON
	body := state.uploadedFiles["classroom50test/assignments.json"]
	if err := json.Unmarshal([]byte(body), &assigns); err != nil {
		t.Fatalf("decode assignments.json: %v\nbody:\n%s", err, body)
	}
	if len(assigns.Assignments) != 0 {
		t.Errorf("entries = %d, want 0 (the only assignment was skipped)", len(assigns.Assignments))
	}
	if !strings.Contains(stderr.String(), "not a template") {
		t.Errorf("stderr missing skip reason, got:\n%s", stderr.String())
	}
	// Summary must report counts from what actually landed in
	// assignments.json — not from the pre-skip plan. The skipped
	// assignment was individual, so a stale count would show
	// "1 individual, 0 group" alongside "0 entries".
	if !strings.Contains(stdout.String(), "0 entries (0 individual, 0 group)") {
		t.Errorf("summary mode counts disagree with committed entries (entry count and mode count must come from the same source), got:\n%s", stdout.String())
	}
}

func TestRunMigrate_ShortNameOverride(t *testing.T) {
	server := migrateTestServer(t, realExportClassroom(), nil)
	defer server.Close()

	var stdout, stderr bytes.Buffer
	err := runMigrate(githubtest.NewTestClient(t, server), &stdout, &stderr, migrateOptions{
		Source:    "95884",
		Target:    "cs50-fall-2026",
		ShortName: "cs-principles",
		Term:      "Spring-2026",
		DryRun:    true,
	})
	if err != nil {
		t.Fatalf("runMigrate: %v", err)
	}
	out := stdout.String()
	if !strings.Contains(out, "short_name:    cs-principles") {
		t.Errorf("stdout should show overridden short-name, got:\n%s", out)
	}
	if strings.Contains(out, "classroom50test/classroom50/classroom50test") {
		t.Errorf("stdout used derived short-name despite --short-name override:\n%s", out)
	}
	if !strings.Contains(out, "term:          Spring-2026") {
		t.Errorf("stdout missing --term value:\n%s", out)
	}
}

func TestRunMigrate_EmptySourceRejected(t *testing.T) {
	// resolveSource is the canonical seam for empty-source defense.
	var stdout, stderr bytes.Buffer
	err := runMigrate(nil, &stdout, &stderr, migrateOptions{Source: "", Target: "cs50-fall-2026", DryRun: true})
	if err == nil {
		t.Fatalf("expected error for empty --source")
	}
	if !strings.Contains(err.Error(), "--source must not be empty") {
		t.Errorf("err = %v, want '--source must not be empty' substring", err)
	}
}

// migrateE2EState is a stateful in-memory backing for end-to-end
// migrate tests. It serves source-side classroom API endpoints,
// target-side repo probes, the generate + PATCH cycle, and the
// commitTree internals (refs, trees, commits, blobs) — enough to
// run runMigrate(DryRun=false) start-to-finish.
type migrateE2EState struct {
	mu sync.Mutex

	classroom   classroomDetail
	assignments []classroomAssignmentDetail

	// Per-test knobs. Defaults assume the happy path; tests can
	// flip these before handing the state to httptest.
	sourceIsTemplate map[string]bool // "owner/repo" → is_template (default true)
	existingDirs     map[string]bool // <short-name> → already exists in target classroom50 (default false)
	// failTAGrant, when true, makes the TA staff-team template-grant PUT return
	// 500 so a test can assert the failure is non-blocking (warns, no exit change).
	failTAGrant bool

	// Captured side-effects.
	generated         map[string]bool   // "owner/repo" → was generated
	markedAsTemplate  map[string]bool   // "owner/repo" → got is_template PATCH
	uploadedFiles     map[string]string // git tree path → blob content
	commitsCreated    int
	teamsCreated      int      // count of POST /orgs/{org}/teams (students + staff)
	membershipDeleted []string // slugs that received a DELETE .../memberships/{user}
	// templateGrants records team-slug → repo grants (PUT .../teams/{slug}/repos/{owner}/{repo})
	// so a test can assert which teams got read on a private migrated template.
	templateGrants map[string]string

	parentSHA     string
	parentTreeSHA string
	commitSHA     string
}

func newMigrateE2EState(classroom classroomDetail, assignments []classroomAssignmentDetail) *migrateE2EState {
	s := &migrateE2EState{
		classroom:        classroom,
		assignments:      assignments,
		sourceIsTemplate: map[string]bool{},
		existingDirs:     map[string]bool{},
		generated:        map[string]bool{},
		markedAsTemplate: map[string]bool{},
		uploadedFiles:    map[string]string{},
		templateGrants:   map[string]string{},
		parentSHA:        "parent-sha-1",
		parentTreeSHA:    "parent-tree-1",
		commitSHA:        "new-commit-sha",
	}
	// Default: every assignment's source repo IS a template
	// (matches the real-export shape).
	for _, a := range assignments {
		if a.StarterCodeRepo != nil {
			s.sourceIsTemplate[a.StarterCodeRepo.FullName] = true
		}
	}
	return s
}

// handler returns the routing http.Handler for the test server.
// Dispatch order in s.dispatch goes most-specific path first.
func (s *migrateE2EState) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.dispatch(t, w, r)
	})
}

func (s *migrateE2EState) dispatch(t *testing.T, w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	// Source-side: discovery.
	case path == fmt.Sprintf("/classrooms/%d", s.classroom.ID):
		writeJSON(t, w, s.classroom)
	case path == fmt.Sprintf("/classrooms/%d/assignments", s.classroom.ID):
		if r.URL.Query().Get("page") == "1" {
			out := make([]classroomAssignmentListItem, len(s.assignments))
			for i, a := range s.assignments {
				out[i] = classroomAssignmentListItem{ID: a.ID, Title: a.Title, Slug: a.Slug, Type: a.Type}
			}
			writeJSON(t, w, out)
			return
		}
		writeJSON(t, w, []classroomAssignmentListItem{})
	case strings.HasPrefix(path, "/assignments/"):
		var id int64
		_, _ = fmt.Sscanf(strings.TrimPrefix(path, "/assignments/"), "%d", &id)
		for _, a := range s.assignments {
			if a.ID == id {
				writeJSON(t, w, a)
				return
			}
		}
		http.NotFound(w, r)

	// Target-side: commitTree internals (most specific paths first).
	case strings.Contains(path, "/git/refs/heads/"):
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			return
		}
		writeJSON(t, w, map[string]any{"object": map[string]string{"sha": s.parentSHA}})
	case strings.Contains(path, "/git/commits/"+s.parentSHA):
		writeJSON(t, w, map[string]any{"tree": map[string]string{"sha": s.parentTreeSHA}})
	case strings.HasSuffix(path, "/git/commits"):
		writeJSON(t, w, map[string]string{"sha": s.commitSHA})
	case strings.HasSuffix(path, "/git/blobs"):
		// uploadBlobs sends {content: <base64>, encoding: "base64"}.
		// Stash decoded content under a per-blob SHA so the tree
		// step (below) can re-key it by tree path.
		var body struct {
			Content  string `json:"content"`
			Encoding string `json:"encoding"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		decoded, _ := base64.StdEncoding.DecodeString(body.Content)
		sha := fmt.Sprintf("blob-%d", len(s.uploadedFiles))
		s.uploadedFiles[sha] = string(decoded)
		writeJSON(t, w, map[string]string{"sha": sha})
	case strings.HasSuffix(path, "/git/trees"):
		// Re-key blobs from blob-N → tree path so tests assert by path.
		var body struct {
			Tree []struct {
				Path string `json:"path"`
				SHA  string `json:"sha"`
			} `json:"tree"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		for _, e := range body.Tree {
			if content, ok := s.uploadedFiles[e.SHA]; ok {
				s.uploadedFiles[e.Path] = content
				delete(s.uploadedFiles, e.SHA)
			}
		}
		s.commitsCreated++
		writeJSON(t, w, map[string]string{"sha": "new-tree-sha"})

	// Target-side: contents probe (for "already exists" + classroom50 read).
	case strings.HasPrefix(path, "/repos/"+s.targetOrg()+"/classroom50/contents/"):
		short := strings.TrimPrefix(path, "/repos/"+s.targetOrg()+"/classroom50/contents/")
		short = strings.SplitN(short, "?", 2)[0]
		if s.existingDirs[short] {
			writeJSON(t, w, map[string]any{"type": "dir"})
			return
		}
		w.WriteHeader(http.StatusNotFound)

	// Target-side: classroom50 repo lookup (for resolveConfigRepoBranch).
	case path == "/repos/"+s.targetOrg()+"/classroom50":
		writeJSON(t, w, map[string]string{"default_branch": "main"})

	// Target-side: branch stability poll (waitForStableBranch).
	// Same SHA on every read → caller returns after one 500ms sleep.
	case strings.Contains(path, "/branches/") && strings.HasPrefix(path, "/repos/"+s.targetOrg()+"/"):
		writeJSON(t, w, map[string]any{"commit": map[string]string{"sha": "stable-sha"}})

	// Target-side: per-assignment template repo probe / PATCH / generate.
	case strings.HasPrefix(path, "/repos/"+s.targetOrg()+"/"):
		repo := strings.TrimPrefix(path, "/repos/"+s.targetOrg()+"/")
		switch r.Method {
		case http.MethodGet:
			full := s.targetOrg() + "/" + repo
			if s.generated[full] {
				writeJSON(t, w, map[string]any{
					"is_template":    s.markedAsTemplate[full],
					"default_branch": "main",
				})
				return
			}
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPatch:
			full := s.targetOrg() + "/" + repo
			s.markedAsTemplate[full] = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected method %s on %s", r.Method, path)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}

	// Source-side: generate from template at
	// /repos/{src_owner}/{src_repo}/generate.
	case strings.HasSuffix(path, "/generate"):
		var body struct {
			Owner string `json:"owner"`
			Name  string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.generated[body.Owner+"/"+body.Name] = true
		w.WriteHeader(http.StatusCreated)
		writeJSON(t, w, map[string]string{"default_branch": "main"})
	case strings.HasPrefix(path, "/repos/"):
		// /repos/{owner}/{repo} — source-side is_template probe.
		full := strings.TrimPrefix(path, "/repos/")
		isTpl, known := s.sourceIsTemplate[full]
		if !known {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		writeJSON(t, w, map[string]any{"is_template": isTpl})

	// Target-side: team create (POST /orgs/{org}/teams). Echo the
	// requested name as the slug (canonical short-name), so the students
	// team and the two staff teams each get their correct slug.
	case path == "/orgs/"+s.targetOrg()+"/teams" && r.Method == http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.teamsCreated++
		writeJSON(t, w, map[string]any{"id": 4242 + s.teamsCreated, "slug": body.Name})

	// Target-side: team repo-access probe (GET → 404 = no access yet)
	// and grant (PUT → 204) for a private migrated template.
	case strings.HasPrefix(path, "/orgs/"+s.targetOrg()+"/teams/classroom50-classroom50test/repos/"):
		switch r.Method {
		case http.MethodGet:
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPut:
			s.templateGrants["classroom50-classroom50test"] = strings.TrimPrefix(path, "/orgs/"+s.targetOrg()+"/teams/classroom50-classroom50test/repos/")
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected method %s on %s", r.Method, path)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}

	// Authenticated user lookup (CurrentUser) for the instructor
	// maintainer add.
	case path == "/user" && r.Method == http.MethodGet:
		writeJSON(t, w, map[string]any{"login": "teacher", "id": 1})

	// Target-side: staff-team config-repo grant probe/PUT and membership
	// PUT (add instructor maintainer). Both live under a staff-team slug.
	// A staff-team grant on the private template repo (readability) is the
	// eager TA-team template read; record it so a test can assert it fired.
	case strings.HasPrefix(path, "/orgs/"+s.targetOrg()+"/teams/") && strings.Contains(path, "/repos/"):
		switch r.Method {
		case http.MethodGet:
			w.WriteHeader(http.StatusNotFound)
		case http.MethodPut:
			rest := strings.TrimPrefix(path, "/orgs/"+s.targetOrg()+"/teams/")
			if slug, repoPath, ok := strings.Cut(rest, "/repos/"); ok && strings.HasSuffix(repoPath, "/readability") {
				// The `-ta` suffix is how the mock tells the TA staff team's
				// template grant from the student team's.
				if s.failTAGrant && strings.HasSuffix(slug, "-ta") {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				s.templateGrants[slug] = repoPath
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected method %s on %s", r.Method, path)
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	case strings.HasPrefix(path, "/orgs/"+s.targetOrg()+"/teams/") && strings.Contains(path, "/memberships/") && r.Method == http.MethodPut:
		w.WriteHeader(http.StatusOK)
		writeJSON(t, w, map[string]any{"state": "active"})

	// Target-side: membership DELETE — dropping the creator from the
	// students + TA teams (they must not hold a student/TA role). Idempotent;
	// 204 = removed. Record the targeted slug so the test can assert WHICH
	// teams are dropped (students + ta, never instructor).
	case strings.HasPrefix(path, "/orgs/"+s.targetOrg()+"/teams/") && strings.Contains(path, "/memberships/") && r.Method == http.MethodDelete:
		if slug, _, ok := strings.Cut(strings.TrimPrefix(path, "/orgs/"+s.targetOrg()+"/teams/"), "/memberships/"); ok {
			// dispatch runs under s.mu (see handler), so append directly.
			s.membershipDeleted = append(s.membershipDeleted, slug)
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		t.Errorf("unexpected path %q method %s", path, r.Method)
		http.NotFound(w, r)
	}
}

// targetOrg is the hard-coded target every E2E test routes against.
func (s *migrateE2EState) targetOrg() string { return "cs50-fall-2026" }

// mapKeys returns m's keys for diagnostic error messages (order
// is not stable).
func mapKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
