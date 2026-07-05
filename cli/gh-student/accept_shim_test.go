package main

import (
	"strings"
	"testing"
)

func TestRenderEmbeddedShim(t *testing.T) {
	// The embedded shim is the universal one-body-fits-all that gh student
	// accept drops into every student repo. {{ORG}} is the only per-classroom
	// customization; everything else is fixed.
	got := renderEmbeddedShim("cs50-fall-2026")

	// Trigger contract: branch pushes auto-grade; manual submit/* tag pushes
	// still work (the runner detects which fired and creates or reuses the tag).
	for _, want := range []string{
		"branches: [main]",
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

	// Placeholder must be fully substituted.
	if strings.Contains(got, "{{ORG}}") {
		t.Errorf("embedded shim still contains unsubstituted {{ORG}}:\n%s", got)
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
			got := renderEmbeddedShim(org)
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
