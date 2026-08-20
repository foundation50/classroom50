"""Loads the embedded publish/collect-time scripts for the test suite.

These live under `cli/gh-teacher/skeleton/dotgithub/scripts/` because `gh
teacher init` embeds them at `.github/scripts/` in each org's `classroom50`
repo:

  - collect_scores.py    — score collector (collect-scores.yaml)
  - regrade_repos.py     — regrade fan-out (regrade.yaml)
  - materialize_tests.py — translates assignments.json `tests` blocks into
                           per-assignment tests.json bundles (publish-pages.yaml)
  - probe_token.py       — service-token scope probe (probe-token.yaml)

Importing via `importlib` keeps the embedded path canonical — no second copy.
"""

from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import sys
import urllib.error

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


def github_http_error(
    code: int,
    headers: dict[str, str] | None = None,
    body: bytes | dict | None = b"",
    url: str = "https://api.github.com/x",
) -> urllib.error.HTTPError:
    """An HTTPError shaped like GitHub's, for both script test modules.

    `headers` is a plain dict — the real HTTPMessage answers `.get` the same
    way — and the body is readable exactly ONCE, which is the property the
    scripts' body caching exists to survive. A dict body is JSON-encoded; None
    means no body stream at all (an error that can't be read)."""
    if isinstance(body, dict):
        body = json.dumps(body).encode("utf-8")
    fp = io.BytesIO(body) if body is not None else None
    return urllib.error.HTTPError(url=url, code=code, msg="msg", hdrs=headers, fp=fp)


class FakeResponse:
    """Stand-in for the object the scripts' opener returns. `read(*args)` covers
    both `resp.read()` and collect's `resp.read(max_bytes)`."""

    def __init__(self, body: bytes = b"{}", status: int = 200):
        self.status = status
        self.headers: dict[str, str] = {}
        self._body = body

    def read(self, *args):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False
