package ignorematch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// sharedMatcherCasesPath locates the cross-language golden fixture
// (also consumed by the Python runner.py test) relative to this package.
const sharedMatcherCasesPath = "../../../shared/testdata/allowed_files_matcher_cases.json"

type matcherCase struct {
	Name       string   `json:"name"`
	Patterns   []string `json:"patterns"`
	Paths      []string `json:"paths"`
	Disallowed []string `json:"disallowed"`
}

// TestDisallowed_SharedFixtureParity runs the shared golden cases so the
// Go matcher and the Python runner-side classifier stay in lockstep.
func TestDisallowed_SharedFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(sharedMatcherCasesPath))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var doc struct {
		Cases []matcherCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("shared fixture has no cases")
	}
	for _, c := range doc.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := Disallowed(c.Patterns, c.Paths)
			if err != nil {
				t.Fatalf("Disallowed: %v", err)
			}
			gotList := keys(got)
			want := append([]string(nil), c.Disallowed...)
			sort.Strings(want)
			if len(gotList) != len(want) {
				t.Fatalf("disallowed = %v, want %v", gotList, want)
			}
			for i := range want {
				if gotList[i] != want[i] {
					t.Fatalf("disallowed = %v, want %v", gotList, want)
				}
			}
		})
	}
}

func TestDisallowed_Allowlist(t *testing.T) {
	// `*` ignores everything, `!hello.py` re-includes it: only hello.py is
	// allowed, the rest disallowed.
	paths := []string{"hello.py", "main.c", "sub/foo.txt"}
	got, err := Disallowed([]string{"*", "!hello.py"}, paths)
	if err != nil {
		t.Fatalf("Disallowed: %v", err)
	}
	if got["hello.py"] {
		t.Errorf("hello.py marked disallowed, want allowed")
	}
	if !got["main.c"] || !got["sub/foo.txt"] {
		t.Errorf("expected main.c and sub/foo.txt disallowed, got %#v", keys(got))
	}
}

func TestDisallowed_NoPatternsAllowsEverything(t *testing.T) {
	got, err := Disallowed(nil, []string{"a", "b"})
	if err != nil {
		t.Fatalf("Disallowed: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("nil patterns should disallow nothing, got %#v", keys(got))
	}
}

func TestDisallowed_IgnoreSpecificNoise(t *testing.T) {
	// The looser "drop the noise" shape: ignore node_modules and lock
	// files, allow the rest.
	paths := []string{"main.py", "node_modules/x.js", "package.lock"}
	got, err := Disallowed([]string{"node_modules/", "*.lock"}, paths)
	if err != nil {
		t.Fatalf("Disallowed: %v", err)
	}
	if got["main.py"] {
		t.Errorf("main.py should be allowed")
	}
	if !got["node_modules/x.js"] || !got["package.lock"] {
		t.Errorf("expected node_modules/x.js and package.lock disallowed, got %#v", keys(got))
	}
}

func TestDisallowed_EmptyPaths(t *testing.T) {
	got, err := Disallowed([]string{"*"}, nil)
	if err != nil {
		t.Fatalf("Disallowed: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("no paths should yield empty result, got %#v", keys(got))
	}
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// TestDisallowed_IgnoresAmbientGitConfig proves the matcher ignores the host's
// global gitignore: patterns not matching `app.log` keep it allowed even when
// a global excludesFile would ignore `*.log`.
func TestDisallowed_IgnoresAmbientGitConfig(t *testing.T) {
	home := t.TempDir()
	globalIgnore := filepath.Join(home, "globalignore")
	if err := os.WriteFile(globalIgnore, []byte("*.log\n"), 0o644); err != nil {
		t.Fatalf("write global ignore: %v", err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_GLOBAL", "")
	gitconfig := filepath.Join(home, ".gitconfig")
	if err := os.WriteFile(gitconfig, []byte("[core]\n\texcludesFile = "+globalIgnore+"\n"), 0o644); err != nil {
		t.Fatalf("write gitconfig: %v", err)
	}

	got, err := Disallowed([]string{"secret.txt"}, []string{"app.log", "keep.py"})
	if err != nil {
		t.Fatalf("Disallowed: %v", err)
	}
	if got["app.log"] {
		t.Errorf("app.log marked disallowed — ambient global excludesFile leaked into the matcher")
	}
	if len(got) != 0 {
		t.Errorf("only secret.txt could match the patterns; got disallowed=%v", keys(got))
	}
}
