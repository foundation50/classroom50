//go:build e2e

package e2e

import (
	"fmt"
	"os"
	"testing"
)

// config is the suite's environment. The suite is a clean NO-OP when the
// required creds are absent, so `go test ./...` without provisioning
// passes rather than failing.
type config struct {
	Org          string // E2E_ORG (the throwaway org; teacher must OWN it)
	Teacher      string // resolved from E2E_TEACHER_PAT
	TeacherPAT   string // E2E_TEACHER_PAT  (admin:org, workflow, repo, delete_repo)
	Student      string // resolved from E2E_STUDENT_PAT
	StudentPAT   string // E2E_STUDENT_PAT  (read:org, repo)
	Student2     string // resolved from E2E_STUDENT2_PAT (group flow only)
	Student2PAT  string // E2E_STUDENT2_PAT (optional)
	CollectToken string // E2E_COLLECT_TOKEN (fine-grained, Contents: R/W + Members: Read)
	Template     string // E2E_TEMPLATE: a public is_template repo, owner/name
	Classroom    string // E2E_CLASSROOM (default cs-principles)
	Assignment   string // E2E_ASSIGNMENT (default hello)
}

var (
	cfg        config
	teacherBin string // path to the freshly-built gh-teacher
	studentBin string // path to the freshly-built gh-student
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func TestMain(m *testing.M) {
	cfg = config{
		Org:          os.Getenv("E2E_ORG"),
		TeacherPAT:   os.Getenv("E2E_TEACHER_PAT"),
		StudentPAT:   os.Getenv("E2E_STUDENT_PAT"),
		Student2PAT:  os.Getenv("E2E_STUDENT2_PAT"),
		CollectToken: os.Getenv("E2E_COLLECT_TOKEN"),
		Template:     os.Getenv("E2E_TEMPLATE"), // empty = template-less assignment (no external dep)
		Classroom:    envOr("E2E_CLASSROOM", "cs-principles"),
		Assignment:   envOr("E2E_ASSIGNMENT", "hello"),
	}

	if cfg.Org == "" || cfg.TeacherPAT == "" || cfg.StudentPAT == "" || cfg.CollectToken == "" {
		fmt.Fprintln(os.Stderr, "e2e: E2E_ORG / E2E_TEACHER_PAT / E2E_STUDENT_PAT / E2E_COLLECT_TOKEN "+
			"not all set — skipping the e2e suite (this is a clean pass, not a failure)")
		os.Exit(0)
	}

	// This is a standalone module (not in the repo's go.work); building the
	// CLIs with the workspace active resolves the wrong modules. Fail fast
	// with a clear message rather than a confusing build error later.
	if os.Getenv("GOWORK") != "off" {
		fmt.Fprintln(os.Stderr, "e2e: GOWORK must be \"off\" (this is a standalone module — "+
			"run `GOWORK=off go test -tags e2e ...`; see test/e2e/README.md)")
		os.Exit(1)
	}

	if err := buildBinaries(); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: build binaries: %v\n", err)
		os.Exit(1)
	}

	// Resolve identities and require the teacher to OWN the org — a
	// member can't run init/teardown or manage collaborators (the
	// maintain/404 lesson). Fail fast with a legible message.
	var err error
	if cfg.Teacher, err = whoami(cfg.TeacherPAT); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: resolve teacher login: %v\n", err)
		os.Exit(1)
	}
	if cfg.Student, err = whoami(cfg.StudentPAT); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: resolve student login: %v\n", err)
		os.Exit(1)
	}
	if cfg.Student2PAT != "" {
		if cfg.Student2, err = whoami(cfg.Student2PAT); err != nil {
			fmt.Fprintf(os.Stderr, "e2e: resolve student2 login: %v\n", err)
			os.Exit(1)
		}
	}
	role, err := orgRole(cfg.TeacherPAT, cfg.Org, cfg.Teacher)
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: read teacher org role: %v\n", err)
		os.Exit(1)
	}
	if role != "admin" {
		fmt.Fprintf(os.Stderr, "e2e: teacher %s is %q in %s — must be an OWNER (admin). "+
			"Provision a bot/owner before running.\n", cfg.Teacher, role, cfg.Org)
		os.Exit(1)
	}
	if cfg.Student == cfg.Teacher {
		fmt.Fprintf(os.Stderr, "e2e: student and teacher are the same account (%s) — "+
			"the round-trip needs two distinct accounts.\n", cfg.Teacher)
		os.Exit(1)
	}

	// Disposability guard: the teardown-first below deletes EVERY repo in the
	// org. Owner + distinct-student checks don't prove the org is a throwaway —
	// a fat-fingered E2E_ORG pointing at a real org the teacher happens to own
	// would be wiped. So refuse to run against an org that already holds repos
	// other than a leftover classroom50 marker, unless the operator explicitly
	// opts in (E2E_ALLOW_DIRTY_ORG=1) for a known-dirty throwaway org.
	if os.Getenv("E2E_ALLOW_DIRTY_ORG") != "1" {
		if extras, err := nonMarkerRepos(cfg.TeacherPAT, cfg.Org); err != nil {
			fmt.Fprintf(os.Stderr, "e2e: list org repos for disposability guard: %v\n", err)
			os.Exit(1)
		} else if len(extras) > 0 {
			sample := extras
			if len(sample) > 5 {
				sample = sample[:5]
			}
			fmt.Fprintf(os.Stderr, "e2e: refusing to run — %s contains %d repo(s) other than the "+
				"classroom50 marker (e.g. %v). The suite teardown-FIRST deletes every repo in the org, "+
				"so this looks like it may not be a throwaway org. Point E2E_ORG at a disposable org, or "+
				"set E2E_ALLOW_DIRTY_ORG=1 if you are certain this org is disposable.\n",
				cfg.Org, len(extras), sample)
			os.Exit(1)
		}
	}

	// Clean slate, then run, then always clean up what we created.
	teardownQuiet()
	code := m.Run()
	teardownQuiet()
	os.Exit(code)
}

// nonMarkerRepos returns the names of repos in org other than the classroom50
// config marker, used by the disposability guard to avoid wiping a non-throwaway
// org. Paginates so a large org is fully inspected.
func nonMarkerRepos(token, org string) ([]string, error) {
	var extras []string
	for page := 1; ; page++ {
		var repos []struct {
			Name string `json:"name"`
		}
		st, err := getJSONPoll(token, fmt.Sprintf("/orgs/%s/repos?per_page=100&page=%d", org, page), &repos)
		if err != nil {
			return nil, err
		}
		if st != 200 {
			return nil, fmt.Errorf("GET /orgs/%s/repos: status %d", org, st)
		}
		if len(repos) == 0 {
			break
		}
		for _, r := range repos {
			if r.Name != "classroom50" {
				extras = append(extras, r.Name)
			}
		}
	}
	return extras, nil
}
