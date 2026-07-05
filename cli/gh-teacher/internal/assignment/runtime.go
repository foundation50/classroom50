package assignment

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

// RunsOnLabelPattern and the *Pattern regexes below are exported only for the
// regex-parity test (init_skeleton_test.go), which asserts they match the
// inline-Python validator in autograde-runner.yaml. Production callers must NOT
// match these directly — go through ValidateRuntime / ValidateContainer, the
// trust boundary.
//
// RunsOnLabelPattern bounds each `runtime.runs-on` label. No value allow-list —
// the teacher owns the label; the pattern is purely an anti-injection gate
// (alphanumerics plus `-_.`, leading alnum, length-capped) since the label
// flows verbatim into the workflow's `runs-on:`.
var RunsOnLabelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// LanguageVersionPattern: shared shape for python/node/java/go versions.
// Permissive (`3.12`, `20`, `1.23.4`, `latest`) but injection-safe.
var LanguageVersionPattern = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,32}$`)

// AptPackagePattern matches Debian/Ubuntu package naming. Each `runtime.apt`
// entry flows into `apt-get install` unquoted, so this is a hard gate.
var AptPackagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.+-]{0,63}$`)

// ContainerImagePattern is intentionally permissive (the image-ref grammar is
// wide); the check is anti-injection, not syntactic — reject whitespace,
// quotes, backticks, `$`, `;`, `&`, `|`, control chars. Actions parses the rest.
var ContainerImagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$`)

// ContainerUserPattern accepts what `docker run --user` accepts ("root", "0",
// "1000:1000", "appuser:appgroup"). It flows into `container.options: --user
// <value>`, so it must be tight enough that nothing escapes into adjacent
// options.
var ContainerUserPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$`)

// ParseRuntimeFile loads `--runtime <path>` (or `-` for stdin) and validates
// it. Empty path → no override (Runtime stays nil, runner uses defaults).
// DisallowUnknownFields so a typo'd key fails loudly.
func ParseRuntimeFile(path string) (*RuntimeRef, error) {
	return parseRuntimeFileFrom(path, os.Stdin)
}

// parseRuntimeFileFrom is the testable seam for ParseRuntimeFile (injectable
// stdin for the `-` path).
func parseRuntimeFileFrom(path string, stdin io.Reader) (*RuntimeRef, error) {
	if path == "" {
		return nil, nil
	}
	var (
		data  []byte
		err   error
		label string
	)
	if path == "-" {
		data, err = io.ReadAll(stdin)
		label = "<stdin>"
	} else {
		data, err = os.ReadFile(path)
		label = path
	}
	if err != nil {
		return nil, fmt.Errorf("read --runtime %s: %w", label, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, fmt.Errorf("--runtime %s is empty", label)
	}
	var r RuntimeRef
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return nil, fmt.Errorf("parse --runtime %s: %w", label, err)
	}
	if err := expectEOF(dec); err != nil {
		return nil, fmt.Errorf("parse --runtime %s: %w", label, err)
	}
	if err := ValidateRuntime(r); err != nil {
		return nil, fmt.Errorf("--runtime %s: %w", label, err)
	}
	return &r, nil
}

// ValidateRuntime is the structural bar for RuntimeRef, run on both the write
// and parse paths so a hand-edited assignments.json can't smuggle a value the
// CLI would reject at write time.
func ValidateRuntime(r RuntimeRef) error {
	if err := ValidateRunsOn(r.RunsOn); err != nil {
		return err
	}
	if r.Container != nil {
		// GitHub-hosted containers run on Ubuntu only, so reject a recognized
		// macOS/Windows hosted label (a custom label passes — the teacher owns
		// OS matching). Apt is forbidden — the image owns its packages.
		for _, label := range r.RunsOn {
			if isNonUbuntuHostedLabel(label) {
				return fmt.Errorf("runtime.runs-on %q invalid with container: GitHub Actions runs containers on Ubuntu hosts only", label)
			}
		}
		if len(r.Apt) > 0 {
			return errors.New("runtime.apt is not allowed when runtime.container is set: install packages in the container image instead")
		}
		if err := ValidateContainer(*r.Container); err != nil {
			return err
		}
	}

	for _, pair := range []struct{ field, value string }{
		{"runtime.python", r.Python},
		{"runtime.node", r.Node},
		{"runtime.java", r.Java},
		{"runtime.go", r.Go},
	} {
		if pair.value == "" {
			continue
		}
		if !LanguageVersionPattern.MatchString(pair.value) {
			return fmt.Errorf("%s %q must match %s (e.g. \"3.12\", \"20\", \"1.23.4\")", pair.field, pair.value, LanguageVersionPattern.String())
		}
	}

	for i, pkg := range r.Apt {
		if !AptPackagePattern.MatchString(pkg) {
			return fmt.Errorf("runtime.apt[%d] %q must match %s (lowercase Debian package name)", i, pkg, AptPackagePattern.String())
		}
	}
	return nil
}

// ValidateRunsOn injection-checks each label and caps the count. An empty
// RunsOn is valid (omitted → runner defaults to ubuntu-latest); the degenerate
// "" and [] forms are rejected earlier by RunsOn.UnmarshalJSON.
func ValidateRunsOn(r RunsOn) error {
	if len(r) == 0 {
		return nil
	}
	if len(r) > 10 {
		return fmt.Errorf("runtime.runs-on has %d labels (max 10)", len(r))
	}
	for i, label := range r {
		if !RunsOnLabelPattern.MatchString(label) {
			return fmt.Errorf("runtime.runs-on[%d] %q must match %s (a GitHub runner label: alphanumerics plus '._-', no whitespace or metacharacters)", i, label, RunsOnLabelPattern.String())
		}
	}
	return nil
}

// isNonUbuntuHostedLabel reports whether label is a recognized GitHub-hosted
// macOS/Windows label — the only labels we know won't run a Linux container.
// Custom/self-hosted labels are unknown, so they pass.
func isNonUbuntuHostedLabel(label string) bool {
	return strings.HasPrefix(label, "macos-") || strings.HasPrefix(label, "windows-")
}

// ValidateContainer enforces image-string sanity and the `user` shortcut.
// Image is regex-checked (permissive but injection-safe); user must match
// `docker run --user` grammar. Only publicly-pullable images are supported.
func ValidateContainer(c ContainerSpec) error {
	if c.Image == "" {
		return errors.New("runtime.container.image must not be empty")
	}
	if !ContainerImagePattern.MatchString(c.Image) {
		return fmt.Errorf("runtime.container.image %q contains characters other than [A-Za-z0-9._:/@+-]", c.Image)
	}
	if c.User != "" && !ContainerUserPattern.MatchString(c.User) {
		return fmt.Errorf("runtime.container.user %q must match %s (e.g. \"root\", \"0\", \"1000:1000\")", c.User, ContainerUserPattern.String())
	}
	return nil
}
