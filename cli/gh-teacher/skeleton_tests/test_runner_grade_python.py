"""Tests for runner.py's pytest grading path.

Focus is _ensure_pytest (issue #212): actions/setup-python provides only bare
CPython, so a `python` test must have pytest + pytest-json-report installed
before it runs. _ensure_pytest checks each dep against the grading interpreter
and installs only what's missing, best-effort, without breaking per-case
scoring when the report is present.
"""

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
    """Stand-in for runner._run_command that records the install commands it's
    asked to run (the only thing _ensure_pytest still shells out for)."""

    def __init__(self):
        self.installs: list[str] = []

    def __call__(self, command, cwd, timeout, stdin=""):
        self.installs.append(command)
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


def test_swallows_install_failure(monkeypatch):
    monkeypatch.setattr(runner.importlib.util, "find_spec", lambda module: None)

    def boom(command, cwd, timeout, stdin=""):
        raise OSError("no network")

    monkeypatch.setattr(runner, "_run_command", boom)
    # Must not raise -- an offline runner degrades to fallback scoring.
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
