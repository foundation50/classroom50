"""Unit tests for verify_locale.py -- the translated-pack integrity gate.

verify_locale.py is the shipping gate for language packs: a pack that drops a
key, a {{placeholder}}, or a <tag> markup marker must FAIL. Its correctness
rests on hand-written regexes and set arithmetic, so these tests lock down the
detection behavior on tiny inline fixtures -- a future regex tweak that
silently stops catching a real mismatch (turning the gate into a permanent
PASS) fails here first.

Run from the repo root:

    python -m pytest web/src/locales/test_verify_locale.py

The module is loaded via importlib (not a plain import) because it lives
outside any package; main() resolves en.json relative to the cwd, so the
integration tests chdir into a tmp fixture folder and nothing touches the
real tree.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

VERIFY_PATH = Path(__file__).resolve().parent / "verify_locale.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = _load_module("verify_locale", VERIFY_PATH)


def _run(monkeypatch, tmp_path, base: dict, trans: dict):
    """Write fixture en.json + xx.json into tmp_path, chdir there, run main().

    Returns main()'s exit code (0 pass / 1 fail / 2 usage error).
    """
    (tmp_path / "en.json").write_text(json.dumps(base), encoding="utf-8")
    (tmp_path / "xx.json").write_text(json.dumps(trans), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.argv", ["verify_locale.py", "xx.json"])
    return verify.main()


# --------------------------------------------------------------------------
# markup_markers(): what counts as a <Trans> component tag
# --------------------------------------------------------------------------


class TestMarkupMarkers:
    def test_open_and_close_tags(self):
        assert verify.markup_markers("No PR for <repo>{{repo}}</repo> yet.") == [
            "</repo>",
            "<repo>",
        ]

    def test_self_closing_tag(self):
        assert verify.markup_markers("Line one<br/>line two") == ["<br/>"]

    def test_self_closing_tag_with_space(self):
        assert verify.markup_markers("Line one<br />line two") == ["<br />"]

    def test_repeated_tags_counted_as_multiset(self):
        # Two <b> pairs must yield four markers, not a deduplicated two.
        assert verify.markup_markers("<b>a</b> and <b>c</b>") == [
            "</b>",
            "</b>",
            "<b>",
            "<b>",
        ]

    def test_numeric_comparison_is_not_markup(self):
        # "<1 day" style strings must not register as markers.
        assert verify.markup_markers("graded in <1 day") == []

    def test_owner_repo_placeholder_hint_is_markup(self):
        # en.json's literal "<owner>/<repo>" hint DOES match; that's fine --
        # the check only requires the translation to carry the same markers,
        # which rule 3 of TRANSLATION_PROMPT.md (don't translate code) already
        # guarantees.
        assert verify.markup_markers("<owner>/<repo>") == ["<owner>", "<repo>"]

    def test_non_string_value(self):
        assert verify.markup_markers(42) == []


# --------------------------------------------------------------------------
# The shipping gate: marker mismatches flip the exit code
# --------------------------------------------------------------------------


class TestMarkupGate:
    BASE = {"pr": {"empty": "No PR for <repo>{{repo}}</repo> yet."}}

    def test_matching_markers_pass(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base=self.BASE,
            trans={"pr": {"empty": "Für <repo>{{repo}}</repo> gibt es noch keinen PR."}},
        )
        assert code == 0

    def test_missing_closing_tag_fails(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base=self.BASE,
            trans={"pr": {"empty": "Für <repo>{{repo}} gibt es noch keinen PR."}},
        )
        assert code == 1

    def test_extra_tag_fails(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base=self.BASE,
            trans={"pr": {"empty": "Für <repo>{{repo}}</repo> <b>keinen</b> PR."}},
        )
        assert code == 1

    def test_renamed_tag_fails(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base=self.BASE,
            trans={"pr": {"empty": "Für <code>{{repo}}</code> gibt es keinen PR."}},
        )
        assert code == 1

    def test_numeric_angle_text_does_not_trip(self, monkeypatch, tmp_path):
        # Both sides say "<1 day" in their own words; no markers on either
        # side, so no MARKUP mismatch.
        code = _run(
            monkeypatch,
            tmp_path,
            base={"eta": "usually <1 day"},
            trans={"eta": "meist <1 Tag"},
        )
        assert code == 0

    def test_self_closing_tag_must_be_preserved(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base={"msg": "one<br/>two"},
            trans={"msg": "eins zwei"},
        )
        assert code == 1


# --------------------------------------------------------------------------
# attribute_markers(): a pack tag carrying an attribute is rejected, matching
# the runtime customLocale.ts guard (defense-in-depth for the registry path).
# --------------------------------------------------------------------------


class TestAttributeMarkerGate:
    BASE = {"pr": {"empty": "No PR for <repo>{{repo}}</repo> yet."}}

    def test_attribute_bearing_tag_fails(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base=self.BASE,
            trans={"pr": {"empty": 'Für <repo href="https://evil.example">{{repo}}</repo>.'}},
        )
        assert code == 1

    def test_slash_separated_attribute_fails(self, monkeypatch, tmp_path):
        # <repo/ href="…"> bypasses a whitespace-only guard but html-parse-stringify
        # still reads a clean href, so it must fail here too.
        code = _run(
            monkeypatch,
            tmp_path,
            base=self.BASE,
            trans={"pr": {"empty": 'Für <repo/ href="https://evil.example">{{repo}}.'}},
        )
        assert code == 1

    def test_bare_markers_still_pass(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base=self.BASE,
            trans={"pr": {"empty": "Für <repo>{{repo}}</repo> gibt es keinen PR."}},
        )
        assert code == 0

    def test_attribute_markers_helper(self):
        assert verify.attribute_markers('x <a href="y">z</a>') == ['<a href="y">']
        assert verify.attribute_markers("<repo>{{r}}</repo> <br/>") == []
        assert verify.attribute_markers("<owner>/<repo>") == []


# --------------------------------------------------------------------------
# The pre-existing checks still gate (smoke-level, so a refactor of main()
# can't silently drop them while the markup tests keep passing)
# --------------------------------------------------------------------------


class TestExistingGate:
    def test_identical_pack_passes(self, monkeypatch, tmp_path):
        base = {"nav": {"home": "Home", "n_one": "{{n}} item", "n_other": "{{n}} items"}}
        assert _run(monkeypatch, tmp_path, base=base, trans=base) == 0

    def test_missing_key_fails(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base={"nav": {"home": "Home", "away": "Away"}},
            trans={"nav": {"home": "Zuhause"}},
        )
        assert code == 1

    def test_placeholder_mismatch_fails(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base={"hello": "Hello {{name}}"},
            trans={"hello": "Hallo {{nom}}"},
        )
        assert code == 1

    def test_extra_plural_variant_allowed(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            base={"count_one": "{{n}} item", "count_other": "{{n}} items"},
            trans={
                "count_one": "{{n}}",
                "count_few": "{{n}}",
                "count_many": "{{n}}",
                "count_other": "{{n}}",
            },
        )
        assert code == 0


# --------------------------------------------------------------------------
# missing_plural_categories(): CLDR completeness is advisory — i18next renders
# English for counts whose category key is absent, but long-published packs
# (ru/pl/cs) predate the check, so gaps warn without failing.
# --------------------------------------------------------------------------


class TestPluralCategoryGaps:
    def test_arabic_pack_missing_categories_reported(self):
        gaps = verify.missing_plural_categories(
            "ar",
            base_keys={"count_one", "count_other", "title"},
            trans_keys={"count_one", "count_other", "title"},
        )
        assert gaps == ["count_few", "count_many", "count_two", "count_zero"]

    def test_complete_arabic_pack_reports_none(self):
        cats = ("zero", "one", "two", "few", "many", "other")
        trans = {f"count_{c}" for c in cats}
        assert (
            verify.missing_plural_categories(
                "ar", base_keys={"count_one", "count_other"}, trans_keys=trans
            )
            == []
        )

    def test_unlisted_language_assumes_one_other(self):
        assert (
            verify.missing_plural_categories(
                "de",
                base_keys={"count_one", "count_other"},
                trans_keys={"count_one", "count_other"},
            )
            == []
        )

    def test_gap_is_warning_not_failure(self, monkeypatch, tmp_path):
        # An ar.json missing _few/_many/... must still PASS (exit 0).
        (tmp_path / "en.json").write_text(
            json.dumps({"count_one": "{{n}} item", "count_other": "{{n}} items"}),
            encoding="utf-8",
        )
        (tmp_path / "ar.json").write_text(
            json.dumps({"count_one": "{{n}}", "count_other": "{{n}}"}),
            encoding="utf-8",
        )
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr("sys.argv", ["verify_locale.py", "ar.json"])
        assert verify.main() == 0
