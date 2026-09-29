package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/ghhelp"
	"github.com/foundation50/gh-teacher/internal/cliutil"
)

func TestHelpCopyConventions(t *testing.T) {
	if v := ghhelp.Lint(newRootCmd()); len(v) != 0 {
		t.Fatalf("%d help copy violation(s):\n  %s", len(v), strings.Join(v, "\n  "))
	}
}

func runRoot(t *testing.T, args ...string) (string, error) {
	t.Helper()
	root := newRootCmd()
	var buf bytes.Buffer
	root.SetOut(&buf)
	root.SetErr(&buf)
	root.SetArgs(args)
	err := root.Execute()
	return buf.String(), err
}

// Guards that ghhelp.Install is wired into the real root: the package's own
// tests only cover a synthetic tree.
func TestUsageErrorIsConciseOnRealTree(t *testing.T) {
	out, err := runRoot(t, "assignment", "add")
	if err == nil {
		t.Fatalf("a missing argument must fail:\n%s", out)
	}
	if !strings.Contains(out, "Run 'gh-teacher assignment add --help'") {
		t.Fatalf("usage error should point at --help:\n%s", out)
	}
	for _, unwanted := range []string{"Flags:", "--repo-visibility"} {
		if strings.Contains(out, unwanted) {
			t.Errorf("usage error should not dump flags (%q):\n%s", unwanted, out)
		}
	}
}

func TestGroupTypoFailsOnRealTree(t *testing.T) {
	out, err := runRoot(t, "assignment", "ad")
	if err == nil {
		t.Fatalf("a mistyped subcommand must fail, got exit 0 with:\n%s", out)
	}
	if code := cliutil.ExitCodeFor(err); code != 1 {
		t.Errorf("exit code = %d, want 1", code)
	}
	for _, want := range []string{`unknown command "ad" for "gh-teacher assignment"`, "Did you mean this?", "\tadd", "Available Commands:"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestGroupHelpOnRealTree(t *testing.T) {
	out, err := runRoot(t, "assignment", "--help")
	if err != nil {
		t.Fatalf("assignment --help failed: %v", err)
	}
	if strings.Contains(out, "gh-teacher assignment [flags]") {
		t.Errorf("group help must not show a [flags] usage line:\n%s", out)
	}
	if !strings.Contains(out, "gh-teacher assignment [command]") {
		t.Errorf("group help missing the [command] usage line:\n%s", out)
	}
}

func TestHelpRendersWrappedFlagsOnRealTree(t *testing.T) {
	out, err := runRoot(t, "assignment", "add", "--help")
	if err != nil {
		t.Fatalf("assignment add --help failed: %v", err)
	}
	for _, want := range []string{"Usage:", "Examples:", "Flags:", "--repo-visibility string", "Global Flags:", "--verbose",
		// Safety caveats live in Long, not in flag descriptions.
		"public repos are not autograded", "needs a paid GitHub plan", "--student-permission admin lets students change repo settings"} {
		if !strings.Contains(out, want) {
			t.Errorf("--help missing %q", want)
		}
	}
	for _, l := range strings.Split(out, "\n") {
		if len([]rune(l)) > ghhelp.MaxWrapWidth {
			t.Errorf("help line longer than %d columns: %q", ghhelp.MaxWrapWidth, l)
		}
	}
}

// Guards that ghcompletion.Install is wired into the real root, and before
// ghhelp.Install: swapping the two would let `completion powershell` print
// help and exit 0 instead of failing.
func TestCompletionOnRealTree(t *testing.T) {
	out, err := runRoot(t, "completion", "zsh")
	if err != nil {
		t.Fatalf("completion zsh failed: %v\n%s", err, out)
	}
	if !strings.HasPrefix(out, "# zsh completion for `gh teacher`") {
		t.Errorf("completion zsh must emit the gh teacher script, got:\n%.120s", out)
	}
	if out, err := runRoot(t, "completion", "powershell"); err == nil {
		t.Errorf("completion powershell must fail, got exit 0 with:\n%s", out)
	}
}
