package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/ghhelp"
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
	out, err := runRoot(t, "accept")
	if err == nil {
		t.Fatalf("a missing argument must fail:\n%s", out)
	}
	if !strings.Contains(out, "Run 'gh-student accept --help'") {
		t.Fatalf("usage error should point at --help:\n%s", out)
	}
	for _, unwanted := range []string{"Flags:", "--new-team"} {
		if strings.Contains(out, unwanted) {
			t.Errorf("usage error should not dump flags (%q):\n%s", unwanted, out)
		}
	}
}

func TestGroupTypoFailsOnRealTree(t *testing.T) {
	out, err := runRoot(t, "team", "lst")
	if err == nil {
		t.Fatalf("a mistyped subcommand must fail, got exit 0 with:\n%s", out)
	}
	for _, want := range []string{`unknown command "lst" for "gh-student team"`, "Did you mean this?", "\tlist", "Available Commands:"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestGroupHelpOnRealTree(t *testing.T) {
	out, err := runRoot(t, "team", "--help")
	if err != nil {
		t.Fatalf("team --help failed: %v", err)
	}
	if strings.Contains(out, "gh-student team [flags]") {
		t.Errorf("group help must not show a [flags] usage line:\n%s", out)
	}
	if !strings.Contains(out, "gh-student team [command]") {
		t.Errorf("group help missing the [command] usage line:\n%s", out)
	}
}

func TestHelpRendersWrappedFlagsOnRealTree(t *testing.T) {
	out, err := runRoot(t, "accept", "--help")
	if err != nil {
		t.Fatalf("accept --help failed: %v", err)
	}
	for _, want := range []string{"Usage:", "Flags:", "--new-team", "Global Flags:", "--verbose"} {
		if !strings.Contains(out, want) {
			t.Errorf("--help missing %q", want)
		}
	}
	// --team-name has the longest description; it must wrap rather than
	// render as one line at the cap.
	if strings.Contains(out, `--new-team, for example "The Sharks"`) {
		t.Errorf("--team-name description was not wrapped:\n%s", out)
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
	if !strings.HasPrefix(out, "# zsh completion for `gh student`") {
		t.Errorf("completion zsh must emit the gh student script, got:\n%.120s", out)
	}
	if out, err := runRoot(t, "completion", "powershell"); err == nil {
		t.Errorf("completion powershell must fail, got exit 0 with:\n%s", out)
	}
}
