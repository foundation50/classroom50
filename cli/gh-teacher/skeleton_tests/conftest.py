"""Loads the embedded publish/collect-time scripts for the test suite.

These scripts live under `cli/gh-teacher/skeleton/dotgithub/scripts/`
because `gh teacher init` embeds them at `.github/scripts/` in each org's
`classroom50` repo:

  - collect_scores.py    — score collector (collect-scores.yaml)
  - regrade_repos.py     — regrade fan-out: re-tags student repos so the
                           autograder re-runs (regrade.yaml)
  - materialize_tests.py — translates assignments.json `tests` blocks into
                           per-assignment tests.json bundles (publish-pages.yaml)
  - probe_token.py       — service-token scope probe (probe-token.yaml)

Importing via `importlib` keeps the embedded path canonical — no second
copy to keep in sync.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys

_HERE = pathlib.Path(__file__).resolve().parent
_SCRIPTS_DIR = _HERE.parent / "skeleton" / "dotgithub" / "scripts"


def _load_module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None, f"could not load {path}"
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


collect_scores = _load_module("collect_scores", _SCRIPTS_DIR / "collect_scores.py")
materialize_tests = _load_module("materialize_tests", _SCRIPTS_DIR / "materialize_tests.py")
regrade_repos = _load_module("regrade_repos", _SCRIPTS_DIR / "regrade_repos.py")
probe_token = _load_module("probe_token", _SCRIPTS_DIR / "probe_token.py")
