"""Keeps schemas/assignments-v1.schema.json honest.

The JSON Schema lets non-CLI clients (the GUI) validate assignments.json writes
without hand-porting the Go validators. These tests pin it against the same
shapes the Go suite pins, including the example kit's tests.json, so schema
drift fails CI rather than surfacing as a GUI/CLI disagreement.
"""

from __future__ import annotations

import json
import pathlib

import pytest
from jsonschema import Draft202012Validator

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_SCHEMA = json.loads((_REPO_ROOT / "schemas" / "assignments-v1.schema.json").read_text())
_KIT_TESTS = json.loads(
    (_REPO_ROOT / "examples" / "declarative-tests" / "tests.json").read_text())

validator = Draft202012Validator(_SCHEMA)


def _entry(**overrides):
    entry = {
        "slug": "hello",
        "name": "Hello",
        "template": {"owner": "o", "repo": "t", "branch": "main"},
        "mode": "individual",
        "autograder": "default",
    }
    entry.update(overrides)
    return entry


def _manifest(*entries):
    return {"schema": "classroom50/assignments/v1", "assignments": list(entries)}


def _errors(doc):
    return [e.message for e in validator.iter_errors(doc)]


class TestSchemaAccepts:
    def test_minimal_manifest(self):
        assert _errors(_manifest(_entry())) == []

    def test_template_optional(self):
        # A template-less assignment omits the `template` block entirely;
        # the schema must accept it (gh student accept then creates an
        # empty shim-only repo). Mirrors the Go ValidateExistingEntry path.
        entry = _entry()
        del entry["template"]
        assert _errors(_manifest(entry)) == []

    def test_example_kit_tests(self):
        # The verification kit's tests.json is the canonical fixture the
        # CLI already accepts (pinned by TestKit-style Go coverage).
        assert _errors(_manifest(_entry(tests=_KIT_TESTS))) == []

    def test_runtime_and_group_fields(self):
        entry = _entry(
            mode="group",
            max_group_size=4,
            due="2026-09-15T23:59:00-04:00",
            runtime={
                "container": {"image": "cs50/cli:latest", "user": "root"},
                "python": "3.12",
            },
        )
        assert _errors(_manifest(entry)) == []

    def test_run_test_with_exit_code(self):
        tests = [{"name": "t", "type": "run", "run": "x", "exit-code": 42, "points": 1}]
        assert _errors(_manifest(_entry(tests=tests))) == []

    def test_feedback_pr_flag_accepted(self):
        # feedback_pr is a CLI-written boolean (gh teacher assignment add
        # --feedback-pr); the schema must accept it given the assignment
        # object is additionalProperties:false.
        assert _errors(_manifest(_entry(feedback_pr=True))) == []
        assert _errors(_manifest(_entry(feedback_pr=False))) == []

    def test_feedback_pr_must_be_boolean(self):
        assert _errors(_manifest(_entry(feedback_pr="yes"))) != []

    def test_allowed_files_accepted(self):
        # allowed_files is a CLI-written ordered list of gitignore-style
        # patterns; the schema must accept it given the assignment object
        # is additionalProperties:false.
        assert _errors(_manifest(_entry(allowed_files=["*", "!hello.py"]))) == []
        assert _errors(_manifest(_entry(allowed_files=[]))) == []

    def test_container_with_ubuntu_runs_on(self):
        entry = _entry(runtime={"container": {"image": "x"}, "runs-on": "ubuntu-22.04"})
        assert _errors(_manifest(entry)) == []

    def test_custom_runner_labels(self):
        # Custom / self-hosted runner: runs-on
        # accepts an array of labels, no value allow-list.
        entry = _entry(runtime={"runs-on": ["self-hosted", "gpu"], "python": "3.12"})
        assert _errors(_manifest(entry)) == []

    def test_custom_single_label_runs_on(self):
        # A single arbitrary label is accepted as a string.
        entry = _entry(runtime={"runs-on": "self-hosted"})
        assert _errors(_manifest(entry)) == []

    def test_container_on_custom_runner(self):
        entry = _entry(runtime={"runs-on": ["self-hosted"], "container": {"image": "cs50/cli:latest"}})
        assert _errors(_manifest(entry)) == []

    def test_go_parity_timeout_zero_and_optional_points(self):
        # Go accepts both shapes (0 = default timeout; missing points = 0),
        # so the schema must too — a hand-edited file the CLI accepts
        # should never be rejected by a schema-validating client.
        tests = [
            {"name": "a", "type": "run", "run": "x", "timeout": 0, "points": 1},
            {"name": "b", "type": "run", "run": "x"},
        ]
        assert _errors(_manifest(_entry(tests=tests))) == []

    @pytest.mark.parametrize("due", [
        "2026-09-15T23:59:00-04:00",
        "2026-09-15T23:59:00Z",
        "2026-09-15T23:59:00.123Z",
    ])
    def test_due_rfc3339_shapes(self, due):
        assert _errors(_manifest(_entry(due=due))) == []

    def test_due_meta_auto_detected(self):
        # Write-side provenance the CLI emits for a zone-less --due;
        # `zone` present, `source` = auto-detected. collect-scores
        # ignores it.
        entry = _entry(
            due="2026-09-16T03:59:00Z",
            due_meta={
                "input": "2026-09-15T23:59:00",
                "zone": "America/New_York",
                "offset": "-04:00",
                "source": "auto-detected",
            },
        )
        assert _errors(_manifest(entry)) == []

    def test_due_meta_explicit_offset_omits_zone(self):
        # An explicit offset carries no zone name, so `zone` is omitted.
        entry = _entry(
            due="2026-09-16T03:59:00Z",
            due_meta={
                "input": "2026-09-15T23:59:00-04:00",
                "offset": "-04:00",
                "source": "explicit-offset",
            },
        )
        assert _errors(_manifest(entry)) == []


class TestSchemaRejects:
    def test_template_null_rejected(self):
        # A template-less assignment omits the `template` key. An explicit
        # null is rejected (the Go parser rejects it too, via
        # rejectExplicitNullTemplates) — keep CLI and schema in lockstep.
        entry = _entry()
        entry["template"] = None
        assert _errors(_manifest(entry)) != []

    def test_allowed_files_empty_pattern_rejected(self):
        # An empty-string pattern is rejected (mirrors the Go
        # ValidateAllowedFiles minLength check).
        assert _errors(_manifest(_entry(allowed_files=["*", ""]))) != []

    def test_allowed_files_whitespace_only_pattern_rejected(self):
        # A whitespace-only pattern is rejected too, matching the Go
        # ValidateAllowedFiles strings.TrimSpace check and the workflow's
        # inline pat.strip() re-validation — all three validators agree.
        assert _errors(_manifest(_entry(allowed_files=["*", "   "]))) != []

    def test_allowed_files_must_be_array(self):
        # A scalar value is rejected; allowed_files is an ordered list.
        assert _errors(_manifest(_entry(allowed_files="hello.py"))) != []

    def test_partial_template_rejected(self):
        # When present, the template block still requires owner/repo/branch
        # (mirrors the Go ValidateExistingEntry partial check).
        for partial in (
            {"owner": "cs50", "repo": "hello-template", "branch": ""},
            {"owner": "cs50", "repo": "", "branch": "main"},
            {},
        ):
            entry = _entry()
            entry["template"] = partial
            assert _errors(_manifest(entry)) != []

    @pytest.mark.parametrize("bad_test", [
        # The GUI prototype's legacy shape: unknown `output`, no type/run.
        {"name": "t", "input": "python main.py", "output": "hi", "points": 1},
        {"name": "t", "type": "nope", "run": "x", "points": 1},
        # io-only / run-only field misuse.
        {"name": "t", "type": "io", "run": "x", "expected": "y",
         "comparison": "included", "exit-code": 0, "points": 1},
        {"name": "t", "type": "run", "run": "x", "expected": "y", "points": 1},
        # included against an empty expected matches everything.
        {"name": "t", "type": "io", "run": "x", "comparison": "included", "points": 1},
        # inline vs file fields are mutually exclusive.
        {"name": "t", "type": "io", "run": "x", "comparison": "exact",
         "input": "a", "input-file": "f", "points": 1},
        # bounds
        {"name": "t", "type": "run", "run": "x", "points": 11000},
        {"name": "t", "type": "run", "run": "x", "timeout": 9999, "points": 1},
    ])
    def test_bad_test_specs(self, bad_test):
        assert _errors(_manifest(_entry(tests=[bad_test]))) != []

    def test_unknown_entry_key_is_preserved(self):
        # An unknown top-level entry key is TOLERATED, not rejected: the entry
        # object is additionalProperties:true ("tolerate AND preserve"). The
        # known sub-objects (template/due_meta/runtime/tests) stay strict — see
        # test_bad_test_specs and test_bad_due_meta.
        assert _errors(_manifest(_entry(future_field="v2-only"))) == []

    def test_max_group_size_zero_must_be_omitted(self):
        # max_group_size: 0 is invalid everywhere — below the minimum of
        # 2, and an individual entry must omit the field entirely.
        assert _errors(_manifest(_entry(max_group_size=0))) != []

    def test_group_mode_requires_max_group_size(self):
        # mode: group with no max_group_size is rejected by the
        # mode<->size invariant (group requires it, >= 2).
        assert _errors(_manifest(_entry(mode="group"))) != []
        # size below the minimum (1) is rejected too.
        assert _errors(_manifest(_entry(mode="group", max_group_size=1))) != []

    def test_individual_mode_forbids_max_group_size(self):
        # mode: individual must NOT carry max_group_size.
        assert _errors(_manifest(_entry(max_group_size=3))) != []

    def test_autograder_must_be_written_explicitly(self):
        # Same documented strictness: the CLI's parser normalizes a
        # missing/empty autograder to "default"; clients must write it.
        entry = _entry()
        del entry["autograder"]
        assert _errors(_manifest(entry)) != []
        assert _errors(_manifest(_entry(autograder=""))) != []

    def test_apt_forbidden_with_container(self):
        entry = _entry(runtime={"container": {"image": "x"}, "apt": ["gcc"]})
        assert _errors(_manifest(entry)) != []

    def test_non_ubuntu_runs_on_with_container_passes_schema(self):
        # The Ubuntu-only-with-container rule is enforced by the
        # authoritative validators (runtime.go + the inline validator),
        # not the JSON Schema — clients should rely on those. The schema
        # only forbids apt-with-container.
        entry = _entry(runtime={"container": {"image": "x"}, "runs-on": "windows-latest"})
        assert _errors(_manifest(entry)) == []

    @pytest.mark.parametrize("runs_on", [
        "self hosted",            # whitespace
        "self-hosted; rm -rf /",  # shell metacharacters
        [],                       # empty array
        ["bad label"],            # whitespace in array element
        ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],  # >10 labels
        123,                      # wrong type
    ])
    def test_bad_runs_on(self, runs_on):
        assert _errors(_manifest(_entry(runtime={"runs-on": runs_on}))) != []

    @pytest.mark.parametrize("due", [
        # Mirrors validateDueDate in assignments_json.go: date-only
        # and timezone-less timestamps are ambiguous deadlines.
        "2026-09-15",
        "2026-09-15T23:59:00",
        "2026-09-15T24:00:00Z",
        "2026-09-15T23:60:00Z",
        "2026-09-15T23:59:60Z",
        "2026-09-15T23:59:00+24:00",
        "2026-09-15t23:59:00z",
        "next Tuesday",
        "",
    ])
    def test_due_must_be_full_rfc3339(self, due):
        assert _errors(_manifest(_entry(due=due))) != []

    @pytest.mark.parametrize("due_meta", [
        # Unknown key (additionalProperties: false).
        {"input": "x", "offset": "-04:00", "source": "auto-detected", "tz": "x"},
        # source outside the enum.
        {"input": "x", "offset": "-04:00", "source": "guessed"},
        # offset must be [+-]HH:MM, never a bare Z.
        {"input": "x", "offset": "Z", "source": "explicit-offset"},
        # Missing a required field (offset).
        {"input": "x", "source": "migrated"},
    ])
    def test_bad_due_meta(self, due_meta):
        entry = _entry(due="2026-09-16T03:59:00Z", due_meta=due_meta)
        assert _errors(_manifest(entry)) != []

    def test_wrong_schema_sentinel(self):
        assert _errors({"schema": "v2", "assignments": []}) != []


class TestEmptyRepo:
    def _bare_entry(self, **overrides):
        # An empty_repo entry has no template and no grading-adjacent fields.
        entry = _entry(empty_repo=True)
        del entry["template"]
        entry.update(overrides)
        return entry

    def test_empty_repo_accepted(self):
        assert _errors(_manifest(self._bare_entry())) == []

    def test_empty_repo_false_accepted_alongside_template(self):
        # The GUI may write an explicit false; it must not trigger the
        # mutual-exclusion conditional.
        assert _errors(_manifest(_entry(empty_repo=False))) == []

    def test_empty_repo_must_be_boolean(self):
        assert _errors(_manifest(self._bare_entry(empty_repo="yes"))) != []

    def test_empty_repo_rejects_template(self):
        entry = self._bare_entry()
        entry["template"] = {"owner": "o", "repo": "t", "branch": "main"}
        assert _errors(_manifest(entry)) != []

    def test_empty_repo_rejects_tests(self):
        entry = self._bare_entry(
            tests=[{"name": "t", "type": "run", "run": "true", "points": 1}]
        )
        assert _errors(_manifest(entry)) != []

    def test_empty_repo_rejects_feedback_pr_true(self):
        assert _errors(_manifest(self._bare_entry(feedback_pr=True))) != []

    def test_empty_repo_allows_feedback_pr_false(self):
        # The GUI writes feedback_pr: false explicitly for an empty repo.
        assert _errors(_manifest(self._bare_entry(feedback_pr=False))) == []

    def test_empty_repo_rejects_allowed_files(self):
        assert _errors(_manifest(self._bare_entry(allowed_files=["*"]))) != []

    def test_empty_repo_rejects_pass_threshold(self):
        assert _errors(_manifest(self._bare_entry(pass_threshold=70))) != []
