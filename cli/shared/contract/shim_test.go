package contract

import (
	"strings"
	"testing"
)

func TestRenderDefaultShim(t *testing.T) {
	got := RenderDefaultShim("cs50-fall-2026", "main", "main", "", nil)

	// Trigger contract: branch pushes auto-grade; manual submit/* tag pushes
	// still work (the runner detects which fired and creates or reuses the tag).
	for _, want := range []string{
		`branches: ["main"]`,
		`tags: ["submit/*"]`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("shim missing trigger %q\nfull:\n%s", want, got)
		}
	}

	// Quoted in the template so the unsubstituted placeholder doesn't trip
	// YAML's flow-mapping parser; the quotes stay valid in Actions `uses:`.
	wantUses := `uses: "cs50-fall-2026/classroom50/.github/workflows/autograde-runner.yaml@main"`
	if !strings.Contains(got, wantUses) {
		t.Errorf("shim missing %q\nfull:\n%s", wantUses, got)
	}

	for _, ph := range []string{"{{ORG}}", "{{BRANCH}}", "{{CONFIG_BRANCH}}"} {
		if strings.Contains(got, ph) {
			t.Errorf("shim still contains unsubstituted %s:\n%s", ph, got)
		}
	}

	for _, perm := range []string{"contents: write", "statuses: write", "pull-requests: write"} {
		if !strings.Contains(got, perm) {
			t.Errorf("shim missing required permission %q\nfull:\n%s", perm, got)
		}
	}

	// The shim must stay inert: bootstrap / status / release logic lives in
	// autograde-runner.yaml, never in every student repo.
	for _, mustNotContain := range []string{
		"PAGES_BASE_URL",
		"shell: python3",
		"Post commit status",
		"Publish release",
		"gh release",
		"actions/checkout",
	} {
		if strings.Contains(got, mustNotContain) {
			t.Errorf("shim should NOT contain %q (lives in the runner):\n%s", mustNotContain, got)
		}
	}
}

func TestRenderDefaultShim_OrgSubstitution(t *testing.T) {
	for _, org := range []string{"cs50-fall-2026", "foundation50", "very-long-org-name-2026"} {
		t.Run(org, func(t *testing.T) {
			got := RenderDefaultShim(org, "main", "main", "", nil)
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

func TestRenderDefaultShim_BranchSubstitution(t *testing.T) {
	// A master-default repo triggers on master; a config repo still on master
	// is referenced via @master so the reusable-workflow ref resolves.
	got := RenderDefaultShim("cs50", "master", "master", "", nil)
	if !strings.Contains(got, `branches: ["master"]`) {
		t.Errorf("expected branches: [\"master\"], got:\n%s", got)
	}
	wantUses := `uses: "cs50/classroom50/.github/workflows/autograde-runner.yaml@master"`
	if !strings.Contains(got, wantUses) {
		t.Errorf("expected %q, got:\n%s", wantUses, got)
	}

	def := RenderDefaultShim("cs50", "", "", "", nil)
	if !strings.Contains(def, `branches: ["main"]`) {
		t.Errorf("empty branch should default to main, got:\n%s", def)
	}
	if !strings.Contains(def, "autograde-runner.yaml@main") {
		t.Errorf("empty configBranch should default to main, got:\n%s", def)
	}
}

func TestRenderDefaultShim_TagMode(t *testing.T) {
	got := RenderDefaultShim("cs50-fall-2026", "main", "main", SubmissionModeTag, nil)

	if strings.Contains(got, "branches:") {
		t.Errorf("tag-mode shim must not contain a branches: trigger:\n%s", got)
	}
	if !strings.Contains(got, `tags: ["submit/*"]`) {
		t.Errorf("tag-mode shim missing the submit/* tag trigger:\n%s", got)
	}
	for _, ph := range []string{"{{ORG}}", "{{BRANCH}}", "{{CONFIG_BRANCH}}"} {
		if strings.Contains(got, ph) {
			t.Errorf("tag-mode shim still contains unsubstituted %s:\n%s", ph, got)
		}
	}

	// Exactly one line removed: tag-mode output equals every-push output
	// minus the substituted branch trigger line.
	everyPush := RenderDefaultShim("cs50-fall-2026", "main", "main", "", nil)
	wantTag := strings.Replace(everyPush, "    branches: [\"main\"]\n", "", 1)
	if got != wantTag {
		t.Errorf("tag-mode shim is not every-push minus the branch line:\ngot:\n%s\nwant:\n%s", got, wantTag)
	}
}

// Every non-tag mode value (absent, the explicit wire default, junk validated
// upstream) renders identical bytes, so submission_mode changed nothing for
// existing assignments.
func TestRenderDefaultShim_EveryPushByteIdentical(t *testing.T) {
	base := RenderDefaultShim("cs50", "main", "main", "", nil)
	for _, mode := range []string{SubmissionModeEveryPush, "unvalidated-junk"} {
		if got := RenderDefaultShim("cs50", "main", "main", mode, nil); got != base {
			t.Errorf("mode %q rendered different bytes than the default", mode)
		}
	}
}

func TestRenderDefaultShim_SubmissionTags(t *testing.T) {
	got := RenderDefaultShim("cs50", "main", "main", "", []string{"phase1", "v*"})
	wantTags := `tags: ["phase1", "v*", "submit/*"]`
	if !strings.Contains(got, wantTags) {
		t.Errorf("shim missing widened tags trigger %q\nfull:\n%s", wantTags, got)
	}
	if !strings.Contains(got, `branches: ["main"]`) {
		t.Errorf("milestone tags must not drop the branch trigger:\n%s", got)
	}

	both := RenderDefaultShim("cs50", "main", "main", SubmissionModeTag, []string{"phase1"})
	if strings.Contains(both, "branches:") {
		t.Errorf("tag mode + milestone tags must drop the branch trigger:\n%s", both)
	}
	if !strings.Contains(both, `tags: ["phase1", "submit/*"]`) {
		t.Errorf("tag mode + milestone tags missing the widened trigger:\n%s", both)
	}

	base := RenderDefaultShim("cs50", "main", "main", "", nil)
	want := strings.Replace(base, "    tags: [\"submit/*\"]\n",
		"    tags: [\"phase1\", \"v*\", \"submit/*\"]\n", 1)
	if got != want {
		t.Errorf("submission-tags shim is not the default minus one line swap:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestRenderDefaultShim_NoTagsByteIdentical(t *testing.T) {
	base := RenderDefaultShim("cs50", "main", "main", "", nil)
	if got := RenderDefaultShim("cs50", "main", "main", "", []string{}); got != base {
		t.Error("empty submission_tags rendered different bytes than nil")
	}
}

// The line-surgery constants must match the template exactly and once; a
// drifted template would silently fall back to an every-push, submit/*-only
// shim instead of failing.
func TestShimTriggerLines_MatchTemplate(t *testing.T) {
	for name, line := range map[string]string{
		"branch": shimBranchTriggerLine,
		"tags":   shimTagsTriggerLine,
	} {
		if n := strings.Count(defaultShimTemplate, line); n != 1 {
			t.Errorf("autograde-shim.yaml contains the %s trigger line %q %d time(s), want exactly 1", name, line, n)
		}
	}
}

// The backfill commit message is mirrored byte-for-byte by the web GUI and
// collect_scores.py's TOOL_COMMIT_SUBJECTS; [skip ci] is load-bearing.
func TestShimBackfillCommitMessage(t *testing.T) {
	got := ShimBackfillCommitMessage()
	want := "[Classroom 50] Add autograde workflow (enable-autograder)\n\n[skip ci]"
	if got != want {
		t.Errorf("ShimBackfillCommitMessage = %q, want %q", got, want)
	}
	// The subject the baseline readers (runner.py, collect_scores.py, the web,
	// both CLIs) compare against; pinned so none can drift.
	if s := ShimBackfillCommitSubject(); s != "[Classroom 50] Add autograde workflow (enable-autograder)" {
		t.Errorf("ShimBackfillCommitSubject = %q", s)
	}
	if s := CommitSubject("  first line \nbody\n[skip ci]"); s != "first line" {
		t.Errorf("CommitSubject = %q, want trimmed first line", s)
	}
}
