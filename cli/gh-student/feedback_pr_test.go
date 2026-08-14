package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/assignments"
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
	// existingBaseSHA is what GET /git/ref/heads/feedback reports when
	// refExists. Empty means the read 404s (unverifiable base).
	existingBaseSHA string
	// headHasDiff makes the FIRST pulls POST succeed immediately (no
	// zero-diff 422) — the interrupted-prior-accept case where the empty
	// commit already landed.
	headHasDiff bool
	// failPRCreate makes every pulls POST fail 403 (e.g. a fork of the
	// permissions problem the best-effort contract must absorb).
	failPRCreate bool
	// prCreateRace makes the pulls POST 422 "A pull request already exists"
	// and the NEXT list report one, modelling a concurrent accept that won.
	prCreateRace bool
	// failLabelAdd makes POST /issues/{n}/labels fail, so tests can assert a
	// label failure never fails the step.
	failLabelAdd bool
	// prListStates records the `state` query of every base+head PR list, so
	// tests can prove the any-state short-circuit really asks for state=all.
	prListStates []string
	prListBases  []string
	prListHeads  []string

	refCreates    int
	refReads      int
	commitCreates int
	refPatches    int
	prCreates     int
	labelCreates  int
	labelAdds     int

	// acceptSHAResolves counts lazy accept-SHA resolutions, so a test can prove
	// the paginated commit-history read is skipped when it isn't needed.
	acceptSHAResolves int

	lastCommitMessage string
	lastCommitTree    string
	lastRefBody       map[string]string
	lastPRBody        map[string]string
	lastLabelName     string
	lastAddedLabels   []string
}

func (s *feedbackPRServer) mux(t *testing.T) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			q := r.URL.Query()
			s.prListStates = append(s.prListStates, q.Get("state"))
			s.prListBases = append(s.prListBases, q.Get("base"))
			s.prListHeads = append(s.prListHeads, q.Get("head"))
			// A won race becomes visible only on the re-query after the
			// failed create.
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
		if s.prCreateRace {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for o:main."}]}`)
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
		body, _ := io.ReadAll(r.Body)
		var ref map[string]string
		_ = json.Unmarshal(body, &ref)
		s.lastRefBody = ref
		if s.refExists {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"message":"Reference already exists"}`)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"ref": "refs/heads/feedback"})
	})

	mux.HandleFunc("/repos/o/r/git/ref/heads/feedback", func(w http.ResponseWriter, _ *http.Request) {
		s.refReads++
		if s.existingBaseSHA == "" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": map[string]string{"sha": s.existingBaseSHA},
		})
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
		if s.failLabelAdd {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"message":"Resource not accessible by integration"}`)
			return
		}
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
	return ensureFeedbackPullRequest(client, ui.NewForced(&out, false), false, "o", "r", "main", mode, nil,
		func() (string, error) {
			s.acceptSHAResolves++
			return "accept-sha", nil
		})
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
	// The release URL is part of the built-in body: it links the latest
	// autograding result and self-updates via .../releases/latest.
	if !strings.Contains(s.lastPRBody["body"], "https://github.com/o/r/releases/latest") {
		t.Error("PR body lacks the releases/latest URL; the built-in body must carry the latest-submission link")
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
			// The short-circuit only covers a closed/merged PR because the
			// query asks for every state; state=open would silently reopen the
			// duplicate-PR hole.
			if len(s.prListStates) == 0 || s.prListStates[0] != "all" {
				t.Errorf("PR lookup used state=%v, want state=all", s.prListStates)
			}
			if s.prListBases[0] != contract.FeedbackBaseBranch {
				t.Errorf("PR lookup base = %q, want %q", s.prListBases[0], contract.FeedbackBaseBranch)
			}
			if s.prListHeads[0] != "o:main" {
				t.Errorf("PR lookup head = %q, want the owner-qualified o:main", s.prListHeads[0])
			}
			// The accept SHA costs a paginated commit-history read, so it must
			// not be resolved on the path that short-circuits without it.
			if s.acceptSHAResolves != 0 {
				t.Errorf("accept SHA resolved %d times on an already-PR'd repo, want 0", s.acceptSHAResolves)
			}
		})
	}
}

// TestEnsureFeedbackPullRequest_RefExistsAtAcceptSHAIsTolerated pins the heal
// path: a feedback branch surviving a prior interrupted run (or created by the
// runner) at the SAME accept commit is not an error; the flow continues to the
// PR create.
func TestEnsureFeedbackPullRequest_RefExistsAtAcceptSHAIsTolerated(t *testing.T) {
	s := &feedbackPRServer{refExists: true, existingBaseSHA: "accept-sha"}
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.refReads == 0 {
		t.Error("existing feedback ref was adopted without reading its SHA back")
	}
	if s.prCreates == 0 {
		t.Error("PR was never created after tolerating the existing ref")
	}
}

// TestEnsureFeedbackPullRequest_RefExistsAtWrongSHAIsRefused is the
// poisoned-base guard. The org ruleset locks updates and deletion but leaves
// creation open, so a student can pre-create `feedback` at their finished HEAD;
// opening the PR there would show the teacher an empty grading diff. Mirrors
// the runner's `existing != base_sha` refusal.
func TestEnsureFeedbackPullRequest_RefExistsAtWrongSHAIsRefused(t *testing.T) {
	s := &feedbackPRServer{refExists: true, existingBaseSHA: "student-chosen-sha"}
	err := runEnsureFeedbackPR(t, s, contract.ModeIndividual)
	if err == nil {
		t.Fatal("want an error when feedback points at a commit other than the accept SHA, got nil")
	}
	if !strings.Contains(err.Error(), "student-chosen-sha") {
		t.Errorf("error should name the unexpected base SHA, got %v", err)
	}
	if s.prCreates != 0 {
		t.Errorf("PR created (%d times) over an unverified base", s.prCreates)
	}
}

// TestEnsureFeedbackPullRequest_UnreadableRefIsRefused pins that an
// unverifiable base is treated like a wrong one: the read failing (403/5xx) must
// not be read as "matches". Same rule as the runner's existing_base_sha, which
// raises on anything but a genuine 404.
func TestEnsureFeedbackPullRequest_UnreadableRefIsRefused(t *testing.T) {
	s := &feedbackPRServer{refExists: true} // existingBaseSHA empty -> read 404s
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err == nil {
		t.Fatal("want an error when the existing feedback ref can't be read, got nil")
	}
	if s.prCreates != 0 {
		t.Errorf("PR created (%d times) over an unreadable base", s.prCreates)
	}
}

// TestEnsureFeedbackPullRequest_FreezesBaseAtAcceptSHA pins the ref body: the
// base must be frozen at the accept commit, since the runner verifies exactly
// that SHA before it will maintain the PR.
func TestEnsureFeedbackPullRequest_FreezesBaseAtAcceptSHA(t *testing.T) {
	s := &feedbackPRServer{}
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := s.lastRefBody["ref"]; got != "refs/heads/"+contract.FeedbackBaseBranch {
		t.Errorf("created ref = %q, want refs/heads/%s", got, contract.FeedbackBaseBranch)
	}
	if got := s.lastRefBody["sha"]; got != "accept-sha" {
		t.Errorf("feedback base frozen at %q, want the accept commit accept-sha", got)
	}
}

// TestEnsureFeedbackPullRequest_LostCreateRaceIsNotAFailure pins the
// concurrent-accept case (two group members, or a re-accept racing the runner):
// the loser gets GitHub's "A pull request already exists" 422, and re-querying
// finds the PR, so the student is never told nothing was opened.
func TestEnsureFeedbackPullRequest_LostCreateRaceIsNotAFailure(t *testing.T) {
	s := &feedbackPRServer{prCreateRace: true, headHasDiff: true}
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("a lost create race must resolve as success, got %v", err)
	}
}

// TestEnsureFeedbackPullRequest_LabelFailureDoesNotFailTheStep pins the
// best-effort label: the PR is in place, so a label failure is reported but
// never returned.
func TestEnsureFeedbackPullRequest_LabelFailureDoesNotFailTheStep(t *testing.T) {
	s := &feedbackPRServer{failLabelAdd: true}
	if err := runEnsureFeedbackPR(t, s, contract.ModeIndividual); err != nil {
		t.Fatalf("a label failure must not fail the step, got %v", err)
	}
	if s.labelAdds == 0 {
		t.Error("label add was never attempted")
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
	_, err := createFeedbackPR(client, "o", "r", "main", nil)
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
	_, err = createFeedbackPR(client2, "o", "r", "main", nil)
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

// TestAcceptCommitSHA_PaginatesToTheOldestCommit pins the page walk. A single
// full page would hand back a NEWER commit as the "accept commit", freezing the
// feedback base where the runner's baseline_sha() disagrees — which strands the
// PR behind the runner's poisoned-base refusal for the repo's whole life.
func TestAcceptCommitSHA_PaginatesToTheOldestCommit(t *testing.T) {
	var server *httptest.Server
	mux := http.NewServeMux()
	var requests int
	mux.HandleFunc("/repos/o/r/commits", func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Query().Get("cursor") == "two" {
			// Final page, no Link rel=next -> the walk stops here.
			_ = json.NewEncoder(w).Encode([]map[string]string{
				{"sha": "older"}, {"sha": "accept-sha"},
			})
			return
		}
		// A FULL first page advertising the next one, exactly as GitHub replies
		// when the marker's history exceeds a page.
		w.Header().Set("Link", `<`+server.URL+`/repos/o/r/commits?cursor=two>; rel="next"`)
		full := make([]map[string]string, 100)
		for i := range full {
			full[i] = map[string]string{"sha": "newer"}
		}
		_ = json.NewEncoder(w).Encode(full)
	})
	server = httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	sha, err := acceptCommitSHA(client, "o", "r")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sha != "accept-sha" {
		t.Errorf("acceptCommitSHA = %q, want the oldest commit accept-sha across pages", sha)
	}
	if requests < 2 {
		t.Errorf("only %d request(s); a full page must be followed to its next page", requests)
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

// templatePRBodyMux serves the pulls POST for o/r (head already has a diff, so
// it 201s without the empty-commit dance) plus a scriptable contents endpoint
// for the template repo t/tmpl. contentsByPath maps a repo-relative path to a
// decoded body; status maps a path to a non-200 (403/404) to exercise per-path
// fall-through and fail-open. A path absent from both maps 404s.
func templatePRBodyMux(t *testing.T, contentsByPath map[string]string, status map[string]int) (*http.ServeMux, *map[string]string) {
	t.Helper()
	mux := http.NewServeMux()
	captured := map[string]string{}
	mux.HandleFunc("/repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &captured)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"number": 1})
	})
	mux.HandleFunc("/repos/t/tmpl/contents/", func(w http.ResponseWriter, r *http.Request) {
		// Path after ".../contents/", ignoring the ?ref= query.
		rel := strings.TrimPrefix(r.URL.EscapedPath(), "/repos/t/tmpl/contents/")
		if code, ok := status[rel]; ok {
			w.WriteHeader(code)
			_, _ = io.WriteString(w, `{"message":"nope"}`)
			return
		}
		content, ok := contentsByPath[rel]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"message":"Not Found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"content":  base64.StdEncoding.EncodeToString([]byte(content)),
			"encoding": "base64",
		})
	})
	return mux, &captured
}

func tmplRef() *feedbackTemplateRef {
	return &feedbackTemplateRef{owner: "t", repo: "tmpl", branch: "main"}
}

// TestCreateFeedbackPR_TemplateBodyVerbatim: flag set + a readable template PR
// file -> the PR body is the file's contents byte-for-byte (no substitution),
// not the built-in body.
func TestCreateFeedbackPR_TemplateBodyVerbatim(t *testing.T) {
	teacher := "Custom teacher body :sparkles: with `HEAD_BRANCH` left literal"
	mux, captured := templatePRBodyMux(t,
		map[string]string{".github/pull_request_template.md": teacher}, nil)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	if _, err := createFeedbackPR(client, "o", "r", "main", tmplRef()); err != nil {
		t.Fatalf("createFeedbackPR: %v", err)
	}
	if (*captured)["body"] != teacher {
		t.Errorf("PR body = %q, want the teacher template verbatim %q", (*captured)["body"], teacher)
	}
}

// TestCreateFeedbackPR_TemplateProbeOrder: the first native path missing (404)
// falls through to the second, which is used.
func TestCreateFeedbackPR_TemplateProbeOrder(t *testing.T) {
	teacher := "root template"
	mux, captured := templatePRBodyMux(t,
		map[string]string{"pull_request_template.md": teacher}, nil)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	if _, err := createFeedbackPR(client, "o", "r", "main", tmplRef()); err != nil {
		t.Fatalf("createFeedbackPR: %v", err)
	}
	if (*captured)["body"] != teacher {
		t.Errorf("PR body = %q, want the second-path template %q", (*captured)["body"], teacher)
	}
}

// TestCreateFeedbackPR_FailsOpenToBuiltin exercises every fall-open branch:
// all paths 404, a 403 (private/lost read), an empty-after-trim file, and an
// oversize file. Each yields the built-in body, and the PR is still created.
func TestCreateFeedbackPR_FailsOpenToBuiltin(t *testing.T) {
	builtinMarker := "**Don't close or merge this pull request**"
	oversize := strings.Repeat("x", contract.FeedbackTemplateMaxBytes+1)
	cases := []struct {
		name     string
		contents map[string]string
		status   map[string]int
	}{
		{"all paths 404", nil, nil},
		{"private/lost read 403", nil, map[string]int{
			".github/pull_request_template.md": http.StatusForbidden,
			"pull_request_template.md":         http.StatusForbidden,
			"docs/pull_request_template.md":    http.StatusForbidden,
		}},
		{"empty after trim", map[string]string{".github/pull_request_template.md": "   \n\t "}, nil},
		{"oversize", map[string]string{".github/pull_request_template.md": oversize}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mux, captured := templatePRBodyMux(t, c.contents, c.status)
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			client := newTestRESTClient(t, server)

			if _, err := createFeedbackPR(client, "o", "r", "main", tmplRef()); err != nil {
				t.Fatalf("createFeedbackPR: %v", err)
			}
			if !strings.Contains((*captured)["body"], builtinMarker) {
				t.Errorf("expected the built-in body, got %q", (*captured)["body"])
			}
		})
	}
}

// TestCreateFeedbackPR_NilRefNoProbe: no template ref -> built-in body and the
// template contents endpoint is never called.
func TestCreateFeedbackPR_NilRefNoProbe(t *testing.T) {
	probed := false
	mux, captured := templatePRBodyMux(t, nil, nil)
	mux.HandleFunc("/repos/t/tmpl/", func(w http.ResponseWriter, _ *http.Request) {
		probed = true
		w.WriteHeader(http.StatusNotFound)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	client := newTestRESTClient(t, server)

	if _, err := createFeedbackPR(client, "o", "r", "main", nil); err != nil {
		t.Fatalf("createFeedbackPR: %v", err)
	}
	if probed {
		t.Error("template repo was probed even though no template ref was passed")
	}
	if !strings.Contains((*captured)["body"], "**Don't close or merge this pull request**") {
		t.Errorf("expected built-in body, got %q", (*captured)["body"])
	}
}

// TestResolveFeedbackTemplateRef pins the accept-side gate: only feedback_pr
// AND feedback_pr_template AND a template yield a ref; an empty branch -> main.
func TestResolveFeedbackTemplateRef(t *testing.T) {
	tmpl := &assignments.TemplateRef{Owner: "t", Repo: "tmpl", Branch: "dev"}
	cases := []struct {
		name  string
		entry assignments.Entry
		want  *feedbackTemplateRef
	}{
		{"opted in", assignments.Entry{FeedbackPR: true, FeedbackPRTemplate: true, Template: tmpl},
			&feedbackTemplateRef{owner: "t", repo: "tmpl", branch: "dev"}},
		{"flag off", assignments.Entry{FeedbackPR: true, FeedbackPRTemplate: false, Template: tmpl}, nil},
		{"feedback_pr off", assignments.Entry{FeedbackPR: false, FeedbackPRTemplate: true, Template: tmpl}, nil},
		{"no template", assignments.Entry{FeedbackPR: true, FeedbackPRTemplate: true, Template: nil}, nil},
		{"empty branch defaults to main",
			assignments.Entry{FeedbackPR: true, FeedbackPRTemplate: true,
				Template: &assignments.TemplateRef{Owner: "t", Repo: "tmpl", Branch: ""}},
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
