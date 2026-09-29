package ghcompletion

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/ghhelp"
)

// The test binary doubles as a fake gh so the shell tests need neither the
// real gh nor installed extensions. gh's completer is cobra-generated, so a
// cobra root named gh reproduces it faithfully, including the limitation
// under test: `gh __complete student ...` yields nothing for an extension.
const fakeGHEnv = "GHCOMPLETION_FAKE_GH"

func TestMain(m *testing.M) {
	if os.Getenv(fakeGHEnv) == "1" {
		os.Exit(runFakeGH(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func runFakeGH(args []string) int {
	root := fakeGHRoot()
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		return 1
	}
	return 0
}

func fakeGHRoot() *cobra.Command {
	root := &cobra.Command{Use: "gh", Short: "GitHub CLI"}
	root.CompletionOptions.DisableDefaultCmd = true

	pr := &cobra.Command{Use: "pr", Short: "Manage pull requests"}
	for _, name := range []string{"checkout", "checks", "list"} {
		pr.AddCommand(&cobra.Command{Use: name, Short: name + " a pull request", Run: func(*cobra.Command, []string) {}})
	}
	root.AddCommand(pr)

	// Extensions as gh registers them: flags unparsed, args passed through.
	for name, ext := range map[string]func() *cobra.Command{"student": fakeStudentRoot, "teacher": fakeTeacherRoot} {
		root.AddCommand(&cobra.Command{
			Use:                name,
			Short:              "Extension " + name,
			DisableFlagParsing: true,
			Args:               cobra.ArbitraryArgs,
			RunE: func(cmd *cobra.Command, args []string) error {
				c := ext()
				c.SetOut(cmd.OutOrStdout())
				c.SetErr(cmd.ErrOrStderr())
				c.SetArgs(args)
				return c.Execute()
			},
		})
	}

	var shell string
	completion := &cobra.Command{
		Use: "completion",
		RunE: func(cmd *cobra.Command, _ []string) error {
			w := cmd.OutOrStdout()
			switch shell {
			case "bash":
				return root.GenBashCompletionV2(w, true)
			case "zsh":
				return root.GenZshCompletion(w)
			case "fish":
				return root.GenFishCompletion(w, true)
			}
			return fmt.Errorf("unknown shell %q", shell)
		},
	}
	completion.Flags().StringVarP(&shell, "shell", "s", "", "Shell type")
	root.AddCommand(completion)
	return root
}

func fakeStudentRoot() *cobra.Command {
	root := &cobra.Command{Use: "gh-student", Short: "Student extension"}
	root.PersistentFlags().BoolP("verbose", "v", false, "Show operational details")
	accept := &cobra.Command{Use: "accept <url>", Short: "Accept an assignment", Run: func(*cobra.Command, []string) {}}
	accept.Flags().String("key", "", "Access key")
	accept.Flags().String("new-team", "", "Create a team")
	root.AddCommand(accept,
		&cobra.Command{Use: "submit", Short: "Submit the current assignment", Run: func(*cobra.Command, []string) {}},
		&cobra.Command{Use: "whoami", Short: "Print the authenticated user", Run: func(*cobra.Command, []string) {}},
	)
	Install(root, "student")
	ghhelp.Install(root)
	return root
}

func fakeTeacherRoot() *cobra.Command {
	root := &cobra.Command{Use: "gh-teacher", Short: "Teacher extension"}
	assignment := &cobra.Command{Use: "assignment", Short: "Manage assignments"}
	for _, name := range []string{"add", "list", "remove"} {
		assignment.AddCommand(&cobra.Command{Use: name, Short: name + " an assignment", Run: func(*cobra.Command, []string) {}})
	}
	root.AddCommand(assignment,
		&cobra.Command{Use: "init", Short: "Create a classroom", Run: func(*cobra.Command, []string) {}},
	)
	Install(root, "teacher")
	ghhelp.Install(root)
	return root
}

// testShells describes each shell under test: how to run it without rc
// files, the harness load modes for gh's completer, and the cobra-generated
// hook the template wraps plus the request line the rewrite relies on. The
// real gh must keep emitting those, and the fake gh must match, or the
// wrappers fall back to doing nothing at rc time.
var testShells = []struct {
	name           string
	args           []string
	loadModes      []string
	wraps, request string
}{
	{"bash", []string{"--noprofile", "--norc"}, []string{"eager", "loader", "none"},
		"__gh_get_completion_results", `requestComp="${words[0]} __complete ${args[*]}"`},
	{"zsh", []string{"-f"}, []string{"fpath", "none"},
		"_gh", `requestComp="${words[1]} __complete ${words[2,-1]}"`},
	{"fish", []string{"--no-config"}, []string{"autoload", "none"},
		"__gh_perform_completion", `$args[1] __complete $args[2..-1]`},
}

func shellArgs(t *testing.T, name string) []string {
	t.Helper()
	for _, sh := range testShells {
		if sh.name == name {
			return sh.args
		}
	}
	t.Fatalf("no testShells entry for %s", name)
	return nil
}

func TestScriptRendersForEachShell(t *testing.T) {
	if len(testShells) != len(shells) {
		t.Fatalf("testShells covers %d shells, package supports %d", len(testShells), len(shells))
	}
	for _, sh := range testShells {
		t.Run(sh.name, func(t *testing.T) {
			out, err := Script(sh.name, "student")
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"gh student __complete", "__gh_ext_student_prev", sh.wraps} {
				if !strings.Contains(out, want) {
					t.Errorf("%s script missing %q", sh.name, want)
				}
			}
			if strings.Contains(out, "{{") {
				t.Errorf("%s script has an unrendered template action", sh.name)
			}
		})
	}
}

// The templates hard-code cobra-internal names from gh's completer. The
// fake gh below reproduces them from this module's cobra; this checks the
// real gh still agrees, so a gh release on a restructured cobra fails here
// instead of silently disabling every wrapper.
func TestRealGHCompleterShape(t *testing.T) {
	gh, err := exec.LookPath("gh")
	if err != nil {
		skipOrFailInCI(t, "gh not installed")
	}
	for _, sh := range testShells {
		t.Run(sh.name, func(t *testing.T) {
			t.Parallel()
			out, err := exec.Command(gh, "completion", "-s", sh.name).Output()
			if err != nil {
				t.Fatalf("gh completion -s %s: %v", sh.name, err)
			}
			fake := runFake(t, "completion", "-s", sh.name)
			for _, w := range []string{sh.wraps, sh.request} {
				if !strings.Contains(string(out), w) {
					t.Errorf("real gh's %s completer no longer contains %q; the %s template wraps it", sh.name, w, sh.name)
				}
				if !strings.Contains(fake, w) {
					t.Errorf("fake gh's %s completer lacks %q; the shell tests would not exercise the wrapper", sh.name, w)
				}
			}
		})
	}
}

// A missing tool skips locally but fails in CI, so a runner-image change
// cannot quietly drop the shell coverage.
func skipOrFailInCI(t *testing.T, reason string) {
	t.Helper()
	if os.Getenv("CI") != "" {
		t.Fatalf("%s (required in CI)", reason)
	}
	t.Skip(reason)
}

func TestScriptRejectsBadInput(t *testing.T) {
	if _, err := Script("powershell", "student"); err == nil {
		t.Error("powershell must be rejected: its completer cannot be chained")
	}
	for _, name := range []string{"", "Student", "my ext", "-x", "a/b"} {
		if _, err := Script("zsh", name); err == nil {
			t.Errorf("extension %q must be rejected", name)
		}
	}
	out, err := Script("bash", "pr-comments")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "__gh_ext_pr_comments_exec() { gh pr-comments") {
		t.Errorf("hyphenated extension must map to an underscore identifier:\n%s", out)
	}
}

func TestInstallReplacesCobraDefault(t *testing.T) {
	root := fakeStudentRoot()
	var buf bytes.Buffer
	root.SetOut(&buf)
	root.SetErr(&buf)

	root.SetArgs([]string{"completion", "zsh"})
	if err := root.Execute(); err != nil {
		t.Fatalf("completion zsh: %v\n%s", err, buf.String())
	}
	if !strings.HasPrefix(buf.String(), "# zsh completion for `gh student`") {
		t.Errorf("completion zsh printed something else:\n%.200s", buf.String())
	}

	buf.Reset()
	root.SetArgs([]string{"completion", "powershell"})
	if err := root.Execute(); err == nil {
		t.Errorf("completion powershell must fail, got:\n%s", buf.String())
	}

	var names []string
	for _, c := range root.Commands() {
		if c.Name() == "completion" {
			for _, sub := range c.Commands() {
				names = append(names, sub.Name())
			}
		}
	}
	if got := strings.Join(names, " "); got != "bash fish zsh" {
		t.Errorf("completion subcommands = %q, want bash fish zsh", got)
	}
}

// The fake gh must reproduce the limitation the scripts work around, or the
// shell tests below would pass without exercising the wrapper.
func TestFakeGHDoesNotCompleteExtensionArgs(t *testing.T) {
	out := runFake(t, "__complete", "student", "sub")
	if strings.Contains(out, "submit") {
		t.Fatalf("fake gh completed into the extension; the real gh does not:\n%s", out)
	}
	out = runFake(t, "student", "__complete", "sub")
	if !strings.Contains(out, "submit") {
		t.Fatalf("extension's own __complete must work through gh dispatch:\n%s", out)
	}
}

func runFake(t *testing.T, args ...string) string {
	t.Helper()
	root := fakeGHRoot()
	var buf bytes.Buffer
	root.SetOut(&buf)
	root.SetErr(&buf)
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		t.Fatalf("fake gh %v: %v\n%s", args, err, buf.String())
	}
	return buf.String()
}

// shellCase describes one Tab press the harness scripts simulate and what
// the wrapped completer must offer.
type shellCase struct {
	id           string
	want         []string // every one must be offered
	wantExactly  string   // when set, the only completion
	wantNoneOf   []string
	needsTeacher bool // expectations hold only when the teacher script is loaded
}

var shellCases = []shellCase{
	{id: "student_root", want: []string{"accept", "submit", "whoami"}, wantNoneOf: []string{"<files>"}},
	{id: "student_prefix", wantExactly: "submit"},
	{id: "student_flags", want: []string{"--key", "--new-team", "--verbose"}},
	{id: "teacher_group", want: []string{"add", "list", "remove"}, needsTeacher: true},
	{id: "gh_own", want: []string{"checkout", "checks"}, wantNoneOf: []string{"list"}},
	{id: "gh_ext_name", wantExactly: "student"},
}

func TestShells(t *testing.T) {
	shims := installFakeGH(t)

	// Script load orders: alone, after another extension, re-sourced, and
	// re-sourced after the rc re-ran gh's own completion setup (--reload-gh
	// is a harness marker, not a script), which resets gh's hook.
	orders := [][]string{
		{"student"},
		{"teacher", "student"},
		{"student", "teacher", "student"},
		{"teacher", "student", "--reload-gh", "student", "teacher"},
	}

	for _, sh := range testShells {
		t.Run(sh.name, func(t *testing.T) {
			bin := lookPath(t, sh.name)
			for _, mode := range sh.loadModes {
				for _, order := range orders {
					name := mode + "/" + strings.Join(order, "+")
					t.Run(name, func(t *testing.T) {
						t.Parallel()
						out := runHarness(t, bin, sh.args, sh.name, mode, order, shims)
						assertCompletions(t, out, slices.Contains(order, "teacher"))
					})
				}
			}
		})
	}
}

func lookPath(t *testing.T, name string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the scripts target POSIX shells")
	}
	bin, err := exec.LookPath(name)
	if err != nil {
		skipOrFailInCI(t, name+" not installed")
	}
	return bin
}

// Stock macOS bash has no bash-completion package, and gh's completer
// cannot run without it. The wrapper must then register nothing rather
// than a completer whose every Tab fails.
func TestBashWithoutBashCompletionIsNoop(t *testing.T) {
	bin := lookPath(t, "bash")
	out := runHarness(t, bin, shellArgs(t, "bash"), "bash", "none-nocomp", []string{"student"}, installFakeGH(t))
	if strings.TrimSpace(out) != "registered\tno" {
		t.Fatalf("wrapper must not register a gh completer without bash-completion, got:\n%s", out)
	}
}

// installFakeGH puts a `gh` shim that re-executes this test binary as the
// fake gh on PATH and returns the directory holding it.
func installFakeGH(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	shim := "#!/bin/sh\n" + fakeGHEnv + "=1 exec " + shellQuote(exe) + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func runHarness(t *testing.T, bin string, shellArgs []string, shell, loadMode string, order []string, shims string) string {
	t.Helper()
	tmp := t.TempDir()
	var scripts []string
	for _, ext := range order {
		if strings.HasPrefix(ext, "--") {
			scripts = append(scripts, ext) // harness marker, passed through
			continue
		}
		script, err := Script(shell, ext)
		if err != nil {
			t.Fatal(err)
		}
		// Same script twice must be the same file, as a user's rc would have.
		p := filepath.Join(tmp, ext+"."+shell)
		if err := os.WriteFile(p, []byte(script), 0o644); err != nil {
			t.Fatal(err)
		}
		scripts = append(scripts, p)
	}
	harness, err := filepath.Abs(filepath.Join("testdata", "harness."+shell))
	if err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(bin, slices.Concat(shellArgs, []string{harness}, scripts)...)
	cmd.Dir = tmp // fish file completion must not pick up repo files
	cmd.Env = []string{
		"PATH=" + shims + string(os.PathListSeparator) + os.Getenv("PATH"),
		"HOME=" + tmp,
		"XDG_CONFIG_HOME=" + filepath.Join(tmp, "xdg"),
		"HARNESS_TMP=" + tmp,
		"HARNESS_LOAD=" + loadMode,
		"TERM=dumb",
		"LANG=C",
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s harness failed: %v\n%s", shell, err, out)
	}
	return string(out)
}

func assertCompletions(t *testing.T, out string, teacherLoaded bool) {
	t.Helper()
	got := map[string][]string{}
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		id, rest, ok := strings.Cut(line, "\t")
		if !ok {
			t.Fatalf("harness printed a non-result line: %q\n%s", line, out)
		}
		got[id] = strings.Fields(rest)
	}
	for _, c := range shellCases {
		words, ok := got[c.id]
		if !ok {
			t.Errorf("case %s missing from harness output:\n%s", c.id, out)
			continue
		}
		if c.needsTeacher && !teacherLoaded {
			if slices.Contains(words, c.want[0]) {
				t.Errorf("%s: teacher script not loaded but got %v", c.id, words)
			}
			continue
		}
		if c.wantExactly != "" && (len(words) != 1 || words[0] != c.wantExactly) {
			t.Errorf("%s: got %v, want exactly [%s]", c.id, words, c.wantExactly)
		}
		for _, w := range c.want {
			if !slices.Contains(words, w) {
				t.Errorf("%s: got %v, missing %q", c.id, words, w)
			}
		}
		for _, w := range c.wantNoneOf {
			if slices.Contains(words, w) {
				t.Errorf("%s: got %v, must not include %q", c.id, words, w)
			}
		}
	}
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
