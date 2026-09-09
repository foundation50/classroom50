package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/ui"
)

// pagesTestServer wires the minimal fresh-create provisioning routes for
// acceptIntoRepo plus a /pages handler, recording the request order and the
// Pages body so a test can pin "Pages before the accept commit".
func pagesTestServer(t *testing.T, org, repoName string, pagesStatus int, pagesMessage string) (*httptest.Server, *[]string, *[]byte) {
	t.Helper()
	var (
		order      []string
		pagesBody  []byte
		refPatched bool
	)
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/pages", func(w http.ResponseWriter, r *http.Request) {
		order = append(order, r.Method+" pages")
		pagesBody, _ = io.ReadAll(r.Body)
		// go-gh only surfaces the body's `message` on an error when the
		// response is JSON, so the header must land before the status.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(pagesStatus)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": pagesMessage})
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/contents/.classroom50.yaml", func(w http.ResponseWriter, _ *http.Request) {
		if refPatched {
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "file"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice/permission", func(w http.ResponseWriter, _ *http.Request) {
		writePermissionReadback(w, "push")
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/collaborators/alice", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/branches/master", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"commit": map[string]any{"sha": "stable"}})
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/refs/heads/master", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"object": map[string]string{"sha": "parent"}})
		case http.MethodPatch:
			refPatched = true
			w.WriteHeader(http.StatusOK)
		}
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/commits/parent", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tree": map[string]string{"sha": "parent-tree"}})
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/blobs", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "blob"})
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/trees", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "tree"})
	})
	mux.HandleFunc("/repos/"+org+"/"+repoName+"/git/commits", func(w http.ResponseWriter, _ *http.Request) {
		order = append(order, "POST commits")
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": "commit"})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, &order, &pagesBody
}

func TestAcceptIntoRepo_Pages(t *testing.T) {
	const (
		org      = "o"
		repoName = "cs-principles-site-alice"
	)
	origBackoff := verifyProvisionBackoff
	verifyProvisionBackoff = time.Millisecond
	t.Cleanup(func() { verifyProvisionBackoff = origBackoff })

	params := func(pages *assignments.Pages, alreadyExisted bool) acceptRepoParams {
		var errBuf bytes.Buffer
		ownerID := int64(4242)
		return acceptRepoParams{
			org:            org,
			classroom:      "cs-principles",
			assignment:     "site",
			username:       "alice",
			ownerID:        &ownerID,
			acceptedAt:     "2026-06-01T14:33:11Z",
			repoName:       repoName,
			branch:         "master", // the settled branch, deliberately not main
			shim:           "shim-content",
			autograderName: "default",
			pages:          pages,
			fullName:       org + "/" + repoName,
			htmlURL:        "https://github.com/" + org + "/" + repoName,
			alreadyExisted: alreadyExisted,
			createSp:       ui.NewForced(&errBuf, false).Spinner("Creating"),
			createMsg:      "Creating",
		}
	}

	t.Run("branch source: legacy build on the settled default branch, before the accept commit", func(t *testing.T) {
		server, order, body := pagesTestServer(t, org, repoName, http.StatusCreated, "")
		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, params(&assignments.Pages{Source: "branch"}, false)); err != nil {
			t.Fatalf("acceptIntoRepo: %v", err)
		}
		if want := `{"build_type":"legacy","source":{"branch":"master","path":"/"}}`; string(*body) != want {
			t.Errorf("pages body = %s, want %s", *body, want)
		}
		if len(*order) < 2 || (*order)[0] != "POST pages" || (*order)[1] != "POST commits" {
			t.Errorf("Pages must be enabled before the accept commit; order = %v", *order)
		}
		if !strings.Contains(out.String(), "GitHub Pages enabled") {
			t.Errorf("expected a Pages-enabled line:\n%s", out.String())
		}
	})

	t.Run("workflow source: build_type workflow, no source", func(t *testing.T) {
		server, _, body := pagesTestServer(t, org, repoName, http.StatusCreated, "")
		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, params(&assignments.Pages{Source: "workflow"}, false)); err != nil {
			t.Fatalf("acceptIntoRepo: %v", err)
		}
		if want := `{"build_type":"workflow"}`; string(*body) != want {
			t.Errorf("pages body = %s, want %s", *body, want)
		}
	})

	t.Run("named branch and /docs are passed through", func(t *testing.T) {
		server, _, body := pagesTestServer(t, org, repoName, http.StatusCreated, "")
		var out bytes.Buffer
		p := params(&assignments.Pages{Source: "branch", Branch: "gh-pages", Path: "/docs"}, false)
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, p); err != nil {
			t.Fatalf("acceptIntoRepo: %v", err)
		}
		if want := `{"build_type":"legacy","source":{"branch":"gh-pages","path":"/docs"}}`; string(*body) != want {
			t.Errorf("pages body = %s, want %s", *body, want)
		}
	})

	t.Run("409 already enabled is not a warning", func(t *testing.T) {
		server, _, _ := pagesTestServer(t, org, repoName, http.StatusConflict, "GitHub Pages is already enabled.")
		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, params(&assignments.Pages{Source: "workflow"}, false)); err != nil {
			t.Fatalf("acceptIntoRepo: %v", err)
		}
		if strings.Contains(out.String(), "Warning: could not enable GitHub Pages") {
			t.Errorf("409 must not warn:\n%s", out.String())
		}
		if !strings.Contains(out.String(), "already enabled") {
			t.Errorf("expected an already-enabled line:\n%s", out.String())
		}
	})

	t.Run("refusal fails open with a plan hint and accept still succeeds", func(t *testing.T) {
		server, order, _ := pagesTestServer(t, org, repoName, http.StatusUnprocessableEntity, "Upgrade to GitHub Pro or make this repository public to enable Pages.")
		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, params(&assignments.Pages{Source: "workflow"}, false)); err != nil {
			t.Fatalf("a Pages refusal must not fail accept: %v", err)
		}
		if !strings.Contains(out.String(), "Warning: could not enable GitHub Pages") || !strings.Contains(out.String(), "plan doesn't allow Pages on private repositories") {
			t.Errorf("expected a fail-open warning with the plan hint:\n%s", out.String())
		}
		if !strings.Contains(strings.Join(*order, ","), "POST commits") {
			t.Errorf("the accept commit must still land after a Pages refusal; order = %v", *order)
		}
	})

	t.Run("no pages block: /pages is never called", func(t *testing.T) {
		server, order, _ := pagesTestServer(t, org, repoName, http.StatusCreated, "")
		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, params(nil, false)); err != nil {
			t.Fatalf("acceptIntoRepo: %v", err)
		}
		for _, o := range *order {
			if strings.Contains(o, "pages") {
				t.Fatalf("unexpected Pages call without a pages block; order = %v", *order)
			}
		}
	})

	t.Run("heal of a half-provisioned repo never touches Pages", func(t *testing.T) {
		server, order, _ := pagesTestServer(t, org, repoName, http.StatusCreated, "")
		var out bytes.Buffer
		if err := acceptIntoRepo(newTestRESTClient(t, server), ui.NewForced(&out, false), false, &out, params(&assignments.Pages{Source: "workflow"}, true)); err != nil {
			t.Fatalf("acceptIntoRepo (heal): %v", err)
		}
		for _, o := range *order {
			if strings.Contains(o, "pages") {
				t.Fatalf("heal must not re-assert Pages; order = %v", *order)
			}
		}
	})
}

func TestPagesRefusalHint(t *testing.T) {
	cases := []struct {
		msg  string
		want string
	}{
		{"HTTP 422: Upgrade to GitHub Pro or make this repository public", "plan doesn't allow Pages on private repositories"},
		{"HTTP 422: Validation Failed: branch does not exist", "branch it publishes from doesn't exist"},
		{"something else", "Your teacher can enable it from the submissions page"},
	}
	for _, tc := range cases {
		if got := pagesRefusalHint(errString(tc.msg)); !strings.Contains(got, tc.want) {
			t.Errorf("pagesRefusalHint(%q) = %q, want it to contain %q", tc.msg, got, tc.want)
		}
	}
}

type errString string

func (e errString) Error() string { return string(e) }
