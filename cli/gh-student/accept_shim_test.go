package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

func TestRenderEmbeddedShim(t *testing.T) {
	// The embedded shim is the universal one-body-fits-all that gh student
	// accept drops into every student repo. {{ORG}}, the submission branch, and
	// the config-repo branch are the per-repo substitutions; everything else is
	// fixed.
	got := renderEmbeddedShim("cs50-fall-2026", "main", "main", "")

	// Trigger contract: branch pushes auto-grade; manual submit/* tag pushes
	// still work (the runner detects which fired and creates or reuses the tag).
	for _, want := range []string{
		`branches: ["main"]`,
		`tags: ["submit/*"]`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("embedded shim missing trigger %q\nfull:\n%s", want, got)
		}
	}

	// Org-substituted reusable-workflow `uses:` line. Quoted in the embed so
	// the unsubstituted placeholder doesn't trip YAML's flow-mapping parser;
	// the quotes survive substitution and stay valid in Actions `uses:`.
	wantUses := `uses: "cs50-fall-2026/classroom50/.github/workflows/autograde-runner.yaml@main"`
	if !strings.Contains(got, wantUses) {
		t.Errorf("embedded shim missing %q\nfull:\n%s", wantUses, got)
	}

	// Placeholders must be fully substituted.
	for _, ph := range []string{"{{ORG}}", "{{BRANCH}}", "{{CONFIG_BRANCH}}"} {
		if strings.Contains(got, ph) {
			t.Errorf("embedded shim still contains unsubstituted %s:\n%s", ph, got)
		}
	}

	// Caller's job-level permissions must include both writes the runner's
	// downstream steps need.
	for _, perm := range []string{"contents: write", "statuses: write"} {
		if !strings.Contains(got, perm) {
			t.Errorf("embedded shim missing required permission %q\nfull:\n%s", perm, got)
		}
	}

	// Shim must NOT contain any bootstrap / status / release logic — that
	// lives in autograde-runner.yaml. A regression that re-inlines it would
	// put substantive logic in every student repo, which this architecture
	// exists to avoid.
	for _, mustNotContain := range []string{
		"PAGES_BASE_URL",
		"shell: python3",
		"Post commit status",
		"Publish release",
		"gh release",
		"actions/checkout",
	} {
		if strings.Contains(got, mustNotContain) {
			t.Errorf("embedded shim should NOT contain %q (lives in the runner, not the shim):\n%s",
				mustNotContain, got)
		}
	}
}

func TestRenderEmbeddedShim_OrgSubstitution(t *testing.T) {
	// `{{ORG}}` substitution is the only per-classroom customization in the
	// shim — exercise hyphenated and plain shapes to confirm ReplaceAll isn't
	// matching anything else.
	for _, org := range []string{"cs50-fall-2026", "foundation50", "very-long-org-name-2026"} {
		t.Run(org, func(t *testing.T) {
			got := renderEmbeddedShim(org, "main", "main", "")
			wantUses := `uses: "` + org + `/classroom50/.github/workflows/autograde-runner.yaml@main"`
			if !strings.Contains(got, wantUses) {
				t.Errorf("expected %q in shim, got:\n%s", wantUses, got)
			}
			if strings.Contains(got, "{{ORG}}") {
				t.Errorf("placeholder leak for %q:\n%s", org, got)
			}
		})
	}
}

func TestRenderEmbeddedShim_BranchSubstitution(t *testing.T) {
	// A master-default assignment repo must trigger on `master`; a config repo
	// that stayed on `master` (rename didn't land) must be referenced via
	// `@master` so the reusable-workflow ref resolves.
	got := renderEmbeddedShim("cs50", "master", "master", "")
	if !strings.Contains(got, `branches: ["master"]`) {
		t.Errorf("expected branches: [\"master\"], got:\n%s", got)
	}
	wantUses := `uses: "cs50/classroom50/.github/workflows/autograde-runner.yaml@master"`
	if !strings.Contains(got, wantUses) {
		t.Errorf("expected %q, got:\n%s", wantUses, got)
	}

	// Empty branch/configBranch default to main.
	def := renderEmbeddedShim("cs50", "", "", "")
	if !strings.Contains(def, `branches: ["main"]`) {
		t.Errorf("empty branch should default to main, got:\n%s", def)
	}
	if !strings.Contains(def, "autograde-runner.yaml@main") {
		t.Errorf("empty configBranch should default to main, got:\n%s", def)
	}
}

func TestRenderEmbeddedShim_TagMode(t *testing.T) {
	got := renderEmbeddedShim("cs50-fall-2026", "main", "main", contract.SubmissionModeTag)

	// Tag mode keeps ONLY the submit/* tag trigger: a plain `git push` must
	// not grade. The branch trigger line is removed whole — no leftover key.
	if strings.Contains(got, "branches:") {
		t.Errorf("tag-mode shim must not contain a branches: trigger:\n%s", got)
	}
	if !strings.Contains(got, `tags: ["submit/*"]`) {
		t.Errorf("tag-mode shim missing the submit/* tag trigger:\n%s", got)
	}

	// Everything else is unchanged: uses: line, permissions, no placeholders.
	wantUses := `uses: "cs50-fall-2026/classroom50/.github/workflows/autograde-runner.yaml@main"`
	if !strings.Contains(got, wantUses) {
		t.Errorf("tag-mode shim missing %q\nfull:\n%s", wantUses, got)
	}
	for _, ph := range []string{"{{ORG}}", "{{BRANCH}}", "{{CONFIG_BRANCH}}"} {
		if strings.Contains(got, ph) {
			t.Errorf("tag-mode shim still contains unsubstituted %s:\n%s", ph, got)
		}
	}
	for _, perm := range []string{"contents: write", "statuses: write"} {
		if !strings.Contains(got, perm) {
			t.Errorf("tag-mode shim missing required permission %q\nfull:\n%s", perm, got)
		}
	}

	// The removal is exactly one line: tag-mode output equals every-push
	// output minus the substituted branch trigger line.
	everyPush := renderEmbeddedShim("cs50-fall-2026", "main", "main", "")
	wantTag := strings.Replace(everyPush, "    branches: [\"main\"]\n", "", 1)
	if got != wantTag {
		t.Errorf("tag-mode shim is not every-push minus the branch line:\ngot:\n%s\nwant:\n%s", got, wantTag)
	}
}

// TestRenderEmbeddedShim_EveryPushByteIdentical pins that every non-tag mode
// value — absent, the explicit wire default, and junk (validated upstream) —
// renders the identical bytes, so introducing submission_mode changed nothing
// for existing assignments.
func TestRenderEmbeddedShim_EveryPushByteIdentical(t *testing.T) {
	base := renderEmbeddedShim("cs50", "main", "main", "")
	for _, mode := range []string{contract.SubmissionModeEveryPush, "unvalidated-junk"} {
		if got := renderEmbeddedShim("cs50", "main", "main", mode); got != base {
			t.Errorf("mode %q rendered different bytes than the default", mode)
		}
	}
}

// TestShimBranchTriggerLine_MatchesEmbed guards the line-surgery constant
// against embed drift: if autograde-shim.yaml's trigger line changes shape,
// tag mode would silently stop removing it (falling back to an every-push
// shim). Fail here instead.
func TestShimBranchTriggerLine_MatchesEmbed(t *testing.T) {
	if !strings.Contains(embeddedShimContent, shimBranchTriggerLine) {
		t.Fatalf("embed/autograde-shim.yaml no longer contains the exact branch trigger line %q — update shimBranchTriggerLine in lockstep", shimBranchTriggerLine)
	}
	if strings.Count(embeddedShimContent, shimBranchTriggerLine) != 1 {
		t.Fatalf("branch trigger line appears more than once in the embed; single-occurrence surgery would remove the wrong one")
	}
}

func TestResolveConfigRepoBranch(t *testing.T) {
	newServer := func(t *testing.T, handler http.HandlerFunc) *httptest.Server {
		server := httptest.NewServer(handler)
		t.Cleanup(server.Close)
		return server
	}

	t.Run("returns the config repo's actual default branch (master)", func(t *testing.T) {
		server := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": "master"})
		})
		got, err := resolveConfigRepoBranch(newTestRESTClient(t, server), "o")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "master" {
			t.Errorf("got %q, want master", got)
		}
	})

	t.Run("empty default_branch falls back to main", func(t *testing.T) {
		server := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"default_branch": ""})
		})
		got, err := resolveConfigRepoBranch(newTestRESTClient(t, server), "o")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "main" {
			t.Errorf("got %q, want main", got)
		}
	})

	t.Run("a read failure is returned as an error (never a silent main)", func(t *testing.T) {
		server := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})
		_, err := resolveConfigRepoBranch(newTestRESTClient(t, server), "o")
		if err == nil {
			t.Fatal("expected an error on a failed config-repo read")
		}
	})
}
