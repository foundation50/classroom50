package submitcmd

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"

	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/ui"
)

// initRepoWithFiles creates a git repo at dir containing the given
// relative files (each written with trivial content) and stages them
// so `git ls-files` enumerates them.
func initRepoWithFiles(t *testing.T, dir string, files []string) {
	t.Helper()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "Tester")
	for _, f := range files {
		p := filepath.Join(dir, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", p, err)
		}
		if err := os.WriteFile(p, []byte("x\n"), 0o644); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	run("add", "-A")
}

func copiedFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		out = append(out, rel)
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	sort.Strings(out)
	return out
}

func TestCopySubmittableFiles_AllowlistKeepsOnlyMatchAndControlFiles(t *testing.T) {
	src := t.TempDir()
	initRepoWithFiles(t, src, []string{
		"hello.py",
		"scratch.py",
		"build/out.o",
		".classroom50.yaml",
		".github/workflows/autograde.yaml",
	})
	dst := t.TempDir()

	u := ui.NewForced(os.Stderr, false)
	if err := copySubmittableFiles(src, dst, []string{"*", "!hello.py"}, u, false); err != nil {
		t.Fatalf("copySubmittableFiles: %v", err)
	}

	got := copiedFiles(t, dst)
	want := []string{
		".classroom50.yaml",
		".github/workflows/autograde.yaml",
		"hello.py",
	}
	if len(got) != len(want) {
		t.Fatalf("copied = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("copied = %v, want %v", got, want)
		}
	}
}

func TestCopySubmittableFiles_NoPatternsKeepsEverything(t *testing.T) {
	src := t.TempDir()
	files := []string{"hello.py", "scratch.py", "build/out.o"}
	initRepoWithFiles(t, src, files)
	dst := t.TempDir()

	u := ui.NewForced(os.Stderr, false)
	if err := copySubmittableFiles(src, dst, nil, u, false); err != nil {
		t.Fatalf("copySubmittableFiles: %v", err)
	}

	got := copiedFiles(t, dst)
	if len(got) != len(files) {
		t.Errorf("copied = %v, want all %v (no filtering)", got, files)
	}
}

func TestCopySubmittableFiles_ControlFilesKeptEvenUnderStarIgnore(t *testing.T) {
	// `*` with no negation would disallow everything; control files
	// must still survive.
	src := t.TempDir()
	initRepoWithFiles(t, src, []string{
		"anything.py",
		".classroom50.yaml",
		".github/workflows/autograde.yaml",
	})
	dst := t.TempDir()

	u := ui.NewForced(os.Stderr, false)
	if err := copySubmittableFiles(src, dst, []string{"*"}, u, false); err != nil {
		t.Fatalf("copySubmittableFiles: %v", err)
	}

	got := copiedFiles(t, dst)
	want := []string{".classroom50.yaml", ".github/workflows/autograde.yaml"}
	if len(got) != len(want) {
		t.Fatalf("copied = %v, want only control files %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("copied = %v, want %v", got, want)
		}
	}
}

func TestFetchAllowedFiles_FetchFailureReturnsNil(t *testing.T) {
	// Best-effort guarantee: a manifest fetch failure must never block
	// submission — fetchAllowedFiles returns nil (submit all) since the
	// runner enforces the allowlist authoritatively.
	orig := fetchEntryFn
	t.Cleanup(func() { fetchEntryFn = orig })
	fetchEntryFn = func(ctx context.Context, org, classroom, secret, assignment string) (assignments.Entry, error) {
		return assignments.Entry{}, errors.New("pages 404")
	}

	u := ui.NewForced(os.Stderr, false)
	cfg := &classroomcfg.Config{Classroom: "cs-principles", Assignment: "hello"}
	got := fetchAllowedFiles(context.Background(), "o", cfg, u, false)
	if got != nil {
		t.Errorf("fetchAllowedFiles on fetch failure = %#v, want nil (submit all)", got)
	}
}

func TestFetchAllowedFiles_SuccessReturnsPatterns(t *testing.T) {
	orig := fetchEntryFn
	t.Cleanup(func() { fetchEntryFn = orig })
	fetchEntryFn = func(ctx context.Context, org, classroom, secret, assignment string) (assignments.Entry, error) {
		return assignments.Entry{AllowedFiles: []string{"*", "!hello.py"}}, nil
	}

	u := ui.NewForced(os.Stderr, false)
	cfg := &classroomcfg.Config{Classroom: "cs-principles", Assignment: "hello"}
	got := fetchAllowedFiles(context.Background(), "o", cfg, u, false)
	if len(got) != 2 || got[0] != "*" || got[1] != "!hello.py" {
		t.Errorf("fetchAllowedFiles = %#v, want [* !hello.py]", got)
	}
}

// sharedControlPathCasesPath locates the cross-language golden fixture
// (also consumed by the Python runner.py test) relative to this package.
const sharedControlPathCasesPath = "../../../shared/testdata/control_path_cases.json"

// TestIsControlPath_SharedFixtureParity runs the shared golden cases so the Go
// isControlPath and the Python _is_control_path force-keep sets stay in
// lockstep, like the matcher fixture pins the two matchers.
func TestIsControlPath_SharedFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(sharedControlPathCasesPath))
	if err != nil {
		t.Fatalf("read shared control-path fixture: %v", err)
	}
	var doc struct {
		Cases []struct {
			Path      string `json:"path"`
			IsControl bool   `json:"is_control"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse shared control-path fixture: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("shared control-path fixture has no cases")
	}
	for _, c := range doc.Cases {
		if got := isControlPath(c.Path); got != c.IsControl {
			t.Errorf("isControlPath(%q) = %v, want %v", c.Path, got, c.IsControl)
		}
	}
}
