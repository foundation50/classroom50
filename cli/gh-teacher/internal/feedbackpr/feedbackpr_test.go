package feedbackpr

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// assignmentsJSON is a minimal v1 assignments.json with one feedback_pr
// assignment (`hello`) plus optional extra entries the test appends.
func assignmentsJSON(t *testing.T, entries string) string {
	t.Helper()
	return `{"schema":"classroom50/assignments/v1","assignments":[` + entries + `]}`
}

const helloEntry = `{"slug":"hello","name":"Hello","mode":"individual","autograder":"default","feedback_pr":true}`

// classroomMux wires the config-repo reads (repo object, assignments.json,
// classroom.json 404 -> derived team slug), the team-member list, and, for
// each repo in repoStates, the per-repo existence probe and (for existing
// repos) a fresh-open ensure sequence. repoStates maps a repo name to one of
// "missing" (404 probe), "fresh" (opens a PR), or "existing" (already has one).
func classroomMux(t *testing.T, assignments string, members []string, repoStates map[string]string) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()

	// Config repo object (default branch) — must not collide with the student
	// assignment repos, so register the exact path.
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	})

	// Config-repo contents: assignments.json served; classroom.json 404s so
	// the team slug derives to classroom50-<short>.
	mux.HandleFunc("/repos/o/classroom50/contents/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/repos/o/classroom50/contents/")
		if path == "cs/assignments.json" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"content":  base64.StdEncoding.EncodeToString([]byte(assignments)),
				"encoding": "base64",
			})
			return
		}
		http.NotFound(w, r)
	})

	// Derived classroom team members. Skipped when members is nil so a --user
	// test can register a fail-if-hit handler and pin that the team lookup is
	// not consulted.
	if members != nil {
		mux.HandleFunc("/orgs/o/teams/classroom50-cs/members", func(w http.ResponseWriter, _ *http.Request) {
			out := make([]map[string]any, 0, len(members))
			for _, m := range members {
				out = append(out, map[string]any{"login": m})
			}
			_ = json.NewEncoder(w).Encode(out)
		})
	}

	for repo, state := range repoStates {
		mountRepo(mux, repo, state)
	}
	return mux
}

// mountRepo registers the existence probe plus (for a "fresh" repo) the full
// ensure sequence under /repos/o/<repo>/. "missing" 404s the probe; "existing"
// answers the base+head PR list with one open PR (idempotent no-op).
func mountRepo(mux *http.ServeMux, repo, state string) {
	base := "/repos/o/" + repo

	mux.HandleFunc(base, func(w http.ResponseWriter, _ *http.Request) {
		if state == "missing" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	})
	if state == "missing" {
		return
	}

	mux.HandleFunc(base+"/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if state == "existing" {
				_ = json.NewEncoder(w).Encode([]map[string]any{{"number": 7, "state": "open"}})
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{})
			return
		}
		// Fresh open: head already has a diff, so the first create succeeds.
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"number": 1})
	})
	// Freeze the base and read commit history for the accept SHA.
	mux.HandleFunc(base+"/git/refs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/feedback"})
	})
	mux.HandleFunc(base+"/commits", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{{"sha": "newer"}, {"sha": "accept-sha"}})
	})
	// Label steps (best-effort).
	mux.HandleFunc(base+"/labels", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{}`)
	})
	mux.HandleFunc(base+"/issues/1/labels", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[]`)
	})
}

func runCmd(t *testing.T, mux *http.ServeMux, p runParams) (string, string, error) {
	t.Helper()
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)
	var out, errOut bytes.Buffer
	err := run(client, &out, &errOut, p)
	return out.String(), errOut.String(), err
}

func params(overrides func(*runParams)) runParams {
	p := runParams{org: "o", classroom: "cs", assignment: "hello"}
	if overrides != nil {
		overrides(&p)
	}
	return p
}

// TestRun_BulkOpensMissingSkipsExistingAndUnaccepted pins the happy bulk path:
// one repo without a PR is opened, one that already has one is counted as
// existed, and an unaccepted (no-repo) member is silently skipped (not a
// failure).
func TestRun_BulkOpensMissingSkipsExistingAndUnaccepted(t *testing.T) {
	mux := classroomMux(t, assignmentsJSON(t, helloEntry),
		[]string{"alice", "bob", "carol"},
		map[string]string{
			"cs-hello-alice": "fresh",
			"cs-hello-bob":   "existing",
			"cs-hello-carol": "missing",
		})

	out, _, err := runCmd(t, mux, params(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "1 opened, 1 already had one, 0 blocked, 0 setup incomplete, 0 failed (of 2 repo(s))") {
		t.Errorf("summary not as expected:\n%s", out)
	}
	if !strings.Contains(out, "Opened Feedback PR on cs-hello-alice") {
		t.Errorf("missing per-repo open line:\n%s", out)
	}
}

// TestRun_UserTargetsSingleRepo pins --user: only that student's repo is
// touched, and the team lookup is NOT consulted (a handler that fails the test
// if hit pins the intent directly).
func TestRun_UserTargetsSingleRepo(t *testing.T) {
	mux := classroomMux(t, assignmentsJSON(t, helloEntry),
		nil, // team list must not be consulted with --user
		map[string]string{"cs-hello-alice": "fresh"})
	mux.HandleFunc("/orgs/o/teams/classroom50-cs/members", func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("team members must not be listed on the --user path")
	})

	out, _, err := runCmd(t, mux, params(func(p *runParams) { p.user = "alice" }))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "1 opened, 0 already had one, 0 blocked, 0 setup incomplete, 0 failed (of 1 repo(s))") {
		t.Errorf("summary not as expected:\n%s", out)
	}
}

// TestRun_UserMissingRepoIsReported pins that a --user target who hasn't
// accepted is reported (not a silent no-op): the one repo the teacher named is
// the answer they asked for.
func TestRun_UserMissingRepoIsReported(t *testing.T) {
	mux := classroomMux(t, assignmentsJSON(t, helloEntry),
		nil, map[string]string{"cs-hello-alice": "missing"})

	out, _, err := runCmd(t, mux, params(func(p *runParams) { p.user = "alice" }))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "cs-hello-alice does not exist") || !strings.Contains(out, "alice has not accepted hello") {
		t.Errorf("missing --user repo not reported:\n%s", out)
	}
}

// TestRun_ProbeFailureIsFailedBucketAndExitsNonZero pins the transient-failure
// path end to end: a repo whose probe 500s lands in the failed bucket, the
// stderr detail names it, and the command exits non-zero.
func TestRun_ProbeFailureIsFailedBucketAndExitsNonZero(t *testing.T) {
	mux := classroomMux(t, assignmentsJSON(t, helloEntry), []string{"alice"}, nil)
	mux.HandleFunc("/repos/o/cs-hello-alice", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"message":"boom"}`)
	})

	out, errOut, err := runCmd(t, mux, params(nil))
	if err == nil {
		t.Fatal("want a non-nil error when a repo fails, got nil")
	}
	if !strings.Contains(out, "0 opened, 0 already had one, 0 blocked, 0 setup incomplete, 1 failed (of 1 repo(s))") {
		t.Errorf("summary not as expected:\n%s", out)
	}
	if !strings.Contains(errOut, "probe failed") || !strings.Contains(errOut, "cs-hello-alice") {
		t.Errorf("failed stderr detail not as expected:\n%s", errOut)
	}
}

// TestRun_BlockedBaseMismatch pins the blocked bucket: a student-precreated
// `feedback` at the wrong SHA lands in blocked (not failed), the summary and
// stderr name it, and the command exits non-zero.
func TestRun_BlockedBaseMismatch(t *testing.T) {
	mux := classroomMux(t, assignmentsJSON(t, helloEntry),
		[]string{"alice"}, nil)
	// Custom repo wiring: probe 200, no PR, ref create 422 already-exists, and
	// the read-back reports a student-chosen SHA (not accept-sha).
	base := "/repos/o/cs-hello-alice"
	mux.HandleFunc(base, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	})
	mux.HandleFunc(base+"/pulls", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{})
	})
	mux.HandleFunc(base+"/commits", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{{"sha": "accept-sha"}})
	})
	mux.HandleFunc(base+"/git/refs", func(w http.ResponseWriter, _ *http.Request) {
		write422or403(w, http.StatusUnprocessableEntity, `{"message":"Reference already exists"}`)
	})
	mux.HandleFunc(base+"/git/ref/heads/feedback", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "student-chosen-sha"}})
	})

	out, errOut, err := runCmd(t, mux, params(nil))
	if err == nil {
		t.Fatal("want a non-nil error when a repo is blocked, got nil")
	}
	if !strings.Contains(out, "0 opened, 0 already had one, 1 blocked, 0 setup incomplete, 0 failed") {
		t.Errorf("summary not as expected:\n%s", out)
	}
	if !strings.Contains(errOut, "cs-hello-alice") || !strings.Contains(errOut, "org admin") {
		t.Errorf("blocked stderr detail not as expected:\n%s", errOut)
	}
}

// TestRun_IncompleteSetupIsNotFailed pins the issue #502 shape: a repo that
// exists but whose accept never committed .classroom50.yaml (the commits query
// for the marker is empty) lands in its own "setup incomplete" bucket, not the
// retryable "failed" one, and the stderr detail tells the teacher to have the
// student re-run setup rather than to re-run this command.
func TestRun_IncompleteSetupIsNotFailed(t *testing.T) {
	mux := classroomMux(t, assignmentsJSON(t, helloEntry), []string{"alice"}, nil)
	base := "/repos/o/cs-hello-alice"
	mux.HandleFunc(base, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	})
	mux.HandleFunc(base+"/pulls", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]any{})
	})
	mux.HandleFunc(base+"/commits", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{})
	})
	mux.HandleFunc(base+"/git/refs", func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("must not freeze a feedback base with no accept marker")
	})

	out, errOut, err := runCmd(t, mux, params(nil))
	if err == nil {
		t.Fatal("want a non-nil error when a repo never finished setup, got nil")
	}
	if !strings.Contains(err.Error(), "never finished setup") {
		t.Errorf("error should name the incomplete-setup cause, got: %v", err)
	}
	if !strings.Contains(out, "0 opened, 0 already had one, 0 blocked, 1 setup incomplete, 0 failed") {
		t.Errorf("summary not as expected:\n%s", out)
	}
	if !strings.Contains(out, "Setup incomplete: cs-hello-alice") {
		t.Errorf("per-repo line not as expected:\n%s", out)
	}
	if !strings.Contains(errOut, "cs-hello-alice") || !strings.Contains(errOut, "Re-run setup") {
		t.Errorf("incomplete stderr detail not as expected:\n%s", errOut)
	}
	if strings.Contains(errOut, "transient") {
		t.Errorf("incomplete setup must not be reported as a transient failure:\n%s", errOut)
	}
}

// TestRun_NonMainDefaultBranch pins that the head branch is resolved from the
// repo's settled default branch, not a hardcoded `main`: a repo whose default
// is `master` is probed, opened, and counted against the org:master head. The
// whole reason defaultBranch reads the repo object is this case.
func TestRun_NonMainDefaultBranch(t *testing.T) {
	// classroomMux must not register cs-hello-alice (it would hardcode main and
	// collide), so pass no repoStates and wire the master repo by hand.
	mux := classroomMux(t, assignmentsJSON(t, helloEntry), []string{"alice"}, nil)
	base := "/repos/o/cs-hello-alice"
	mux.HandleFunc(base, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "master"})
	})
	var listedHead, prHead string
	mux.HandleFunc(base+"/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			listedHead = r.URL.Query().Get("head")
			_ = json.NewEncoder(w).Encode([]map[string]any{})
			return
		}
		body, _ := io.ReadAll(r.Body)
		var pr map[string]string
		_ = json.Unmarshal(body, &pr)
		prHead = pr["head"]
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"number": 1})
	})
	mux.HandleFunc(base+"/commits", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{{"sha": "accept-sha"}})
	})
	mux.HandleFunc(base+"/git/refs", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/feedback"})
	})
	mux.HandleFunc(base+"/labels", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{}`)
	})
	mux.HandleFunc(base+"/issues/1/labels", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[]`)
	})

	out, _, err := runCmd(t, mux, params(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "1 opened, 0 already had one, 0 blocked, 0 setup incomplete, 0 failed (of 1 repo(s))") {
		t.Errorf("summary not as expected:\n%s", out)
	}
	if listedHead != "o:master" {
		t.Errorf("existence probe head = %q, want o:master", listedHead)
	}
	if prHead != "master" {
		t.Errorf("PR head = %q, want master", prHead)
	}
}

// TestRun_EmptyRepoAssignmentRefused pins the up-front guard: an empty_repo
// assignment has no baseline, so the command refuses rather than churning.
func TestRun_EmptyRepoAssignmentRefused(t *testing.T) {
	entry := `{"slug":"bare","name":"Bare","mode":"individual","autograder":"default","empty_repo":true}`
	mux := classroomMux(t, assignmentsJSON(t, entry), nil, nil)
	_, _, err := runCmd(t, mux, params(func(p *runParams) { p.assignment = "bare" }))
	if err == nil || !strings.Contains(err.Error(), "empty_repo") {
		t.Fatalf("want an empty_repo refusal, got %v", err)
	}
}

// TestRun_FeedbackPRDisabledRefused pins the guard for an assignment with
// feedback_pr off (absent -> false): no PR is opened for its repos.
func TestRun_FeedbackPRDisabledRefused(t *testing.T) {
	entry := `{"slug":"quiz","name":"Quiz","mode":"individual","autograder":"default"}`
	mux := classroomMux(t, assignmentsJSON(t, entry), nil, nil)
	_, _, err := runCmd(t, mux, params(func(p *runParams) { p.assignment = "quiz" }))
	if err == nil || !strings.Contains(err.Error(), "feedback_pr disabled") {
		t.Fatalf("want a feedback_pr-disabled refusal, got %v", err)
	}
}

// TestRun_UnregisteredAssignmentRefused pins the not-registered error.
func TestRun_UnregisteredAssignmentRefused(t *testing.T) {
	mux := classroomMux(t, assignmentsJSON(t, helloEntry), nil, nil)
	_, _, err := runCmd(t, mux, params(func(p *runParams) { p.assignment = "nope" }))
	if err == nil || !strings.Contains(err.Error(), "not registered") {
		t.Fatalf("want a not-registered error, got %v", err)
	}
}

// TestNewCmd_Wiring pins the command shape (name, arg count, flags) so the
// registration in assignmentcmd stays valid.
func TestNewCmd_Wiring(t *testing.T) {
	cmd := NewCmd()
	if cmd.Use != "feedback-pr <org> <classroom> <assignment>" {
		t.Errorf("Use = %q", cmd.Use)
	}
	if cmd.Flags().Lookup("user") == nil || cmd.Flags().Lookup("quiet") == nil {
		t.Error("expected --user and --quiet flags")
	}
	if err := cmd.Args(cmd, []string{"o", "cs"}); err == nil {
		t.Error("want an arg-count error for 2 args (needs 3)")
	}
	if err := cmd.Args(cmd, []string{"o", "cs", "hello"}); err != nil {
		t.Errorf("3 args should be accepted, got %v", err)
	}
}

// TestResolveFeedbackTemplateRef pins the teacher-side gate: the flag lives in
// Extra (the Go teacher struct doesn't type it, like copy_about/copy_topics),
// so it must be decoded from there, gated on a non-nil Template, with an empty
// branch defaulting to main.
func TestResolveFeedbackTemplateRef(t *testing.T) {
	tmpl := &assignment.TemplateRef{Owner: "t", Repo: "tmpl", Branch: "dev"}
	extra := func(v string) map[string]json.RawMessage {
		return map[string]json.RawMessage{"feedback_pr_template": json.RawMessage(v)}
	}
	cases := []struct {
		name  string
		entry assignment.AssignmentEntry
		want  *feedbackTemplateRef
	}{
		{"opted in", assignment.AssignmentEntry{Template: tmpl, Extra: extra("true")},
			&feedbackTemplateRef{owner: "t", repo: "tmpl", branch: "dev"}},
		{"no template", assignment.AssignmentEntry{Template: nil, Extra: extra("true")}, nil},
		{"key absent", assignment.AssignmentEntry{Template: tmpl, Extra: nil}, nil},
		{"flag false", assignment.AssignmentEntry{Template: tmpl, Extra: extra("false")}, nil},
		{"non-bool value", assignment.AssignmentEntry{Template: tmpl, Extra: extra(`"yes"`)}, nil},
		{"empty branch defaults to main",
			assignment.AssignmentEntry{
				Template: &assignment.TemplateRef{Owner: "t", Repo: "tmpl", Branch: ""},
				Extra:    extra("true")},
			&feedbackTemplateRef{owner: "t", repo: "tmpl", branch: "main"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := resolveFeedbackTemplateRef(c.entry)
			if c.want == nil {
				if got != nil {
					t.Errorf("got %+v, want nil", got)
				}
				return
			}
			if got == nil || *got != *c.want {
				t.Errorf("got %+v, want %+v", got, c.want)
			}
		})
	}
}
