#!/usr/bin/env python3
"""Sweep the web app source for i18n coverage problems against en.json.

This is the inverse of verify_locale.py: verify_locale.py checks a *translated
pack* against en.json, whereas this checks that the *source code* and en.json
agree. It is meant to be run over the whole codebase to answer "are we missing
any translation coverage?".

Run from the repo root (or anywhere -- it locates web/src relative to itself):

    python web/src/locales/audit_i18n.py            # human-readable report
    python web/src/locales/audit_i18n.py --strict   # also exit 1 on dead/hardcoded

It reports five independent things:

  1. MISSING keys  -- a t("...") / i18n.t("...") reference in code whose key is
     absent from en.json. These render as the raw key (or English fallback) and
     are always a bug. Fails the run (exit 1). Quoted, single-quoted, and
     no-interpolation backtick keys (t(`foo.bar`)) are all recognized, as are
     hyphenated segments and i18next namespaces (the "ns:" prefix is stripped
     before comparing, since en.json is flattened without it). A concatenated
     key (t("prefix." + x)) is treated as a dynamic prefix, not a missing key.

  2. DEAD keys     -- keys in en.json that no source string literal references,
     directly or indirectly. "Indirectly" matters: many keys are stored as bare
     string constants (labelKey/titleKey/what/why/...) and passed to t() later,
     so we count a key as used if its exact dotted string appears anywhere in the
     source, and also honour dynamic t(`prefix.${x}`) prefixes. Reported as a
     warning; only fails under --strict. Caveat: a dynamic t(`prefix.${x}`) marks
     the whole en.json subtree under `prefix` used, so neither DEAD nor MISSING
     holds inside a dynamically-addressed subtree (orgActivity.type.*,
     classes.filter.*, ...) -- an orphan there can't be flagged and a
     runtime-missing key falls back to English silently. DEAD is a lower bound.

  3. SPLIT keys    -- keys in en.json using the retired fragment convention
     (_prefix/_suffix/_middle/_from/_emphasis/_link/_1...) that stitched
     sentences together in JSX. Fragments force English word order onto every
     language and break RTL; sentences must be single keys with {{placeholders}}
     and <tag> markers (see TRANSLATION_PROMPT.md). i18next plural suffixes
     (_one/_other/...) are exempt. Always fails the run (exit 1) so the
     convention can't return. Scope caveat: the check matches the underscore
     naming only -- a camelCase lookalike (fooPrefix/fooSuffix) would evade
     it, so reviewers should treat any Prefix/Suffix key pair as a smell.

  4. PHYSICAL directional classes -- Tailwind utilities that pin a physical
     edge (ml-/pr-/left-/text-left/border-l/rounded-r...) and therefore don't
     mirror under dir="rtl". The codebase is fully converted to logical
     equivalents (ms-/me-/ps-/pe-/start-/end-/...); this line-based scan is the
     CI backstop behind the eslint no-restricted-syntax rule (see
     web/src/eslint/directionalClassRule.ts -- keep the two regexes in sync),
     catching what AST selectors can't: class recipes in plain .ts files and
     dynamic template chunks. A `physical-ok` comment on the line exempts a
     deliberate physical edge. Reported as a warning; fails under --strict.

  5. HARDCODED strings -- user-facing string literals that bypass i18n entirely
     (so no language pack can ever translate them). Heuristic; reported as a
     warning, only fails under --strict. Coverage is deliberately narrow -- green
     means "the covered shapes hardcode no prose", not "no hardcoded prose
     anywhere". Covered: double-quoted aria-label/alt/title/placeholder, and raw
     first-arg strings to toast()/setError()/failDeviceFlow(). NOT covered: JSX
     children text (<span>Hello</span>), brace/template-literal attributes
     (title={`...`}), single-quoted attributes, or prose through any other
     helper. Dev-only UI (HARDCODED_IGNORE_PREFIXES) and scoped format-hint
     values (HARDCODED_ALLOWED_VALUES) are exempt.

Exit code: 0 when clean (no MISSING/SPLIT, and under --strict no
DEAD/PHYSICAL/HARDCODED), else 1.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# --- locate web/src relative to this file (web/src/locales/audit_i18n.py) ---
LOCALES_DIR = Path(__file__).resolve().parent
SRC_DIR = LOCALES_DIR.parent
EN_FILE = LOCALES_DIR / "en.json"

# keep in sync with verify_locale.py
PLURAL_SUFFIXES = ("_zero", "_one", "_two", "_few", "_many", "_other")

# Legal characters in an i18next key: dotted segments, plus '-' (JSON keys allow
# hyphens) and ':' (the i18next namespace separator, e.g. "common:foo.bar").
_KEY_CHARS = r"[A-Za-z0-9_.:-]+"
# The translator call, matched for both quoted and backtick-static keys below.
# The (?<![.\w]) look-behind rejects any object method named `t` (e.g.
# `builder.t("a.b")`) so only a bare `t(` or `i18n.t(` translator call matches.
_T_CALL = r"(?<![.\w])(?:i18n\.)?t\("
# t("key") / t('key') / i18n.t("key") with a static dotted key.
STATIC_KEY_RE = re.compile(_T_CALL + r'\s*["\'](' + _KEY_CHARS + r')["\']')
# t(`key`) with a static dotted key and NO interpolation (a no-${} template
# literal is idiomatic i18next and must be caught by the MISSING gate too).
STATIC_BACKTICK_RE = re.compile(_T_CALL + r"\s*`(" + _KEY_CHARS + r")`")
# dynamic: t(`prefix.${...}`) -> record the literal prefix so we don't flag its keys
DYNAMIC_PREFIX_RE = re.compile(_T_CALL + r"\s*`([A-Za-z0-9_.]*)\$\{")
# any dotted string literal in source (catches labelKey/titleKey/what/why consts)
STRING_LITERAL_RE = re.compile(r'["\']([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)["\']')

# user-visible attributes whose literal (prose) values bypass i18n. The value
# is a single bounded run (no nested `[^"]*` quantifiers) with a letter required
# via a lookahead, so matching stays linear — the earlier `[^"]*X[^"]*` shape
# backtracked quadratically on a long unterminated attribute line.
ATTR_RE = re.compile(
    r'(?:aria-label|alt|title|placeholder)\s*=\s*"(?=[^"]*[A-Za-z]{2})([^"]{1,300})"'
)
# error/toast style calls taking a raw string first arg the user may see
USERFACING_CALL_RE = re.compile(
    r'\b(toast(?:\.\w+)?|setError|failDeviceFlow)\s*\(\s*"([^"]*[A-Za-z]{3}[^"]*)"'
)

# literals that look like code/config, not prose worth translating
CODEISH_RE = re.compile(r"^[a-z0-9]+(?:[-_/][a-z0-9]+)*$")  # ubuntu-latest, foo_bar

# The retired sentence-fragment suffixes (SPLIT check). Two shapes:
#  - underscore tails (_prefix/_suffix/.../_<digits> for numbered variants)
#  - camelCase tails (fooPrefix/fooSuffix) — the same disease with different
#    casing; they slipped the original underscore-only gate.
# camelCase Link/Emphasis tails stay legal (nav.allClassesLink is a whole
# label, not a fragment), as do plural _one/_other/... via the exact-name
# alternation. A leading lowercase run before the camel tail is required so a
# bare "prefix"/"suffix" leaf (e.g. a form label named exactly that) doesn't
# match — those aren't concat fragments.
SPLIT_SUFFIX_RE = re.compile(
    r"_(?:prefix|suffix|middle|from|emphasis|link|\d+)$"
    r"|[a-z0-9](?:Prefix|Suffix)(?:_(?:zero|one|two|few|many|other))?$"
)

# Physical directional Tailwind utilities (PHYSICAL check). Keep in sync with
# directionalClassPattern in web/src/eslint/directionalClassRule.ts -- same
# token shapes, Python syntax. A token starts the string, or follows
# whitespace, a quote/backtick (string openings), or a variant colon.
PHYSICAL_CLASS_RE = re.compile(
    r"""(?:^|[\s:"'`])-?(?:(?:scroll-)?[mp][lr]|left|right)-(?:\d|\[|auto|full|px)
      | (?:^|[\s:"'`])text-(?:left|right)(?![A-Za-z0-9_-])
      | (?:^|[\s:"'`])(?:border|rounded)-(?:[lr]|t[lr]|b[lr])(?![A-Za-z])
      | (?:^|[\s:"'`])(?:float|clear)-(?:left|right)(?![A-Za-z0-9_-])
    """,
    re.VERBOSE,
)

# Escape hatch for a deliberately physical edge (viewport-anchored chrome,
# animation sheens): a `physical-ok` comment on the same line skips the scan.
PHYSICAL_OK_MARKER = "physical-ok"

# Source path prefixes exempt from the HARDCODED scan: dev-only UI that never
# ships to end users (gated behind import.meta.env.DEV), so translating its
# labels would be dead weight. Relative to the repo root, matched with
# str.startswith on the rel() path (forward slashes).
HARDCODED_IGNORE_PREFIXES = ("web/src/components/dev/",)

# Specific literal values that are NOT translatable prose despite matching a
# user-facing-attribute pattern — a format example / code sample identical in
# every language. Each value is scoped to the one path prefix it's allowed in
# (byte-exact value match, str.startswith path match) so the exemption can't
# silently spread to other files. Keep this map tiny and justified; prefer i18n
# for real prose.
HARDCODED_ALLOWED_VALUES = {
    # GitHub PAT prefix shown as an input placeholder (a format hint), only in
    # the PAT sign-in prompt.
    "ghp_…": "web/src/auth/",
}


def is_allowed_hardcoded(val: str, relpath: str) -> bool:
    """True when `val` is an allowlisted non-prose literal in its scoped path."""
    prefix = HARDCODED_ALLOWED_VALUES.get(val)
    return prefix is not None and relpath.startswith(prefix)


def flatten(obj: dict, prefix: str = "") -> dict[str, object]:
    out: dict[str, object] = {}
    for key, value in obj.items():
        dotted = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(flatten(value, dotted))
        else:
            out[dotted] = value
    return out


def base_stem(key: str) -> str:
    for suffix in PLURAL_SUFFIXES:
        if key.endswith(suffix):
            return key[: -len(suffix)]
    return key


def strip_namespace(key: str) -> str:
    """Drop an i18next namespace prefix (`common:foo.bar` -> `foo.bar`).

    en.json is flattened without a namespace prefix, so a namespaced reference
    must be compared against the bare key. Only the first ':' separates the
    namespace; anything after is the key path.
    """
    return key.split(":", 1)[1] if ":" in key else key


def collect_static_key(raw: str, static_keys: set[str], dynamic_prefixes: set[str]) -> None:
    """Route a captured static-key token to the right bucket.

    A concatenated key like `t("prefix." + x)` captures the partial token
    `prefix.` (trailing dot). That is not a real key -- treat it as a dynamic
    prefix so it neither fires a spurious MISSING nor flags its own keys DEAD.
    """
    key = strip_namespace(raw)
    if key.endswith("."):
        dynamic_prefixes.add(key)
    else:
        static_keys.add(key)


SOURCE_SUFFIXES = ("ts", "tsx", "mts", "cts")
TEST_SUFFIXES = tuple(f".test.{ext}" for ext in SOURCE_SUFFIXES)


def iter_source_files() -> list[Path]:
    files: list[Path] = []
    # Glob per suffix so the filesystem walk prunes by name -- rglob("*") would
    # descend into (and stat) the whole node_modules tree before the guard below
    # could skip it.
    for path in (p for ext in SOURCE_SUFFIXES for p in SRC_DIR.rglob(f"*.{ext}")):
        if path.name.endswith(TEST_SUFFIXES):
            continue
        if "node_modules" in path.parts:
            continue
        files.append(path)
    return files


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(SRC_DIR.parent.parent))
    except ValueError:
        return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="also fail (exit 1) on dead keys, physical classes, and hardcoded strings",
    )
    args = parser.parse_args()

    if not EN_FILE.exists():
        print(f"error: {EN_FILE} not found", file=sys.stderr)
        return 2

    en = flatten(json.loads(EN_FILE.read_text(encoding="utf-8")))
    en_keys = set(en)

    static_keys: set[str] = set()
    dynamic_prefixes: set[str] = set()
    literal_strings: set[str] = set()
    hardcoded: list[tuple[str, int, str]] = []
    physical: list[tuple[str, int, str]] = []

    for path in iter_source_files():
        text = path.read_text(encoding="utf-8")
        relpath = rel(path)
        for m in STATIC_KEY_RE.finditer(text):
            collect_static_key(m.group(1), static_keys, dynamic_prefixes)
        for m in STATIC_BACKTICK_RE.finditer(text):
            collect_static_key(m.group(1), static_keys, dynamic_prefixes)
        for m in DYNAMIC_PREFIX_RE.finditer(text):
            if m.group(1):
                dynamic_prefixes.add(m.group(1))
        for m in STRING_LITERAL_RE.finditer(text):
            literal_strings.add(m.group(1))
        # Physical directional classes can hide in any string (class recipes in
        # .ts files, template chunks), so scan line-by-line over all source.
        for i, line in enumerate(text.splitlines(), 1):
            if PHYSICAL_OK_MARKER in line:
                continue
            m = PHYSICAL_CLASS_RE.search(line)
            if m:
                physical.append((relpath, i, m.group(0).strip()))
        # Hardcoded JSX-attribute prose can appear in any component-bearing file
        # (a .ts helper returning JSX via createElement, not just .tsx), so scan
        # every source file; ATTR_RE is specific enough that non-JSX files match
        # nothing.
        if relpath.startswith(HARDCODED_IGNORE_PREFIXES):
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for m in ATTR_RE.finditer(line):
                val = m.group(1).strip()
                if CODEISH_RE.match(val) or is_allowed_hardcoded(val, relpath):
                    continue
                hardcoded.append((relpath, i, val))
            for m in USERFACING_CALL_RE.finditer(line):
                val = m.group(2)
                # skip developer-only "must be used within" invariants
                if "must be used" in val or is_allowed_hardcoded(val, relpath):
                    continue
                hardcoded.append((relpath, i, val))

    # 1) MISSING: statically referenced but absent from en.json (allow plural base)
    missing = sorted(
        k
        for k in static_keys
        if k not in en_keys
        and not any(f"{k}{p}" in en_keys for p in PLURAL_SUFFIXES)
    )

    # 2) DEAD: en.json key whose stem/full form appears in no source literal and
    #    isn't covered by a dynamic prefix.
    def is_used(key: str) -> bool:
        stem = base_stem(key)
        if key in literal_strings or stem in literal_strings:
            return True
        if key in static_keys or stem in static_keys:
            return True
        return any(pfx and key.startswith(pfx) for pfx in dynamic_prefixes)

    dead = sorted(k for k in en_keys if not is_used(k))

    # 3) SPLIT: retired fragment-suffix keys (plural suffixes exempt via the
    #    regex requiring the exact retired names / digits).
    split = sorted(k for k in en_keys if SPLIT_SUFFIX_RE.search(k))

    # 4) PHYSICAL and 5) HARDCODED already collected
    physical.sort()
    hardcoded.sort()

    print(f"en.json flat keys:          {len(en_keys)}")
    print(f"static t() keys referenced: {len(static_keys)}")
    print(f"dynamic t(`prefix`) prefixes: {sorted(dynamic_prefixes) or '(none)'}")

    print(f"\n=== MISSING keys ({len(missing)}) — referenced in code, absent from en.json ===")
    for k in missing:
        print(f"  {k}")
    if not missing:
        print("  (none)")

    print(f"\n=== DEAD keys ({len(dead)}) — in en.json, no source reference found ===")
    for k in dead:
        print(f"  {k}")
    if not dead:
        print("  (none)")

    print(f"\n=== SPLIT keys ({len(split)}) — retired _prefix/_suffix fragment convention ===")
    for k in split:
        print(f"  {k}")
    if not split:
        print("  (none)")

    print(
        f"\n=== PHYSICAL directional classes ({len(physical)}) — don't mirror in RTL ==="
    )
    for p, i, s in physical:
        print(f"  {p}:{i}: {s!r}")
    if not physical:
        print("  (none)")
    else:
        print(
            "  (convert to the logical equivalent, or append a"
            " `physical-ok: <reason>` comment to exempt a deliberate edge)"
        )

    print(f"\n=== HARDCODED user-facing strings ({len(hardcoded)}) — bypass i18n ===")
    for p, i, s in hardcoded:
        print(f"  {p}:{i}: {s!r}")
    if not hardcoded:
        print("  (none)")

    failed = (
        bool(missing)
        or bool(split)
        or (args.strict and (dead or hardcoded or physical))
    )
    print("\nRESULT:", "FAIL" if failed else "PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
