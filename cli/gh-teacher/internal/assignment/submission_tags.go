package assignment

import (
	"fmt"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// submission_tags validation: the writer-side gate for teacher-named
// milestone tag patterns (see the assignments-v1 schema description). The
// values are rendered verbatim into the shim's quoted-YAML `on.push.tags`
// line AND compiled by the shared matcher (contract.MatchesSubmissionTag and
// its web/Python mirrors), so both rules live in the shared contract package
// (charset + no stacked quantifiers — see contract.IsSafeSubmissionTagPattern
// for why stacked quantifiers are the one cross-language divergence risk).
// This wrapper only adds the human-facing error messages. Keep the constants
// in lockstep with the schema's submission_tags maxItems/items.pattern and
// the web SUBMISSION_TAGS_CAP / SUBMISSION_TAG_PATTERN_RE
// (web/src/util/submissionTags.ts) — parity-pinned by
// TestSubmissionTagsSchemaParity.

// SubmissionTagsCap is the maximum number of milestone tag patterns.
// Single-sourced in the shared contract package.
const SubmissionTagsCap = contract.SubmissionTagsCap

// ValidateSubmissionTags accepts an empty list (no milestone tags — the
// canonical submit/* namespace always triggers) or up to SubmissionTagsCap
// unique, charset-safe patterns. `!` excludes are rejected: tags-ignore is
// deferred, and a silently-dropped exclude would grade tags the teacher
// meant to exclude. A quantifier with nothing to repeat (leading `?`/`+`, or
// `+` stacked on another quantifier like `v*+`) is rejected because the four
// matcher implementations would disagree on it (possessive quantifier in
// Python, compile error in Go/JS).
func ValidateSubmissionTags(patterns []string) error {
	if len(patterns) > SubmissionTagsCap {
		return fmt.Errorf("too many submission_tags patterns (%d): %d max", len(patterns), SubmissionTagsCap)
	}
	seen := make(map[string]struct{}, len(patterns))
	for _, pattern := range patterns {
		if strings.HasPrefix(pattern, "!") {
			return fmt.Errorf("invalid submission_tags pattern %q: exclude patterns (\"!\") are not supported", pattern)
		}
		if !contract.SubmissionTagCharsetRE.MatchString(pattern) {
			return fmt.Errorf("invalid submission_tags pattern %q: only letters, digits, . _ / - and the glob characters * ? + [ ] are allowed", pattern)
		}
		if !contract.IsSafeSubmissionTagPattern(pattern) {
			return fmt.Errorf("invalid submission_tags pattern %q: `?` and `+` repeat the preceding character and cannot start a pattern or follow another glob quantifier", pattern)
		}
		if _, dup := seen[pattern]; dup {
			return fmt.Errorf("submission_tags pattern %q is listed more than once", pattern)
		}
		seen[pattern] = struct{}{}
	}
	return nil
}
