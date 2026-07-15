package reponame

import "testing"

// reponame delegates to cli/shared/contract; these pin the gh-student-facing API
// so a refactor of the delegation can't silently change the repo-name shape that
// `gh student accept` and group-membership owner recovery depend on.
func TestName(t *testing.T) {
	if got := Name("CS101", "HW1", "Alice"); got != "cs101-hw1-alice" {
		t.Errorf("Name = %q, want %q", got, "cs101-hw1-alice")
	}
}

func TestPrefix(t *testing.T) {
	if got := Prefix("CS101", "HW1"); got != "cs101-hw1-" {
		t.Errorf("Prefix = %q, want %q", got, "cs101-hw1-")
	}
}

// Name must equal Prefix + lowercased username so the owner is recoverable by
// stripping the prefix (the group-membership consumer relies on this).
func TestNameIsPrefixPlusOwner(t *testing.T) {
	prefix := Prefix("cs101", "hw1")
	name := Name("cs101", "hw1", "Bob")
	if name != prefix+"bob" {
		t.Errorf("Name = %q, want %q", name, prefix+"bob")
	}
}
