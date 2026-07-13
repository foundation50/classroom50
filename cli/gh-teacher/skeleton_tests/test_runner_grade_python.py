"""Tests for runner.py's pytest grading path (_ensure_pytest, issue #212):
install the pytest deps missing from the grading interpreter, best-effort."""

from __future__ import annotations

import json
import pathlib
import subprocess

from conftest import _load_module, _SCRIPTS_DIR

runner = _load_module("runner", _SCRIPTS_DIR / "runner.py")


def _completed(returncode: int) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args="", returncode=returncode,
                                       stdout="", stderr="")


class _InstallRecorder:
    """Stand-in for runner._run_command that records the install commands (and
    their timeouts) it's asked to run."""

    def __init__(self):
        self.installs: list[str] = []
        self.timeouts: list[int] = []

    def __call__(self, command, cwd, timeout, stdin=""):
        self.installs.append(command)
        self.timeouts.append(timeout)
        return _completed(0)


def _run_ensure(monkeypatch, importable):
    importable = set(importable)
    monkeypatch.setattr(
        runner.importlib.util, "find_spec",
        lambda module: object() if module in importable else None)
    rec = _InstallRecorder()
    monkeypatch.setattr(runner, "_run_command", rec)
    runner._ensure_pytest(cwd=None, timeout=30)
    return rec


def test_skips_install_when_both_present(monkeypatch):
    rec = _run_ensure(monkeypatch, {"pytest", "pytest_jsonreport"})
    assert rec.installs == []


def test_installs_only_pytest_when_plugin_present(monkeypatch):
    rec = _run_ensure(monkeypatch, {"pytest_jsonreport"})
    assert len(rec.installs) == 1
    assert "pytest" in rec.installs[0]
    assert "pytest-json-report" not in rec.installs[0]


def test_installs_only_plugin_when_pytest_present(monkeypatch):
    rec = _run_ensure(monkeypatch, {"pytest"})
    assert len(rec.installs) == 1
    assert "pytest-json-report" in rec.installs[0]
    # The bare `pytest` token must not appear as a standalone install target.
    assert " pytest " not in f" {rec.installs[0]} "


def test_installs_both_when_both_missing(monkeypatch):
    rec = _run_ensure(monkeypatch, set())
    assert len(rec.installs) == 1
    assert "pytest" in rec.installs[0]
    assert "pytest-json-report" in rec.installs[0]


def test_install_targets_grading_interpreter(monkeypatch):
    import shlex
    import sys
    rec = _run_ensure(monkeypatch, set())
    # The fix rests on installing into the interpreter that grades (sys.executable),
    # not whatever `python` the run command resolves from PATH.
    assert rec.installs[0].startswith(f"{shlex.quote(sys.executable)} -m pip install")


def test_install_uses_its_own_timeout_floor(monkeypatch):
    # A cold install can't fit the 10s default per-test timeout; _ensure_pytest
    # must floor the install budget at PIP_INSTALL_TIMEOUT so the fix isn't a no-op.
    monkeypatch.setattr(runner.importlib.util, "find_spec", lambda module: None)
    rec = _InstallRecorder()
    monkeypatch.setattr(runner, "_run_command", rec)
    runner._ensure_pytest(cwd=None, timeout=10)
    assert rec.timeouts == [runner.PIP_INSTALL_TIMEOUT]


def test_install_keeps_larger_test_timeout(monkeypatch):
    # A teacher-set timeout above the floor is respected, not clamped down.
    monkeypatch.setattr(runner.importlib.util, "find_spec", lambda module: None)
    rec = _InstallRecorder()
    monkeypatch.setattr(runner, "_run_command", rec)
    runner._ensure_pytest(cwd=None, timeout=runner.PIP_INSTALL_TIMEOUT + 60)
    assert rec.timeouts == [runner.PIP_INSTALL_TIMEOUT + 60]


def test_swallows_install_failure(monkeypatch):
    monkeypatch.setattr(runner.importlib.util, "find_spec", lambda module: None)

    def boom(command, cwd, timeout, stdin=""):
        raise OSError("no network")

    monkeypatch.setattr(runner, "_run_command", boom)
    # Must not raise -- an offline runner degrades to fallback scoring.
    runner._ensure_pytest(cwd=None, timeout=30)


def test_swallows_install_timeout(monkeypatch):
    # A bounded install that times out is the realistic failure; TimeoutExpired
    # is a SubprocessError, so the except tuple must swallow it too.
    monkeypatch.setattr(runner.importlib.util, "find_spec", lambda module: None)

    def slow(command, cwd, timeout, stdin=""):
        raise subprocess.TimeoutExpired(cmd="pip", timeout=timeout)

    monkeypatch.setattr(runner, "_run_command", slow)
    runner._ensure_pytest(cwd=None, timeout=30)


def test_grade_python_per_case_scoring_unaffected(monkeypatch, tmp_path):
    """_ensure_pytest runs before grading, but a produced report.json still
    drives per-case scoring -- the auto-install must not change the happy
    path."""
    monkeypatch.setattr(runner, "_ensure_pytest",
                        lambda cwd, timeout: None)

    def fake_run(command, cwd, timeout, stdin=""):
        # Write the report the runner asked for via --json-report-file=...
        for token in command.split():
            if token.startswith("--json-report-file="):
                path = token.split("=", 1)[1].strip("'\"")
                pathlib.Path(path).write_text(
                    json.dumps({"summary": {"total": 4, "passed": 3}}))
        return _completed(1)

    monkeypatch.setattr(runner, "_run_command", fake_run)
    spec = {"name": "pytest suite", "type": "python", "run": "python -m pytest -q"}
    outcome = runner._grade_python(spec, cwd=tmp_path, timeout=30,
                                   points=8, name="pytest suite")
    # 3/4 cases -> 6 points, capped below full credit since not all passed.
    assert outcome["score"] == 6
    assert outcome["passed"] is False
    assert "3/4" in outcome["detail"]
