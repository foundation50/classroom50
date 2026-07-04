package main

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
)

// TestSkeletonFiles_Manifest pins every path the init skeleton
// commits and the placeholder substitutions applied to each. A
// missing file or stale placeholder breaks grading silently —
// runtime errors only show up the first time a student submits.
func TestSkeletonFiles_Manifest(t *testing.T) {
	files, err := skeletonFiles("main")
	if err != nil {
		t.Fatalf("skeletonFiles: %v", err)
	}

	wantPaths := []string{
		".github/workflows/autograde-runner.yaml",
		".github/workflows/publish-pages.yaml",
		".github/workflows/collect-scores.yaml",
		".github/workflows/regrade.yaml",
		".github/workflows/probe-token.yaml",
		".github/scripts/runner.py",
		".github/scripts/collect_scores.py",
		".github/scripts/regrade_repos.py",
		".github/scripts/probe_token.py",
		".github/scripts/ensure_feedback_pr.py",
		"README.md",
	}
	for _, p := range wantPaths {
		if _, ok := files[p]; !ok {
			t.Errorf("skeleton missing %q (got files: %v)", p, keys(files))
		}
	}

	// No org-level autograder.py — the diagnostic stub now ships
	// inside gh-teacher (embed/autograder.py) and is written to
	// `<classroom>/autograder.py` only when teachers explicitly run
	// `gh teacher autograder set-default`. Org-level scaffolding
	// would silently re-introduce the old "default lives at the org
	// level" architecture.
	if _, ok := files[".github/scripts/autograder.py"]; ok {
		t.Errorf("init skeleton must not include .github/scripts/autograder.py — defaults are classroom-scoped now")
	}

	// {{DEFAULT_BRANCH}} substituted everywhere; a leak would 404
	// publish-pages's `on:` branch trigger.
	for path, body := range files {
		if strings.Contains(body, "{{DEFAULT_BRANCH}}") {
			t.Errorf("skeleton leaked {{DEFAULT_BRANCH}} placeholder in %s:\n%s", path, body)
		}
	}

	// __pycache__ isn't dot-prefixed, so //go:embed walks it; skeletonFiles
	// must filter the bytecode out.
	for path := range files {
		if strings.Contains(path, "__pycache__") || strings.HasSuffix(path, ".pyc") {
			t.Errorf("skeleton must not embed bytecode-cache path %q", path)
		}
	}

	// publish-pages must actually publish the org-level scripts the
	// autograde-runner fetches from Pages — runner.py and the Phase 2
	// ensure_feedback_pr.py. A missing copy line would 404 the runtime
	// fetch and silently disable grading / the Feedback PR.
	pubBody, ok := files[".github/workflows/publish-pages.yaml"]
	if !ok {
		t.Fatal("publish-pages.yaml missing from skeleton")
	}
	for _, script := range []string{"runner.py", "ensure_feedback_pr.py"} {
		if !strings.Contains(pubBody, "_site/"+script) {
			t.Errorf("publish-pages.yaml does not publish %s to the site root (autograde-runner fetches it from Pages)", script)
		}
	}

	// The classrooms index must publish the `active` archival flag so the
	// student accept page can refuse an archived classroom.
	if !strings.Contains(pubBody, `"active"`) {
		t.Error("publish-pages.yaml classrooms index must include the \"active\" key so the student accept page can refuse archived classrooms")
	}
}

// TestSkeletonFiles_AutogradeRunner pins the runner workflow's
// shape: two-job structure with runtime dispatch in setup → grade,
// language toolchains, autograder fetch, post-grade publish. A
// regression here breaks grading for every student silently.
//
// Asserts on the parsed YAML structure where possible (more
// resilient to whitespace/indent changes); falls back to substring
// checks only for content embedded inside `run:` shell scripts and
// inline-Python blocks where YAML structure can't see the value.
func TestSkeletonFiles_AutogradeRunner(t *testing.T) {
	files, err := skeletonFiles("main")
	if err != nil {
		t.Fatalf("skeletonFiles: %v", err)
	}
	body, ok := files[".github/workflows/autograde-runner.yaml"]
	if !ok {
		t.Fatalf("autograde-runner.yaml missing from skeleton")
	}

	var doc map[string]any
	if err := yaml.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatalf("parse autograde-runner.yaml: %v", err)
	}

	// `on: workflow_call` — required for the student-repo shim's `uses:` to work.
	if _, hasCall := nested(doc, "on", "workflow_call"); !hasCall {
		t.Errorf("autograde-runner.yaml missing `on.workflow_call` (student shim's uses: would fail)")
	}

	// Workflow-level permissions: contents:write (publish release, push tag),
	// statuses:write (post commit status).
	for _, perm := range []string{"contents", "statuses"} {
		got, ok := nested(doc, "permissions", perm)
		if !ok || got != "write" {
			t.Errorf("autograde-runner.yaml workflow permissions[%q] = %v, want \"write\"", perm, got)
		}
	}

	// Workflow-level concurrency: every push grades (no cancel).
	if got, ok := nested(doc, "concurrency", "cancel-in-progress"); !ok || got != false {
		t.Errorf("autograde-runner.yaml concurrency.cancel-in-progress = %v, want false", got)
	}

	// Cross-binary literal parity: the `feedback` base-branch name now
	// lives in ensure_feedback_pr.py (BASE_BRANCH), fetched from Pages by
	// the Feedback PR step. It must match the Go `feedbackBaseBranch` const
	// that the org ruleset targets — a drift would point the runner and the
	// ruleset at different branches, silently breaking the frozen-base lock.
	// This is the enforced single-source the "keep in lockstep" comment asks
	// for (Phase 1; moved to the script in Phase 2).
	fbScript, ok := files[".github/scripts/ensure_feedback_pr.py"]
	if !ok {
		t.Fatal("ensure_feedback_pr.py missing from skeleton")
	}
	wantBaseBranch := "BASE_BRANCH = \"" + feedbackBaseBranch + "\""
	if !strings.Contains(fbScript, wantBaseBranch) {
		t.Errorf("ensure_feedback_pr.py does not pin %s (feedbackBaseBranch drift vs the org ruleset)", wantBaseBranch)
	}

	// F1: the grade job must pass MODE through to runner.py so a group
	// autograder's multi-username result.json is validated (not rejected).
	if got, ok := nested(doc, "jobs", "grade", "env", "MODE"); !ok || got == "" {
		t.Errorf("autograde-runner.yaml grade.env.MODE = %v, want the setup `mode` output (F1 mode-aware validation)", got)
	}

	// === Setup → grade → set-latest job structure ===
	jobs, _ := nested(doc, "jobs")
	jobsMap, ok := jobs.(map[string]any)
	if !ok {
		t.Fatalf("jobs: not a map")
	}
	for _, j := range []string{"setup", "grade", "set-latest"} {
		if _, present := jobsMap[j]; !present {
			t.Errorf("autograde-runner.yaml missing job %q", j)
		}
	}

	// === grade job ===
	if got, _ := nested(doc, "jobs", "grade", "runs-on"); got != "${{ fromJSON(needs.setup.outputs.runs-on) }}" {
		t.Errorf("grade.runs-on = %v, want fromJSON(needs.setup.outputs.runs-on) parameterization (runs-on is emitted as a JSON array to support multi-label custom runners)", got)
	}
	if got, _ := nested(doc, "jobs", "grade", "container"); got != "${{ fromJSON(needs.setup.outputs.container) }}" {
		t.Errorf("grade.container = %v, want fromJSON(needs.setup.outputs.container)", got)
	}
	if got, _ := nested(doc, "jobs", "grade", "needs"); got != "setup" {
		t.Errorf("grade.needs = %v, want \"setup\"", got)
	}
	// Pin shell: bash on the grade job — Actions falls back to `sh -e`
	// inside containers, and our run: blocks use bash idioms (`set -euo pipefail`).
	if got, _ := nested(doc, "jobs", "grade", "defaults", "run", "shell"); got != "bash" {
		t.Errorf("grade.defaults.run.shell = %v, want \"bash\" (steps fail in non-bash containers)", got)
	}

	// === setup job: outputs the inline validator emits ===
	setupOutputs, _ := nested(doc, "jobs", "setup", "outputs")
	outputsMap, _ := setupOutputs.(map[string]any)
	for _, out := range []string{
		"submission-tag", "runs-on", "container",
		"python", "node", "java", "go", "apt",
		"base-url", "classroom", "assignment",
		// is-acceptance gates the whole skip-the-acceptance-commit path;
		// a dropped output would make every gate below read empty and
		// re-grade the acceptance commit.
		"is-acceptance",
	} {
		if _, ok := outputsMap[out]; !ok {
			t.Errorf("setup.outputs missing %q", out)
		}
	}

	// === acceptance-commit skip wiring ===
	// The acceptance commit (the one that introduced .classroom50.yaml,
	// student-authored, so it fires this workflow) has nothing to grade.
	// The setup `acceptance` step detects it via the Pages-fetched
	// runner.py and emits is-acceptance; the tag/read steps and the grade
	// job are gated off it. A silent revert of any of these would re-grade
	// every acceptance commit and republish the spurious 0/0 release —
	// exactly what this guard exists to prevent.
	//
	// grade is gated at the job level (set-latest needs grade, so it skips
	// transitively).
	if got, _ := nested(doc, "jobs", "grade", "if"); got != "needs.setup.outputs.is-acceptance != 'true'" {
		t.Errorf("grade.if = %v, want \"needs.setup.outputs.is-acceptance != 'true'\" (acceptance-commit skip)", got)
	}
	// The setup checkout must use full history: _baseline_scan walks back
	// to the commit that added .classroom50.yaml, and a shallow clone
	// hides it (the un-deepenable case fails open to grade, but a silent
	// regression here would make detection unreliable).
	if !strings.Contains(body, "fetch-depth: 0") {
		t.Errorf("autograde-runner.yaml setup checkout missing fetch-depth: 0 (acceptance scan needs full history)")
	}
	// The tag and read steps are step-gated off the same detection so the
	// acceptance commit produces no submit/* tag and no metadata read.
	if !strings.Contains(body, "if: steps.acceptance.outputs.is-acceptance != 'true'") {
		t.Errorf("autograde-runner.yaml tag/read steps not gated on the acceptance detection")
	}
	// Branch trigger only — a tag push is always a submission, so the
	// detection step must not run on tag pushes (its absence leaves
	// is-acceptance empty, which the != 'true' gates treat as grade).
	if !strings.Contains(body, "if: github.ref_type == 'branch'") {
		t.Errorf("autograde-runner.yaml acceptance step not restricted to branch pushes")
	}
	// Fail open: both the fetch-failure branch and the run-failure branch
	// of the detection step must write is-acceptance=false so an uncertain
	// detection grades rather than dropping a real submission.
	if !strings.Contains(body, `echo "is-acceptance=false" >> "$GITHUB_OUTPUT"`) {
		t.Errorf("autograde-runner.yaml acceptance step missing the fail-open is-acceptance=false fallback")
	}
	if !strings.Contains(body, "--detect-acceptance") {
		t.Errorf("autograde-runner.yaml acceptance step doesn't invoke runner.py --detect-acceptance")
	}

	// === set-latest job: serialized + commit-time-based ===
	if got, _ := nested(doc, "jobs", "set-latest", "concurrency", "group"); got != "classroom50-set-latest-${{ github.repository }}" {
		t.Errorf("set-latest concurrency group = %v, want per-repo serialization", got)
	}
	if got, _ := nested(doc, "jobs", "set-latest", "concurrency", "cancel-in-progress"); got != false {
		t.Errorf("set-latest cancel-in-progress = %v, want false", got)
	}

	// === substring checks for content embedded inside run: scripts ===
	// These check semantics that YAML structure can't see — shell-
	// script lines, inline-Python statements, regex literals.

	// Auto-tag step: short-SHA suffix prevents collisions; idempotency
	// reuses an existing submit/* tag for the same SHA. `--refs` filters
	// out annotated-tag `^{}` peeled-ref rows that would otherwise be
	// captured by the awk pattern.
	for _, want := range []string{
		`refs/tags/*`,
		`TAG="submit/$(date -u +%Y-%m-%dT%H-%M-%SZ)-$(echo "$SHA" | cut -c1-7)"`,
		`git push origin "refs/tags/$TAG"`,
		`git ls-remote --refs --tags origin`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("autograde-runner.yaml missing tag step line %q", want)
		}
	}

	// Inline-Python validator runs in setup. Its outputs are the
	// runtime-dispatch points the grade job reads.
	if !strings.Contains(body, `shell: python3 {0}`) {
		t.Errorf("autograde-runner.yaml setup step missing inline Python validator")
	}
	if !strings.Contains(body, `f"https://{owner}.github.io/classroom50"`) {
		t.Errorf("autograde-runner.yaml base_url not org-level")
	}

	// runtime.container.user → container.options translation must use
	// an explicit allow-list build (`emitted = {"image": image}` etc.)
	// rather than copying unknown keys through. Mirrors Go's
	// `assignment.ContainerSpec` + DisallowUnknownFields. Only `image`
	// and `user` are container keys — private registry auth is out of
	// scope for this model, so images must be publicly pullable.
	for _, want := range []string{
		`_RUNTIME_KEYS = {"runs-on", "container", "python", "node", "java", "go", "apt"}`,
		`_CONTAINER_KEYS = {"image", "user"}`,
		`emitted = {"image": image}`,
		`emitted["options"] = f"--user {user}"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("inline validator missing %q (allow-list / user→options translation)", want)
		}
	}

	// Toolchain steps gated on matching setup outputs.
	for _, want := range []string{
		"if: needs.setup.outputs.python != ''",
		"actions/setup-python@v6",
		"if: needs.setup.outputs.node != ''",
		"actions/setup-node@v6",
		"if: needs.setup.outputs.java != ''",
		"actions/setup-java@v5",
		"if: needs.setup.outputs.go != ''",
		"actions/setup-go@v6",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("autograde-runner.yaml missing toolchain dispatch %q", want)
		}
	}

	// runner.py is fetched at the org-level URL on every run, with
	// curl --retry so a transient Pages 5xx doesn't fail the whole run.
	if !strings.Contains(body, `${PAGES_BASE_URL}/runner.py`) {
		t.Errorf("autograde-runner.yaml doesn't fetch runner.py at the org-level URL")
	}
	if !strings.Contains(body, "--retry 3") || !strings.Contains(body, "--retry-all-errors") {
		t.Errorf("autograde-runner.yaml runner.py curl is missing retry flags (single point of failure on Pages 5xx)")
	}

	// The Feedback PR logic lives in ensure_feedback_pr.py, fetched from
	// Pages like runner.py (the reusable workflow has no config-repo
	// checkout). The step must be the thin fetch+exec shim, not inline bash.
	if !strings.Contains(body, `${PAGES_BASE_URL}/ensure_feedback_pr.py`) {
		t.Errorf("autograde-runner.yaml doesn't fetch ensure_feedback_pr.py at the org-level URL (Feedback PR logic should be Pages-fetched, not inline)")
	}

	// Commit status posted always; release publish skipped on error.
	if !strings.Contains(body, `context="classroom50/autograde"`) {
		t.Errorf("autograde-runner.yaml doesn't post the classroom50/autograde commit status")
	}
	if !strings.Contains(body, "if: success() && steps.autograde.outputs.status != 'error'") {
		t.Errorf("release step not gated on success() && status != 'error'")
	}

	// set-latest uses commit-time-based comparison (not lexical tag
	// compare) so two pushes in the same UTC second still order
	// correctly, and a non-submit/* "latest" can't permanently block
	// future submissions from claiming latest.
	if !strings.Contains(body, `if [[ -z "$CURRENT" || "$CURRENT" != submit/* ]]`) {
		t.Errorf("set-latest job missing non-submit/* fallback (cascade-block protection)")
	}
	if !strings.Contains(body, `commit.committer.date`) {
		t.Errorf("set-latest job not using commit-time-based comparison")
	}
	if !strings.Contains(body, `gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --latest=true`) {
		t.Errorf("set-latest job missing forward-only latest pointer flip")
	}
}

// TestRegexParity_GoVsInlinePython enforces that the regex/allow-list
// constants duplicated between cli/gh-teacher/internal/assignment/runtime.go
// and the inline Python validator in autograde-runner.yaml stay in lockstep.
// Drift would let the CLI write a value the runtime workflow rejects
// (or vice versa), surfacing only on the next student submission.
func TestRegexParity_GoVsInlinePython(t *testing.T) {
	files, err := skeletonFiles("main")
	if err != nil {
		t.Fatalf("skeletonFiles: %v", err)
	}
	runner, ok := files[".github/workflows/autograde-runner.yaml"]
	if !ok {
		t.Fatalf("autograde-runner.yaml missing from skeleton")
	}

	// For each Go-side pattern, assert the inline-Python source
	// contains the same regex literal. The literal is the contract;
	// any reformat of the underlying validator that drops a regex
	// would fail this check.
	type pair struct {
		name      string
		goPattern string
	}
	pairs := []pair{
		{"assignment.LanguageVersionPattern", assignment.LanguageVersionPattern.String()},
		{"assignment.AptPackagePattern", assignment.AptPackagePattern.String()},
		{"assignment.ContainerImagePattern", assignment.ContainerImagePattern.String()},
		{"assignment.ContainerUserPattern", assignment.ContainerUserPattern.String()},
		{"assignment.RunsOnLabelPattern", assignment.RunsOnLabelPattern.String()},
	}
	for _, p := range pairs {
		if !strings.Contains(runner, p.goPattern) {
			t.Errorf("inline Python validator missing regex literal mirrored from %s: %q", p.name, p.goPattern)
		}
	}
}

// TestCollectScoresCommitPrefix pins the third leg of the [Classroom 50]
// commit-prefix mirror: the collect-scores workflow's `git commit -m`
// literal. The Go const (contract.CommitPrefix, pinned by contract_test.go)
// and the web COMMIT_PREFIX (pinned by web/src/util/commit.test.ts) are the
// other two; this file is an embedded YAML copy with no compile-time link,
// so a reworded prefix here would otherwise drift silently while CI stays
// green. Asserts the committed message starts with the shared prefix.
func TestCollectScoresCommitPrefix(t *testing.T) {
	files, err := skeletonFiles("main")
	if err != nil {
		t.Fatalf("skeletonFiles: %v", err)
	}
	body, ok := files[".github/workflows/collect-scores.yaml"]
	if !ok {
		t.Fatal("collect-scores.yaml missing from skeleton")
	}
	want := `commit -m "` + contract.CommitPrefix + " "
	if !strings.Contains(body, want) {
		t.Errorf("collect-scores.yaml commit message does not start with the shared prefix %q; the [Classroom 50] mirror has drifted from contract.CommitPrefix:\n%s", contract.CommitPrefix, body)
	}
}

// nested walks doc by key path; returns (value, true) on hit and
// assert on parsed YAML structure without nesting type-assertions.
func nested(doc any, keys ...string) (any, bool) {
	cur := doc
	for _, k := range keys {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		v, present := m[k]
		if !present {
			return nil, false
		}
		cur = v
	}
	return cur, true
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
