"""Keeps the result/scores/tests/classroom JSON Schemas honest.

Companion to test_assignments_schema.py. These schemas let non-CLI clients
(the GUI) validate the artifacts the system produces without hand-porting the
Go/Python validators. Two kinds of check:

  1. Accepts/rejects: pin each schema against real emitted shapes and malformed
     ones, so schema drift fails CI rather than surfacing as a GUI/CLI
     disagreement.
  2. Cross-validator parity: feed result.json payloads through BOTH the
     result-v1 schema and the authoritative Python validators (runner.py /
     collect_scores.py validate_result) and assert they agree on rules the
     schema CAN express. Rules JSON Schema can't express (identity match,
     mode-dependent assignment_type, owner match, score<=max-score) are
     enumerated below and excluded — the code validators own them.
"""

from __future__ import annotations

import json
import pathlib

import pytest
from jsonschema import Draft202012Validator

# Reuse conftest's importlib loader (the established skeleton_tests pattern)
# rather than re-implementing it. collect_scores is exposed directly; runner.py
# is loaded on demand since this suite doesn't import it by default.
from conftest import _SCRIPTS_DIR, _load_module
from conftest import collect_scores as cs

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_SCHEMAS = _REPO_ROOT / "schemas"

# runner.py isn't loaded by skeleton_tests/conftest, so load it here for the
# result-validator parity.
runner = _load_module("runner", _SCRIPTS_DIR / "runner.py")


def _validator(filename: str) -> Draft202012Validator:
    schema = json.loads((_SCHEMAS / filename).read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _errs(validator: Draft202012Validator, doc) -> list[str]:
    return [e.message for e in validator.iter_errors(doc)]


# --- result/v1 ---------------------------------------------------------------

RESULT_V = _validator("result-v1.schema.json")

_RESULT_BASE = {
    "schema": "classroom50/result/v1",
    "classroom": "cs-principles",
    "assignment": "hello",
    "assignment_type": "individual",
    "owner": "alice",
    "submission": "submit/2026-06-01T14-32-05Z-a1b2c3d",
    "commit": "https://github.com/x/commit/abc",
    "release": "https://github.com/x/releases/tag/y",
    "review": "https://github.com/x/commit/abc",
    "datetime": "2026-06-01T14:33:11Z",
    "score": 0,
    "max-score": 0,
    "tests": [],
}


def _result(**overrides):
    doc = dict(_RESULT_BASE)
    doc.update(overrides)
    return doc


class TestResultSchema:
    def test_empty_result_accepted(self):
        assert _errs(RESULT_V, _result()) == []

    def test_graded_result_with_tests_accepted(self):
        doc = _result(
            score=18,
            max_score=20,
            tests=[{"test-name": "t1", "passed": True, "score": 18, "max-score": 20}],
        )
        # `max_score` key fix-up: the field is "max-score" on the wire.
        doc["max-score"] = doc.pop("max_score")
        assert _errs(RESULT_V, doc) == []

    def test_group_result_accepted(self):
        # The schema is mode-independent on its closed shape: a group
        # result (assignment_type="group") is structurally valid. The
        # difference between individual and group is the assignment_type
        # enum value; the credited member list lives in scores.json, not
        # here.
        assert _errs(RESULT_V, _result(assignment_type="group")) == []

    def test_extra_per_test_diagnostic_field_preserved(self):
        doc = _result(tests=[{
            "test-name": "t1", "passed": False, "score": 0, "max-score": 5,
            "output": "AssertionError", "message": "expected 3 got 4",
        }])
        assert _errs(RESULT_V, doc) == []

    def test_submitted_by_accepted(self):
        # The pusher-identity block is optional and, when present, must
        # carry a non-empty username and an int-or-null id.
        assert _errs(RESULT_V, _result(submitted_by={"username": "bob", "id": 222})) == []
        assert _errs(RESULT_V, _result(submitted_by={"username": "bob", "id": None})) == []

    def test_graded_at_accepted(self):
        # Optional: the "last graded" wall-clock instant (moves on regrade),
        # distinct from `datetime` (the fixed submission instant).
        assert _errs(RESULT_V, _result(graded_at="2026-06-02T09:00:00Z")) == []

    def test_graded_at_malformed_rejected(self):
        # Same strict UTC-Z pattern as datetime.
        assert _errs(RESULT_V, _result(graded_at="2026-06-02 09:00:00")) != []

    def test_submitted_by_malformed_rejected(self):
        assert _errs(RESULT_V, _result(submitted_by={"id": 222})) != []            # no username
        assert _errs(RESULT_V, _result(submitted_by={"username": "", "id": 1})) != []  # empty
        assert _errs(RESULT_V, _result(submitted_by={"username": "b", "id": "x"})) != []  # str id

    @pytest.mark.parametrize("doc", [
        {"schema": "classroom50/result/v2"},          # wrong sentinel
        {"owner": ""},                                 # empty owner
        {"assignment_type": "bogus"},                  # not in enum
        {"submission": "main"},                        # not submit/*
        {"score": -1},                                 # negative
        {"datetime": "2026-06-01 14:33:11"},           # not RFC3339 UTC
    ])
    def test_malformed_rejected(self, doc):
        assert _errs(RESULT_V, _result(**doc)) != []

    def test_unknown_top_level_key_rejected(self):
        assert _errs(RESULT_V, _result(extra="x")) != []


# --- result/v1 cross-validator parity ---------------------------------------
#
# The schema and the code validators (runner.py / collect_scores.py
# validate_result) must agree on the rules BOTH layers check. Two classes of
# rule are deliberately EXCLUDED from the equality assertion:
#
#   1. Rules the schema can't express (the code validators own them):
#      identity match; mode-dependent assignment_type; score <= max-score and
#      per-test score <= max-score.
#   2. Rules the schema expresses MORE STRICTLY than the code validators
#      (schema is the canonical closed form; the code is deliberately lenient):
#      additionalProperties:false; the exact UTC datetime pattern. Asserted in
#      test_schema_stricter_than_code, NOT folded into the equality table.
#
# So the parity table keeps identity + scores valid, no extra keys, and a
# canonical datetime, varying only rules both layers should agree on.

_PARITY_CLASSROOM = "cs-principles"
_PARITY_ASSIGNMENT = "hello"
_PARITY_USERNAME = "alice"


def _schema_ok(doc) -> bool:
    return _errs(RESULT_V, doc) == []


def _runner_ok(doc) -> bool:
    return runner.validate_result(
        doc, classroom=_PARITY_CLASSROOM, assignment=_PARITY_ASSIGNMENT,
        owner=_PARITY_USERNAME,
    ) is None


def _collect_ok(doc) -> bool:
    try:
        cs.validate_result(doc, _PARITY_CLASSROOM, _PARITY_ASSIGNMENT, _PARITY_USERNAME)
        return True
    except ValueError:
        return False


@pytest.mark.parametrize("doc", [
    _RESULT_BASE,                                                   # canonical valid
    {**_RESULT_BASE, "tests": [
        {"test-name": "t", "passed": True, "score": 1, "max-score": 1}]},
    {**_RESULT_BASE, "schema": "classroom50/result/v2"},           # bad sentinel
    {**_RESULT_BASE, "submission": "nope"},                        # bad submission
    {**_RESULT_BASE, "score": "ten"},                              # bad score type
    {**_RESULT_BASE, "tests": "not-a-list"},                       # bad tests type
    {**_RESULT_BASE, "tests": [{"test-name": "t", "passed": "yes",
                                "score": 1, "max-score": 1}]},     # bad passed type
])
def test_result_schema_matches_code_validators(doc):
    # The schema, the runner validator, and the collect validator must
    # agree on every expressible rule. (All docs keep identity + scores
    # valid so the inexpressible rules don't diverge the verdict.)
    schema_verdict = _schema_ok(doc)
    assert _runner_ok(doc) == schema_verdict, (
        f"runner vs schema disagree on {doc!r}: runner={_runner_ok(doc)} schema={schema_verdict}"
    )
    assert _collect_ok(doc) == schema_verdict, (
        f"collect vs schema disagree on {doc!r}: collect={_collect_ok(doc)} schema={schema_verdict}"
    )


def test_f1_group_result_accepted_by_runner_and_collect():
    # A group autograder stamps assignment_type="group". The schema
    # accepts it (mode-independent closed shape); the runner in group
    # mode and the collector in group mode must BOTH accept it.
    group_doc = {**_RESULT_BASE, "assignment_type": "group"}
    assert _schema_ok(group_doc)
    assert runner.validate_result(
        group_doc, classroom=_PARITY_CLASSROOM, assignment=_PARITY_ASSIGNMENT,
        is_group=True, owner=_PARITY_USERNAME,
    ) is None
    # collect (group mode) also accepts it — owner present and matches.
    cs.validate_result(
        group_doc, _PARITY_CLASSROOM, _PARITY_ASSIGNMENT, _PARITY_USERNAME, is_group=True
    )


@pytest.mark.parametrize("mode, want", [
    ("group", True),
    ("GROUP", True),
    (" group ", True),
    ("Group", True),
    ("individual", False),
    ("", False),
    (None, False),
    ("groups", False),
    ("teamwork", False),
])
def test_mode_is_group_env_derivation(mode, want):
    # The MODE env -> is_group wiring must fail closed: only an exact
    # 'group' (case/space-insensitive) enables the looser group rule;
    # everything else stays individual (strict). Pins the string parsing
    # the Go test (grade.env.MODE) and the validator tests can't see.
    assert runner.mode_is_group(mode) is want


def test_f1_assignment_type_mismatch_rejected_by_runner_and_collect():
    # The mode contract is enforced: an individual-typed result validated
    # in group mode is rejected by both code validators (and vice versa).
    individual_doc = {**_RESULT_BASE, "assignment_type": "individual"}
    assert runner.validate_result(
        individual_doc, classroom=_PARITY_CLASSROOM, assignment=_PARITY_ASSIGNMENT,
        is_group=True, owner=_PARITY_USERNAME,
    ) is not None
    with pytest.raises(ValueError):
        cs.validate_result(
            individual_doc, _PARITY_CLASSROOM, _PARITY_ASSIGNMENT, _PARITY_USERNAME, is_group=True
        )


@pytest.mark.parametrize("doc, why", [
    ({**_RESULT_BASE, "extra": "x"},
     "extra top-level key: schema additionalProperties:false rejects; code validators only check known keys"),
    ({**_RESULT_BASE, "datetime": "2026-06-01T14:33:11+00:00"},
     "non-Z UTC offset: schema datetime pattern rejects; code only requires a non-empty string"),
    ({**_RESULT_BASE, "datetime": "2026-06-01T14:33:11.5Z"},
     "fractional seconds: same — schema-stricter than code"),
])
def test_schema_stricter_than_code(doc, why):
    # Documents the KNOWN, intentional divergence: the schema is the
    # canonical closed form and pins make_result's exact output, while the
    # code validators are deliberately lenient. The schema must REJECT
    # while BOTH code validators ACCEPT. If this ever flips, the parity
    # docstring's scoping is wrong and must be revisited.
    assert not _schema_ok(doc), f"expected schema to reject ({why})"
    assert _runner_ok(doc), f"expected runner to accept ({why})"
    assert _collect_ok(doc), f"expected collect to accept ({why})"


# --- results/v1 (per-repo results.json envelope) ----------------------------

RESULTS_V = _validator("results-v1.schema.json")


class TestResultsSchema:
    # results.json (written by `gh teacher download`) is a bare array of
    # {submission_tag, result} envelopes, newest first; `result` is a raw
    # result/v1 payload (still carrying `assignment`) or null. The validator
    # call above runs check_schema, so the schema itself is also pinned valid.

    def test_envelope_array_with_payload_and_null_accepted(self):
        doc = [
            {"submission_tag": "submit/2026-06-02T10-00-00Z-aaaa", "result": _result(**{"max-score": 0})},
            {"submission_tag": "submit/2026-06-01T10-00-00Z-bbbb", "result": None},
        ]
        # _result() omits the bucket-key drop — a results.json `result` is the
        # RAW payload and still carries `assignment`, which _RESULT_BASE has.
        assert _errs(RESULTS_V, doc) == []

    def test_empty_array_accepted(self):
        assert _errs(RESULTS_V, []) == []

    @pytest.mark.parametrize("doc, why", [
        ({"submission_tag": "submit/x", "result": None}, "top-level must be an array, not an object"),
        ([{"result": None}], "envelope missing submission_tag"),
        ([{"submission_tag": "submit/x"}], "envelope missing result"),
        ([{"submission_tag": "v1.0.0", "result": None}], "submission_tag not submit/*"),
        ([{"submission_tag": "submit/x", "result": None, "extra": 1}], "extra envelope key rejected"),
        ([{"submission_tag": "submit/x", "result": {"schema": "classroom50/result/v2"}}], "result wrong sentinel"),
        ([{"submission_tag": "submit/x", "result": {}}], "result missing required fields"),
    ])
    def test_malformed_rejected(self, doc, why):
        assert _errs(RESULTS_V, doc) != [], f"expected rejection: {why}"


def test_results_v1_payload_required_matches_result_v1():
    # The results.json `result` payload is the RAW result/v1 (it still carries
    # `assignment`, unlike a scores.json submission record). Pin its required
    # set equal to result-v1's so a result/v1 field change can't silently
    # drift the results-v1 envelope contract.
    result = json.loads((_SCHEMAS / "result-v1.schema.json").read_text())
    results = json.loads((_SCHEMAS / "results-v1.schema.json").read_text())
    payload = results["$defs"]["resultPayload"]
    assert set(payload["required"]) == set(result["required"]), (
        f"results-v1 resultPayload.required {sorted(payload['required'])} != "
        f"result-v1 required {sorted(result['required'])}"
    )


# --- scores/v1 ---------------------------------------------------------------

SCORES_V = _validator("scores-v1.schema.json")

_SUBMISSION_RECORD = {
    "schema": "classroom50/result/v1",
    "classroom": "cs-principles",
    "assignment_type": "individual",
    "owner": "alice",
    "submission": "submit/2026-06-01T14-32-05Z-a1b2c3d",
    "commit": "c", "release": "r", "review": "v",
    "datetime": "2026-06-01T14:33:11Z",
    "score": 18, "max-score": 20,
    "tests": [{"test-name": "t1", "passed": True, "score": 18, "max-score": 20}],
}


def _entry(**overrides):
    """A canonical gradebook entry: owner identity + a one-element
    submissions history. Overrides patch the entry (not the record)."""
    entry = {
        "owner": "alice",
        "submissions": [dict(_SUBMISSION_RECORD)],
    }
    entry.update(overrides)
    return entry


def _scores(buckets):
    """Wrap a {slug: assignmentBucket} map in the scores/v1 root."""
    return {"schema": "classroom50/scores/v1", "assignments": buckets}


def _individual_bucket(entries):
    return {"type": "individual", "entries": entries}


class TestScoresSchema:
    def test_scaffold_empty_accepted(self):
        assert _errs(SCORES_V, {"schema": "classroom50/scores/v1", "assignments": {}}) == []

    def test_rows_with_late_override_group_accepted(self):
        late_record = {**_SUBMISSION_RECORD, "late": False}
        group_record = {**_SUBMISSION_RECORD, "assignment_type": "group"}
        doc = _scores({
            "hello": _individual_bucket([
                {"owner": "alice", "submissions": [late_record]},
            ]),
            "project": {
                "type": "group",
                "entries": [
                    {
                        "owner": "alice",
                        "member_usernames": ["alice", "bob"],
                        "override": True,
                        "submissions": [group_record],
                    },
                ],
            },
        })
        assert _errs(SCORES_V, doc) == []

    def test_multi_submission_history_accepted(self):
        # An entry with several submissions (newest first) validates.
        older = {**_SUBMISSION_RECORD, "submission": "submit/2026-05-30T10-00-00Z-0000000"}
        doc = _scores({
            "hello": _individual_bucket([
                _entry(submissions=[dict(_SUBMISSION_RECORD), older]),
            ]),
        })
        assert _errs(SCORES_V, doc) == []

    def test_submission_record_with_submitted_by_accepted(self):
        rec = {**_SUBMISSION_RECORD, "submitted_by": {"username": "bob", "id": 222}}
        doc = _scores({"hello": _individual_bucket([_entry(submissions=[rec])])})
        assert _errs(SCORES_V, doc) == []

    def test_entry_missing_submissions_rejected(self):
        # submissions is required and must be non-empty.
        no_subs = {"owner": "alice"}
        empty_subs = {"owner": "alice", "submissions": []}
        for bad in (no_subs, empty_subs):
            assert _errs(SCORES_V, _scores({"hello": _individual_bucket([bad])})) != []

    def test_entry_missing_owner_rejected(self):
        # owner is the stable per-bucket key and is required on an entry.
        bad = {"submissions": [dict(_SUBMISSION_RECORD)]}
        assert _errs(SCORES_V, _scores({"hello": _individual_bucket([bad])})) != []

    def test_submission_record_must_not_carry_assignment_required_fields(self):
        # A submission record is a result/v1 payload minus `assignment`;
        # the record's own required fields (score, datetime, ...) are
        # enforced. A record missing `score` is rejected.
        bad_record = {k: v for k, v in _SUBMISSION_RECORD.items() if k != "score"}
        doc = _scores({"hello": _individual_bucket([_entry(submissions=[bad_record])])})
        assert _errs(SCORES_V, doc) != []

    @pytest.mark.parametrize("doc", [
        {"schema": "classroom50/scores/v2", "assignments": {}},        # bad sentinel
        {"schema": "classroom50/scores/v1", "assignments": []},        # array, not an object map
        {"schema": "classroom50/scores/v1", "assignments": {"Bad-Slug": {"type": "individual", "entries": []}}},  # bad slug key
        {"schema": "classroom50/scores/v1", "assignments": {"hello": {"entries": []}}},  # bucket missing type
        {"schema": "classroom50/scores/v1", "assignments": {"hello": {"type": "individual", "entries": {}}}},  # entries not an array
    ])
    def test_malformed_rejected(self, doc):
        assert _errs(SCORES_V, doc) != []


# --- tests/v1 ----------------------------------------------------------------

TESTS_V = _validator("tests-v1.schema.json")
_KIT_TESTS = json.loads((_REPO_ROOT / "examples" / "declarative-tests" / "tests.json").read_text())


class TestTestsSchema:
    def test_example_kit_accepted(self):
        assert _errs(TESTS_V, {"schema": "classroom50/tests/v1", "tests": _KIT_TESTS}) == []

    def test_materializer_output_accepted(self):
        # tests.json is exactly {schema, tests:[...]} with the entry's
        # tests copied verbatim — mirror what materialize_tests writes.
        payload = {"schema": cs.RESULT_SCHEMA_V1.replace("result", "tests"), "tests": _KIT_TESTS}
        # sentinel sanity: the derived string must equal the real one.
        assert payload["schema"] == "classroom50/tests/v1"
        assert _errs(TESTS_V, payload) == []

    @pytest.mark.parametrize("bad", [
        {"name": "t", "type": "io", "run": "r"},                       # io needs comparison
        {"name": "t", "type": "io", "run": "r", "comparison": "exact", "exit-code": 1},  # exit-code on io
        {"name": "t", "type": "run", "run": "x", "points": 11000},     # out of range
    ])
    def test_bad_test_rejected(self, bad):
        assert _errs(TESTS_V, {"schema": "classroom50/tests/v1", "tests": [bad]}) != []


def test_tests_v1_test_def_matches_assignments_v1():
    # The materializer copies assignment `tests` items verbatim, so the
    # tests-v1 `test` $def MUST equal assignments-v1's `test` $def. Pin it
    # structurally so the two can't drift.
    assignments = json.loads((_SCHEMAS / "assignments-v1.schema.json").read_text())
    tests = json.loads((_SCHEMAS / "tests-v1.schema.json").read_text())
    assert tests["$defs"]["test"] == assignments["$defs"]["test"], (
        "tests-v1 #/$defs/test drifted from assignments-v1 #/$defs/test"
    )


def test_scores_v1_submission_record_matches_result_v1_minus_assignment():
    # Each scores.json submission record is a result/v1 payload minus
    # `assignment` (the bucket key). Pin the relationship structurally —
    # mirroring the tests-v1<->assignments-v1 guard — so a result-v1 field
    # change can't silently drift the scores submission-record contract.
    result = json.loads((_SCHEMAS / "result-v1.schema.json").read_text())
    scores = json.loads((_SCHEMAS / "scores-v1.schema.json").read_text())
    record = scores["$defs"]["submissionRecord"]

    # The record requires exactly result-v1's required fields, minus `assignment`.
    want_required = set(result["required"]) - {"assignment"}
    assert set(record["required"]) == want_required, (
        f"scores-v1 submissionRecord required {sorted(record['required'])} != result-v1 "
        f"required minus 'assignment' {sorted(want_required)}"
    )
    # The shared result fields the record restates must keep result-v1's
    # validation rules (ignore `description` prose — the record annotates some
    # fields differently on purpose).
    def _rules(d):
        return {k: v for k, v in d.items() if k != "description"}
    for field in ("schema", "classroom", "assignment_type", "owner",
                  "submission", "commit", "release", "review",
                  "datetime", "score", "max-score"):
        assert _rules(record["properties"][field]) == _rules(result["properties"][field]), (
            f"scores-v1 submissionRecord.{field} drifted from result-v1.{field}"
        )
    # The record's per-test shape must match result-v1's testResult def.
    assert scores["$defs"]["testResult"] == result["$defs"]["testResult"], (
        "scores-v1 #/$defs/testResult drifted from result-v1 #/$defs/testResult"
    )
    # The optional `submitted_by` block is inlined in scores-v1 (not a
    # cross-file $ref); pin it equal to result-v1's $defs/submittedBy so a
    # future result-v1 change can't silently desync the GUI's scores.json
    # validation. Compare structure only (descriptions differ by design).
    def _strip_desc(d):
        if isinstance(d, dict):
            return {k: _strip_desc(v) for k, v in d.items() if k != "description"}
        if isinstance(d, list):
            return [_strip_desc(v) for v in d]
        return d
    assert _strip_desc(scores["$defs"]["submissionRecord"]["properties"]["submitted_by"]) == _strip_desc(
        result["$defs"]["submittedBy"]
    ), "scores-v1 submissionRecord.submitted_by drifted from result-v1 #/$defs/submittedBy"


def test_scores_v1_entry_keys_on_owner_and_carries_submissions():
    # An entry's structural contract: required owner + a non-empty
    # submissions history; each item is the submissionRecord shape.
    scores = json.loads((_SCHEMAS / "scores-v1.schema.json").read_text())
    entry = scores["$defs"]["entry"]
    assert set(entry["required"]) == {"owner", "submissions"}
    assert entry["properties"]["submissions"]["items"]["$ref"] == "#/$defs/submissionRecord"
    assert entry["properties"]["submissions"]["minItems"] == 1


# --- classroom/v1 ------------------------------------------------------------

CLASSROOM_V = _validator("classroom-v1.schema.json")


class TestClassroomSchema:
    def test_hand_authored_accepted(self):
        doc = {"schema": "classroom50/classroom/v1", "name": "CS Principles",
               "short_name": "cs-principles", "term": "Fall 2026", "org": "cs50"}
        assert _errs(CLASSROOM_V, doc) == []

    def test_migrated_accepted(self):
        doc = {
            "schema": "classroom50/classroom/v1", "name": "CS", "short_name": "cs",
            "term": "", "org": "cs50",
            "migrated_from": {
                "source": "github-classroom", "classroom_id": 42,
                "original_name": "CS", "original_org_login": "old",
                "url": "https://classroom.github.com/classrooms/42",
                "migrated_at": "2026-01-01T00:00:00Z",
            },
        }
        assert _errs(CLASSROOM_V, doc) == []

    def test_team_block_accepted(self):
        # `gh teacher classroom add`/`migrate` write the per-classroom
        # team ref; the schema must accept it (matches classroomJSON.Team
        # / teamRef in cli/gh-teacher).
        doc = {
            "schema": "classroom50/classroom/v1", "name": "CS Principles",
            "short_name": "cs-principles", "term": "Fall 2026", "org": "cs50",
            "team": {"id": 4242, "slug": "classroom50-cs-principles"},
        }
        assert _errs(CLASSROOM_V, doc) == []

    def test_staff_teams_block_accepted(self):
        # The schema must accept the web-authored `teams` staff-team block.
        doc = {
            "schema": "classroom50/classroom/v1", "name": "CS Principles",
            "short_name": "cs-principles", "term": "Fall 2026", "org": "cs50",
            "teams": {
                "instructor": {"id": 11, "slug": "classroom50-cs-principles-instructor"},
                "ta": {"id": 12, "slug": "classroom50-cs-principles-ta"},
            },
        }
        assert _errs(CLASSROOM_V, doc) == []

    def test_staff_teams_partial_block_accepted(self):
        # Each sub-team is optional: a classroom may carry only one role.
        doc = {
            "schema": "classroom50/classroom/v1", "name": "X",
            "short_name": "cs1", "term": "", "org": "o",
            "teams": {"instructor": {"id": 11, "slug": "classroom50-cs1-instructor"}},
        }
        assert _errs(CLASSROOM_V, doc) == []

    @pytest.mark.parametrize("teams, why", [
        ({"instructor": {"slug": "classroom50-cs1-instructor"}}, "teamRef missing id"),
        ({"instructor": {"id": 11}}, "teamRef missing slug"),
        ({"instructor": {"id": 11, "slug": "x", "extra": 1}}, "teamRef extra key"),
        ({"owner": {"id": 11, "slug": "classroom50-cs1-owner"}}, "unknown role key"),
    ])
    def test_staff_teams_malformed_rejected(self, teams, why):
        doc = {
            "schema": "classroom50/classroom/v1", "name": "X",
            "short_name": "cs1", "term": "", "org": "o", "teams": teams,
        }
        assert _errs(CLASSROOM_V, doc) != [], f"expected rejection: {why}"

    @pytest.mark.parametrize("doc", [
        {"schema": "classroom50/classroom/v2", "name": "X", "short_name": "x", "term": "", "org": "o"},
        {"schema": "classroom50/classroom/v1", "name": "X", "short_name": "Bad_Name", "term": "", "org": "o"},
        {"schema": "classroom50/classroom/v1", "name": "X", "short_name": "x", "term": "", "org": "o", "extra": 1},
    ])
    def test_malformed_rejected(self, doc):
        assert _errs(CLASSROOM_V, doc) != []


# --- repo-config/v1 ----------------------------------------------------------

REPO_CONFIG_V = _validator("repo-config-v1.schema.json")

_REPO_CONFIG_V1 = {
    "schema": "classroom50/repo-config/v1",
    "classroom": "cs-principles",
    "assignment": "hello",
    "owner": {"username": "alice", "id": 12345, "accepted_at": "2026-06-01T14:33:11Z"},
    "source": {"owner": "cs50", "owner_id": 99, "repo": "hello-template", "branch": "main"},
}


class TestRepoConfigSchema:
    # .classroom50.yaml is written by BOTH the gh-student CLI and the web GUI.
    # All keys except classroom/assignment are optional (pre-v1 files predate
    # schema/owner/source-id), and the schema is intentionally open (the GUI
    # reader ignores unknown keys; historical files may carry legacy blocks).

    def test_full_v1_accepted(self):
        assert _errs(REPO_CONFIG_V, _REPO_CONFIG_V1) == []

    def test_owner_id_null_accepted(self):
        doc = {**_REPO_CONFIG_V1, "owner": {"username": "alice", "id": None}}
        assert _errs(REPO_CONFIG_V, doc) == []

    def test_source_owner_id_null_accepted(self):
        doc = {
            **_REPO_CONFIG_V1,
            "source": {"owner": "cs50", "owner_id": None, "repo": "t", "branch": "main"},
        }
        assert _errs(REPO_CONFIG_V, doc) == []

    def test_pre_v1_minimal_accepted(self):
        # An older CLI-authored file: just identity, no schema/owner/source.
        assert _errs(REPO_CONFIG_V, {"classroom": "cs-principles", "assignment": "hello"}) == []

    def test_pre_v1_with_legacy_key_accepted(self):
        # Historical files carried since-removed top-level blocks (config:,
        # autograde:). The open schema must still validate them, matching the
        # Go ReadConfig which tolerates unknown keys.
        doc = {"classroom": "cs", "assignment": "hello", "config": {"x": 1}, "autograde": True}
        assert _errs(REPO_CONFIG_V, doc) == []

    def test_template_less_omits_source_accepted(self):
        doc = {
            "schema": "classroom50/repo-config/v1",
            "classroom": "cs",
            "assignment": "solo",
            "owner": {"username": "alice", "id": 7},
        }
        assert _errs(REPO_CONFIG_V, doc) == []

    @pytest.mark.parametrize("doc, why", [
        ({"assignment": "hello"}, "missing classroom"),
        ({"classroom": "cs"}, "missing assignment"),
        ({**_REPO_CONFIG_V1, "schema": "classroom50/repo-config/v2"}, "wrong sentinel"),
        ({**_REPO_CONFIG_V1, "owner": {"username": "alice", "id": "12345"}}, "string id, not number"),
        ({**_REPO_CONFIG_V1, "source": {"owner": "cs50", "owner_id": "99"}}, "string owner_id"),
        ({**_REPO_CONFIG_V1, "owner": {"id": 1}}, "owner missing username"),
        ({**_REPO_CONFIG_V1, "owner": {"username": "", "id": 1}}, "empty owner username"),
        ({"classroom": "", "assignment": "hello"}, "empty classroom"),
    ])
    def test_malformed_rejected(self, doc, why):
        assert _errs(REPO_CONFIG_V, doc) != [], f"expected rejection: {why}"

    def test_render_shape_validates_parity_pin(self):
        # Parity pin (mirrors test_results_v1_payload_required_matches_result_v1):
        # a dict mirroring the CLI's Render() field set for a full v1 Config must
        # validate, so a Go-side field rename not reflected here surfaces in CI.
        # (pytest can't invoke Go's Render(); metadata_test.go pins the Go side.)
        rendered_shape = {
            "schema": "classroom50/repo-config/v1",
            "classroom": "cs-principles",
            "assignment": "hello",
            "owner": {"username": "alice", "id": 12345, "accepted_at": "2026-06-01T14:33:11Z"},
            "source": {"owner": "cs50", "owner_id": 99, "repo": "hello-template", "branch": "main"},
        }
        assert _errs(REPO_CONFIG_V, rendered_shape) == []
