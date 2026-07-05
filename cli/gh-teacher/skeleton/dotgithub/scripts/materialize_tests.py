#!/usr/bin/env python3
"""Materialize declarative tests from each classroom's assignments.json.

Run by publish-pages.yaml before the per-assignment bundles are tarred. For
every assignment entry with a `tests` block, writes

    <classroom>/autograders/<slug>/tests.json   (schema classroom50/tests/v1)

into the checkout so the bundle step tars it alongside any sibling fixtures
(input-file / expected-file). runner.py grades the bundled file with its
built-in interpreter (run_declarative).

Validation lives elsewhere (tests.go at write time, runner.py at grade time),
so this script stays forgiving: a malformed manifest emits a ::warning:: and is
skipped rather than failing the Pages deploy. tests.json-vs-autograder.py
precedence is resolved in ONE place — runner.py's entrypoint resolution — so it
isn't special-cased here.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

ASSIGNMENTS_SCHEMA_V1 = "classroom50/assignments/v1"
TESTS_SCHEMA_V1 = "classroom50/tests/v1"
TESTS_FILENAME = "tests.json"

# Mirror validate.ShortNamePattern in cli/gh-teacher/internal/validate/validate.go.
# The slug becomes a directory path here, so a traversal-style slug must be
# rejected before it reaches mkdir.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}$")


def materialize(root: pathlib.Path) -> int:
    """Walk every <classroom>/assignments.json under `root`, writing a
    tests.json for each assignment that declares tests. Returns the count of
    files written. Never raises on bad manifest data -- warns and skips."""
    written = 0
    for manifest in sorted(root.glob("*/assignments.json")):
        classroom = manifest.parent.name
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"::warning::{manifest}: {exc}; skipping declarative-test materialization")
            continue
        if not isinstance(data, dict):
            print(f"::warning::{manifest}: not a JSON object; skipping")
            continue
        if data.get("schema") != ASSIGNMENTS_SCHEMA_V1:
            print(f"::warning::{manifest}: schema {data.get('schema')!r}, "
                  f"want {ASSIGNMENTS_SCHEMA_V1!r}; skipping")
            continue

        for entry in data.get("assignments") or []:
            if not isinstance(entry, dict):
                continue
            tests = entry.get("tests")
            if not tests:
                continue
            slug = entry.get("slug")
            if not isinstance(slug, str) or not SLUG_RE.match(slug):
                print(f"::warning::{manifest}: skipping entry with invalid slug {slug!r}")
                continue
            if not isinstance(tests, list):
                print(f"::warning::{manifest}: {slug}: 'tests' is not a list; skipping")
                continue

            outdir = root / classroom / "autograders" / slug
            outdir.mkdir(parents=True, exist_ok=True)
            payload = {"schema": TESTS_SCHEMA_V1, "tests": tests}
            (outdir / TESTS_FILENAME).write_text(
                json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            print(f"materialized {outdir / TESTS_FILENAME} ({len(tests)} test(s))")
            written += 1
    return written


def main() -> int:
    root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path.cwd()
    count = materialize(root)
    print(f"materialize_tests: wrote {count} tests.json file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
