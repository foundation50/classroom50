package feedbackpr

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// ensureServer is a scriptable GitHub double for the teacher-side ensure flow
// on o/r (default branch `main`, accept commit `accept-sha`, tree `tree-sha`).
// Ported from the accept-side double (cli/gh-student/feedback_pr_test.go),
// adapted to the teacher CLI: the repo object read (for the settled default
// branch) is served, and the ref PATCH goes through the same endpoint. Knobs
// select the scenario; the counters let tests assert idempotency.
type ensureServer struct {
	existingPRState string // non-empty -> the base+head PR list returns one PR in that state
	refExists       bool   // POST /git/refs 422 "Reference already exists"
	existingBaseSHA string // GET /git/ref/heads/feedback SHA when refExists ("" -> read 404s)
	refReadStatus   int    // when refExists and non-zero, GET /git/ref/heads/feedback returns this status (overrides existingBaseSHA)
	headHasDiff     bool   // first pulls POST succeeds immediately (no zero-diff 422)
	failPRCreate    bool   // every pulls POST 403
	prCreateRace    bool   // pulls POST 422 "already exists" and the NEXT list reports one
	failLabelAdd    bool   // POST /issues/{n}/labels fails
	failRefPatch    bool   // PATCH /git/refs/heads/main 422 (lost the fast-forward race)
	retryablePRList int    // fail the first N GET /pulls with a retryable 502, then behave normally

	prListStates []string

	refCreates    int
	refReads      int
	commitCreates int
	refPatches    int
	prCreates     int
	labelAdds     int
	prListCalls   int

	lastCommitMessage string
	lastCommitTree    string
	lastRefBody       map[string]string
	lastPRBody        map[string]string
	lastAddedLabels   []string
}

func (s *ensureServer) mux(t *testing.T) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()

	// The settled default branch read (teacher CLI resolves it from the repo
	// object rather than being handed `main` up front).
	mux.HandleFunc("/repos/o/r", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
	})

	mux.HandleFunc("/repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			s.prListCalls++
			// Ride out the whole-ensure retry: fail the first N existence
			// probes with a retryable 502, then behave normally.
			if s.prListCalls <= s.retryablePRList {
				write422or403(w, http.StatusBadGateway, `{"message":"Server Error"}`)
				return
			}
			s.prListStates = append(s.prListStates, r.URL.Query().Get("state"))
			if s.existingPRState != "" || (s.prCreateRace && s.prCreates > 0) {
				state := s.existingPRState
				if state == "" {
					state = "open"
				}
				_ = json.NewEncoder(w).Encode([]map[string]any{{"number": 7, "state": state}})
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{})
			return
		}
		s.prCreates++
		body, _ := io.ReadAll(r.Body)
		var pr map[string]string
		_ = json.Unmarshal(body, &pr)
		s.lastPRBody = pr
		if s.failPRCreate {
			write422or403(w, http.StatusForbidden, `{"message":"Resource not accessible by integration"}`)
			return
		}
		if s.prCreateRace {
			write422or403(w, http.StatusUnprocessableEntity, `{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for o:main."}]}`)
			return
		}
		if !s.headHasDiff && s.refPatches == 0 {
			write422or403(w, http.StatusUnprocessableEntity, `{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"No commits between feedback and main"}]}`)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"number": 1})
	})

	mux.HandleFunc("/repos/o/r/git/refs", func(w http.ResponseWriter, r *http.Request) {
		s.refCreates++
		body, _ := io.ReadAll(r.Body)
		var ref map[string]string
		_ = json.Unmarshal(body, &ref)
		s.lastRefBody = ref
		if s.refExists {
			write422or403(w, http.StatusUnprocessableEntity, `{"message":"Reference already exists"}`)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/feedback"})
	})

	mux.HandleFunc("/repos/o/r/git/ref/heads/feedback", func(w http.ResponseWriter, _ *http.Request) {
		s.refReads++
		if s.refReadStatus != 0 {
			write422or403(w, s.refReadStatus, `{"message":"Server Error"}`)
			return
		}
		if s.existingBaseSHA == "" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": s.existingBaseSHA}})
	})

	mux.HandleFunc("/repos/o/r/git/ref/heads/main", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "accept-sha"}})
	})
	mux.HandleFunc("/repos/o/r/git/commits/accept-sha", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "tree-sha"}})
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
		if s.failRefPatch {
			// Lost the fast-forward race (a student pushed between our
			// branch-tip read and this PATCH): GitHub 422s a non-fast-forward.
			write422or403(w, http.StatusUnprocessableEntity, `{"message":"Update is not a fast forward"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/main"})
	})

	mux.HandleFunc("/repos/o/r/labels", func(w http.ResponseWriter, _ *http.Request) {
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
		if s.failLabelAdd {
			write422or403(w, http.StatusForbidden, `{"message":"Resource not accessible by integration"}`)
			return
		}
		_, _ = io.WriteString(w, `[]`)
	})

	// Commit-history read for the accept SHA (oldest-first-touching-marker).
	mux.HandleFunc("/repos/o/r/commits", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]map[string]string{{"sha": "newer"}, {"sha": "accept-sha"}})
	})

	return mux
}

func write422or403(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func runEnsure(t *testing.T, s *ensureServer, mode string) error {
	t.Helper()
	server := httptest.NewServer(s.mux(t))
	t.Cleanup(server.Close)
	client := githubtest.NewTestClient(t, server)
	return ensureFeedbackPullRequest(client, "o", "r", "main", mode)
}

// TestEnsure_FreshOpen pins the full sequence on an un-pushed repo: freeze the
// base at the accept commit, hit the zero-diff 422, land ONE empty commit (the
// head's own tree, [skip ci] in the message), fast-forward, retry the create,
// label it. Returns nil (a fresh open).
func TestEnsure_FreshOpen(t *testing.T) {
	s := &ensureServer{}
	if err := runEnsure(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.refCreates != 1 {
		t.Errorf("feedback ref created %d times, want 1", s.refCreates)
	}
	if s.prCreates != 2 {
		t.Errorf("pulls POST attempted %d times, want 2 (zero-diff 422, then success)", s.prCreates)
	}
	if s.commitCreates != 1 || s.refPatches != 1 {
		t.Errorf("empty commit %d / ref patch %d, want 1/1", s.commitCreates, s.refPatches)
	}
	if s.lastCommitTree != "tree-sha" {
		t.Errorf("empty commit tree = %q, want the head's own tree tree-sha", s.lastCommitTree)
	}
	if want := contract.FeedbackOpenCommitMessage(); s.lastCommitMessage != want {
		t.Errorf("empty commit message = %q, want %q", s.lastCommitMessage, want)
	}
	if s.lastRefBody["sha"] != "accept-sha" {
		t.Errorf("feedback base frozen at %q, want accept-sha", s.lastRefBody["sha"])
	}
	if s.lastPRBody["base"] != contract.FeedbackBaseBranch || s.lastPRBody["head"] != "main" {
		t.Errorf("PR base/head = %q/%q, want %q/main", s.lastPRBody["base"], s.lastPRBody["head"], contract.FeedbackBaseBranch)
	}
	if s.lastPRBody["title"] != contract.FeedbackPRTitle {
		t.Errorf("PR title = %q, want %q", s.lastPRBody["title"], contract.FeedbackPRTitle)
	}
	if !strings.Contains(s.lastPRBody["body"], "https://github.com/o/r/releases/latest") {
		t.Error("PR body lacks the releases/latest URL; the runner would clobber it")
	}
	if len(s.lastAddedLabels) != 1 || s.lastAddedLabels[0] != "Individual Assignment" {
		t.Errorf("added labels = %v, want [Individual Assignment]", s.lastAddedLabels)
	}
}

// TestEnsure_ExistingPRIsAlreadyExists pins idempotency: a PR in ANY state
// short-circuits before any write and returns errAlreadyExists (counted as
// "already had one", never re-opened).
func TestEnsure_ExistingPRIsAlreadyExists(t *testing.T) {
	for _, state := range []string{"open", "closed", "merged"} {
		t.Run(state, func(t *testing.T) {
			s := &ensureServer{existingPRState: state}
			err := runEnsure(t, s, contract.ModeIndividual)
			if !isAlreadyExists(err) {
				t.Fatalf("err = %v, want errAlreadyExists", err)
			}
			if s.refCreates+s.commitCreates+s.refPatches+s.prCreates+s.labelAdds != 0 {
				t.Errorf("writes on an already-PR'd repo: refs=%d commits=%d patches=%d prs=%d labels=%d",
					s.refCreates, s.commitCreates, s.refPatches, s.prCreates, s.labelAdds)
			}
			if len(s.prListStates) == 0 || s.prListStates[0] != "all" {
				t.Errorf("PR lookup used state=%v, want state=all", s.prListStates)
			}
		})
	}
}

// TestEnsure_RefExistsAtAcceptSHAIsTolerated pins the heal path: a feedback
// branch surviving a prior interrupted run at the SAME accept commit is adopted
// (read back), not an error.
func TestEnsure_RefExistsAtAcceptSHAIsTolerated(t *testing.T) {
	s := &ensureServer{refExists: true, existingBaseSHA: "accept-sha"}
	if err := runEnsure(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.refReads == 0 {
		t.Error("existing feedback ref adopted without reading its SHA back")
	}
	if s.prCreates == 0 {
		t.Error("PR never created after tolerating the existing ref")
	}
}

// TestEnsure_RefExistsAtWrongSHAIsBlocked is the poisoned-base guard: a
// student-precreated `feedback` at a different SHA returns errBaseMismatch (the
// blocked bucket), never opening a PR over the wrong base.
func TestEnsure_RefExistsAtWrongSHAIsBlocked(t *testing.T) {
	s := &ensureServer{refExists: true, existingBaseSHA: "student-chosen-sha"}
	err := runEnsure(t, s, contract.ModeIndividual)
	if !isBaseMismatch(err) {
		t.Fatalf("err = %v, want errBaseMismatch", err)
	}
	if !strings.Contains(err.Error(), "student-chosen-sha") {
		t.Errorf("error should name the unexpected base SHA, got %v", err)
	}
	if s.prCreates != 0 {
		t.Errorf("PR created (%d times) over an unverified base", s.prCreates)
	}
}

// TestEnsure_LostCreateRaceIsAlreadyExists pins the concurrent-open case: the
// loser gets GitHub's "already exists" 422 and re-querying finds the PR, so it
// resolves as errAlreadyExists, not a failure.
func TestEnsure_LostCreateRaceIsAlreadyExists(t *testing.T) {
	s := &ensureServer{prCreateRace: true, headHasDiff: true}
	if err := runEnsure(t, s, contract.ModeIndividual); !isAlreadyExists(err) {
		t.Fatalf("err = %v, want errAlreadyExists", err)
	}
}

// TestEnsure_LabelFailureDoesNotFail pins the best-effort label: the PR is in
// place, so a label failure never fails the open.
func TestEnsure_LabelFailureDoesNotFail(t *testing.T) {
	s := &ensureServer{failLabelAdd: true}
	if err := runEnsure(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("a label failure must not fail the open, got %v", err)
	}
	if s.labelAdds == 0 {
		t.Error("label add was never attempted")
	}
}

// TestEnsure_PriorEmptyCommitNotDuplicated pins PR-first ordering: when the
// head already moved past the accept SHA, the first create succeeds and no new
// empty commit is pushed.
func TestEnsure_PriorEmptyCommitNotDuplicated(t *testing.T) {
	s := &ensureServer{headHasDiff: true}
	if err := runEnsure(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.commitCreates != 0 || s.refPatches != 0 {
		t.Errorf("empty commit pushed (%d commits, %d patches) though the PR could open directly", s.commitCreates, s.refPatches)
	}
	if s.prCreates != 1 {
		t.Errorf("pulls POST attempted %d times, want 1", s.prCreates)
	}
}

// TestEnsure_CreateFailureSurfacesError pins that a hard 403 comes back as a
// (failed-bucket) error.
func TestEnsure_CreateFailureSurfacesError(t *testing.T) {
	s := &ensureServer{failPRCreate: true}
	err := runEnsure(t, s, contract.ModeIndividual)
	if err == nil {
		t.Fatal("want an error when the PR create hard-fails, got nil")
	}
	if isAlreadyExists(err) || isBaseMismatch(err) {
		t.Errorf("a 403 must be a plain (failed) error, got %v", err)
	}
}

// TestEnsure_GroupLabel pins the group-mode label so the runner (same table)
// recognizes the PR as its own.
func TestEnsure_GroupLabel(t *testing.T) {
	s := &ensureServer{}
	if err := runEnsure(t, s, contract.ModeGroup); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(s.lastAddedLabels) != 1 || s.lastAddedLabels[0] != "Group Assignment" {
		t.Errorf("added labels = %v, want [Group Assignment]", s.lastAddedLabels)
	}
}

// TestEnsure_RetryableFailureThenSuccess pins the whole-ensure retry loop (the
// reason this package rides out GitHub's post-create git-data lag): the first
// existence probe 502s (retryable), so the ensure retries and the second
// attempt opens the PR. Without the loop this would surface the 502 as a
// failure.
func TestEnsure_RetryableFailureThenSuccess(t *testing.T) {
	s := &ensureServer{retryablePRList: 1, headHasDiff: true}
	if err := runEnsure(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("a retryable 502 on attempt 1 should be ridden out, got %v", err)
	}
	if s.prListCalls < 2 {
		t.Errorf("existence probe called %d times, want >=2 (a retry after the 502)", s.prListCalls)
	}
	if s.prCreates == 0 {
		t.Error("PR never created after the retry succeeded")
	}
}

// TestEnsure_RefPatchFailureSurfacesError pins the lost-ref-race path the
// force:false empty commit is built around: when a student pushes between our
// branch-tip read and the fast-forward PATCH, GitHub 422s the non-fast-forward,
// and the ensure surfaces that as a (failed-bucket) error rather than opening a
// PR over a stale head. 422 is non-retryable, so a re-run — by which point the
// student's push gives the head a diff — heals it.
func TestEnsure_RefPatchFailureSurfacesError(t *testing.T) {
	s := &ensureServer{failRefPatch: true}
	err := runEnsure(t, s, contract.ModeIndividual)
	if err == nil {
		t.Fatal("want an error when the fast-forward PATCH loses the race, got nil")
	}
	if isAlreadyExists(err) || isBaseMismatch(err) {
		t.Errorf("a lost ref race must be a plain (failed) error, got %v", err)
	}
	if s.commitCreates != 1 {
		t.Errorf("empty commit created %d times, want 1 (created before the failing PATCH)", s.commitCreates)
	}
	// The retried create must never run: the head never fast-forwarded, so
	// opening a PR now would be over the stale head.
	if s.prCreates != 1 {
		t.Errorf("pulls POST attempted %d times, want 1 (no create after the PATCH failed)", s.prCreates)
	}
}

// TestEnsure_UnverifiableBaseIsNotAdopted pins the safety rule that an
// unverifiable existing base is as unsafe as a wrong one: after the ref-create
// 422 (already exists), a NON-404 read-back error (here a 500) must fail the
// ensure — never silently adopt the branch and open a PR over an unverified
// base.
func TestEnsure_UnverifiableBaseIsNotAdopted(t *testing.T) {
	s := &ensureServer{refExists: true, refReadStatus: http.StatusInternalServerError}
	err := runEnsure(t, s, contract.ModeIndividual)
	if err == nil {
		t.Fatal("want an error when the existing base can't be verified, got nil")
	}
	if isAlreadyExists(err) || isBaseMismatch(err) {
		t.Errorf("an unverifiable base must be a plain error, not exists/mismatch, got %v", err)
	}
	if s.refReads == 0 {
		t.Error("the existing feedback ref was never read back")
	}
	if s.prCreates != 0 {
		t.Errorf("PR created (%d times) over an unverified base", s.prCreates)
	}
}
