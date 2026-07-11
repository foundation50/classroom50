//go:build e2e

package e2e

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestGroupAssignment covers the manual E2E plan §7 (group round trip):
// a group-mode assignment, founder accept (founder = admin), the founder
// adding a teammate as a push collaborator via `gh student invite` (v1's
// teammate-add; NOT `group join`), one submission, and the score fanning
// out to BOTH rostered members in scores.json.
//
// It is self-contained — its own init→teardown — so it's independent of
// TestHappyPath's ordering: each test starts on a clean org (TestMain's
// teardown-first, or the prior test's teardown-last) and wipes the org at
// the end. Enabling it roughly doubles suite runtime, so it's gated on a
// distinct second student bot (E2E_STUDENT2_PAT).
//
// Prerequisite: THREE distinct accounts — the teacher/owner, a founder
// student (E2E_STUDENT_PAT), and a teammate student (E2E_STUDENT2_PAT),
// each a classic PAT with read:org, repo, workflow.
func TestGroupAssignment(t *testing.T) {
	if cfg.Student2PAT == "" {
		t.Skip("group flow deferred: set E2E_STUDENT2_PAT (a 2nd student bot) to enable §7")
	}
	if cfg.Student2 == cfg.Student || cfg.Student2 == cfg.Teacher {
		t.Skipf("group flow needs a 3rd distinct account; student2 %q overlaps teacher/student", cfg.Student2)
	}

	classroom := cfg.Classroom
	assignment := cfg.Assignment + "-group" // distinct slug from the individual happy-path assignment
	founder := cfg.Student                  // student A: accepts, owns the repo, becomes admin
	teammate := cfg.Student2                // student B: added as a push collaborator
	repo := strings.ToLower(fmt.Sprintf("%s-%s-%s", classroom, assignment, founder))
	pagesBase := fmt.Sprintf("https://%s.github.io/classroom50", cfg.Org)
	// See TestHappyPath: tracks the latest classroom50 commit so publish-pages
	// waits filter to the run we triggered, not a stale earlier one.
	var pagesDeployStart time.Time

	step(t, "G1 init bootstraps the org", func(t *testing.T) {
		initAt := time.Now()
		if out, err := runCLI(cfg.TeacherPAT, "", withServiceToken(), teacherBin,
			"init", cfg.Org, "--yes"); err != nil {
			t.Fatalf("init: %v\n%s", err, out)
		}
		waitForRunSuccess(t, "classroom50", "publish-pages.yaml", initAt, 15*time.Minute)
		// No index.html at the site root (it 404s); poll runner.py, which init
		// always publishes there. 8m covers first-deploy propagation lag.
		waitForPages(t, pagesBase+"/runner.py", "#!/usr/bin/env python3", 8*time.Minute)
	})

	step(t, "G2 classroom add", func(t *testing.T) {
		teacher(t, "classroom", "add", cfg.Org, classroom, "--name", "CS Principles", "--term", "Spring-2026")
		// Wait for the just-committed config files to be readable before the
		// next CLI step reads them — the config repo's read-after-write can lag
		// a few seconds, and roster add fails hard if roster.csv isn't visible.
		for _, f := range []string{"classroom.json", "assignments.json", "roster.csv", "scores.json"} {
			waitFor(t, classroom+"/"+f+" readable", 1*time.Minute, func() (bool, error) {
				return contentExists(t, cfg.TeacherPAT, "classroom50", classroom+"/"+f), nil
			})
		}
	})

	step(t, "G3 roster add both members", func(t *testing.T) {
		teacher(t, "roster", "add", cfg.Org, classroom, founder,
			"--first-name", "Founder", "--last-name", "Bot", "--email", founder+"@example.edu", "--section", "section-1")
		teacher(t, "roster", "add", cfg.Org, classroom, teammate,
			"--first-name", "Teammate", "--last-name", "Bot", "--email", teammate+"@example.edu", "--section", "section-1")
		csv, ok := fetchContent(t, cfg.TeacherPAT, "classroom50", classroom+"/roster.csv")
		if !ok || !strings.Contains(csv, founder) || !strings.Contains(csv, teammate) {
			t.Fatalf("both members not in roster.csv:\n%s", csv)
		}
	})

	step(t, "G4 group assignment add", func(t *testing.T) {
		due := time.Now().Add(72 * time.Hour).Format("2006-01-02T15:04:05-07:00")
		args := []string{"assignment", "add", cfg.Org, classroom, assignment,
			"--name", "Hello (group)", "--due", due, "--mode", "group", "--max-group-size", "2"}
		// Template-less by default; E2E_TEMPLATE (a PUBLIC is_template repo)
		// opts into exercising the generate path.
		if cfg.Template != "" {
			args = append(args, "--template", cfg.Template)
		}
		teacher(t, args...)
		j, ok := fetchContent(t, cfg.TeacherPAT, "classroom50", classroom+"/assignments.json")
		if !ok || !strings.Contains(j, assignment) || !strings.Contains(j, "group") {
			t.Fatalf("group assignment %s not in assignments.json:\n%s", assignment, j)
		}
	})

	step(t, "G5 autograder set-default", func(t *testing.T) {
		pagesDeployStart = time.Now()
		teacher(t, "autograder", "set-default", cfg.Org, classroom)
	})

	step(t, "G6 Pages serves the assignment manifest", func(t *testing.T) {
		waitForRunSuccess(t, "classroom50", "publish-pages.yaml", pagesDeployStart, 15*time.Minute)
		waitForPages(t, pagesBase+"/"+classroom+"/assignments.json", assignment, 5*time.Minute)
	})

	step(t, "G7 founder accepts (founder = admin)", func(t *testing.T) {
		student(t, cfg.StudentPAT, "accept", cfg.Org, classroom, assignment)
		if !repoExists(t, cfg.StudentPAT, repo) {
			t.Fatalf("group repo %s not created", repo)
		}
		if perm := collaboratorPermission(t, repo, founder); perm != "admin" {
			t.Errorf("founder %s permission on %s = %q, want admin", founder, repo, perm)
		}
	})

	step(t, "G8 founder invites teammate to push", func(t *testing.T) {
		// The teammate must be an org member before they can be added as a
		// collaborator (the init lockdown blocks outside collaborators).
		// Accept their pending org invite as the teammate, mirroring what a
		// real student does from the invite email.
		st, b, err := apiReq(http.MethodPatch, cfg.Student2PAT,
			"/user/memberships/orgs/"+cfg.Org, []byte(`{"state":"active"}`))
		if err != nil || st != 200 {
			t.Fatalf("teammate accept org membership: status %d err %v: %s", st, err, b)
		}

		// Founder adds the teammate as a push collaborator (v1's teammate-add).
		if out, err := runCLI(cfg.StudentPAT, "", nil, studentBin,
			"invite", cfg.Org+"/"+repo, teammate); err != nil {
			t.Fatalf("gh student invite: %v\n%s", err, out)
		}

		// An org member added as a collaborator is granted directly; poll for
		// it, then assert push (`write`)-level access.
		waitFor(t, "teammate is a collaborator", 2*time.Minute, func() (bool, error) {
			return getJSON(t, cfg.TeacherPAT, "/repos/"+cfg.Org+"/"+repo+"/collaborators/"+teammate, nil) == 204, nil
		})
		if perm := collaboratorPermission(t, repo, teammate); perm != "write" {
			t.Errorf("teammate %s permission on %s = %q, want write (push)", teammate, repo, perm)
		}
	})

	step(t, "G9 founder submit triggers autograde + release", func(t *testing.T) {
		dir := cloneStudentRepo(t, repo)
		if err := os.WriteFile(filepath.Join(dir, "e2e-group.txt"), []byte("e2e group submission\n"), 0o644); err != nil {
			t.Fatalf("write change: %v", err)
		}
		submitAt := time.Now()
		out, err := runCLI(cfg.StudentPAT, dir, append(gitIdentityEnv(), gitAuthEnv()...), studentBin, "submit")
		if err != nil {
			t.Fatalf("gh-student submit: %v\n%s", err, out)
		}
		waitForRunSuccess(t, repo, "autograde.yaml", submitAt, 10*time.Minute)
		waitForReleaseAsset(t, repo, "result.json", 5*time.Minute)
	})

	step(t, "G10 collect-scores credits BOTH members", func(t *testing.T) {
		collectAt := time.Now()
		dispatchWorkflow(t, "classroom50", "collect-scores.yaml", "main", map[string]string{"classroom": classroom})
		waitForRunSuccess(t, "classroom50", "collect-scores.yaml", collectAt, 8*time.Minute)
		// The group entry's member_usernames must fan the single submission
		// out to both rostered members (collect intersects the repo's
		// collaborators with the roster). Match each login as a quoted JSON
		// token so a substring collision can't fake a credited member.
		waitFor(t, "scores.json credits both members", 3*time.Minute, func() (bool, error) {
			j, ok := fetchContent(t, cfg.TeacherPAT, "classroom50", classroom+"/scores.json")
			return ok &&
				strings.Contains(j, fmt.Sprintf("%q", founder)) &&
				strings.Contains(j, fmt.Sprintf("%q", teammate)), nil
		})
	})

	step(t, "G11 teardown wipes the org", func(t *testing.T) {
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
