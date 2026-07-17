#!/usr/bin/env python3
"""Verify a translated language pack against the base en.json.

Fails loudly on any dropped/added/renamed key, non-string leaf value,
placeholder mismatch, or markup-marker mismatch. Run from the src/locales
folder:

    python verify_locale.py <CODE>.json      # e.g. python verify_locale.py de.json

Exit code is 0 on PASS and 1 on FAIL, so it can gate CI or a shipping step.
"""

import json
import re
import sys
from pathlib import Path

BASE_FILE = "en.json"
# keep in sync with audit_i18n.py
PLURAL_SUFFIXES = ("_zero", "_one", "_two", "_few", "_many", "_other")


def flatten(obj, prefix=""):
    """Flatten nested dicts to dotted keys, matching the app's internal shape."""
    out = {}
    for key, value in obj.items():
        dotted = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(flatten(value, dotted))
        else:
            out[dotted] = value
    return out


def placeholders(value):
    """Sorted list of {{...}} placeholders in a string (empty for non-strings)."""
    if not isinstance(value, str):
        return []
    return sorted(re.findall(r"\{\{.*?\}\}", value))


def markup_markers(value):
    """Sorted list of <tag>/</tag>/<tag/> markers in a string (empty for non-strings).

    These are react-i18next <Trans> component tags (e.g. <repo>{{repo}}</repo>)
    that translations must carry over verbatim. The tag name must start with a
    letter so non-markup angle-bracket text like "<1 day" or the literal
    "<owner>/<repo>" placeholder hint still compare as-is between packs without
    false positives on digits.
    """
    if not isinstance(value, str):
        return []
    return sorted(re.findall(r"</?[a-zA-Z]\w*\s*/?>", value))


def is_allowed_plural_variant(key, base_keys):
    """Allow extra keys only when they are i18next plural variants of a base key."""
    if not any(key.endswith(suffix) for suffix in PLURAL_SUFFIXES):
        return False
    stem = key.rsplit("_", 1)[0]
    return any(f"{stem}_{p}" in base_keys for p in ("one", "other"))


def main():
    if len(sys.argv) != 2:
        print("usage: python verify_locale.py <CODE>.json", file=sys.stderr)
        return 2

    base_path = Path(BASE_FILE)
    trans_path = Path(sys.argv[1])
    if not base_path.exists():
        print(f"error: base file {BASE_FILE} not found (run from src/locales)", file=sys.stderr)
        return 2
    if not trans_path.exists():
        print(f"error: translation file {trans_path} not found", file=sys.stderr)
        return 2

    base = flatten(json.loads(base_path.read_text(encoding="utf-8")))
    trans = flatten(json.loads(trans_path.read_text(encoding="utf-8")))

    base_keys, trans_keys = set(base), set(trans)

    missing = sorted(base_keys - trans_keys)
    extra = sorted(
        k for k in (trans_keys - base_keys) if not is_allowed_plural_variant(k, base_keys)
    )
    bad_type = sorted(k for k, v in trans.items() if not isinstance(v, str))

    ph_mismatch = []
    mk_mismatch = []
    for key in sorted(base_keys & trans_keys):
        if placeholders(base[key]) != placeholders(trans[key]):
            ph_mismatch.append((key, placeholders(base[key]), placeholders(trans[key])))
        if markup_markers(base[key]) != markup_markers(trans[key]):
            mk_mismatch.append((key, markup_markers(base[key]), markup_markers(trans[key])))

    passed = not (missing or extra or bad_type or ph_mismatch or mk_mismatch)

    print(f"base keys: {len(base_keys)} | translated keys: {len(trans_keys)}")
    print(f"MISSING keys ({len(missing)}): {missing or '(none)'}")
    print(f"UNEXPECTED extra keys ({len(extra)}): {extra or '(none)'}")
    print(f"NON-STRING values ({len(bad_type)}): {bad_type or '(none)'}")
    print(f"PLACEHOLDER mismatches ({len(ph_mismatch)}):")
    for key, base_ph, trans_ph in ph_mismatch:
        print(f"  {key}: base={base_ph} translated={trans_ph}")
    if not ph_mismatch:
        print("  (none)")
    print(f"MARKUP mismatches ({len(mk_mismatch)}):")
    for key, base_mk, trans_mk in mk_mismatch:
        print(f"  {key}: base={base_mk} translated={trans_mk}")
    if not mk_mismatch:
        print("  (none)")

    print("\nRESULT:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
