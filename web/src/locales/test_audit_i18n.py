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
# HARDCODED exemptions: dev-only paths and an allowlist of format examples are
# skipped, but real prose in a shipping file still fails --strict. These guard
# the exemption mechanism so it can't silently swallow a genuine hardcoded
# string.
# --------------------------------------------------------------------------


class TestHardcodedExemptions:
    def test_real_hardcoded_prose_fails_strict(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={
                "App.tsx": 't("nav.home"); const x = <div aria-label="Dismiss notification" />'
            },
            strict=True,
        )
        assert code == 1

    def test_dev_only_path_is_exempt(self, monkeypatch, tmp_path):
        # Same prose under components/dev/ must NOT fail — dev-only UI.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={
                "components/dev/Overlay.tsx": 't("nav.home"); const x = <div aria-label="Some dev label here" />'
            },
            strict=True,
        )
        assert code == 0

    def test_allowlisted_value_is_exempt(self, monkeypatch, tmp_path):
        # The PAT-format placeholder is a format hint, not translatable prose.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={
                "auth/Prompt.tsx": 't("nav.home"); const x = <input placeholder="ghp_…" />'
            },
            strict=True,
        )
        assert code == 0

    def test_allowlisted_value_exempt_in_userfacing_call(self, monkeypatch, tmp_path):
        # The allowlist must apply to the toast/setError/failDeviceFlow branch
        # too, not only JSX attributes.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"auth/Prompt.tsx": 't("nav.home"); setError("ghp_…")'},
            strict=True,
        )
        assert code == 0

    def test_allowlisted_value_outside_scope_still_fails(self, monkeypatch, tmp_path):
        # ghp_… is only exempt under web/src/auth/; the same value elsewhere is
        # a genuine hardcoded string and must fail --strict.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={
                "pages/Dashboard.tsx": 't("nav.home"); const x = <input placeholder="ghp_…" />'
            },
            strict=True,
        )
        assert code == 1

    def test_allowlist_is_byte_exact(self, monkeypatch, tmp_path):
        # A near-miss (ASCII "..." instead of the U+2026 ellipsis) is NOT the
        # allowlisted value, so it must still fail even in the scoped path.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={
                "auth/Prompt.tsx": 't("nav.home"); const x = <input placeholder="ghp_..." />'
            },
            strict=True,
        )
        assert code == 1


# --------------------------------------------------------------------------
# SPLIT keys: the retired _prefix/_suffix fragment convention is a hard
# failure (no --strict needed) so it can't quietly return after the Trans
# refactor. Plural suffixes and camelCase near-misses must stay legal.
# --------------------------------------------------------------------------


class TestSplitKeyGate:
    def test_split_key_fails_without_strict(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"body_prefix": "Open", "body_suffix": "to continue."}},
            sources={"App.tsx": 't("nav.body_prefix"); t("nav.body_suffix")'},
        )
        assert code == 1

    def test_numbered_fragment_fails(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"body_1": "Part one", "body_2": "part two."}},
            sources={"App.tsx": 't("nav.body_1"); t("nav.body_2")'},
        )
        assert code == 1

    def test_plural_suffixes_are_legal(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"students": {"count_one": "1 student", "count_other": "{{count}}"}},
            sources={"App.tsx": 't("students.count")'},
        )
        assert code == 0

    def test_camelcase_link_key_is_legal(self, monkeypatch, tmp_path):
        # nav.allClassesLink ends in "Link" but not "_link" — must pass.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"allClassesLink": "All Classrooms"}},
            sources={"App.tsx": 't("nav.allClassesLink")'},
        )
        assert code == 0


# --------------------------------------------------------------------------
# PHYSICAL directional classes: warning by default, fails --strict; the
# physical-ok marker exempts a deliberate physical edge. Logical classes and
# lookalike tokens must never trip it.
# --------------------------------------------------------------------------


class TestPhysicalClassGate:
    def test_physical_class_fails_strict(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"App.tsx": 't("nav.home"); const c = "btn ml-2"'},
            strict=True,
        )
        assert code == 1

    def test_physical_class_advisory_by_default(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"App.tsx": 't("nav.home"); const c = "btn ml-2"'},
        )
        assert code == 0

    def test_template_literal_chunk_detected(self, monkeypatch, tmp_path):
        # Class recipes in plain .ts template literals are the reason this
        # backstop exists — the eslint selectors can't reach them.
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={
                "classes.ts": 't("nav.home"); export const row = `flex pl-4 ${accent}`'
            },
            strict=True,
        )
        assert code == 1

    # The quote/backtick opening branch is the one alternative unique to the
    # Python copy of the regex (the eslint pattern opens on ^|[\s:] only, its
    # selectors having already scoped to the string content) — a blind re-sync
    # from directionalClassRule.ts would drop it while every space-preceded
    # fixture stayed green. Pin it explicitly.
    @pytest.mark.parametrize(
        "src",
        ['const c = "ml-2 btn"', "const c = `pl-4 ${x}`"],
    )
    def test_physical_class_at_string_opening_detected(
        self, monkeypatch, tmp_path, src
    ):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"App.tsx": f't("nav.home"); {src}'},
            strict=True,
        )
        assert code == 1

    def test_physical_ok_marker_exempts(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={
                "App.tsx": 't("nav.home"); const c = "fixed left-3" // physical-ok: viewport chrome'
            },
            strict=True,
        )
        assert code == 0

    def test_logical_and_lookalike_classes_pass(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={
                "App.tsx": (
                    't("nav.home"); '
                    'const c = "ms-2 me-auto ps-5 text-start border-s-2 start-2 end-3 '
                    'rounded-lg translate-x-0.5 rtl:-translate-x-0.5 space-x-3 '
                    'inset-x-0 tooltip-right rtl:tooltip-left col-start-2 justify-start"'
                )
            },
            strict=True,
        )
        assert code == 0

    def test_variant_prefixed_physical_detected(self, monkeypatch, tmp_path):
        code = _run(
            monkeypatch,
            tmp_path,
            en={"nav": {"home": "Home"}},
            sources={"App.tsx": 't("nav.home"); const c = "sm:right-4"'},
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


class TestParityWithEslintRule:
    """PHYSICAL_CLASS_RE and directionalClassPattern (directionalClassRule.ts)
    must catch the same class tokens. Both suites assert the shared probe
    fixture (web/src/eslint/directionalClassProbes.json) so extending one
    pattern without the other fails the other side's tests -- the sync is a
    tested contract, not a comment. The Python side matters most: it backstops
    template-literal chunks in .ts class recipes the AST rule can't reach, so
    a stale copy here silently un-guards those files."""

    PROBES_PATH = (
        AUDIT_PATH.parent.parent / "eslint" / "directionalClassProbes.json"
    )

    @pytest.fixture(scope="class")
    def probes(self):
        return json.loads(self.PROBES_PATH.read_text(encoding="utf-8"))

    def test_matches_all_fixture_probes(self, probes):
        misses = [c for c in probes["matches"] if not audit.PHYSICAL_CLASS_RE.search(c)]
        assert misses == [], f"PHYSICAL_CLASS_RE misses fixture probes: {misses}"

    def test_ignores_all_fixture_non_probes(self, probes):
        hits = [c for c in probes["nonMatches"] if audit.PHYSICAL_CLASS_RE.search(c)]
        assert hits == [], f"PHYSICAL_CLASS_RE wrongly matches: {hits}"

    def test_fixture_is_nonempty(self, probes):
        # An emptied fixture would green both suites while guarding nothing.
        assert len(probes["matches"]) >= 20
        assert len(probes["nonMatches"]) >= 15


class TestCamelCaseSplitGate:
    """The SPLIT gate must catch camelCase affix tails (fooSuffix/fooPrefix),
    not just the underscore convention — rongxin's RTL review found six
    camelCase fragment keys the underscore-only regex waved through."""

    @pytest.mark.parametrize(
        "key",
        [
            "orgMembers.idSuffix",
            "students.githubIdSuffix",
            "assignments.form.passThresholdSuffix",
            "published.servedUnlistedSuffix",
            "classes.toolbar.termPrefix",
            "classes.toolbar.sortPrefix",
            # plural variants of a camelCase fragment are still fragments
            "submissions.stats.ungradedSuffix_one",
            "submissions.stats.ungradedSuffix_other",
        ],
    )
    def test_camelcase_affix_keys_flagged(self, key):
        assert audit.SPLIT_SUFFIX_RE.search(key), key

    @pytest.mark.parametrize(
        "key",
        [
            # whole labels, not fragments
            "nav.allClassesLink",
            "orgMembers.usernameWithId",
            "assignments.form.passThresholdUnit",
            "published.servedUnlistedNote",
            "classes.toolbar.term",
            "submissions.stats.ungradedNote_one",
            # a bare prefix/suffix leaf is a label named "prefix", not a fragment
            "form.prefix",
            "form.suffix",
            # plural forms of ordinary keys stay legal
            "published.resourceCount_other",
        ],
    )
    def test_legal_keys_not_flagged(self, key):
        assert not audit.SPLIT_SUFFIX_RE.search(key), key
