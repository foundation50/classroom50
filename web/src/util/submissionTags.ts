// Authoring + matching helpers for an assignment's `submission_tags`: the
// teacher-named milestone tag patterns (e.g. phase1, phase2, complete) that
// trigger grading alongside the canonical submit/* namespace. Patterns are
// the supported subset of GitHub Actions tag filters — the same strings are
// rendered into the shim's `on.push.tags`, so this matcher and GitHub's own
// filter evaluation must agree on what fires:
//
//   - a literal name matches exactly (case-sensitive)
//   - `*`  matches zero or more characters, NOT crossing `/`
//   - `**` matches zero or more characters, crossing `/`
//   - `?`  matches zero or one of the PRECEDING character
//   - `+`  matches one or more of the preceding character
//   - `[abc]` / `[a-z]` character classes
//
// `!` negation and tags-ignore are deferred. Hand-mirrored with NO
// compile-time link from Go contract.MatchesSubmissionTag
// (cli/shared/contract/submissiontags.go) and the Python copies
// (autograde-runner.yaml read step, regrade_repos.py) — all pinned to
// identical output by cli/shared/testdata/submission_tag_match_cases.json.
// Validation mirrors gh-teacher's ValidateSubmissionTags.

export const SUBMISSION_TAGS_CAP = 20

// Charset for one pattern: the glob metacharacters GitHub filters need plus
// safe literal-name characters. Deliberately excludes `"` `\` whitespace and
// control characters — patterns are spliced into a quoted-YAML `tags:` line
// in the shim, so anything that could break that line is rejected at write
// time. Mirrors the Go validator and the schema items pattern.
export const SUBMISSION_TAG_PATTERN_RE = /^[A-Za-z0-9._/*?+[\]-]+$/

// A leading `?`/`+` (nothing to repeat) or a `+` stacked on another
// quantifier (`v*+`, `a++`): those translate to POSSESSIVE quantifiers,
// which Python 3.11+ compiles (and matches!) while Go RE2 and JS reject —
// the one construct where the four matcher copies would diverge. Rejected at
// write time and failed closed everywhere else. Mirrors Go
// contract.stackedQuantifierRE and the Python copies.
const STACKED_QUANTIFIER_RE = /^[?+]|[*?+]\+/

// isSafeSubmissionTagPattern mirrors Go contract.IsSafeSubmissionTagPattern:
// charset-safe for the quoted-YAML tags line AND compiles identically across
// the four matcher implementations. Render paths (shimTagsList copies) and
// the matcher fail closed on unsafe patterns.
export function isSafeSubmissionTagPattern(pattern: string): boolean {
  return (
    SUBMISSION_TAG_PATTERN_RE.test(pattern) &&
    !STACKED_QUANTIFIER_RE.test(pattern)
  )
}

// One pattern per line in the textarea; blank lines dropped, whitespace
// trimmed (unlike allowed_files, whitespace is never significant here — the
// charset forbids it). Tolerates undefined like submissionTagsToText does —
// callers hand it raw form values.
export function parseSubmissionTags(raw: string | undefined): string[] {
  return (raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

export function submissionTagsToText(patterns: string[] | undefined): string {
  return (patterns ?? []).join("\n")
}

// Mirror gh-teacher's ValidateSubmissionTags. Returns an error message, or
// undefined when valid. An empty list is valid (no milestone tags — the
// canonical submit/* namespace always works).
export function validateSubmissionTags(patterns: string[]): string | undefined {
  if (patterns.length > SUBMISSION_TAGS_CAP) {
    return `Too many tag patterns (${patterns.length}) — ${SUBMISSION_TAGS_CAP} max.`
  }
  const seen = new Set<string>()
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      return `"${pattern}": exclude patterns ("!") aren't supported.`
    }
    if (!SUBMISSION_TAG_PATTERN_RE.test(pattern)) {
      return `"${pattern}": tag patterns may only use letters, digits, . _ / - and the glob characters * ? + [ ].`
    }
    if (!isSafeSubmissionTagPattern(pattern)) {
      return `"${pattern}": ? and + repeat the preceding character and can't start a pattern or follow another glob character.`
    }
    if (seen.has(pattern)) {
      return `"${pattern}" is listed more than once.`
    }
    seen.add(pattern)
  }
  return undefined
}

// safeShimTagPatterns is the render-time gate for the two shim writers
// (autograderYaml.ts template, submissionTrigger.ts retrofit): the milestone
// patterns to splice into the quoted-YAML tags line, or [] when ANY pattern
// is unsafe or the list is over-cap. FAIL CLOSED all-or-nothing, mirroring Go
// contract.ShimTagsList: patterns are validated at write time, but the shim
// writers consume the PUBLISHED manifest, which is hand-editable — a
// partially-filtered list would silently grade a different tag set than
// configured, while dropping to the canonical submit/* alone keeps the
// failure visible and the workflow file well-formed.
export function safeShimTagPatterns(patterns: string[] | undefined): string[] {
  const list = patterns ?? []
  if (list.length > SUBMISSION_TAGS_CAP) return []
  return list.every(isSafeSubmissionTagPattern) ? list : []
}

// matchesSubmissionTag reports whether tag matches ANY of the patterns. An
// empty pattern list matches nothing.
export function matchesSubmissionTag(patterns: string[], tag: string): boolean {
  return patterns.some((pattern) => {
    // Unsafe patterns match nothing — fail closed. The explicit safety gate
    // (not just the compile failure) is what keeps the PYTHON mirror in
    // lockstep: a stacked quantifier like `v*+` compiles possessively there
    // and would match, so all four copies carry the same guard.
    if (!isSafeSubmissionTagPattern(pattern)) return false
    const re = compileTagPattern(pattern)
    return re !== null && re.test(tag)
  })
}

// Translate one Actions tag-filter pattern into an anchored RegExp,
// character by character so `.` and other regex metacharacters stay literal.
function compileTagPattern(pattern: string): RegExp | null {
  let out = "^"
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*" // ** crosses /
        i++
      } else {
        out += "[^/]*" // * stops at /
      }
    } else if (ch === "?" || ch === "+") {
      out += ch // zero-or-one / one-or-more of the preceding element
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1)
      if (close !== -1) {
        out += pattern.slice(i, close + 1) // character class verbatim
        i = close
      } else {
        out += "\\[" // unclosed [ is literal
      }
    } else {
      out += ch.replace(/[.\\^$()|{}]/g, "\\$&")
    }
  }
  out += "$"
  try {
    return new RegExp(out)
  } catch {
    return null
  }
}
