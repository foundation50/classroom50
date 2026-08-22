"""Pins the classroom/assignment short-name (slug) pattern across every mirror.

The regex `^[a-z0-9][a-z0-9-]{1,99}$` is hand-copied into seven places with no
compile-time link between them (Go, Python, a workflow YAML, three JSON Schemas,
and TypeScript). A drift here is exactly how the web create path silently fell
out of the contract (foundation50/classroom50#691), so assert byte-identical
copies and fail CI on the next drift.
"""

from __future__ import annotations

import json
import pathlib
import re

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]

# The one authoritative pattern. Every mirror must match this literal exactly.
_EXPECTED = r"^[a-z0-9][a-z0-9-]{1,99}$"


def _schema_short_name_pattern(rel: str) -> str:
    schema = json.loads((_REPO_ROOT / rel).read_text())
    return schema["$defs"]["shortName"]["pattern"]


def _extract(rel: str, pattern: str) -> str:
    text = (_REPO_ROOT / rel).read_text()
    m = re.search(pattern, text)
    assert m, f"{rel}: could not find the short-name pattern (regex {pattern!r})"
    return m.group(1)


def test_all_short_name_mirrors_match() -> None:
    found = {
        "schemas/classroom-v1.schema.json": _schema_short_name_pattern(
            "schemas/classroom-v1.schema.json"
        ),
        "schemas/assignments-v1.schema.json": _schema_short_name_pattern(
            "schemas/assignments-v1.schema.json"
        ),
        "schemas/scores-v1.schema.json": _schema_short_name_pattern(
            "schemas/scores-v1.schema.json"
        ),
        "cli/gh-teacher/internal/validate/validate.go": _extract(
            "cli/gh-teacher/internal/validate/validate.go",
            r"ShortNamePattern = regexp\.MustCompile\(`([^`]+)`\)",
        ),
        "cli/gh-teacher/skeleton/dotgithub/scripts/materialize_tests.py": _extract(
            "cli/gh-teacher/skeleton/dotgithub/scripts/materialize_tests.py",
            r'SLUG_RE = re\.compile\(r"([^"]+)"\)',
        ),
        "cli/gh-teacher/skeleton/dotgithub/workflows/autograde-runner.yaml": _extract(
            "cli/gh-teacher/skeleton/dotgithub/workflows/autograde-runner.yaml",
            r'_SLUG = re\.compile\(r"([^"]+)"\)',
        ),
        "web/src/util/shortName.ts": _extract(
            "web/src/util/shortName.ts",
            r"SHORT_NAME_PATTERN = /([^/]+)/",
        ),
    }

    drifted = {rel: pat for rel, pat in found.items() if pat != _EXPECTED}
    assert not drifted, (
        f"short-name pattern drift (expected {_EXPECTED!r}): {drifted!r}"
    )
