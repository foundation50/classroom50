package contract

import (
	"regexp"
	"strings"
)

// Submission-tag pattern matching: the supported subset of GitHub Actions
// tag-filter patterns (the strings assignments.json's submission_tags carries
// are rendered verbatim into the shim's `on.push.tags`, so this matcher and
// GitHub's own filter evaluation MUST agree on what fires):
//
//   - a literal name matches exactly (case-sensitive)
//   - `*`  matches zero or more characters, NOT crossing `/`
//   - `**` matches zero or more characters, crossing `/`
//   - `?`  matches zero or one of the PRECEDING character
//   - `+`  matches one or more of the preceding character
//   - `[abc]` / `[a-z]` character classes
//
// `!` negation and tags-ignore are deferred (writers reject them; see
// ValidateSubmissionTags in gh-teacher's assignment package).
//
// Hand-mirrored with NO compile-time link in the web
// (web/src/util/submissionTags.ts) and Python (autograde-runner.yaml read
// step, regrade_repos.py) — all four pinned to identical output by the shared
// golden fixture cli/shared/testdata/submission_tag_match_cases.json.

// SubmissionTagsCap is the maximum number of milestone tag patterns.
const SubmissionTagsCap = 20

// SubmissionTagCharsetRE is the per-pattern charset: literal-name characters
// plus the glob metacharacters GitHub Actions tag filters support
// (* ? + [ ]). Deliberately excludes quotes, backslashes, whitespace, and
// control characters — patterns are spliced into the shim's quoted-YAML
// `tags:` line, so anything that could break out of that string context is
// rejected. Mirrors the schema items.pattern byte-for-byte (modulo JSON
// escaping) and the web SUBMISSION_TAG_PATTERN_RE — parity-pinned by
// TestSubmissionTagsSchemaParity and the web vitest.
var SubmissionTagCharsetRE = regexp.MustCompile(`^[A-Za-z0-9._/*?+\[\]-]+$`)

// stackedQuantifierRE rejects a leading `?`/`+` (no literal to repeat) and —
// the load-bearing case — a `+` immediately following another quantifier
// (`v*+`, `a++`, `x?+`). Those translate to POSSESSIVE quantifiers, which
// Python 3.11+ compiles (and matches!) while Go RE2 and JS reject — the one
// construct where the four matcher copies would otherwise diverge. JSON
// Schema keeps the charset-only items.pattern (Go RE2 can't compile the
// lookahead an ECMA equivalent would need), so this rule is validator- and
// matcher-enforced. Keep the literal in lockstep with the web and Python
// copies (util/submissionTags.ts, autograde-runner.yaml read step,
// regrade_repos.py).
var stackedQuantifierRE = regexp.MustCompile(`^[?+]|[*?+]\+`)

// IsSafeSubmissionTagPattern reports whether one milestone tag pattern is
// safe to render into the shim's quoted-YAML tags line AND compiles
// identically across the four matcher implementations. The write-side
// validators reject unsafe patterns with a friendly message; the render and
// match paths fail closed on them (defense-in-depth against a hand-edited
// published manifest that bypassed write validation).
func IsSafeSubmissionTagPattern(pattern string) bool {
	return SubmissionTagCharsetRE.MatchString(pattern) && !stackedQuantifierRE.MatchString(pattern)
}

// ShimTagsList renders the YAML flow sequence for the shim's
// `on.push.tags:` line: the configured milestone patterns (if any) UNION the
// always-on canonical submit/* namespace. No patterns -> `"submit/*"` alone,
// byte-identical to the pre-submission_tags shim.
//
// FAIL CLOSED: patterns are charset-validated at write time, but this is the
// render chokepoint for workflow files committed into student repos, so the
// manifest is not trusted here — any unsafe pattern (or an over-cap list)
// drops the ENTIRE milestone set and renders the canonical `"submit/*"`
// alone. A partially-filtered list would silently grade a different tag set
// than the teacher configured; all-or-nothing keeps the failure visible.
// Byte-format mirrored in the web's safeShimTagPatterns/shimTagsList
// (web/src/util/submissionTags.ts and its two call sites) — keep identical.
func ShimTagsList(patterns []string) string {
	safe := len(patterns) <= SubmissionTagsCap
	if safe {
		for _, p := range patterns {
			if !IsSafeSubmissionTagPattern(p) {
				safe = false
				break
			}
		}
	}
	if !safe {
		patterns = nil
	}
	parts := make([]string, 0, len(patterns)+1)
	for _, p := range patterns {
		parts = append(parts, `"`+p+`"`)
	}
	parts = append(parts, `"`+SubmitTagPrefix+`*"`)
	return strings.Join(parts, ", ")
}

// MatchesSubmissionTag reports whether tag matches ANY of the patterns. An
// empty pattern list matches nothing.
func MatchesSubmissionTag(patterns []string, tag string) bool {
	for _, pattern := range patterns {
		// Unsafe patterns match nothing — fail closed. The explicit
		// IsSafeSubmissionTagPattern gate (not just the compile error) is
		// load-bearing in the PYTHON mirror, where a stacked quantifier like
		// `v*+` compiles as a possessive quantifier and would MATCH; all
		// four copies carry the same guard so they cannot diverge.
		if !IsSafeSubmissionTagPattern(pattern) {
			continue
		}
		re, err := compileTagPattern(pattern)
		if err != nil {
			continue
		}
		if re.MatchString(tag) {
			return true
		}
	}
	return false
}

// compileTagPattern translates one Actions tag-filter pattern into an
// anchored regexp. Character-by-character so `.` and other regex
// metacharacters in the pattern stay literal.
func compileTagPattern(pattern string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	runes := []rune(pattern)
	for i := 0; i < len(runes); i++ {
		switch r := runes[i]; r {
		case '*':
			if i+1 < len(runes) && runes[i+1] == '*' {
				b.WriteString(".*") // ** crosses /
				i++
			} else {
				b.WriteString("[^/]*") // * stops at /
			}
		case '?':
			b.WriteString("?")
		case '+':
			b.WriteString("+")
		case '[':
			// Pass a character class through verbatim up to the closing ].
			j := i + 1
			for j < len(runes) && runes[j] != ']' {
				j++
			}
			if j < len(runes) {
				b.WriteString(string(runes[i : j+1]))
				i = j
			} else {
				b.WriteString(regexp.QuoteMeta(string(r))) // unclosed [ is literal
			}
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}
