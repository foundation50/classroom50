"""Loads the embedded scripts for the test suite.

The runner-side scripts live under `cli/gh-teacher/skeleton/dotgithub/scripts/`
because `gh teacher init` lands them at `.github/scripts/` in each org's
`classroom50` repo:
  - runner.py         — runner-side bootstrap (loaded as a module so its pure
                        helpers are unit-testable)
  - collect_scores.py — score collector (loaded so cross-binary constants like
                        RESULT_SCHEMA_V1 can be compared, not just pinned)

The diagnostic-stub autograder lives under `cli/gh-teacher/embed/` because it's
`//go:embed`-ed into the gh-teacher binary and written to
`<classroom>/autograder.py` only when teachers run `gh teacher autograder
set-default` without `--from`. test_default_autograder.py runs it as a
subprocess because it does its work at module-execution time.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

import pytest

_HERE = pathlib.Path(__file__).resolve().parent
_SCRIPTS_DIR = _HERE.parent / "skeleton" / "dotgithub" / "scripts"
_EMBED_DIR = _HERE.parent / "embed"

DEFAULT_AUTOGRADER_PATH = _EMBED_DIR / "autograder.py"


def _load_module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None, f"could not load {path}"
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


runner = _load_module("runner", _SCRIPTS_DIR / "runner.py")
collect_scores = _load_module("collect_scores", _SCRIPTS_DIR / "collect_scores.py")


@pytest.fixture(autouse=True)
def _isolate_actions_env(monkeypatch):
    """This suite itself runs on GitHub Actions, where GITHUB_ACTIONS /
    GITHUB_STEP_SUMMARY are set for real — without isolation, runner-path
    tests would emit ANSI (breaking output assertions) and append release
    bodies to the CI job's own Summary page. NO_COLOR is cleared too: a
    developer who exports it globally would otherwise suppress the ANSI the
    color-gate tests assert. Tests that exercise these surfaces opt back in
    with monkeypatch.setenv."""
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    monkeypatch.delenv("NO_COLOR", raising=False)
