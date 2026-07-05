// Package autograder owns the embed-independent autograder-shim helpers: the
// in-repo path shape for a teacher-authored shim, the name validation guarding
// that path, and the write-time existence probe. The `gh teacher autograder`
// command stays in package main because it's pinned to the
// `//go:embed embed/autograder.py` asset; these helpers reference none of it.
package autograder

import (
	"fmt"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// defaultName is a sentinel meaning "use the universal shim embedded in
// gh-student" — no per-classroom shim file is required. Other names refer to a
// teacher-authored shim at `<classroom>/autograders/<name>.yaml`. Single-sourced
// in the shared contract.
const defaultName = contract.DefaultAutograderName

// FilePath: in-repo path for a non-default autograder shim. The "default"
// sentinel resolves to the embedded gh-student shim and never lands as a file.
func FilePath(classroom, name string) string {
	return classroom + "/autograders/" + name + ".yaml"
}

// ValidateName enforces ShortNamePattern on the value that becomes
// `<classroom>/autograders/<name>.yaml`, blocking traversal-style inputs.
func ValidateName(name string) error {
	if name == "" {
		return fmt.Errorf("--autograder must not be empty (default is %q)", defaultName)
	}
	return validate.ShortName(name, "autograder")
}

// Exists probes the contents API for the named autograder shim at `ref`,
// catching typo'd `--autograder` values at write time. 200 → true, 404 →
// false; other errors propagate. Callers SHOULD skip this for
// contract.DefaultAutograderName (no on-disk counterpart).
func Exists(client githubapi.Client, owner, repo, classroom, name, ref string) (bool, error) {
	return configrepo.ContentsExists(client, owner, repo, FilePath(classroom, name), ref)
}
