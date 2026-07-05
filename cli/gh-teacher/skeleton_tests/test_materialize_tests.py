"""Tests for materialize_tests.py.

Reads each <classroom>/assignments.json and writes a
<classroom>/autograders/<slug>/tests.json for every assignment that declares a
`tests` block, so publish-pages.yaml's bundle step ships it to the runner. Must
be slug-safe (the slug becomes a directory path) and forgiving (a malformed
manifest warns and is skipped, never aborting the Pages deploy).
"""

from __future__ import annotations

import json

from conftest import _load_module, _SCRIPTS_DIR
from conftest import materialize_tests as mt

# Load the grade-time runner too: materialize_tests (publish) and
# runner.load_tests (grade) are the two halves of the tests.json contract, so
# one test below pins that they agree.
runner = _load_module("runner", _SCRIPTS_DIR / "runner.py")


def _manifest(assignments, schema="classroom50/assignments/v1"):
    return json.dumps({"schema": schema, "assignments": assignments})


def _write_classroom(root, name, manifest_text):
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "assignments.json").write_text(manifest_text)
    return d


def _io_test(name="prints"):
    return {"name": name, "type": "io", "run": "./hello",
            "expected": "hi", "comparison": "included", "points": 1}


class TestMaterialize:
    def test_writes_tests_json_for_declarative_assignment(self, tmp_path):
        _write_classroom(tmp_path, "cs", _manifest([
            {"slug": "hello", "name": "Hello",
             "template": {"owner": "o", "repo": "r", "branch": "main"},
             "mode": "individual", "autograder": "default",
             "tests": [
                 {"name": "compiles", "type": "run", "run": "gcc -o hello hello.c", "points": 1},
                 _io_test(),
             ]},
        ]))
        count = mt.materialize(tmp_path)
        assert count == 1

        out = tmp_path / "cs" / "autograders" / "hello" / "tests.json"
        assert out.is_file()
        payload = json.loads(out.read_text())
        assert payload["schema"] == "classroom50/tests/v1"
        assert [t["name"] for t in payload["tests"]] == ["compiles", "prints"]

    def test_skips_assignment_without_tests(self, tmp_path):
        _write_classroom(tmp_path, "cs", _manifest([
            {"slug": "intro", "name": "Intro",
             "template": {"owner": "o", "repo": "r", "branch": "main"},
             "mode": "individual", "autograder": "default"},
        ]))
        assert mt.materialize(tmp_path) == 0
        assert not (tmp_path / "cs" / "autograders" / "intro").exists()

    def test_preserves_existing_fixtures_in_override_dir(self, tmp_path):
        # A teacher who uses expected-file keeps the fixture in the override
        # dir; materialize must drop tests.json alongside, not clobber it.
        override = tmp_path / "cs" / "autograders" / "hello"
        override.mkdir(parents=True)
        (override / "expected.txt").write_text("golden output")
        _write_classroom(tmp_path, "cs", _manifest([
            {"slug": "hello", "name": "Hello",
             "template": {"owner": "o", "repo": "r", "branch": "main"},
             "mode": "individual", "autograder": "default",
             "tests": [{"name": "match", "type": "io", "run": "./hello",
                        "expected-file": "expected.txt", "comparison": "exact", "points": 1}]},
        ]))
        mt.materialize(tmp_path)
        assert (override / "expected.txt").read_text() == "golden output"
        assert (override / "tests.json").is_file()

    def test_rejects_traversal_slug(self, tmp_path):
        # A hand-edited manifest with a path-traversal slug must not escape
        # the classroom directory.
        _write_classroom(tmp_path, "cs", _manifest([
            {"slug": "../../evil", "name": "Evil",
             "template": {"owner": "o", "repo": "r", "branch": "main"},
             "mode": "individual", "autograder": "default",
             "tests": [_io_test()]},
        ]))
        assert mt.materialize(tmp_path) == 0
        # Nothing written outside cs/autograders/.
        assert not (tmp_path / "evil").exists()
        assert not (tmp_path / "cs" / "autograders" / "../../evil").exists()

    def test_skips_bad_schema(self, tmp_path):
        _write_classroom(tmp_path, "cs", _manifest(
            [{"slug": "hello", "tests": [_io_test()]}], schema="classroom50/assignments/v2"))
        assert mt.materialize(tmp_path) == 0
        assert not (tmp_path / "cs" / "autograders" / "hello").exists()

    def test_skips_invalid_json(self, tmp_path):
        _write_classroom(tmp_path, "cs", "{not valid json")
        # Warns and skips rather than raising.
        assert mt.materialize(tmp_path) == 0

    def test_multiple_classrooms(self, tmp_path):
        _write_classroom(tmp_path, "cs-a", _manifest([
            {"slug": "hello", "tests": [_io_test()]}]))
        _write_classroom(tmp_path, "cs-b", _manifest([
            {"slug": "world", "tests": [_io_test()]},
            {"slug": "no-tests", "name": "x"},
        ]))
        assert mt.materialize(tmp_path) == 2
        assert (tmp_path / "cs-a" / "autograders" / "hello" / "tests.json").is_file()
        assert (tmp_path / "cs-b" / "autograders" / "world" / "tests.json").is_file()

    def test_tests_not_a_list_skipped(self, tmp_path):
        _write_classroom(tmp_path, "cs", _manifest([
            {"slug": "hello", "tests": {"oops": "object"}}]))
        assert mt.materialize(tmp_path) == 0
        assert not (tmp_path / "cs" / "autograders" / "hello").exists()

    def test_round_trips_through_runner_load_tests(self, tmp_path):
        # The file materialize writes must be exactly what runner.py's
        # load_tests accepts -- the two halves of the contract.
        _write_classroom(tmp_path, "cs", _manifest([
            {"slug": "hello", "tests": [
                {"name": "compiles", "type": "run", "run": "true", "points": 1},
                _io_test(),
            ]}]))
        mt.materialize(tmp_path)
        out = tmp_path / "cs" / "autograders" / "hello" / "tests.json"
        loaded = runner.load_tests(out)
        assert [t["name"] for t in loaded] == ["compiles", "prints"]
