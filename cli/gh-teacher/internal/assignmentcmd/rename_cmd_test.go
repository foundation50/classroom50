package assignmentcmd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// Rename-command fixture: org "o", classroom "cs" (57-char slug budget), an
// over-budget 58-char old slug, and the 3-char replacement "ps3".
var (
	renameOldSlug = strings.Repeat("s", 58)
	renameNewSlug = "ps3"
	// alice's repo carries a marker naming the OLD slug (ours to rename);
	// bob's repo matches the old prefix but its marker names a sibling slug
	// (prefix over-match — must be left untouched).
	renameAliceRepo   = "cs-" + renameOldSlug + "-alice"
	renameForeignRepo = "cs-" + renameOldSlug + "-extra-bob"
)

type renameFixture struct {
	mu sync.Mutex
	// Served (and updated) config-repo file contents, keyed by config path.
	assignments string
	scores      string
	// Every decoded blob committed to the config repo, in order.
	configBlobs []string
	// Tree payload entries per config-repo commit: path -> sha (nil = delete).
	configTrees []map[string]*string
	// Decoded marker blobs per student repo.
	markerBlobs map[string][]string
	// Commit messages per repo.
	messages map[string][]string
	// PATCH /repos rename payloads: repo -> requested new name.
	renamePatches map[string]string
}

func renameAssignmentsBody(slug, renamedFrom string, locked bool) string {
	entry := map[string]any{
		"slug": slug, "name": "Long", "mode": "individual", "autograder": "default",
	}
	if renamedFrom != "" {
		entry["renamed_from"] = renamedFrom
	}
	if locked {
		entry["locked"] = true
	}
	sibling := map[string]any{
		"slug": "hw2", "name": "HW2", "mode": "individual", "autograder": "default",
	}
	doc := map[string]any{
		"schema":      "classroom50/assignments/v1",
		"assignments": []any{entry, sibling},
	}
	b, _ := json.Marshal(doc)
	return string(b)
}

func renameScoresBody(slug string) string {
	return `{"schema":"classroom50/scores/v1","assignments":{"` + slug + `":{"type":"individual","entries":[{"owner":"alice","submissions":[]}]}}}`
}

// newRenameServer wires every endpoint the rename flow touches. Stateful where
// it matters: committing an assignments.json/scores.json blob updates what the
// contents route serves next, so the lock-restore read observes the rename.
func newRenameServer(t *testing.T, assignments string, repoNames []string, markers map[string]string) (*httptest.Server, *renameFixture) {
	t.Helper()
	fix := &renameFixture{
		assignments:   assignments,
		scores:        renameScoresBody(renameOldSlug),
		markerBlobs:   map[string][]string{},
		messages:      map[string][]string{},
		renamePatches: map[string]string{},
	}
	mux := http.NewServeMux()
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	serveB64 := func(w http.ResponseWriter, content string) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"type": "file", "encoding": "base64", "content": b64(content), "sha": "file-sha",
		})
	}

	mux.HandleFunc("/orgs/o/repos", func(w http.ResponseWriter, _ *http.Request) {
		type repo struct {
			Name string `json:"name"`
		}
		repos := make([]repo, 0, len(repoNames))
		for _, n := range repoNames {
			repos = append(repos, repo{Name: n})
		}
		_ = json.NewEncoder(w).Encode(repos)
	})

	// Config repo: metadata, contents, autograder subtree, commit machinery.
	mux.HandleFunc("/repos/o/classroom50", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs/assignments.json", func(w http.ResponseWriter, _ *http.Request) {
		fix.mu.Lock()
		defer fix.mu.Unlock()
		serveB64(w, fix.assignments)
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs/scores.json", func(w http.ResponseWriter, _ *http.Request) {
		fix.mu.Lock()
		defer fix.mu.Unlock()
		serveB64(w, fix.scores)
	})
	mux.HandleFunc("/repos/o/classroom50/contents/cs/autograders/", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, renameOldSlug+"/autograder.py") {
			serveB64(w, "print('grade')\n")
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/repos/o/classroom50/git/trees/parent-tree", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tree": []map[string]string{
				{"path": "cs/autograders/" + renameOldSlug + "/autograder.py", "type": "blob"},
				{"path": "cs/assignments.json", "type": "blob"},
			},
			"truncated": false,
		})
	})

	// Shared commit machinery for the config repo and every student repo.
	commitRoutes := func(repo string, isConfig bool) {
		base := "/repos/o/" + repo
		mux.HandleFunc(base+"/git/refs/heads/main", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				w.WriteHeader(http.StatusOK)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent-sha"}})
		})
		mux.HandleFunc(base+"/git/commits/parent-sha", func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
		})
		mux.HandleFunc(base+"/git/blobs", func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var payload struct{ Content, Encoding string }
			_ = json.Unmarshal(body, &payload)
			decoded, _ := base64.StdEncoding.DecodeString(payload.Content)
			fix.mu.Lock()
			if isConfig {
				fix.configBlobs = append(fix.configBlobs, string(decoded))
				// Stateful: later reads must observe the committed file.
				switch {
				case strings.Contains(string(decoded), "classroom50/assignments/v1"):
					fix.assignments = string(decoded)
				case strings.Contains(string(decoded), "classroom50/scores/v1"):
					fix.scores = string(decoded)
				}
			} else {
				fix.markerBlobs[repo] = append(fix.markerBlobs[repo], string(decoded))
			}
			fix.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob-sha"})
		})
		mux.HandleFunc(base+"/git/trees", func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var payload struct {
				Tree []struct {
					Path string  `json:"path"`
					SHA  *string `json:"sha"`
				} `json:"tree"`
			}
			_ = json.Unmarshal(body, &payload)
			if isConfig {
				entries := map[string]*string{}
				for _, e := range payload.Tree {
					entries[e.Path] = e.SHA
				}
				fix.mu.Lock()
				fix.configTrees = append(fix.configTrees, entries)
				fix.mu.Unlock()
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-tree-sha"})
		})
		mux.HandleFunc(base+"/git/commits", func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var payload struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(body, &payload)
			fix.mu.Lock()
			fix.messages[repo] = append(fix.messages[repo], payload.Message)
			fix.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"sha": "new-commit-sha"})
		})
	}
	commitRoutes("classroom50", true)

	for _, name := range repoNames {
		repo := name
		marker := markers[repo]
		mux.HandleFunc("/repos/o/"+repo, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPatch {
				body, _ := io.ReadAll(r.Body)
				var payload struct {
					Name string `json:"name"`
				}
				_ = json.Unmarshal(body, &payload)
				fix.mu.Lock()
				fix.renamePatches[repo] = payload.Name
				fix.mu.Unlock()
				_ = json.NewEncoder(w).Encode(map[string]string{"name": payload.Name})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "main"})
		})
		mux.HandleFunc("/repos/o/"+repo+"/contents/.classroom50.yaml", func(w http.ResponseWriter, r *http.Request) {
			if marker == "" {
				http.NotFound(w, r)
				return
			}
			serveB64(w, marker)
		})
		commitRoutes(repo, false)
	}

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, fix
}

func renameMarker(slug string) string {
	return fmt.Sprintf("schema: classroom50/repo-config/v1\nclassroom: cs\nassignment: %s\nowner:\n  username: alice\n", slug)
}

func baseRenameParams() renameParams {
	return renameParams{
		org: "o", classroom: "cs", oldSlug: renameOldSlug, newSlug: renameNewSlug,
		skipConfirm: true, quiet: true,
	}
}

var _ = githubtest.NewTestClient // silence unused-import until the tests below use it

// TestRunAssignmentRename_HappyPath: the full fresh flow — one config commit
// (slug + renamed_from + lock, scores re-key, autograder dir move), alice's
// marker rewritten with [skip ci] then her repo renamed, the sibling-marker
// repo left untouched, and the lock restored afterward.
func TestRunAssignmentRename_HappyPath(t *testing.T) {
	server, fix := newRenameServer(t,
		renameAssignmentsBody(renameOldSlug, "", false),
		[]string{renameAliceRepo, renameForeignRepo},
		map[string]string{
			renameAliceRepo:   renameMarker(renameOldSlug),
			renameForeignRepo: renameMarker(renameOldSlug + "-extra"),
		},
	)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	err := runAssignmentRename(client, strings.NewReader(""), &out, &errOut, baseRenameParams())
	if err != nil {
		t.Fatalf("runAssignmentRename: %v", err)
	}

	fix.mu.Lock()
	defer fix.mu.Unlock()

	// Config commit: rename + provenance + lock, scores re-key, dir move.
	var renamedBlob string
	for _, blob := range fix.configBlobs {
		if strings.Contains(blob, `"renamed_from"`) {
			renamedBlob = blob
		}
	}
	if renamedBlob == "" {
		t.Fatal("no assignments.json blob carrying renamed_from was committed")
	}
	for _, want := range []string{`"slug": "ps3"`, `"renamed_from": "` + renameOldSlug + `"`} {
		if !strings.Contains(renamedBlob, want) {
			t.Errorf("rename commit missing %s:\n%s", want, renamedBlob)
		}
	}
	// The FINAL assignments state (lock restore) must be unlocked again.
	if strings.Contains(fix.assignments, `"locked": true`) {
		t.Errorf("lock not restored, final assignments.json:\n%s", fix.assignments)
	}
	if !strings.Contains(fix.scores, `"ps3"`) || strings.Contains(fix.scores, `"`+renameOldSlug+`"`) {
		t.Errorf("scores bucket not re-keyed:\n%s", fix.scores)
	}
	var moved, deleted bool
	for _, tree := range fix.configTrees {
		if sha, ok := tree["cs/autograders/ps3/autograder.py"]; ok && sha != nil {
			moved = true
		}
		if sha, ok := tree["cs/autograders/"+renameOldSlug+"/autograder.py"]; ok && sha == nil {
			deleted = true
		}
	}
	if !moved || !deleted {
		t.Errorf("autograder dir move incomplete: moved=%t deleted=%t", moved, deleted)
	}

	// Alice: marker rewritten (with [skip ci]) then repo renamed.
	if blobs := fix.markerBlobs[renameAliceRepo]; len(blobs) != 1 || !strings.Contains(blobs[0], "assignment: ps3") {
		t.Errorf("alice marker blobs = %v, want one rewrite to ps3", blobs)
	}
	markerMsg := strings.Join(fix.messages[renameAliceRepo], "\n")
	if !strings.Contains(markerMsg, "[skip ci]") {
		t.Errorf("marker commit message missing [skip ci]: %q", markerMsg)
	}
	if got := fix.renamePatches[renameAliceRepo]; got != "cs-ps3-alice" {
		t.Errorf("alice rename PATCH = %q, want cs-ps3-alice", got)
	}

	// The sibling-marker repo: no marker commit, no rename.
	if len(fix.markerBlobs[renameForeignRepo]) != 0 {
		t.Errorf("foreign repo marker was rewritten: %v", fix.markerBlobs[renameForeignRepo])
	}
	if _, patched := fix.renamePatches[renameForeignRepo]; patched {
		t.Error("foreign repo was renamed despite its sibling marker")
	}
}

// TestRunAssignmentRename_EligibilityGates: only an over-budget, never-renamed
// slug qualifies; the new slug must be free and unreserved.
func TestRunAssignmentRename_EligibilityGates(t *testing.T) {
	t.Run("a fitting slug is refused", func(t *testing.T) {
		server, _ := newRenameServer(t, renameAssignmentsBody("hw1", "", false), nil, nil)
		client := githubtest.NewTestClient(t, server)
		p := baseRenameParams()
		p.oldSlug = "hw1"
		err := runAssignmentRename(client, strings.NewReader(""), io.Discard, io.Discard, p)
		if err == nil || !strings.Contains(err.Error(), "budget") {
			t.Fatalf("err = %v, want a budget-eligibility error", err)
		}
	})

	t.Run("a second rename is refused", func(t *testing.T) {
		server, _ := newRenameServer(t, renameAssignmentsBody(renameOldSlug, "an-even-older-slug", false), nil, nil)
		client := githubtest.NewTestClient(t, server)
		err := runAssignmentRename(client, strings.NewReader(""), io.Discard, io.Discard, baseRenameParams())
		if err == nil || !strings.Contains(err.Error(), "one-shot") {
			t.Fatalf("err = %v, want the one-shot error", err)
		}
	})

	t.Run("a taken new slug is refused", func(t *testing.T) {
		server, _ := newRenameServer(t, renameAssignmentsBody(renameOldSlug, "", false), nil, nil)
		client := githubtest.NewTestClient(t, server)
		p := baseRenameParams()
		p.newSlug = "hw2" // the sibling entry
		err := runAssignmentRename(client, strings.NewReader(""), io.Discard, io.Discard, p)
		if err == nil || !strings.Contains(err.Error(), "already exists") {
			t.Fatalf("err = %v, want a taken-slug error", err)
		}
	})
}

// TestRunAssignmentRename_ConfirmMismatchAborts: without --yes, anything but
// the typed new slug aborts before any write.
func TestRunAssignmentRename_ConfirmMismatchAborts(t *testing.T) {
	server, fix := newRenameServer(t,
		renameAssignmentsBody(renameOldSlug, "", false),
		[]string{renameAliceRepo},
		map[string]string{renameAliceRepo: renameMarker(renameOldSlug)},
	)
	client := githubtest.NewTestClient(t, server)
	p := baseRenameParams()
	p.skipConfirm = false

	err := runAssignmentRename(client, strings.NewReader("wrong\n"), io.Discard, io.Discard, p)
	if err == nil || !strings.Contains(err.Error(), "aborted") {
		t.Fatalf("err = %v, want the aborted-confirmation error", err)
	}
	fix.mu.Lock()
	defer fix.mu.Unlock()
	if len(fix.configBlobs) != 0 || len(fix.renamePatches) != 0 {
		t.Error("an aborted confirmation must write nothing")
	}
}

// TestRunAssignmentRename_ResumeHealsMarker: with the config already renamed,
// a re-run skips the config commit and heals an already-renamed repo whose
// marker still carries the old slug.
func TestRunAssignmentRename_ResumeHealsMarker(t *testing.T) {
	healRepo := "cs-ps3-alice"
	server, fix := newRenameServer(t,
		renameAssignmentsBody(renameNewSlug, renameOldSlug, true),
		[]string{healRepo},
		map[string]string{healRepo: renameMarker(renameOldSlug)},
	)
	client := githubtest.NewTestClient(t, server)

	var out, errOut bytes.Buffer
	if err := runAssignmentRename(client, strings.NewReader(""), &out, &errOut, baseRenameParams()); err != nil {
		t.Fatalf("runAssignmentRename(resume): %v", err)
	}

	fix.mu.Lock()
	defer fix.mu.Unlock()
	if len(fix.configBlobs) != 0 {
		t.Errorf("resume must not re-commit config, got %d blob(s)", len(fix.configBlobs))
	}
	if blobs := fix.markerBlobs[healRepo]; len(blobs) != 1 || !strings.Contains(blobs[0], "assignment: ps3") {
		t.Errorf("heal marker blobs = %v, want one rewrite to ps3", blobs)
	}
	if _, patched := fix.renamePatches[healRepo]; patched {
		t.Error("an already-renamed repo must not be PATCHed again")
	}
	// The pre-rename lock state is unknowable on resume; the teacher gets the
	// unlock pointer instead of a guessed flip.
	if !strings.Contains(errOut.String(), "--unlock") {
		t.Errorf("errOut = %q, want the resume unlock note", errOut.String())
	}
}
