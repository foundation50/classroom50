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


# A tag is a bare marker iff it is exactly </?name/?> (optional leading slash,
# optional self-closing slash). Anything else carries attributes.
_TAG_RE = re.compile(r"<[^>]*>")
_BARE_MARKER_RE = re.compile(r"^</?[a-zA-Z]\w*\s*/?>$")


def attribute_markers(value):
    """Tags in a string that carry attributes (i.e. are not bare markers).

    Mirrors customLocale.ts's runtime pack-ingest guard: react-i18next's <Trans>
    merges a marker tag's attributes onto the mapped component (pack side wins),
    so an attribute-bearing tag like <a href="…"> could repoint a trusted link.
    The contract is bare markers only; a slash-separated form (<repoLink/ href=…>)
    that the parser still reads as an attribute is caught here too.
    """
    if not isinstance(value, str):
        return []
    return sorted(t for t in _TAG_RE.findall(value) if not _BARE_MARKER_RE.match(t))


# CLDR plural categories per target language (Intl.PluralRules cardinal set).
# en.json carries only _one/_other, and i18next does NOT fall back to the
# pack's own _other when a category-specific key is missing -- it jumps
# straight to English (e.g. an ar pack without _few renders English for
# counts 3-10). Python's stdlib has no CLDR data, so the map is hand-pinned
# for the languages in targets.json; unlisted codes assume (one, other).
# Reported as a WARNING, not a failure: several long-published packs (ru, pl,
# cs) predate this check and would otherwise hard-fail the patch pipeline.
PLURAL_CATEGORIES = {
    "zh-CN": ("other",),
    "zh-TW": ("other",),
    "ja": ("other",),
    "ko": ("other",),
    "fr": ("one", "many", "other"),
    "it": ("one", "many", "other"),
    "es": ("one", "many", "other"),
    "pt-BR": ("one", "many", "other"),
    "ru": ("one", "few", "many", "other"),
    "pl": ("one", "few", "many", "other"),
    "cs": ("one", "few", "many", "other"),
    "ar": ("zero", "one", "two", "few", "many", "other"),
    "he": ("one", "two", "other"),
}


def missing_plural_categories(lang, base_keys, trans_keys):
    """Plural keys the target language needs but the pack lacks.

    For every base key that is pluralized in en.json (has _one/_other), the
    pack should carry the target language's full CLDR category set; a missing
    category renders ENGLISH for the counts it covers. Returns sorted
    "stem_category" entries.
    """
    required = PLURAL_CATEGORIES.get(lang, ("one", "other"))
    stems = {
        key.rsplit("_", 1)[0]
        for key in base_keys
        if key.endswith(("_one", "_other"))
    }
    return sorted(
        f"{stem}_{cat}"
        for stem in stems
        for cat in required
        if f"{stem}_{cat}" not in trans_keys
    )


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
    attr_markers = []
    for key in sorted(base_keys & trans_keys):
        if placeholders(base[key]) != placeholders(trans[key]):
            ph_mismatch.append((key, placeholders(base[key]), placeholders(trans[key])))
        if markup_markers(base[key]) != markup_markers(trans[key]):
            mk_mismatch.append((key, markup_markers(base[key]), markup_markers(trans[key])))
        bad = attribute_markers(trans[key])
        if bad:
            attr_markers.append((key, bad))

    # Advisory only (see PLURAL_CATEGORIES): missing categories render English
    # for the counts they cover, but must not fail long-published packs.
    lang = trans_path.stem
    plural_gaps = missing_plural_categories(lang, base_keys, trans_keys)

    passed = not (
        missing or extra or bad_type or ph_mismatch or mk_mismatch or attr_markers
    )

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
    print(f"ATTRIBUTE-BEARING markers ({len(attr_markers)}):")
    for key, tags in attr_markers:
        print(f"  {key}: {tags}")
    if not attr_markers:
        print("  (none)")
    print(f"PLURAL category gaps ({len(plural_gaps)}) — WARNING, not a failure:")
    for key in plural_gaps:
        print(f"  {key}")
    if plural_gaps:
        print(
            f"  ({lang} needs {'/'.join(PLURAL_CATEGORIES.get(lang, ('one', 'other')))};"
            " i18next renders ENGLISH for counts whose category key is absent)"
        )
    else:
        print("  (none)")

    print("\nRESULT:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
