package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/ui"
)

// feedbackPRServer is a scriptable GitHub double for the accept-time Feedback
// PR sequence in o/r (default branch `main`, accept commit `accept-sha`,
// tree `tree-sha`). Knobs select the scenario; the recorder fields let tests
// assert exactly which writes happened (idempotency = zero writes).
type feedbackPRServer struct {
	// existingPRState, when non-empty, makes the base+head PR list return one
	// PR in that state ("open", "closed", "merged" — merged is closed+mergedAt
	// but the accept flow only counts rows, so the distinction is cosmetic).
	existingPRState string
	// refExists makes POST /git/refs 422 "Reference already exists".
	refExists bool
	// headHasDiff makes the FIRST pulls POST succeed immediately (no
	// zero-diff 422) — the interrupted-prior-accept case where the empty
	// commit already landed.
	headHasDiff bool
	// failPRCreate makes every pulls POST fail 403 (e.g. a fork of the
	// permissions problem the best-effort contract must absorb).
	failPRCreate bool

	refCreates    int
	commitCreates int
	refPatches    int
	prCreates     int
	labelCreates  int
	labelAdds     int

	lastCommitMessage string
	lastCommitTree    string
	lastPRBody        map[string]string
	lastLabelName     string
	lastAddedLabels   []string
}

func (s *feedbackPRServer) mux(t *testing.T) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			if s.existingPRState != "" {
				_ = json.NewEncoder(w).Encode([]map[string]any{{"number": 7, "state": s.existingPRState}})
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{})
			return
		}
		// POST
		s.prCreates++
		body, _ := io.ReadAll(r.Body)
		var pr map[string]string
		_ = json.Unmarshal(body, &pr)
		s.lastPRBody = pr
		if s.failPRCreate {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"message":"Resource not accessible by integration"}`)
			return
		}
		// First create 422s zero-diff unless the head already moved past the
		// accept commit (headHasDiff) or the empty commit landed (refPatches).
		if !s.headHasDiff && s.refPatches == 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"No commits between feedback and main"}]}`)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"number": 1})
	})

	mux.HandleFunc("/repos/o/r/git/refs", func(w http.ResponseWriter, r *http.Request) {
		s.refCreates++
		if s.refExists {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"message":"Reference already exists"}`)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/feedback"})
	})

	mux.HandleFunc("/repos/o/r/git/ref/heads/main", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": map[string]string{"sha": "accept-sha"},
		})
	})
	mux.HandleFunc("/repos/o/r/git/commits/accept-sha", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tree": map[string]string{"sha": "tree-sha"},
		})
	})
	mux.HandleFunc("/repos/o/r/git/commits", func(w http.ResponseWriter, r *http.Request) {
		s.commitCreates++
		body, _ := io.ReadAll(r.Body)
		var commit struct {
			Message string `json:"message"`
			Tree    string `json:"tree"`
		}
		_ = json.Unmarshal(body, &commit)
		s.lastCommitMessage = commit.Message
		s.lastCommitTree = commit.Tree
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"sha": "empty-sha"})
	})
	mux.HandleFunc("/repos/o/r/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.refPatches++
		_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/main"})
	})

	mux.HandleFunc("/repos/o/r/labels", func(w http.ResponseWriter, r *http.Request) {
		s.labelCreates++
		body, _ := io.ReadAll(r.Body)
		var label struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(body, &label)
		s.lastLabelName = label.Name
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{}`)
	})
	mux.HandleFunc("/repos/o/r/issues/1/labels", func(w http.ResponseWriter, r *http.Request) {
		s.labelAdds++
		body, _ := io.ReadAll(r.Body)
		var add struct {
			Labels []string `json:"labels"`
		}
		_ = json.Unmarshal(body, &add)
		s.lastAddedLabels = add.Labels
		_, _ = io.WriteString(w, `[]`)
	})

	return mux
}

func runEnsureFeedbackPR(t *testing.T, s *feedbackPRServer, mode string) error {
	t.Helper()
	server := httptest.NewServer(s.mux(t))
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)
	var out bytes.Buffer
	return ensureFeedbackPullRequest(client, ui.NewForced(&out, false), false, "o", "r", "main", "accept-sha", mode)
}

// TestEnsureFeedbackPullRequest_FreshAccept pins the full accept-time
// sequence: freeze the base, hit the zero-diff 422, land ONE empty commit
// (same tree as the head, [skip ci] in the message), fast-forward, retry the
// PR create, label it. This is the issue #228 happy path.
func TestEnsureFeedbackPullRequest_FreshAccept(t *testing.T) {
	s := &feedbackPRServer{}
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if s.refCreates != 1 {
		t.Errorf("feedback ref created %d times, want 1", s.refCreates)
	}
	if s.prCreates != 2 {
		t.Errorf("pulls POST attempted %d times, want 2 (zero-diff 422, then success)", s.prCreates)
	}
	if s.commitCreates != 1 || s.refPatches != 1 {
		t.Errorf("empty commit created %d times / ref patched %d times, want 1/1", s.commitCreates, s.refPatches)
	}
	if s.lastCommitTree != "tree-sha" {
		t.Errorf("empty commit tree = %q, want the head's own tree %q (a different tree would make the commit non-empty)", s.lastCommitTree, "tree-sha")
	}
	if want := contract.FeedbackOpenCommitMessage(); s.lastCommitMessage != want {
		t.Errorf("empty commit message = %q, want %q", s.lastCommitMessage, want)
	}
	if !strings.Contains(s.lastCommitMessage, "[skip ci]") {
		t.Error("empty commit message lacks [skip ci]; the autograde shim would run on the diff-less commit")
	}
	if s.lastPRBody["base"] != contract.FeedbackBaseBranch || s.lastPRBody["head"] != "main" {
		t.Errorf("PR base/head = %q/%q, want %q/main", s.lastPRBody["base"], s.lastPRBody["head"], contract.FeedbackBaseBranch)
	}
	if s.lastPRBody["title"] != contract.FeedbackPRTitle {
		t.Errorf("PR title = %q, want %q", s.lastPRBody["title"], contract.FeedbackPRTitle)
	}
	// The release URL is load-bearing: the runner's backfill_release_link
	// rewrites any open Feedback PR whose body lacks it.
	if !strings.Contains(s.lastPRBody["body"], "https://github.com/o/r/releases/latest") {
		t.Error("PR body lacks the releases/latest URL; the runner would clobber it on first submission")
	}
	if s.lastLabelName != "Individual Assignment" || len(s.lastAddedLabels) != 1 || s.lastAddedLabels[0] != "Individual Assignment" {
		t.Errorf("label = %q added %v, want Individual Assignment", s.lastLabelName, s.lastAddedLabels)
	}
}

// TestEnsureFeedbackPullRequest_GroupLabel pins the group-mode label so the
// runner (same _LABELS table) recognizes the accept-time PR as its own.
func TestEnsureFeedbackPullRequest_GroupLabel(t *testing.T) {
	s := &feedbackPRServer{}
	if err := runEnsureFeedbackPR(t, s, contract.ModeGroup); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.lastLabelName != "Group Assignment" {
		t.Errorf("label = %q, want Group Assignment", s.lastLabelName)
	}
}

// TestEnsureFeedbackPullRequest_ExistingPRIsReadOnly pins re-accept
// idempotency: a PR in ANY state short-circuits before any write — no second
// empty commit, no reopened PR, no duplicate.
func TestEnsureFeedbackPullRequest_ExistingPRIsReadOnly(t *testing.T) {
	for _, state := range []string{"open", "closed", "merged"} {
		t.Run(state, func(t *testing.T) {
			s := &feedbackPRServer{existingPRState: state}
			if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if s.refCreates+s.commitCreates+s.refPatches+s.prCreates+s.labelCreates+s.labelAdds != 0 {
				t.Errorf("writes happened on an already-PR'd repo: refs=%d commits=%d patches=%d prs=%d labels=%d/%d",
					s.refCreates, s.commitCreates, s.refPatches, s.prCreates, s.labelCreates, s.labelAdds)
			}
		})
	}
}

// TestEnsureFeedbackPullRequest_RefExistsIsTolerated pins the heal path: the
// feedback branch surviving a prior interrupted run (or created by the
// runner) is not an error; the flow continues to the PR create.
func TestEnsureFeedbackPullRequest_RefExistsIsTolerated(t *testing.T) {
	s := &feedbackPRServer{refExists: true}
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.prCreates == 0 {
		t.Error("PR was never created after tolerating the existing ref")
	}
}

// TestEnsureFeedbackPullRequest_PriorEmptyCommitNotDuplicated pins the
// PR-first ordering: when the head already has a commit past the accept SHA
// (a prior run's empty commit, or an instant student push), the first pulls
// POST succeeds and NO new empty commit is pushed.
func TestEnsureFeedbackPullRequest_PriorEmptyCommitNotDuplicated(t *testing.T) {
	s := &feedbackPRServer{headHasDiff: true}
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.commitCreates != 0 || s.refPatches != 0 {
		t.Errorf("empty commit pushed (%d commits, %d patches) though the PR could be created directly", s.commitCreates, s.refPatches)
	}
	if s.prCreates != 1 {
		t.Errorf("pulls POST attempted %d times, want 1", s.prCreates)
	}
}

// TestEnsureFeedbackPullRequest_CreateFailureSurfacesError pins that a hard
// failure comes back as an error (the caller downgrades it to a warning — the
// accept itself must not fail).
func TestEnsureFeedbackPullRequest_CreateFailureSurfacesError(t *testing.T) {
	s := &feedbackPRServer{failPRCreate: true}
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err == nil {
		t.Fatal("want an error when the PR create hard-fails, got nil")
	}
}

// TestIsNoCommitsBetween pins the 422 discriminator: GitHub's only signal is
// message text (errors[].code is the generic "custom").
func TestIsNoCommitsBetween(t *testing.T) {
	s := &feedbackPRServer{failPRCreate: true}
	server := httptest.NewServer(s.mux(t))
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	// A 403 must NOT be read as the zero-diff signal.
	_, err := createFeedbackPR(client, "o", "r", "main")
	if err == nil {
		t.Fatal("want error from 403 pulls POST")
	}
	if isNoCommitsBetween(err) {
		t.Error("a 403 was misread as the zero-diff 422")
	}

	s2 := &feedbackPRServer{}
	server2 := httptest.NewServer(s2.mux(t))
	t.Cleanup(server2.Close)
	client2 := newTestRESTClient(t, server2)
	_, err = createFeedbackPR(client2, "o", "r", "main")
	if err == nil {
		t.Fatal("want zero-diff 422 from first pulls POST")
	}
	if !isNoCommitsBetween(err) {
		t.Errorf("zero-diff 422 not recognized: %v", err)
	}
}

// TestAcceptCommitSHA pins the oldest-commit-touching-the-marker rule (the
// runner's baseline_sha() twin) used on the healthy re-accept path.
func TestAcceptCommitSHA(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/commits", func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("path"); got != ".classroom50.yaml" {
			t.Errorf("commits list filtered by path %q, want .classroom50.yaml", got)
		}
		// Newest-first, like GitHub.
		_ = json.NewEncoder(w).Encode([]map[string]string{
			{"sha": "newer"}, {"sha": "accept-sha"},
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	sha, err := acceptCommitSHA(client, "o", "r")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sha != "accept-sha" {
		t.Errorf("acceptCommitSHA = %q, want the OLDEST commit accept-sha", sha)
	}
}

// TestAcceptCommitSHA_NoMarkerCommits pins the empty-history error (a repo
// that never landed the marker cannot anchor a feedback base).
func TestAcceptCommitSHA_NoMarkerCommits(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/commits", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	if _, err := acceptCommitSHA(client, "o", "r"); err == nil {
		t.Fatal("want error when no commits touch the marker, got nil")
	}
}
