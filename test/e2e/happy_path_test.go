//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestHappyPath runs the single-student teacher↔student round trip end to
// end against the live org, mirroring the manual E2E plan §0–6 + §8.
// Steps are ordered and fail-fast: a failed step aborts the rest, since
// each depends on the previous (you can't accept before Pages serves the
// manifest, etc.).
func TestHappyPath(t *testing.T) {
	repo := fmt.Sprintf("%s-%s-%s", cfg.Classroom, cfg.Assignment, cfg.Student) // e.g. cs-principles-hello-bot50
	pagesBase := fmt.Sprintf("https://%s.github.io/classroom50", cfg.Org)
	// Timestamp of the most recent commit to classroom50 (init/classroom/roster/
	// assignment/autograder). Every such commit triggers a fresh publish-pages
	// run, so waitForRunSuccess filters to runs created at/after this to avoid
	// asserting against a stale earlier run.
	var pagesDeployStart time.Time

	step(t, "1.1 teacher scopes", func(t *testing.T) {
		scopes, err := tokenScopes(cfg.TeacherPAT)
		if err != nil {
			t.Fatalf("read scopes: %v", err)
		}
		for _, need := range []string{"admin:org", "workflow", "repo", "delete_repo"} {
			if !contains(scopes, need) {
				t.Fatalf("teacher PAT missing scope %q (has %v)", need, scopes)
			}
		}
	})

	step(t, "1.2 init bootstraps the org", func(t *testing.T) {
		// init reads the service token from the env (no --flag, by design);
		// --yes skips the skeleton-refresh confirmation prompt for scripted runs.
		initAt := time.Now()
		if out, err := runCLI(cfg.TeacherPAT, "", withServiceToken(), teacherBin,
			"init", cfg.Org, "--yes"); err != nil {
			t.Fatalf("init: %v\n%s", err, out)
		}
		pagesDeployStart = initAt
		// config repo exists + private
		var r struct {
			Private bool `json:"private"`
		}
		if getJSON(t, cfg.TeacherPAT, "/repos/"+cfg.Org+"/classroom50", &r) != 200 || !r.Private {
			t.Fatalf("classroom50 config repo missing or not private")
		}
		// the three workflows
		for _, wf := range []string{"autograde-runner.yaml", "publish-pages.yaml", "collect-scores.yaml"} {
			if !contentExists(t, cfg.TeacherPAT, "classroom50", ".github/workflows/"+wf) {
				t.Errorf("missing workflow %s", wf)
			}
		}
		// org locked-down default permission
		var org struct {
			DefaultRepoPerm string `json:"default_repository_permission"`
		}
		getJSON(t, cfg.TeacherPAT, "/orgs/"+cfg.Org, &org)
		if org.DefaultRepoPerm != "none" {
			t.Errorf("default_repository_permission = %q, want none", org.DefaultRepoPerm)
		}
		// rulesets present (Feedback PR base lock + main history guard)
		var rules []struct {
			Name string `json:"name"`
		}
		getJSON(t, cfg.TeacherPAT, "/orgs/"+cfg.Org+"/rulesets", &rules)
		if len(rules) == 0 {
			t.Errorf("no org rulesets created by init")
		}
	})

	step(t, "1.3 init is idempotent", func(t *testing.T) {
		if out, err := runCLI(cfg.TeacherPAT, "", withServiceToken(), teacherBin,
			"init", cfg.Org, "--yes"); err != nil {
			t.Fatalf("re-init: %v\n%s", err, out)
		}
	})

	step(t, "1.4 Pages deploys", func(t *testing.T) {
		waitForRunSuccess(t, "classroom50", "publish-pages.yaml", pagesDeployStart, 15*time.Minute)
		// The site has no index.html, so the root 404s; poll runner.py, which
		// init always publishes at the site root. 8m covers first-deploy lag.
		waitForPages(t, pagesBase+"/runner.py", "#!/usr/bin/env python3", 8*time.Minute)
	})

	step(t, "1.5 rotate service token", func(t *testing.T) {
		out, err := runCLI(cfg.TeacherPAT, "", withServiceToken(), teacherBin,
			"rotate-service-token", cfg.Org)
		if err != nil {
			t.Fatalf("rotate-service-token: %v\n%s", err, out)
		}
	})

	step(t, "2.1 classroom add", func(t *testing.T) {
		teacher(t, "classroom", "add", cfg.Org, cfg.Classroom, "--name", "CS Principles", "--term", "Spring-2026")
		for _, f := range []string{"classroom.json", "assignments.json", "roster.csv", "scores.json"} {
			if !contentExists(t, cfg.TeacherPAT, "classroom50", cfg.Classroom+"/"+f) {
				t.Errorf("missing %s/%s", cfg.Classroom, f)
			}
		}
	})

	step(t, "2.3 roster add student", func(t *testing.T) {
		teacher(t, "roster", "add", cfg.Org, cfg.Classroom, cfg.Student,
			"--first-name", "Bot", "--last-name", "Fifty", "--email", "bot50@example.edu", "--section", "section-1")
		csv, ok := fetchContent(t, cfg.TeacherPAT, "classroom50", cfg.Classroom+"/roster.csv")
		if !ok || !strings.Contains(csv, cfg.Student) {
			t.Fatalf("student %s not in roster.csv", cfg.Student)
		}
		// org invite was sent (pending) — or the student already a member
		var invites []struct {
			Login string `json:"login"`
		}
		getJSON(t, cfg.TeacherPAT, "/orgs/"+cfg.Org+"/invitations", &invites)
		pending := false
		for _, i := range invites {
			if strings.EqualFold(i.Login, cfg.Student) {
				pending = true
			}
		}
		member := getJSON(t, cfg.TeacherPAT, "/orgs/"+cfg.Org+"/members/"+cfg.Student, nil) == 204
		if !pending && !member {
			t.Errorf("student %s neither pending-invited nor a member after roster add", cfg.Student)
		}
	})

	step(t, "2.4 roster migrate is an idempotent no-op on a roster.csv classroom", func(t *testing.T) {
		// `classroom add` already scaffolds roster.csv, so migrate has nothing
		// to rename — it must report the no-op and leave the roster intact.
		out := teacher(t, "roster", "migrate", cfg.Org, cfg.Classroom)
		if !strings.Contains(out, "already migrated") {
			t.Errorf("roster migrate output = %q, want an 'already migrated' no-op", out)
		}
		if !contentExists(t, cfg.TeacherPAT, "classroom50", cfg.Classroom+"/roster.csv") {
			t.Errorf("roster.csv missing after a no-op migrate")
		}
	})

	step(t, "3.1 assignment add", func(t *testing.T) {
		due := time.Now().Add(72 * time.Hour).Format("2006-01-02T15:04:05-07:00")
		args := []string{"assignment", "add", cfg.Org, cfg.Classroom, cfg.Assignment,
			"--name", "Hello", "--due", due}
		// Template-less by default (no external dependency); E2E_TEMPLATE, when
		// set to a PUBLIC is_template repo, also exercises the generate path.
		if cfg.Template != "" {
			args = append(args, "--template", cfg.Template)
		}
		teacher(t, args...)
		j, ok := fetchContent(t, cfg.TeacherPAT, "classroom50", cfg.Classroom+"/assignments.json")
		if !ok || !strings.Contains(j, cfg.Assignment) {
			t.Fatalf("assignment %s not in assignments.json", cfg.Assignment)
		}
	})

	step(t, "3.2 autograder set-default (diagnostic stub)", func(t *testing.T) {
		pagesDeployStart = time.Now()
		teacher(t, "autograder", "set-default", cfg.Org, cfg.Classroom)
		if !contentExists(t, cfg.TeacherPAT, "classroom50", cfg.Classroom+"/autograder.py") {
			t.Errorf("autograder.py not installed")
		}
	})

	step(t, "3.3 Pages serves the assignment manifest", func(t *testing.T) {
		waitForRunSuccess(t, "classroom50", "publish-pages.yaml", pagesDeployStart, 15*time.Minute)
		waitForPages(t, pagesBase+"/"+cfg.Classroom+"/assignments.json", cfg.Assignment, 5*time.Minute)
	})

	step(t, "4.2 student accepts", func(t *testing.T) {
		student(t, cfg.StudentPAT, "accept", cfg.Org, cfg.Classroom, cfg.Assignment)
		if !repoExists(t, cfg.StudentPAT, repo) {
			t.Fatalf("assignment repo %s not created", repo)
		}
		var r struct {
			Private bool `json:"private"`
		}
		getJSON(t, cfg.TeacherPAT, "/repos/"+cfg.Org+"/"+repo, &r)
		if !r.Private {
			t.Errorf("%s is not private", repo)
		}
		if !contentExists(t, cfg.TeacherPAT, repo, ".classroom50.yaml") ||
			!contentExists(t, cfg.TeacherPAT, repo, ".github/workflows/autograde.yaml") {
			t.Errorf("%s missing .classroom50.yaml or autograde shim", repo)
		}
		// The must-have check from manual testing: a stale binary would
		// leave the founder at `maintain` and break group invites.
		if perm := collaboratorPermission(t, repo, cfg.Student); perm != "admin" {
			t.Errorf("founder %s permission on %s = %q, want admin", cfg.Student, repo, perm)
		}
	})

	step(t, "4.3 re-accept is idempotent", func(t *testing.T) {
		out := student(t, cfg.StudentPAT, "accept", cfg.Org, cfg.Classroom, cfg.Assignment)
		if !strings.Contains(strings.ToLower(out), "already accepted") {
			t.Errorf("re-accept did not report an already-accepted note (idempotency contract): %s", out)
		}
	})

	step(t, "5.1–5.2 submit triggers autograde + release + feedback PR", func(t *testing.T) {
		dir := cloneStudentRepo(t, repo)
		if err := os.WriteFile(filepath.Join(dir, "e2e-change.txt"), []byte("e2e submission\n"), 0o644); err != nil {
			t.Fatalf("write change: %v", err)
		}
		submitAt := time.Now()
		out, err := runCLI(cfg.StudentPAT, dir, append(gitIdentityEnv(), gitAuthEnv()...), studentBin, "submit")
		if err != nil {
			t.Fatalf("gh-student submit: %v\n%s", err, out)
		}
		// autograde run (the shim) goes green
		waitForRunSuccess(t, repo, "autograde.yaml", submitAt, 10*time.Minute)
		// a submit/* tag exists
		var tags []struct {
			Ref string `json:"ref"`
		}
		getJSON(t, cfg.TeacherPAT, "/repos/"+cfg.Org+"/"+repo+"/git/matching-refs/tags/submit/", &tags)
		if len(tags) == 0 {
			t.Errorf("no submit/* tag created")
		}
		// a release carrying result.json
		waitForReleaseAsset(t, repo, "result.json", 5*time.Minute)
		// Feedback PR opened against the frozen `feedback` base branch
		// (feedback-pr is on by default; the runner freezes BASE_BRANCH =
		// "feedback" at the baseline and opens the PR once there's a diff).
		waitFor(t, "feedback PR", 5*time.Minute, func() (bool, error) {
			var pulls []struct {
				Base struct {
					Ref string `json:"ref"`
				} `json:"base"`
			}
			st, err := getJSONPoll(cfg.TeacherPAT, "/repos/"+cfg.Org+"/"+repo+"/pulls?state=all", &pulls)
			if err != nil {
				return false, err
			}
			if st != 200 {
				return false, nil
			}
			for _, p := range pulls {
				if p.Base.Ref == "feedback" {
					return true, nil
				}
			}
			return false, nil
		})
	})

	step(t, "6.1 collect-scores", func(t *testing.T) {
		collectAt := time.Now()
		dispatchWorkflow(t, "classroom50", "collect-scores.yaml", "main", map[string]string{"classroom": cfg.Classroom})
		waitForRunSuccess(t, "classroom50", "collect-scores.yaml", collectAt, 8*time.Minute)
		waitFor(t, "scores.json row", 3*time.Minute, func() (bool, error) {
			j, ok := fetchContent(t, cfg.TeacherPAT, "classroom50", cfg.Classroom+"/scores.json")
			// Match the login as a quoted JSON token, not a bare substring, so a
			// coincidental substring (or a login that is a prefix of another)
			// can't yield a false pass.
			return ok && strings.Contains(j, fmt.Sprintf("%q", cfg.Student)), nil
		})
	})

	step(t, "6.2 download writes scores.csv", func(t *testing.T) {
		dest := t.TempDir()
		out, err := runCLI(cfg.TeacherPAT, "", nil, teacherBin,
			"download", cfg.Org, cfg.Classroom, cfg.Assignment, "-d", dest)
		if err != nil {
			t.Fatalf("download: %v\n%s", err, out)
		}
		csv := findFile(t, dest, "scores.csv")
		if csv == "" {
			t.Fatalf("no scores.csv under %s", dest)
		}
		b, _ := os.ReadFile(csv)
		if !strings.Contains(string(b), cfg.Student) {
			t.Errorf("scores.csv missing %s row:\n%s", cfg.Student, b)
		}
	})

	step(t, "8 teardown wipes the org", func(t *testing.T) {
		teacher(t, "teardown", cfg.Org, "--yes")
		var repos []struct {
			Name string `json:"name"`
		}
		getJSON(t, cfg.TeacherPAT, "/orgs/"+cfg.Org+"/repos?per_page=100", &repos)
		if len(repos) != 0 {
			t.Errorf("org not empty after teardown: %d repos", len(repos))
		}
	})
}

// step runs one named, fail-fast stage: a failure aborts the whole flow
// (each stage depends on the prior).
func step(t *testing.T, name string, fn func(t *testing.T)) {
	t.Helper()
	if !t.Run(name, fn) {
		t.Fatalf("aborting: step %q failed", name)
	}
}

// withServiceToken returns the env carrying CLASSROOM50_SERVICE_TOKEN for
// init / rotate-service-token. (runCLI appends extraEnv after the base env.)
func withServiceToken() []string {
	return []string{"CLASSROOM50_SERVICE_TOKEN=" + cfg.CollectToken}
}

func gitIdentityEnv() []string {
	return []string{
		"GIT_AUTHOR_NAME=bot50", "GIT_AUTHOR_EMAIL=bot50@example.edu",
		"GIT_COMMITTER_NAME=bot50", "GIT_COMMITTER_EMAIL=bot50@example.edu",
	}
}

// gitAuthEnv injects a github.com credential helper carrying the student
// token via GIT_CONFIG_* env, so git authenticates HTTPS pushes/fetches
// WITHOUT a token-embedded remote URL (which `gh student submit` can't
// parse — it reads remote.origin.url to derive owner/repo). The leading
// empty `credential.helper` resets any inherited global helper (e.g. a
// `gh` helper logged in as a different user) so only this token is used.
// The helper is SCOPED to github.com (credential.https://github.com.helper)
// so the PAT is only ever handed to GitHub, never to some other host if a
// clone's remote is unexpected. submit's child git processes inherit this
// env (it doesn't override cmd.Env), so its internal bare-clone + push
// authenticate too.
func gitAuthEnv() []string {
	helper := fmt.Sprintf(`!f() { echo username=x-access-token; echo "password=%s"; }; f`, cfg.StudentPAT)
	return []string{
		"GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=credential.https://github.com.helper", "GIT_CONFIG_VALUE_0=",
		"GIT_CONFIG_KEY_1=credential.https://github.com.helper", "GIT_CONFIG_VALUE_1=" + helper,
	}
}

// cloneStudentRepo clones the assignment repo with a CLEAN remote URL (so
// `gh student submit` can parse remote.origin.url) and supplies auth via
// gitAuthEnv's credential helper.
func cloneStudentRepo(t *testing.T, repo string) string {
	t.Helper()
	dir := t.TempDir()
	url := fmt.Sprintf("https://github.com/%s/%s.git", cfg.Org, repo)
	cmd := exec.Command("git", "clone", url, dir)
	cmd.Env = append(os.Environ(), gitIdentityEnv()...)
	cmd.Env = append(cmd.Env, gitAuthEnv()...)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git clone %s: %v\n%s", repo, err, b)
	}
	return dir
}

func findFile(t *testing.T, root, name string) string {
	t.Helper()
	var found string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == name {
			found = p
		}
		return nil
	})
	return found
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
