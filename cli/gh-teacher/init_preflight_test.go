package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// preflightTestServer wires a mux covering the endpoints preflight hits:
// GET /user (with an X-OAuth-Scopes header), GET /orgs/{org}, and
// GET /orgs/{org}/memberships/{login}. Each field lets a test shape one
// response; zero values give a sensible all-OK default.
type preflightTestServer struct {
	scopes           string // X-OAuth-Scopes header on /user; "" omits it
	userStatus       int    // status for /user (default 200)
	orgStatus        int    // status for /orgs/{org} (default 200)
	plan             string // org plan name
	membershipRole   string // role on the membership endpoint (default "admin")
	membershipStatus int    // status for membership (default 200)
}

func newPreflightServer(t *testing.T, cfg preflightTestServer) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		if cfg.scopes != "" {
			w.Header().Set("X-OAuth-Scopes", cfg.scopes)
		}
		if cfg.userStatus != 0 && cfg.userStatus != http.StatusOK {
			w.WriteHeader(cfg.userStatus)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"login": "teacher"})
	})
	mux.HandleFunc("/orgs/", func(w http.ResponseWriter, r *http.Request) {
		// Distinguish /orgs/{org} from /orgs/{org}/memberships/{login}.
		if strings.Contains(r.URL.Path, "/memberships/") {
			if cfg.membershipStatus != 0 && cfg.membershipStatus != http.StatusOK {
				w.WriteHeader(cfg.membershipStatus)
				return
			}
			role := cfg.membershipRole
			if role == "" {
				role = "admin"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"role": role, "state": "active"})
			return
		}
		if cfg.orgStatus != 0 && cfg.orgStatus != http.StatusOK {
			w.WriteHeader(cfg.orgStatus)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"login": "cs50",
			"plan":  map[string]any{"name": cfg.plan},
		})
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func statusOf(checks []preflightCheck, name string) preflightStatus {
	for _, c := range checks {
		if c.Name == name {
			return c.Status
		}
	}
	return ""
}

func TestRunPreflight_AllOK(t *testing.T) {
	// Realistic normalized header: `gh teacher login` requests admin:org,
	// read:org, repo, workflow, but GitHub discards read:org from the
	// granted set because admin:org implies it. The preflight must still
	// pass — a regression here (a plain whole-token read:org check) would
	// hard-fail init right after a correct login.
	server := newPreflightServer(t, preflightTestServer{
		scopes: "admin:org, repo, workflow",
		plan:   "team",
	})
	client := githubtest.NewTestClient(t, server)

	res := runPreflight(client, "cs50", tokenSource{envSet: true})
	if res.Failed {
		t.Fatalf("all-OK preflight should not fail; checks: %+v", res.Checks)
	}
	if res.Plan != "team" {
		t.Errorf("plan = %q, want team", res.Plan)
	}
	for _, name := range []string{"auth scopes", "org access", "org plan", "org ownership", "service token"} {
		if got := statusOf(res.Checks, name); got != preflightOK {
			t.Errorf("check %q = %q, want ok", name, got)
		}
	}
	// The OK detail lists the satisfied scopes; guard the dynamic Join so
	// an empty-list or malformed-string regression is caught.
	for _, c := range res.Checks {
		if c.Name == "auth scopes" {
			if !strings.Contains(c.Detail, "present") || !strings.Contains(c.Detail, "admin:org") {
				t.Errorf("auth-scopes OK detail should list satisfied scopes: %q", c.Detail)
			}
		}
	}
}

func TestRunPreflight_MissingScopeFails(t *testing.T) {
	server := newPreflightServer(t, preflightTestServer{
		scopes: "repo", // missing admin:org, read:org, workflow
		plan:   "enterprise",
	})
	client := githubtest.NewTestClient(t, server)

	res := runPreflight(client, "cs50", tokenSource{envSet: true})
	if !res.Failed {
		t.Fatal("missing required scopes must fail preflight")
	}
	if got := statusOf(res.Checks, "auth scopes"); got != preflightFail {
		t.Errorf("auth scopes = %q, want fail", got)
	}
	// The detail should name every missing scope (the code joins all of
	// them) and point at login. read:org is genuinely missing here — no
	// admin:org/write:org is present to imply it — so it must be listed.
	for _, c := range res.Checks {
		if c.Name == "auth scopes" {
			for _, want := range []string{"admin:org", "read:org", "workflow"} {
				if !strings.Contains(c.Detail, want) {
					t.Errorf("missing-scope detail should name %q: %q", want, c.Detail)
				}
			}
			if !strings.Contains(c.Detail, "gh teacher login") {
				t.Errorf("missing-scope detail should suggest login: %q", c.Detail)
			}
		}
	}
}

func TestRunPreflight_ImpliedScopeSatisfiesWithoutLiteralReadOrg(t *testing.T) {
	// Regression guard for the normalization trap: a header carrying
	// admin:org but NOT a literal read:org must still pass the scope
	// check, because admin:org implies read:org.
	server := newPreflightServer(t, preflightTestServer{
		scopes: "admin:org, repo, workflow", // no literal read:org
		plan:   "team",
	})
	client := githubtest.NewTestClient(t, server)

	res := runPreflight(client, "cs50", tokenSource{envSet: true})
	if got := statusOf(res.Checks, "auth scopes"); got != preflightOK {
		t.Errorf("auth scopes = %q, want ok (admin:org implies read:org)", got)
	}
}

func TestRunPreflight_NoScopeHeaderWarns(t *testing.T) {
	// A fine-grained PAT returns no X-OAuth-Scopes header — we can't
	// verify, so warn (not fail).
	server := newPreflightServer(t, preflightTestServer{scopes: "", plan: "team"})
	client := githubtest.NewTestClient(t, server)

	res := runPreflight(client, "cs50", tokenSource{envSet: true})
	if res.Failed {
		t.Errorf("a missing scope header should warn, not fail: %+v", res.Checks)
	}
	if got := statusOf(res.Checks, "auth scopes"); got != preflightWarn {
		t.Errorf("auth scopes = %q, want warn", got)
	}
}

func TestRunPreflight_OrgNotFoundFails(t *testing.T) {
	server := newPreflightServer(t, preflightTestServer{
		scopes:    "admin:org, repo, workflow",
		orgStatus: http.StatusNotFound,
	})
	client := githubtest.NewTestClient(t, server)

	res := runPreflight(client, "ghost-org", tokenSource{envSet: true})
	if !res.Failed {
		t.Fatal("a 404 on the org must fail preflight")
	}
	if got := statusOf(res.Checks, "org access"); got != preflightFail {
		t.Errorf("org access = %q, want fail", got)
	}
}

func TestRunPreflight_NonOwnerFails(t *testing.T) {
	server := newPreflightServer(t, preflightTestServer{
		scopes:         "admin:org, repo, workflow",
		plan:           "team",
		membershipRole: "member",
	})
	client := githubtest.NewTestClient(t, server)

	res := runPreflight(client, "cs50", tokenSource{envSet: true})
	if !res.Failed {
		t.Fatal("a non-owner must fail preflight")
	}
	if got := statusOf(res.Checks, "org ownership"); got != preflightFail {
		t.Errorf("org ownership = %q, want fail", got)
	}
}

func TestRunPreflight_PlanWarnsButContinues(t *testing.T) {
	server := newPreflightServer(t, preflightTestServer{
		scopes: "admin:org, repo, workflow",
		plan:   "free",
	})
	client := githubtest.NewTestClient(t, server)

	res := runPreflight(client, "cs50", tokenSource{envSet: true})
	if res.Failed {
		t.Errorf("a free plan is advisory, must not fail: %+v", res.Checks)
	}
	if got := statusOf(res.Checks, "org plan"); got != preflightWarn {
		t.Errorf("org plan = %q, want warn", got)
	}
}

func TestInitStepLabels_CountMatchesRenderedSteps(t *testing.T) {
	// The progress headers in init.go index initStepLabels by position;
	// the count is also the `total` in the [n/total] header. Guard the
	// length so a reordering or addition can't desync the indices used
	// in init.go's RunE.
	if len(initStepLabels) != 13 {
		t.Fatalf("initStepLabels = %d, want 13 (update init.go RunE step() calls if you change this)", len(initStepLabels))
	}
	// Every label must be non-empty (a blank header renders as a bare
	// counter).
	for i, l := range initStepLabels {
		if strings.TrimSpace(l) == "" {
			t.Errorf("step label %d is empty", i)
		}
	}
}

func TestRenderDryRunSteps_ListsAllStepsInOrder(t *testing.T) {
	var buf bytes.Buffer
	renderDryRunSteps(&buf)
	out := buf.String()
	if !strings.Contains(out, "no changes made") {
		t.Errorf("dry-run header should make clear nothing is mutated:\n%s", out)
	}
	// Each label appears, numbered in order.
	for i, label := range initStepLabels {
		want := strings.TrimSpace(label)
		if !strings.Contains(out, want) {
			t.Errorf("dry-run output missing step %q:\n%s", want, out)
		}
		_ = i
	}
}

func TestCheckTokenAvailability(t *testing.T) {
	cases := []struct {
		name         string
		tok          tokenSource
		secretExists bool
		want         preflightStatus
	}{
		{"env set", tokenSource{envSet: true}, false, preflightOK},
		{"piped stdin", tokenSource{stdinPiped: true}, false, preflightOK},
		{"interactive tty", tokenSource{stdinTTY: true, stderrTTY: true}, false, preflightOK},
		{"no token no prompt", tokenSource{stdinTTY: true, stderrTTY: false}, false, preflightFail},
		{"no token no prompt but secret exists", tokenSource{stdinTTY: true, stderrTTY: false}, true, preflightOK},
		{"env overrides existing secret", tokenSource{envSet: true}, true, preflightOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := checkTokenAvailability(tc.tok, tc.secretExists)
			if c.Status != tc.want {
				t.Errorf("status = %q, want %q (detail: %q)", c.Status, tc.want, c.Detail)
			}
		})
	}
}

func TestPreflightFailError_NamesFailingChecks(t *testing.T) {
	res := preflightResult{
		Checks: []preflightCheck{
			{Name: "auth scopes", Status: preflightFail, Detail: "missing admin:org"},
			{Name: "org plan", Status: preflightWarn, Detail: "free plan"},
			{Name: "org ownership", Status: preflightFail, Detail: "not an owner"},
		},
		Failed: true,
	}
	err := preflightFailError(res)
	msg := err.Error()
	if !strings.Contains(msg, "auth scopes") || !strings.Contains(msg, "org ownership") {
		t.Errorf("error should name the failing checks: %v", err)
	}
	if strings.Contains(msg, "org plan") {
		t.Errorf("error should not name warn-level checks: %v", err)
	}
}
