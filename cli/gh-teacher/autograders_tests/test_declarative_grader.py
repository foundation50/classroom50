"""Tests for the built-in declarative test grader in runner.py.

The grader turns a materialized tests.json (input/output, run-command, and
pytest specs -- the GitHub Classroom-style autograding model) into a
classroom50/result/v1 result.json. These exercise the comparison modes,
per-test execution (timeouts, setup, exit codes, fixtures), the pytest points
split, and the end-to-end run_declarative wiring. Real shell commands run in
pytest's tmp_path so the subprocess behavior is covered, not mocked.
"""

from __future__ import annotations

import json
import re
import shlex
import sys

import pytest

from conftest import runner as ag


# ---------------------------------------------------------------------------
# compare_output
# ---------------------------------------------------------------------------


class TestCompareOutput:
    def test_included_is_raw_substring(self):
        assert ag.compare_output("hello world", "world", "included")
        assert not ag.compare_output("hello", "world", "included")

    def test_exact_ignores_surrounding_whitespace(self):
        # The trailing-newline footgun: echo adds "\n", teacher writes none.
        assert ag.compare_output("Hello, world!\n", "Hello, world!", "exact")
        assert not ag.compare_output("Hello, world!!", "Hello, world!", "exact")

    def test_regex_search(self):
        assert ag.compare_output("hello, Alice", r"^hello,\s+\w+$", "regex")
        assert not ag.compare_output("nope", r"^hello", "regex")

    def test_regex_is_multiline(self):
        # ^/$ anchor at line boundaries, so a line-anchored pattern still
        # matches when the program prints other lines around it.
        assert ag.compare_output("banner\nhello, Bob!\ndone\n", r"^hello,\s+Bob!$", "regex")

    def test_regex_bad_pattern_raises(self):
        with pytest.raises(re.error):
            ag.compare_output("x", "(unterminated", "regex")

    def test_unknown_mode_raises(self):
        with pytest.raises(ValueError):
            ag.compare_output("x", "x", "fuzzy")


# ---------------------------------------------------------------------------
# execute_test -- run type
# ---------------------------------------------------------------------------


class TestExecuteRun:
    def test_pass_on_exit_zero(self, tmp_path):
        spec = {"name": "t", "type": "run", "run": "true", "points": 3}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"] and o["score"] == 3 and o["max-score"] == 3

    def test_fail_on_nonzero(self, tmp_path):
        spec = {"name": "t", "type": "run", "run": "false", "points": 3}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"] and o["score"] == 0

    def test_custom_expected_exit_code(self, tmp_path):
        spec = {"name": "t", "type": "run", "run": "exit 2", "exit-code": 2, "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"]

    def test_setup_failure_fails_the_test(self, tmp_path):
        spec = {"name": "t", "type": "run", "run": "true", "setup": "false", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"] and "setup exited" in o["detail"]

    def test_setup_runs_before_command(self, tmp_path):
        # setup writes a file; run checks it exists.
        spec = {
            "name": "t", "type": "run",
            "setup": "echo built > marker.txt",
            "run": "test -f marker.txt",
            "points": 1,
        }
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"]

    def test_timeout_fails_the_test(self, tmp_path):
        spec = {"name": "t", "type": "run", "run": "sleep 5", "timeout": 1, "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"] and "timed out" in o["detail"]


# ---------------------------------------------------------------------------
# execute_test -- io type
# ---------------------------------------------------------------------------


class TestExecuteIO:
    def test_included_pass(self, tmp_path):
        spec = {"name": "t", "type": "io", "run": "echo hello world",
                "expected": "world", "comparison": "included", "points": 2}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"] and o["score"] == 2

    def test_exact_pass_despite_trailing_newline(self, tmp_path):
        spec = {"name": "t", "type": "io", "run": "echo Hello, world!",
                "expected": "Hello, world!", "comparison": "exact", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"]

    def test_stdin_input_is_fed(self, tmp_path):
        spec = {"name": "t", "type": "io", "run": "cat", "input": "ping\n",
                "expected": "ping", "comparison": "included", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"]

    def test_exact_fail_shows_unified_diff(self, tmp_path):
        spec = {"name": "t", "type": "io", "run": "printf 'one\\nnope\\n'",
                "expected": "one\ntwo", "comparison": "exact", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"]
        assert "--- expected" in o["detail"]
        assert "+++ actual stdout" in o["detail"]
        assert "-two" in o["detail"] and "+nope" in o["detail"]
        # The matching line is context, not a change.
        assert "-one" not in o["detail"] and "+one" not in o["detail"]
        # A non-empty diff replaces the verbatim blocks — never both (a
        # both-emitted regression would otherwise pass).
        assert "--- expected (exact) ---" not in o["detail"]
        assert "--- actual stdout ---" not in o["detail"]

    def test_included_fail_keeps_expected_and_actual_blocks(self, tmp_path):
        # A line diff against a substring expectation is noise; included and
        # regex failures keep the verbatim expected/actual blocks.
        spec = {"name": "t", "type": "io", "run": "echo nope",
                "expected": "yes", "comparison": "included", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"]
        assert "--- expected (included) ---" in o["detail"]
        assert "--- actual stdout ---" in o["detail"]
        assert "+++" not in o["detail"]

    def test_exact_fail_with_empty_diff_falls_back_to_blocks(self, tmp_path):
        # Separator characters splitlines() folds away (here \x0c) fail the
        # exact comparison but produce an empty unified diff; the detail must
        # fall back to the verbatim blocks, never show FAIL with nothing.
        spec = {"name": "t", "type": "io", "run": "printf 'one\\ftwo'",
                "expected": "one\ntwo", "comparison": "exact", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"]
        assert "--- expected (exact) ---" in o["detail"]
        assert "--- actual stdout ---" in o["detail"]

    def test_fail_includes_stderr_block(self, tmp_path):
        spec = {"name": "t", "type": "io", "run": "echo warn >&2; echo nope",
                "expected": "yes", "comparison": "exact", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"]
        assert "--- stderr ---" in o["detail"] and "warn" in o["detail"]

    def test_invalid_regex_fails_with_message(self, tmp_path):
        spec = {"name": "t", "type": "io", "run": "echo x",
                "expected": "(unterminated", "comparison": "regex", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"] and "invalid regex" in o["detail"]

    def test_input_file_and_expected_file(self, tmp_path):
        (tmp_path / "in.txt").write_text("data\n")
        (tmp_path / "out.txt").write_text("data")
        spec = {"name": "t", "type": "io", "run": "cat",
                "input-file": "in.txt", "expected-file": "out.txt",
                "comparison": "included", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"]

    def test_fixture_path_traversal_rejected(self, tmp_path):
        bundle = tmp_path / "bundle"
        bundle.mkdir()
        (tmp_path / "secret.txt").write_text("top secret")
        spec = {"name": "t", "type": "io", "run": "cat",
                "input-file": "../secret.txt", "expected": "x",
                "comparison": "included", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=bundle)
        assert not o["passed"] and "escapes the bundle" in o["detail"]

    def test_missing_fixture_file_rejected(self, tmp_path):
        spec = {"name": "t", "type": "io", "run": "cat",
                "expected-file": "nope.txt", "comparison": "exact", "points": 1}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert not o["passed"] and "not found" in o["detail"]


# ---------------------------------------------------------------------------
# execute_test -- python type
# ---------------------------------------------------------------------------


def _pytest_run(testfile_body: str, tmp_path, points: int) -> dict:
    (tmp_path / "test_sample.py").write_text(testfile_body)
    spec = {
        "name": "suite", "type": "python",
        # sys.executable so the subprocess uses this interpreter (which has
        # pytest + pytest-json-report), not whatever `python` is on PATH.
        "run": f"{shlex.quote(sys.executable)} -m pytest -q",
        "timeout": 60, "points": points,
    }
    return ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)


class TestExecutePython:
    def test_splits_points_across_cases(self, tmp_path):
        body = (
            "def test_a():\n    assert True\n"
            "def test_b():\n    assert True\n"
            "def test_c():\n    assert False\n"
        )
        o = _pytest_run(body, tmp_path, points=9)
        # 2 of 3 cases pass -> round(9 * 2/3) = 6; not all passed.
        assert o["max-score"] == 9
        assert o["score"] == 6
        assert not o["passed"]
        assert "2/3" in o["detail"]

    def test_all_pass_full_points(self, tmp_path):
        o = _pytest_run("def test_a():\n    assert True\n", tmp_path, points=5)
        assert o["passed"] and o["score"] == 5

    def test_fallback_to_exit_code_without_report(self, tmp_path):
        # `true` ignores the appended --json-report flags and writes no
        # report -> all-or-nothing on the exit code.
        spec = {"name": "suite", "type": "python", "run": "true", "points": 4}
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"] and o["score"] == 4 and "no JSON report" in o["detail"]

    def test_partial_pass_never_gets_full_points(self, tmp_path):
        # points=1 with 2/3 cases passing rounds to 1, which would read
        # "FAIL | 1 / 1" — full credit is reserved for an all-pass run.
        body = (
            "def test_a():\n    assert True\n"
            "def test_b():\n    assert True\n"
            "def test_c():\n    assert False\n"
        )
        o = _pytest_run(body, tmp_path, points=1)
        assert not o["passed"] and o["score"] == 0

    def test_half_passed_uses_python_rounding(self, tmp_path):
        # Pins the points split at the .5 boundary: Python's round() is
        # half-to-even, so round(5 * 1/2) == 2, not 3.
        body = (
            "def test_a():\n    assert True\n"
            "def test_b():\n    assert False\n"
        )
        o = _pytest_run(body, tmp_path, points=5)
        assert o["score"] == 2 and not o["passed"]

    def test_teacher_supplied_json_report_flags_not_duplicated(self, tmp_path):
        # A run command that already configures the plugin must not get the
        # flags appended again (pytest errors on duplicates). The report then
        # lands at the teacher's path, not ours, so scoring falls back to exit.
        (tmp_path / "test_sample.py").write_text("def test_a():\n    assert True\n")
        spec = {
            "name": "suite", "type": "python",
            "run": f"{shlex.quote(sys.executable)} -m pytest -q "
                   "--json-report --json-report-file=own-report.json",
            "timeout": 60, "points": 3,
        }
        o = ag.execute_test(spec, cwd=tmp_path, fixtures_dir=tmp_path)
        assert o["passed"] and o["score"] == 3


# ---------------------------------------------------------------------------
# load_tests
# ---------------------------------------------------------------------------


class TestLoadTests:
    def _write(self, tmp_path, payload):
        p = tmp_path / "tests.json"
        p.write_text(payload if isinstance(payload, str) else json.dumps(payload))
        return p

    def test_valid(self, tmp_path):
        p = self._write(tmp_path, {"schema": "classroom50/tests/v1",
                                   "tests": [{"name": "a", "type": "run", "run": "true", "points": 1}]})
        assert len(ag.load_tests(p)) == 1

    def test_bad_schema(self, tmp_path):
        p = self._write(tmp_path, '{"schema": "nope", "tests": []}')
        with pytest.raises(ag.TestsConfigError):
            ag.load_tests(p)

    def test_empty_tests_list(self, tmp_path):
        p = self._write(tmp_path, '{"schema": "classroom50/tests/v1", "tests": []}')
        with pytest.raises(ag.TestsConfigError):
            ag.load_tests(p)

    def test_invalid_spec(self, tmp_path):
        p = self._write(tmp_path, {"schema": "classroom50/tests/v1",
                                   "tests": [{"name": "a", "type": "nope", "run": "x", "points": 1}]})
        with pytest.raises(ag.TestsConfigError):
            ag.load_tests(p)

    def test_not_json(self, tmp_path):
        p = self._write(tmp_path, "{not json")
        with pytest.raises(json.JSONDecodeError):
            ag.load_tests(p)

    def test_duplicate_names_rejected(self, tmp_path):
        # A hand-placed tests.json bypasses the CLI and inline validators;
        # dupes would make result.json rows ambiguous.
        p = self._write(tmp_path, {"schema": "classroom50/tests/v1", "tests": [
            {"name": "same", "type": "run", "run": "true", "points": 1},
            {"name": "same", "type": "run", "run": "false", "points": 1},
        ]})
        with pytest.raises(ag.TestsConfigError, match="duplicate"):
            ag.load_tests(p)

    def test_timeout_over_cap_rejected(self, tmp_path):
        p = self._write(tmp_path, {"schema": "classroom50/tests/v1", "tests": [
            {"name": "a", "type": "run", "run": "true", "timeout": 9999, "points": 1},
        ]})
        with pytest.raises(ag.TestsConfigError, match="timeout"):
            ag.load_tests(p)

    def test_control_char_in_name_rejected(self, tmp_path):
        # Mirrors tests.go / tests-v1.schema.json: a name is echoed into the
        # release body and a column-0 `::group::FAIL: {name}` log line, where a
        # newline could inject a workflow command. A hand-edited tests.json
        # bypasses the CLI validators, so the grader must reject it too.
        p = self._write(tmp_path, {"schema": "classroom50/tests/v1", "tests": [
            {"name": "t\n::error::pwned", "type": "run", "run": "true", "points": 1},
        ]})
        with pytest.raises(ag.TestsConfigError, match="control characters"):
            ag.load_tests(p)

    @pytest.mark.parametrize("bad_field", [
        {"name": "a", "type": "run", "run": "true", "points": 1, "exit-code": "abc"},
        {"name": "a", "type": "run", "run": "true", "points": 1, "exit-code": []},
        {"name": "a", "type": "io", "run": "echo", "comparison": "exact", "expected": 5},
        {"name": "a", "type": "io", "run": "cat", "comparison": "exact", "expected": "x", "input": 5},
        {"name": "a", "type": "io", "run": "cat", "comparison": "exact", "expected": "x", "input-file": 123},
        {"name": "a", "type": "run", "run": "true", "points": 1, "setup": 123},
    ])
    def test_rejects_wrongly_typed_optional_fields(self, tmp_path, bad_field):
        # These fields aren't checked by the schema sentinel but are
        # consumed by execute_test; a wrong type must fail at load time
        # rather than crash the grader mid-run.
        p = self._write(tmp_path, {"schema": "classroom50/tests/v1", "tests": [bad_field]})
        with pytest.raises(ag.TestsConfigError):
            ag.load_tests(p)


# ---------------------------------------------------------------------------
# render_declarative_body
# ---------------------------------------------------------------------------


class TestRenderDeclarativeBody:
    def test_table_escapes_pipes_and_shows_failure_details(self):
        result = {"score": 1, "max-score": 2}
        outcomes = [
            {"test-name": "a|b", "passed": True, "score": 1, "max-score": 1, "detail": "ok"},
            {"test-name": "c", "passed": False, "score": 0, "max-score": 1, "detail": "boom"},
        ]
        body = ag.render_declarative_body(result, outcomes, "summary text")
        assert "classroom50 autograde: 1/2" in body
        assert "| a\\|b | PASS | 1 / 1 |" in body
        assert "| c | FAIL | 0 / 1 |" in body
        assert "Failure details" in body and "boom" in body
        assert "Status: summary text" in body

    def test_no_failures_omits_details_block(self):
        result = {"score": 1, "max-score": 1}
        outcomes = [{"test-name": "a", "passed": True, "score": 1, "max-score": 1, "detail": ""}]
        body = ag.render_declarative_body(result, outcomes, "all good")
        assert "Failure details" not in body

    def test_detail_with_backtick_fence_cannot_break_out(self):
        # Student output flows into the failure detail; a ``` line must
        # not close the code block and inject Markdown into the body.
        evil = "before\n```\n# PWNED markdown heading\n```python"
        result = {"score": 0, "max-score": 1}
        outcomes = [{"test-name": "t", "passed": False, "score": 0, "max-score": 1, "detail": evil}]
        body = ag.render_declarative_body(result, outcomes, "s")
        lines = body.splitlines()
        start = lines.index("````")
        end = len(lines) - 1 - lines[::-1].index("````")
        # The fence is longer than any backtick run in the payload, and
        # the payload (including its ``` lines) sits strictly inside.
        assert start < end
        assert "# PWNED markdown heading" in lines[start:end]


# ---------------------------------------------------------------------------
# render_log_report
# ---------------------------------------------------------------------------


class TestRenderLogReport:
    def _outcomes(self):
        return [
            {"test-name": "good", "passed": True, "score": 2, "max-score": 2, "detail": "ok"},
            {"test-name": "bad", "passed": False, "score": 0, "max-score": 1,
             "detail": "exit 1\n--- expected\n+++ actual stdout\n-two\n+nope"},
        ]

    def test_all_pass_has_no_groups(self):
        outcomes = [{"test-name": "a", "passed": True, "score": 1, "max-score": 1, "detail": ""}]
        report = ag.render_log_report(outcomes, color=False)
        assert "PASS  a  (1/1)" in report
        assert "::group::" not in report

    def test_failures_get_one_group_each(self):
        report = ag.render_log_report(self._outcomes(), color=False)
        assert "PASS  good  (2/2)" in report
        assert "FAIL  bad  (0/1)" in report
        assert report.count("::group::FAIL: bad") == 1
        assert report.count("::endgroup::") == 1
        # Detail lines are inside the group, indented.
        assert "\n  exit 1\n" in report

    def test_color_off_emits_no_ansi(self):
        report = ag.render_log_report(self._outcomes(), color=False)
        assert "\x1b[" not in report

    def test_color_on_colors_verdicts_and_diff_lines(self):
        report = ag.render_log_report(self._outcomes(), color=True)
        assert f"{ag.ANSI_GREEN}PASS{ag.ANSI_RESET}" in report
        assert f"{ag.ANSI_BOLD}{ag.ANSI_RED}FAIL{ag.ANSI_RESET}" in report
        assert f"  {ag.ANSI_RED}-two{ag.ANSI_RESET}" in report
        assert f"  {ag.ANSI_GREEN}+nope{ag.ANSI_RESET}" in report

    def test_detail_cannot_inject_workflow_commands(self):
        # Detail carries student-controlled output; GitHub only interprets
        # workflow commands at column 0, so every detail line must be
        # indented. A student's ::endgroup::/::error:: must never take effect.
        outcomes = [{"test-name": "t", "passed": False, "score": 0, "max-score": 1,
                     "detail": "::endgroup::\n::error::pwned\n::stop-commands::x"}]
        report = ag.render_log_report(outcomes, color=False)
        for line in report.splitlines():
            if line.startswith("::"):
                assert line in ("::group::FAIL: t", "::endgroup::")

    def test_test_name_cannot_inject_workflow_commands(self):
        # test-name is interpolated into the column-0 `::group::FAIL: {name}`
        # header. Stripping control chars (incl. newlines) guarantees no
        # student/hand-edited name can start a NEW line with a workflow
        # command — the only `::`-prefixed lines are the group open/close.
        outcomes = [{"test-name": "t\n::error::pwned", "passed": False,
                     "score": 0, "max-score": 1, "detail": "d"}]
        report = ag.render_log_report(outcomes, color=False)
        assert "\n::error::" not in report
        for line in report.splitlines():
            if line.startswith("::"):
                assert line.startswith("::group::FAIL: ") or line == "::endgroup::"

    def test_missing_detail_renders_empty_group(self):
        outcomes = [{"test-name": "t", "passed": False, "score": 0, "max-score": 1}]
        report = ag.render_log_report(outcomes, color=False)
        assert "::group::FAIL: t\n::endgroup::" in report


# ---------------------------------------------------------------------------
# append_step_summary
# ---------------------------------------------------------------------------


class TestAppendStepSummary:
    def test_write_failure_is_swallowed(self, tmp_path, monkeypatch):
        # The docstring contract: a write failure must never affect grading.
        monkeypatch.setenv(
            "GITHUB_STEP_SUMMARY", str(tmp_path / "no-such-dir" / "summary.md"))
        ag.append_step_summary("# hi")  # must not raise

    def test_unset_var_is_a_no_op(self):
        ag.append_step_summary("# hi")  # conftest delenv'd the var; must not raise


# ---------------------------------------------------------------------------
# run_declarative (end-to-end)
# ---------------------------------------------------------------------------


def _finalizer(tmp_path):
    gho = tmp_path / "gh_output"
    gho.write_text("")
    fin = ag.Finalizer(
        workspace=tmp_path,
        github_output=str(gho),
        classroom="cs",
        assignment="hello",
        username="alice",
        submission="submit/2026-01-01T00-00-00Z-abc1234",
        commit_link="https://github.com/o/r/commit/abc1234",
        release_link="https://github.com/o/r/releases/tag/x",
    )
    return fin, gho


class TestRunDeclarative:
    def _write_tests(self, tmp_path, specs):
        p = tmp_path / "tests.json"
        p.write_text(json.dumps({"schema": "classroom50/tests/v1", "tests": specs}))
        return p

    def test_grades_and_writes_all_artifacts(self, tmp_path, monkeypatch, capsys):
        step_summary = tmp_path / "step-summary.md"
        monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(step_summary))
        fin, gho = _finalizer(tmp_path)
        p = self._write_tests(tmp_path, [
            {"name": "compiles", "type": "run", "run": "true", "points": 1},
            {"name": "prints", "type": "io", "run": "echo hi",
             "expected": "hi", "comparison": "included", "points": 2},
            {"name": "bad", "type": "run", "run": "false", "points": 1},
        ])
        rc = ag.run_declarative(p, fin, tmp_path)
        assert rc == 0

        result = json.loads((tmp_path / "result.json").read_text())
        assert result["schema"] == "classroom50/result/v1"
        assert result["classroom"] == "cs" and result["assignment"] == "hello"
        assert result["score"] == 3 and result["max-score"] == 4
        assert [t["test-name"] for t in result["tests"]] == ["compiles", "prints", "bad"]
        # The synthesized result must satisfy the v1 validator (ingest parity).
        assert ag.validate_result(result, classroom="cs", assignment="hello") is None

        body = (tmp_path / "release-body.md").read_text()
        assert "classroom50 autograde: 3/4" in body
        assert "Failure details" in body  # `bad` failed

        # run_declarative writes the body; main()'s finally mirrors the final
        # body to the Summary page. Drive that mirror to pin the parity.
        ag.mirror_body_to_step_summary(tmp_path)
        assert step_summary.read_text() == body

        # The per-test report reaches stdout (the workflow log). Plain text
        # here: GITHUB_ACTIONS is unset under pytest, so the color gate holds.
        out = capsys.readouterr().out
        assert "FAIL  bad  (0/1)" in out
        assert "::group::FAIL: bad" in out
        assert "\x1b[" not in out

        out = gho.read_text()
        assert "status=failure" in out  # not all tests passed

    def test_color_gate_turns_on_under_actions(self, tmp_path, monkeypatch, capsys):
        # The conftest fixture deletes GITHUB_ACTIONS; opt back in to pin the
        # positive half of the gate (ANSI in the log under Actions).
        monkeypatch.setenv("GITHUB_ACTIONS", "true")
        fin, _ = _finalizer(tmp_path)
        p = self._write_tests(tmp_path, [
            {"name": "bad", "type": "run", "run": "false", "points": 1},
        ])
        ag.run_declarative(p, fin, tmp_path)
        assert f"{ag.ANSI_BOLD}{ag.ANSI_RED}FAIL{ag.ANSI_RESET}" in capsys.readouterr().out

    def test_no_color_opts_out_under_actions(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setenv("GITHUB_ACTIONS", "true")
        monkeypatch.setenv("NO_COLOR", "1")
        fin, _ = _finalizer(tmp_path)
        p = self._write_tests(tmp_path, [
            {"name": "bad", "type": "run", "run": "false", "points": 1},
        ])
        ag.run_declarative(p, fin, tmp_path)
        assert "\x1b[" not in capsys.readouterr().out

    def test_all_pass_reports_success(self, tmp_path):
        fin, gho = _finalizer(tmp_path)
        p = self._write_tests(tmp_path, [
            {"name": "ok", "type": "run", "run": "true", "points": 5},
        ])
        ag.run_declarative(p, fin, tmp_path)
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["score"] == 5 and result["max-score"] == 5
        assert "status=success" in gho.read_text()

    def test_malformed_tests_json_routes_to_error_result(self, tmp_path):
        fin, gho = _finalizer(tmp_path)
        p = tmp_path / "tests.json"
        p.write_text('{"schema": "wrong", "tests": []}')
        rc = ag.run_declarative(p, fin, tmp_path)
        assert rc == 0  # grading problems never fail the runner
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["tests"] == [] and result["score"] == 0
        assert "status=error" in gho.read_text()

    def test_unexpected_grader_crash_routes_to_error(self, tmp_path, monkeypatch):
        # Backstop: if execute_test raises something unexpected (future
        # field drift), run_declarative must still publish an error result
        # and exit 0 rather than crash the runner.
        fin, gho = _finalizer(tmp_path)
        p = self._write_tests(tmp_path, [{"name": "ok", "type": "run", "run": "true", "points": 1}])

        def _boom(*_args, **_kwargs):
            raise RuntimeError("boom")

        monkeypatch.setattr(ag, "execute_test", _boom)
        rc = ag.run_declarative(p, fin, tmp_path)
        assert rc == 0
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["tests"] == [] and result["score"] == 0
        assert "status=error" in gho.read_text()
