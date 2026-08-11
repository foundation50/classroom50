"""Keeps schemas/assignments-v1.schema.json honest.

The JSON Schema lets non-CLI clients (the GUI) validate assignments.json writes
without hand-porting the Go validators. These tests pin it against the same
shapes the Go suite pins, including the example kit's tests.json, so schema
drift fails CI rather than surfacing as a GUI/CLI disagreement.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

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
                "python": "3.14",
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

    def test_locked_flag_accepted(self):
        # locked is a CLI-written boolean (gh teacher assignment lock); the
        # schema must accept both values given the assignment object is
        # additionalProperties:false.
        assert _errors(_manifest(_entry(locked=True))) == []
        assert _errors(_manifest(_entry(locked=False))) == []

    def test_allowed_files_accepted(self):
        # allowed_files is a CLI-written ordered list of gitignore-style
        # patterns; the schema must accept it given the assignment object
        # is additionalProperties:false.
        assert _errors(_manifest(_entry(allowed_files=["*", "!hello.py"]))) == []
        assert _errors(_manifest(_entry(allowed_files=[]))) == []

    def test_submission_mode_accepted(self):
        # Both enum values are legal: writers omit every-push (the wire
        # default) but other clients may write it explicitly, and readers
        # must accept it. Absent is covered by test_minimal_manifest.
        assert _errors(_manifest(_entry(submission_mode="tag"))) == []
        assert _errors(_manifest(_entry(submission_mode="every-push"))) == []

    def test_submission_tags_accepted(self):
        # Milestone tag patterns: literal names and the supported glob
        # characters. Absent is covered by test_minimal_manifest.
        assert _errors(_manifest(_entry(submission_tags=["phase1", "phase2"]))) == []
        assert (
            _errors(
                _manifest(_entry(submission_tags=["v*", "release-[0-9]", "a/b?", "m.**"]))
            )
            == []
        )

    def test_container_with_ubuntu_runs_on(self):
        entry = _entry(runtime={"container": {"image": "x"}, "runs-on": "ubuntu-22.04"})
        assert _errors(_manifest(entry)) == []

    def test_custom_runner_labels(self):
        # Custom / self-hosted runner: runs-on
        # accepts an array of labels, no value allow-list.
        entry = _entry(runtime={"runs-on": ["self-hosted", "gpu"], "python": "3.14"})
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

    @pytest.mark.parametrize("available_from", [
        "2026-09-01T00:00:00-04:00",
        "2026-09-01T00:00:00Z",
        "2026-09-01T00:00:00.500Z",
    ])
    def test_available_from_rfc3339_shapes(self, available_from):
        assert _errors(_manifest(_entry(available_from=available_from))) == []

    def test_available_from_meta_accepted(self):
        entry = _entry(
            available_from="2026-09-01T04:00:00Z",
            available_from_meta={
                "input": "2026-09-01T00:00:00",
                "zone": "America/New_York",
                "offset": "-04:00",
                "source": "auto-detected",
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

    @pytest.mark.parametrize("available_from", [
        "2026-09-01",
        "2026-09-01T00:00:00",
        "next Tuesday",
        "",
    ])
    def test_available_from_must_be_full_rfc3339(self, available_from):
        assert _errors(_manifest(_entry(available_from=available_from))) != []

    def test_bad_available_from_meta(self):
        # Unknown key inside the closed available_from_meta sub-object.
        entry = _entry(
            available_from="2026-09-01T04:00:00Z",
            available_from_meta={"input": "x", "offset": "-04:00", "source": "auto-detected", "tz": "x"},
        )
        assert _errors(_manifest(entry)) != []

    def test_wrong_schema_sentinel(self):
        assert _errors({"schema": "v2", "assignments": []}) != []

    def test_locked_must_be_boolean(self):
        assert _errors(_manifest(_entry(locked="yes"))) != []

    @pytest.mark.parametrize(
        "submission_mode", ["Tag", "every_push", "push", "", None, True]
    )
    def test_bad_submission_mode(self, submission_mode):
        # Only the two enum values are legal; the Go parser normalizes
        # nothing here (unlike autograder), so clients must write exact
        # values. Mirrors contract.SubmissionModes.
        assert _errors(_manifest(_entry(submission_mode=submission_mode))) != []

    @pytest.mark.parametrize(
        "submission_tags",
        [
            ["!v*"],          # excludes are deferred/rejected
            ['ta"g'],         # quote breaks the YAML tags line
            ["has space"],    # whitespace forbidden
            [""],             # empty pattern
            ["a", "a"],       # uniqueItems
            "phase1",         # must be an array, not a bare string
            [f"t{i}" for i in range(21)],  # over maxItems (20)
        ],
    )
    def test_bad_submission_tags(self, submission_tags):
        # Mirrors gh-teacher's ValidateSubmissionTags and the web
        # validateSubmissionTags — the charset is restricted because the
        # patterns are spliced into the shim's quoted-YAML tags line.
        assert _errors(_manifest(_entry(submission_tags=submission_tags))) != []


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

    def test_empty_repo_allows_submission_mode(self):
        # The submission definition is the app's detection rule, not a shim
        # trigger, so a bare repo may set it (no shim triggers on it; the
        # submissions page still counts pushes/tags accordingly). Mirrors Go's
        # relaxed validateEmptyRepoExclusions.
        assert _errors(_manifest(self._bare_entry(submission_mode="tag"))) == []
        assert (
            _errors(_manifest(self._bare_entry(submission_mode="every-push"))) == []
        )

    def test_empty_repo_allows_submission_tags(self):
        # Same detection-definition reasoning as submission_mode.
        assert (
            _errors(_manifest(self._bare_entry(submission_tags=["phase1"]))) == []
        )


class TestNoAutograder:
    # no_autograder is a narrower sibling of empty_repo: it commits no shim but
    # PERMITS a template and the Feedback PR (a templated repo has a baseline
    # commit). It REQUIRES a template (teacher-supplied CI lives in the
    # template), and excludes the grading-adjacent fields, empty_repo, and a
    # non-default autograder. Mirrors Go's validateNoAutograderExclusions.
    def _entry(self, **overrides):
        # Keeps the default template (the asymmetry vs empty_repo). Overrides
        # win over the no_autograder=True default so a test can set it invalid.
        return _entry(**{"no_autograder": True, **overrides})

    def test_no_autograder_accepted_with_template(self):
        assert _errors(_manifest(self._entry())) == []

    def test_no_autograder_permits_feedback_pr(self):
        # Unlike empty_repo, a templated no-autograder repo can open a Feedback
        # PR (it has a baseline commit to diff against).
        assert _errors(_manifest(self._entry(feedback_pr=True))) == []

    def test_no_autograder_false_accepted(self):
        assert _errors(_manifest(_entry(no_autograder=False))) == []

    def test_no_autograder_must_be_boolean(self):
        assert _errors(_manifest(self._entry(no_autograder="yes"))) != []

    def test_no_autograder_requires_template(self):
        # no_autograder is the TEMPLATED teacher-supplied-CI state: the template
        # carries the workflows. A template-less entry is rejected (use
        # empty_repo for a bare repo). The asymmetry's other half of
        # test_no_autograder_permits_feedback_pr.
        entry = self._entry()
        del entry["template"]
        assert _errors(_manifest(entry)) != []

    def test_no_autograder_rejects_empty_repo(self):
        # A bare repo already commits no shim; the two states must not both be
        # set.
        entry = self._entry(empty_repo=True)
        del entry["template"]  # empty_repo also forbids a template
        assert _errors(_manifest(entry)) != []

    def test_no_autograder_rejects_non_default_autograder(self):
        # A non-default autograder means "fetch this Pages workflow" — the
        # opposite of adding no workflow.
        assert _errors(_manifest(self._entry(autograder="io-suite"))) != []

    @pytest.mark.parametrize(
        "field,value",
        [
            ("tests", [{"name": "t", "type": "run", "run": "true", "points": 1}]),
            ("allowed_files", ["*"]),
            ("release_assets", ["report.pdf"]),
            ("pass_threshold", 70),
        ],
    )
    def test_no_autograder_rejects_grading_fields(self, field, value):
        # No shim exists to grade, trigger, or attach assets to.
        assert _errors(_manifest(self._entry(**{field: value}))) != []

    def test_no_autograder_allows_submission_definition(self):
        # The submission definition is the app's detection rule, not a shim
        # trigger, so a no_autograder assignment may set it. Mirrors Go's
        # relaxed validateNoAutograderExclusions.
        assert _errors(_manifest(self._entry(submission_mode="tag"))) == []
        assert (
            _errors(_manifest(self._entry(submission_tags=["phase1", "v*"]))) == []
        )


class TestInitShim:
    # init_shim is the built-in-autograder-on-an-otherwise-empty-repo state: a
    # template-less repo initialized with only the marker + default shim that
    # DOES autograde. It REQUIRES no template and the default autograder, is
    # mutually exclusive with empty_repo/template/no_autograder/non-default
    # autograder, and PERMITS the grading-adjacent fields (it autogrades).
    # Mirrors Go's validateInitShimExclusions.
    def _entry(self, **overrides):
        # Template-less base (init_shim forbids a template).
        base = _entry(**{"init_shim": True, **overrides})
        base.pop("template", None)
        return base

    def test_init_shim_accepted_template_less(self):
        assert _errors(_manifest(self._entry())) == []

    def test_init_shim_permits_grading_fields(self):
        # Unlike empty_repo/no_autograder, init_shim autogrades, so tests +
        # feedback_pr + submission_mode are allowed.
        assert (
            _errors(
                _manifest(
                    self._entry(
                        feedback_pr=True,
                        tests=[
                            {"name": "t", "type": "run", "run": "true", "points": 1}
                        ],
                        submission_mode="tag",
                        pass_threshold=70,
                    )
                )
            )
            == []
        )

    def test_init_shim_false_accepted(self):
        assert _errors(_manifest(_entry(init_shim=False))) == []

    def test_init_shim_must_be_boolean(self):
        assert _errors(_manifest(self._entry(init_shim="yes"))) != []

    def test_init_shim_rejects_template(self):
        entry = self._entry()
        entry["template"] = {"owner": "o", "repo": "t", "branch": "main"}
        assert _errors(_manifest(entry)) != []

    def test_init_shim_rejects_empty_repo(self):
        assert _errors(_manifest(self._entry(empty_repo=True))) != []

    def test_init_shim_rejects_no_autograder(self):
        assert _errors(_manifest(self._entry(no_autograder=True))) != []

    def test_init_shim_rejects_non_default_autograder(self):
        assert _errors(_manifest(self._entry(autograder="io-suite"))) != []


class TestIncludeAllBranches:
    # include_all_branches only affects the templated generate call, so it
    # REQUIRES a template and is mutually exclusive with the template-less states
    # empty_repo/init_shim; compatible with everything else. Mirrors Go's
    # validateIncludeAllBranchesExclusions.
    def _entry(self, **overrides):
        # Keeps the default template (include_all_branches requires one).
        return _entry(**{"include_all_branches": True, **overrides})

    def test_include_all_branches_accepted_with_template(self):
        assert _errors(_manifest(self._entry())) == []

    def test_include_all_branches_permits_no_autograder_and_grading_fields(self):
        assert _errors(_manifest(self._entry(no_autograder=True))) == []
        assert (
            _errors(
                _manifest(
                    self._entry(
                        submission_mode="tag",
                        tests=[
                            {"name": "t", "type": "run", "run": "true", "points": 1}
                        ],
                    )
                )
            )
            == []
        )

    def test_include_all_branches_false_accepted(self):
        assert _errors(_manifest(_entry(include_all_branches=False))) == []

    def test_include_all_branches_must_be_boolean(self):
        assert _errors(_manifest(self._entry(include_all_branches="yes"))) != []

    def test_include_all_branches_requires_template(self):
        entry = self._entry()
        del entry["template"]
        assert _errors(_manifest(entry)) != []

    def test_include_all_branches_rejects_empty_repo(self):
        entry = self._entry(empty_repo=True)
        del entry["template"]  # empty_repo also forbids a template
        assert _errors(_manifest(entry)) != []

    def test_include_all_branches_rejects_init_shim(self):
        entry = self._entry(init_shim=True)
        del entry["template"]  # init_shim also forbids a template
        assert _errors(_manifest(entry)) != []


class TestGrading:
    # `grading` records the teacher's grading intent (off / auto / manual) as a
    # first-class GUI choice. ABSENT reads as auto (today's behavior). manual
    # requires max_points (>= 1, since a 0 max is the ungraded sentinel a
    # gradebook divides by); off/auto forbid max_points. The field is orthogonal
    # to the autograding tri-state and to collection, so it is intentionally NOT
    # coupled to empty_repo/no_autograder by any conditional.
    def test_grading_absent_accepted(self):
        # Covered by test_minimal_manifest, pinned here for intent.
        assert _errors(_manifest(_entry())) == []

    def test_grading_off_accepted(self):
        assert _errors(_manifest(_entry(grading={"mode": "off"}))) == []

    def test_grading_auto_accepted(self):
        assert _errors(_manifest(_entry(grading={"mode": "auto"}))) == []

    def test_grading_manual_with_max_points_accepted(self):
        assert (
            _errors(_manifest(_entry(grading={"mode": "manual", "max_points": 100})))
            == []
        )

    def test_grading_manual_min_max_points_accepted(self):
        assert (
            _errors(_manifest(_entry(grading={"mode": "manual", "max_points": 1})))
            == []
        )

    def test_grading_manual_requires_max_points(self):
        assert _errors(_manifest(_entry(grading={"mode": "manual"}))) != []

    def test_grading_manual_rejects_zero_max_points(self):
        # 0 is the ungraded sentinel the submissions UI divides by; a configured
        # manual max must be >= 1.
        assert (
            _errors(_manifest(_entry(grading={"mode": "manual", "max_points": 0})))
            != []
        )

    @pytest.mark.parametrize("mode", ["off", "auto"])
    def test_grading_non_manual_forbids_max_points(self, mode):
        assert (
            _errors(_manifest(_entry(grading={"mode": mode, "max_points": 50}))) != []
        )

    def test_grading_requires_mode(self):
        assert _errors(_manifest(_entry(grading={}))) != []

    @pytest.mark.parametrize("mode", ["Manual", "none", "", None, True])
    def test_grading_bad_mode_rejected(self, mode):
        assert _errors(_manifest(_entry(grading={"mode": mode}))) != []

    def test_grading_unknown_key_rejected(self):
        # The grading object is additionalProperties:false.
        assert (
            _errors(_manifest(_entry(grading={"mode": "auto", "weight": 2}))) != []
        )

    def test_grading_manual_coexists_with_no_autograder(self):
        # grading is orthogonal to the autograding tri-state: a teacher-supplied
        # CI (no_autograder) assignment graded manually is a legal combination —
        # no conditional couples the two.
        entry = _entry(no_autograder=True, grading={"mode": "manual", "max_points": 10})
        assert _errors(_manifest(entry)) == []


def _release_assets_errors(value):
    return _errors(_manifest(_entry(release_assets=value)))


def _ecmascript_release_assets_pattern_accepts(value):
    pattern = _SCHEMA["$defs"]["assignment"]["properties"]["release_assets"]["items"]["pattern"]
    script = (
        "const [pattern, encoded] = process.argv.slice(1);"
        "const value = JSON.parse(encoded);"
        "process.stdout.write(JSON.stringify([new RegExp(pattern).test(value),"
        "new RegExp(pattern, 'u').test(value)]));"
    )
    result = subprocess.run(
        ["node", "-e", script, pattern, json.dumps(value)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize(
    "paths",
    [
        [],
        ["report.pdf"],
        ["plots/chart.png", ".github/report.pdf"],
        ["generated*/report.pdf", "plots[2026]/chart.png"],
        ["nested/.git/report.pdf", "résumés 2026/summary.txt"],
        ["archive..old/report.pdf"],
        ["a" * 251 + ".pdf"],
        ["a/report.pdf", "b/Report.pdf"],
    ],
)
def test_release_assets_accepts_exact_paths(paths):
    assert _release_assets_errors(paths) == []


def test_release_assets_accepts_exact_cap():
    assert _release_assets_errors([f"f{i}.pdf" for i in range(50)]) == []


@pytest.mark.parametrize(
    "value",
    [
        None,
        [f"f{i}.pdf" for i in range(51)],
        ["report.pdf", "report.pdf"],
        [""], ["  "], ["/tmp/report.pdf"], ["C:/report.pdf"],
        [r"plots\\chart.png"], ["plots//chart.png"], ["./report.pdf"],
        ["plots/./chart.png"], ["../report.pdf"], ["plots/../report.pdf"],
        ["plots/"], ["a\nreport.pdf"], ["a\x7freport.pdf"],
        ["a\u0085report.pdf"],
        [".git/report.pdf"], [".GiT/report.pdf"],
        [".report.pdf"], ["report.pdf."], ["*.pdf"], ["résumé.pdf"],
        ["a/" + "x" * 252 + ".pdf"],
        ["result.json"], ["nested/RESULT.JSON"],
        ["release-body.md"], ["nested/Release-Body.MD"],
        ["report..pdf"],
    ],
)
def test_release_assets_rejects_invalid_shape(value):
    assert _release_assets_errors(value)


@pytest.mark.parametrize("path", ["\ud800/report.pdf", "\udc00/report.pdf"])
def test_release_assets_ecmascript_rejects_unpaired_surrogates(path):
    assert _release_assets_errors([path])
    assert _ecmascript_release_assets_pattern_accepts(path) == [False, False]


@pytest.mark.parametrize("separator", ["\u2028", "\u2029"])
@pytest.mark.parametrize("surrogate", ["\ud800", "\udc00"])
def test_release_assets_ecmascript_rejects_surrogate_after_line_separator(
    separator, surrogate
):
    path = f"x{separator}{surrogate}/report.pdf"
    assert _release_assets_errors([path])
    assert _ecmascript_release_assets_pattern_accepts(path) == [False, False]


def test_release_assets_ecmascript_accepts_surrogate_pair():
    path = "😀/report.pdf"
    assert _release_assets_errors([path]) == []
    assert _ecmascript_release_assets_pattern_accepts(path) == [True, True]


def test_release_assets_schema_leaves_basename_uniqueness_to_writers():
    assert _release_assets_errors(["a/report.pdf", "b/report.pdf"]) == []


@pytest.mark.parametrize(
    "path",
    ["dir\u2028/result.json", "dir\u2029/release-body.md"],
)
def test_release_assets_ecmascript_rejects_reserved_basename_after_line_separator(path):
    assert _release_assets_errors([path])
    assert _ecmascript_release_assets_pattern_accepts(path) == [False, False]


@pytest.mark.parametrize("value", [[], ["report.pdf"]])
def test_release_assets_property_is_forbidden_on_empty_repo(value):
    bare = _entry(empty_repo=True, feedback_pr=False)
    del bare["template"]
    assert _errors(_manifest(bare)) == []
    assert _errors(_manifest({**bare, "release_assets": value}))
