#!/usr/bin/env python3
"""Sweep the web app source for i18n coverage problems against en.json.

This is the inverse of verify_locale.py: verify_locale.py checks a *translated
pack* against en.json, whereas this checks that the *source code* and en.json
agree. It is meant to be run over the whole codebase to answer "are we missing
any translation coverage?".

Run from the repo root (or anywhere -- it locates web/src relative to itself):

    python web/src/locales/audit_i18n.py            # human-readable report
    python web/src/locales/audit_i18n.py --strict   # also exit 1 on dead/hardcoded

It reports three independent things:

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
     warning; only fails under --strict.

  3. HARDCODED strings -- user-facing string literals that bypass i18n entirely
     (so no language pack can ever translate them): prose in translatable JSX
     attributes (aria-label/alt/title/placeholder) and plain-string error/toast
     calls. Heuristic; reported as a warning, only fails under --strict.

Exit code: 0 when clean (no MISSING, and under --strict no DEAD/HARDCODED), else 1.
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

# user-visible attributes whose literal (prose) values bypass i18n
ATTR_RE = re.compile(
    r'(?:aria-label|alt|title|placeholder)\s*=\s*"([^"]*[A-Za-z]{2}[^"]*)"'
)
# error/toast style calls taking a raw string first arg the user may see
USERFACING_CALL_RE = re.compile(
    r'\b(toast(?:\.\w+)?|setError|failDeviceFlow)\s*\(\s*"([^"]*[A-Za-z]{3}[^"]*)"'
)

# literals that look like code/config, not prose worth translating
CODEISH_RE = re.compile(r"^[a-z0-9]+(?:[-_/][a-z0-9]+)*$")  # ubuntu-latest, foo_bar


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
        help="also fail (exit 1) on dead keys and hardcoded strings",
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
        # Hardcoded JSX-attribute prose can appear in any component-bearing file
        # (a .ts helper returning JSX via createElement, not just .tsx), so scan
        # every source file; ATTR_RE is specific enough that non-JSX files match
        # nothing.
        for i, line in enumerate(text.splitlines(), 1):
            for m in ATTR_RE.finditer(line):
                val = m.group(1).strip()
                if CODEISH_RE.match(val):
                    continue
                hardcoded.append((relpath, i, val))
            for m in USERFACING_CALL_RE.finditer(line):
                val = m.group(2)
                # skip developer-only "must be used within" invariants
                if "must be used" in val:
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

    # 3) HARDCODED already collected
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

    print(f"\n=== HARDCODED user-facing strings ({len(hardcoded)}) — bypass i18n ===")
    for p, i, s in hardcoded:
        print(f"  {p}:{i}: {s!r}")
    if not hardcoded:
        print("  (none)")

    failed = bool(missing) or (args.strict and (dead or hardcoded))
    print("\nRESULT:", "FAIL" if failed else "PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
