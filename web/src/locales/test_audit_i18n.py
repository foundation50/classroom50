"""Unit tests for audit_i18n.py -- the source-vs-en.json i18n coverage gate.

audit_i18n.py is wired into web CI as a build-blocking check: a t("...") key
absent from en.json fails the build. Its correctness rests entirely on
hand-written regexes and set arithmetic, so these tests lock down the
detection behavior on tiny inline fixtures (rather than the live web/src tree)
so a future regex tweak that silently stops catching a real missing key --
turning the gate into a permanent PASS -- fails here first.

Run from the repo root:

    python -m pytest web/src/locales/test_audit_i18n.py

The module is loaded via importlib (not a plain import) because it lives
outside any package and resolves its paths relative to its own __file__; the
tests monkeypatch EN_FILE / SRC_DIR onto tmp fixtures so nothing touches the
real tree.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

AUDIT_PATH = Path(__file__).resolve().parent / "audit_i18n.py"


def _load_audit():
    spec = importlib.util.spec_from_file_location("audit_i18n", AUDIT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = _load_module("audit_i18n", AUDIT_PATH)
verify_locale = _load_module("verify_locale", AUDIT_PATH.parent / "verify_locale.py")


def _capture(text: str) -> tuple[set[str], set[str]]:
    """Run the static-key + backtick + dynamic-prefix regexes over `text`,
    returning (static_keys, dynamic_prefixes) exactly as main() collects them."""
    static_keys: set[str] = set()
    dynamic_prefixes: set[str] = set()
    for m in audit.STATIC_KEY_RE.finditer(text):
        audit.collect_static_key(m.group(1), static_keys, dynamic_prefixes)
    for m in audit.STATIC_BACKTICK_RE.finditer(text):
        audit.collect_static_key(m.group(1), static_keys, dynamic_prefixes)
    for m in audit.DYNAMIC_PREFIX_RE.finditer(text):
        if m.group(1):
            dynamic_prefixes.add(m.group(1))
    return static_keys, dynamic_prefixes


def _run(monkeypatch, tmp_path, en: dict, sources: dict[str, str], *, strict=False):
    """Point the module at a fixture en.json + src tree and run main().

    `sources` maps a relative path under the fake web/src to file contents.
    Returns main()'s exit code (0 pass / 1 fail / 2 missing en.json).
    """
    src_dir = tmp_path / "web" / "src"
    locales = src_dir / "locales"
    locales.mkdir(parents=True)
    en_file = locales / "en.json"
    en_file.write_text(json.dumps(en), encoding="utf-8")
    for relpath, contents in sources.items():
        p = src_dir / relpath
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(contents, encoding="utf-8")

    monkeypatch.setattr(audit, "SRC_DIR", src_dir)
    monkeypatch.setattr(audit, "EN_FILE", en_file)
    monkeypatch.setattr("sys.argv", ["audit_i18n.py"] + (["--strict"] if strict else []))
    return audit.main()


# --------------------------------------------------------------------------
# STATIC_KEY_RE / STATIC_BACKTICK_RE capture across every supported t() form
# --------------------------------------------------------------------------


class TestKeyCapture:
    def test_double_quoted(self):
        assert _capture('t("nav.home")')[0] == {"nav.home"}

    def test_single_quoted(self):
        assert _capture("t('nav.home')")[0] == {"nav.home"}

    def test_i18n_namespaced_call(self):
        assert _capture('i18n.t("nav.home")')[0] == {"nav.home"}

    def test_backtick_no_interpolation(self):
        # A no-${} template literal is idiomatic i18next and MUST be caught.
        assert _capture("t(`nav.home`)")[0] == {"nav.home"}

    def test_hyphenated_segment(self):
        assert _capture('t("new-feature.title")')[0] == {"new-feature.title"}

    def test_namespace_prefix_stripped(self):
        # en.json is flattened without a namespace, so "common:" is stripped.
        assert _capture('t("common:nav.home")')[0] == {"nav.home"}

    def test_method_call_not_matched(self):
        # A method named `t` on some other object is NOT the translator.
        assert _capture('builder.t("a.b")') == (set(), set())

    def test_concatenation_routed_to_dynamic_prefix(self):
        # t("prefix." + x) captures the partial "prefix." -- treat as a prefix,
        # never a (spuriously) missing key.
        static, dynamic = _capture('t("assignments.dynamic." + name)')
        assert static == set()
        assert "assignments.dynamic." in dynamic

    def test_interpolated_backtick_is_a_prefix(self):
        static, dynamic = _capture("t(`classes.filter.${f}`)")
        assert static == set()
        assert "classes.filter." in dynamic

    def test_multiline_call(self):
        # Python \s spans newlines, so a multi-line t() call is captured.
        assert _capture('t(\n  "nav.home",\n)')[0] == {"nav.home"}


# --------------------------------------------------------------------------
# The build-blocking behavior: a referenced-but-absent key fails the run
# --------------------------------------------------------------------------


class TestMissingGate:
    def test_missing_key_fails(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"App.tsx": 't("nav.absent")'},
        )
        assert code == 1

    def test_present_key_passes(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"App.tsx": 't("nav.home")'},
        )
        assert code == 0

    def test_backtick_missing_key_fails(self, monkeypatch, tmp_path):
        # Regression guard for the false-green backtick escape.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"App.tsx": "t(`nav.absent`)"},
        )
        assert code == 1

    def test_concatenation_does_not_false_red(self, monkeypatch, tmp_path):
        # t("prefix." + x) must NOT be reported as a missing key.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"App.tsx": 't("nav." + which)'},
        )
        assert code == 0

    def test_mts_file_is_scanned(self, monkeypatch, tmp_path):
        # A missing key referenced only from a .mts file must still fail.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"helper.mts": 't("nav.absent")'},
        )
        assert code == 1


# --------------------------------------------------------------------------
# Plural-base allowance: t("x.count") is satisfied by x.count_one/_other
# --------------------------------------------------------------------------


class TestPluralBase:
    def test_plural_base_reference_not_missing(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"students": {"count_one": "1", "count_other": "{{n}}"}},
            sources={"App.tsx": 't("students.count")'},
        )
        assert code == 0


# --------------------------------------------------------------------------
# --strict flips the exit code for DEAD/HARDCODED-only findings
# --------------------------------------------------------------------------


class TestStrictFlag:
    def test_dead_key_advisory_by_default(self, monkeypatch, tmp_path):
        # en.json has an unused key; no MISSING -> PASS without --strict.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home", "unused": "x"}},
            sources={"App.tsx": 't("nav.home")'},
        )
        assert code == 0

    def test_dead_key_fails_under_strict(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home", "unused": "x"}},
            sources={"App.tsx": 't("nav.home")'},
            strict=True,
        )
        assert code == 1


# --------------------------------------------------------------------------
# flatten() / PLURAL_SUFFIXES parity with the sibling verify_locale.py.
# The two copies are intentionally duplicated (both scripts are standalone,
# zero-import), so guard against silent drift the way translate_locales does.
# --------------------------------------------------------------------------


class TestParityWithVerifyLocale:
    @pytest.mark.parametrize(
        "obj",
        [
            {},
            {"a": "1"},
            {"a": {"b": "2", "c": {"d": "3"}}},
            {"count_one": "one", "count_other": "many"},
            {"a": {"b": {"c": {"deep": "leaf"}}}, "top": "value"},
        ],
    )
    def test_flatten_matches_verify_locale(self, obj):
        assert audit.flatten(obj) == verify_locale.flatten(obj)

    def test_plural_suffixes_match_verify_locale(self):
        assert audit.PLURAL_SUFFIXES == verify_locale.PLURAL_SUFFIXES

    def test_flatten_matches_on_real_base_locale(self):
        en_file = AUDIT_PATH.parent / "en.json"
        raw = json.loads(en_file.read_text(encoding="utf-8"))
        assert audit.flatten(raw) == verify_locale.flatten(raw)
