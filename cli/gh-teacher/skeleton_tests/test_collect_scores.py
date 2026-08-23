"""Pure-helper tests for `collect_scores.py`.

The HTTP / GitHub-API layer is exercised end-to-end by the functional smoke
test against a live classroom; these focus on the data-shape invariants the
loop depends on: schema validation, override-respect, atomic write semantics,
the roster CSV parser, and the deterministic repo-name formula.
"""

from __future__ import annotations

import csv
import json
import os
import pathlib
import re

import pytest

from conftest import collect_scores as cs
from conftest import github_http_error as http_error
from conftest import FakeResponse


# The exact `collected_at` shape the scores-v1 schema (and every reader —
# Go/TS) enforces: UTC only, seconds precision, trailing `Z`. Stricter than
# cs.RFC3339_RE, which also accepts offsets and fractional seconds — so a drift
# of utc_now_iso() to an isoformat()-style output would satisfy RFC3339_RE yet
# write a document the schema and the other tools reject. Assert the writer's
# output against THIS pattern, matching the schema's collected_at pattern.
SCHEMA_UTC_Z_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$")


# Helpers ---------------------------------------------------------------------


def make_result(
    *,
    classroom: str = "cs-principles",
    assignment: str = "hello",
    username: str = "alice",
    score: int = 10,
    max_score: int = 10,
    submission_tag: str = "submit/2026-06-01T14-32-05Z",
    assignment_type: str = "individual",
    **overrides,
) -> dict:
    """Return a valid v1 result payload, with overrides for the targeted field.
    Carries `owner` (== username, the identity anchor) and `assignment_type`.
    No `usernames` field — who pushed is `submitted_by`, who owns is `owner`."""
    base = {
        "schema": cs.RESULT_SCHEMA_V1,
        "classroom": classroom,
        "assignment": assignment,
        "assignment_type": assignment_type,
        "owner": username,
        "submission": submission_tag,
        "commit": "https://github.com/cs50/cs-principles-hello-alice/commit/abc",
        "release": "https://github.com/cs50/cs-principles-hello-alice/releases/tag/submit%2F2026-06-01T14-32-05Z",
        "review": "https://github.com/cs50/cs-principles-hello-alice/commit/abc",
        "datetime": "2026-06-01T14:33:11Z",
        "score": score,
        "max-score": max_score,
        "tests": [
            {"test-name": "compiles", "passed": True, "score": score, "max-score": max_score},
        ],
    }
    base.update(overrides)
    return base


def stored_record(**kwargs) -> dict:
    """A stored submission record: the result payload minus `assignment`
    (the bucket key). owner + assignment_type are retained."""
    rec = make_result(**kwargs)
    rec.pop("assignment", None)
    return rec


def make_update(*, assignment: str = "hello", assignment_type: str = "individual", **kwargs) -> dict:
    """An apply_updates input entry: a result-shaped record carrying the
    transport hints `_assignment` (bucket slug) and `_type` (mode) that
    apply_updates buckets on and strips on store. owner stays; the bucket key
    `assignment` is dropped."""
    rec = make_result(assignment=assignment, assignment_type=assignment_type, **kwargs)
    rec.pop("assignment", None)
    rec["_assignment"] = assignment
    rec["_type"] = assignment_type
    return rec


def write_roster(path, rows: list[dict[str, str]]) -> None:
    """Write a roster CSV at `path` with the full canonical header (including
    role). Each row dict only needs the fields the test cares about; missing
    fields default to ''."""
    with path.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(cs.ROSTER_REQUIRED_COLUMNS), extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in cs.ROSTER_REQUIRED_COLUMNS})


def stub_team_members(monkeypatch, logins: list[str]) -> None:
    """Stub the team-member listing so collect_classroom's team-driven username
    source yields `logins` (collection is team-driven; the classroom team, not
    the roster, provides the pairs)."""
    monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: list(logins))


def stub_team_members_by_slug(monkeypatch, by_slug: dict[str, list[str]]) -> None:
    """Stub list_team_member_logins to return per-team-slug logins, so a test
    can give the student team and each staff team distinct members. An unknown
    slug yields []. The signature is
    list_team_member_logins(api_url, org, team_slug, token)."""

    def fake(api_url, org, team_slug, token):
        return list(by_slug.get(team_slug, []))

    monkeypatch.setattr(cs, "list_team_member_logins", fake)


def write_minimal_classroom(root: pathlib.Path) -> pathlib.Path:
    """Create a tiny classroom fixture under `root` and return its path."""
    classroom = root / "cs-principles"
    classroom.mkdir()
    (classroom / "classroom.json").write_text(
        json.dumps({"schema": cs.CLASSROOM_SCHEMA_V1, "short_name": "cs-principles"})
    )
    (classroom / "assignments.json").write_text(
        json.dumps(
            {
                "schema": cs.ASSIGNMENTS_SCHEMA_V1,
                "assignments": [
                    {"slug": "hello", "name": "Hello", "mode": "individual", "tests": []}
                ],
            }
        )
    )
    write_roster(classroom / "roster.csv", [{"username": "alice", "github_id": "111"}])
    (classroom / "scores.json").write_text(
        json.dumps({"schema": cs.SCORES_SCHEMA_V1, "assignments": {}})
    )
    return classroom


# row_key ---------------------------------------------------------------------


class TestRowKey:
    def test_keys_on_owner_field_lowercased(self):
        # The stable key is the repo owner.
        assert cs.row_key({"owner": "Alice"}) == "alice"

    def test_owner_invariant_across_changing_member_sets(self):
        # Same owner, different credited member sets -> same key (the
        # group re-credit fix). member_usernames does not affect keying.
        full = {"owner": "alice", "member_usernames": ["alice", "bob"]}
        degraded = {"owner": "alice", "member_usernames": ["alice"]}
        assert cs.row_key(full) == cs.row_key(degraded) == "alice"

    def test_owner_required_no_fallback(self):
        # row_key requires an explicit `owner`. A record carrying only
        # `member_usernames` (no owner) is unkeyable — there is no
        # fallback and no legacy migration; every canonical entry has owner.
        assert cs.row_key({"member_usernames": ["alice"]}) is None

    def test_missing_owner_returns_none(self):
        assert cs.row_key({"datetime": "x"}) is None

    def test_empty_owner_returns_none(self):
        assert cs.row_key({"owner": ""}) is None

    def test_non_string_owner_returns_none(self):
        assert cs.row_key({"owner": 123}) is None


# apply_updates ---------------------------------------------------------------


class TestApplyUpdates:
    def test_appends_new_entry(self):
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        update = make_update()
        changes = cs.apply_updates(scores, [update])
        assert changes == 1
        assert scores["assignments"]["hello"]["type"] == "individual"
        assert scores["assignments"]["hello"]["entries"] == [cs.entry_from_result(update)]

    def test_buckets_by_assignment(self):
        # Each assignment is its own bucket, keyed by slug.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        hello = make_update(assignment="hello", username="alice")
        goodbye = make_update(assignment="goodbye", username="alice")
        changes = cs.apply_updates(scores, [hello, goodbye])
        assert changes == 2
        assert set(scores["assignments"]) == {"hello", "goodbye"}
        assert scores["assignments"]["hello"]["entries"] == [cs.entry_from_result(hello)]
        assert scores["assignments"]["goodbye"]["entries"] == [cs.entry_from_result(goodbye)]

    def test_stored_entry_drops_transport_hints_keeps_other_fields(self):
        # The bucket placement is driven by `_assignment`/`_type`, so the
        # stored entry must not carry them, but owner/submissions are kept.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        cs.apply_updates(scores, [make_update()])
        entry = scores["assignments"]["hello"]["entries"][0]
        assert "_assignment" not in entry
        assert "_type" not in entry
        assert entry["owner"] == "alice"

    def test_replaces_existing_entry_in_place(self):
        # Entry order within a bucket is preserved across collect runs.
        first = make_update(username="alice", score=10)
        second = make_update(username="bob", score=5)
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        cs.apply_updates(scores, [first, second])

        updated_alice = make_update(
            username="alice", score=20, submission_tag="submit/2026-06-02T10-00-00Z"
        )
        changes = cs.apply_updates(scores, [updated_alice])
        assert changes == 1
        entries = scores["assignments"]["hello"]["entries"]
        assert entries[0] == cs.entry_from_result(updated_alice)
        assert entries[1] == cs.entry_from_result(second)  # bob is untouched

    def test_skips_overridden_entries(self):
        # Override contract: teacher correction is final until cleared.
        # A fresh result must not silently overwrite it.
        existing = make_update(username="alice", score=20)
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        cs.apply_updates(scores, [existing])
        scores["assignments"]["hello"]["entries"][0]["override"] = True
        snapshot = dict(scores["assignments"]["hello"]["entries"][0])

        incoming = make_update(username="alice", score=5)
        changes = cs.apply_updates(scores, [incoming])
        assert changes == 0
        assert scores["assignments"]["hello"]["entries"][0] == snapshot

    def test_override_false_is_not_a_skip_signal(self):
        # Explicit "override": false is treated like absent for
        # the refresh decision, but preserved on replacement.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        cs.apply_updates(scores, [make_update(username="alice", score=5)])
        scores["assignments"]["hello"]["entries"][0]["override"] = False

        incoming = make_update(username="alice", score=10)
        changes = cs.apply_updates(scores, [incoming])
        assert changes == 1
        entry = scores["assignments"]["hello"]["entries"][0]
        assert entry["score"] == 10
        assert entry["override"] is False

    def test_identical_incoming_is_a_noop(self):
        # `same_submission` gates re-runs: stable classroom → no commits.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        cs.apply_updates(scores, [make_update()])
        changes = cs.apply_updates(scores, [make_update()])
        assert changes == 0

    def test_identical_modulo_override_field_is_a_noop(self):
        # "override": false on existing vs absent on incoming →
        # same effective data, no change.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        cs.apply_updates(scores, [make_update()])
        scores["assignments"]["hello"]["entries"][0]["override"] = False
        changes = cs.apply_updates(scores, [make_update()])
        assert changes == 0
        # Existing override field is preserved (no overwrite).
        assert scores["assignments"]["hello"]["entries"][0]["override"] is False

    def test_handles_malformed_existing_entry_gracefully(self):
        # A hand-edited non-dict entry doesn't crash the collector;
        # apply_updates ignores it and appends the new entry.
        scores = {
            "schema": cs.SCORES_SCHEMA_V1,
            "assignments": {"hello": {"type": "individual", "entries": ["junk"]}},
        }
        update = make_update()
        changes = cs.apply_updates(scores, [update])
        assert changes == 1
        entries = scores["assignments"]["hello"]["entries"]
        # The junk entry stays where it was; the new entry appends.
        assert entries[0] == "junk"
        assert entries[1] == cs.entry_from_result(update)

    def test_multiple_updates_apply_in_order(self):
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        updates = [
            make_update(username="alice"),
            make_update(username="bob"),
            make_update(username="alice", score=99),  # Replaces.
        ]
        changes = cs.apply_updates(scores, updates)
        assert changes == 3  # alice insert, bob insert, alice replace
        entries = scores["assignments"]["hello"]["entries"]
        assert [e["owner"] for e in entries] == ["alice", "bob"]
        assert entries[0]["score"] == 99

    def test_adds_late_field_to_existing_matching_entry(self):
        # Upgrading the collector should refresh old entries when the
        # only data change is the newly-derived lateness field on a record.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        cs.apply_updates(scores, [make_update(username="alice")])
        incoming = make_update(username="alice", late=False)

        changes = cs.apply_updates(scores, [incoming])

        assert changes == 1
        assert scores["assignments"]["hello"]["entries"][0]["late"] is False

    def test_group_degraded_recollect_replaces_not_duplicates(self):
        # Group degraded-recollect regression. First collect credits a group's full
        # member list; a later collect whose collaborator read degraded to
        # owner-only must REPLACE the same entry (keyed on the owner), not
        # append a second one.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        full = make_update(username="alice", assignment_type="group", score=8)
        full["member_usernames"] = ["alice", "bob"]
        assert cs.apply_updates(scores, [full]) == 1
        assert len(scores["assignments"]["hello"]["entries"]) == 1

        degraded = make_update(username="alice", assignment_type="group", score=8)
        degraded["member_usernames"] = ["alice"]
        changes = cs.apply_updates(scores, [degraded])
        assert changes == 1
        entries = scores["assignments"]["hello"]["entries"]
        assert len(entries) == 1, f"expected exactly one entry, got {entries!r}"
        assert entries[0]["member_usernames"] == ["alice"]

    def test_group_membership_change_replaces_same_owner_entry(self):
        # A teammate is added/removed between collects: same owner -> same
        # entry, updated in place.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        first = make_update(username="alice", assignment_type="group", score=5)
        first["member_usernames"] = ["alice"]
        cs.apply_updates(scores, [first])
        second = make_update(username="alice", assignment_type="group", score=5)
        second["member_usernames"] = ["alice", "bob"]
        cs.apply_updates(scores, [second])
        entries = scores["assignments"]["hello"]["entries"]
        assert len(entries) == 1
        assert entries[0]["member_usernames"] == ["alice", "bob"]

    def test_group_credited_set_shrink_warns_and_still_replaces(self, capsys):
        # A previously-credited teammate (bob) is dropped on re-collect (e.g., he
        # left the classroom team but is still a repo collaborator). The entry is
        # still replaced in place, but the silent revocation must surface a
        # warning naming the dropped member. The owner-only warning in
        # collect_classroom only covers the len==1 collapse, so a >=2 -> >=1
        # shrink needs this guard.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        first = make_update(username="alice", assignment_type="group", score=8)
        first["member_usernames"] = ["alice", "bob", "carol"]
        cs.apply_updates(scores, [first])

        shrunk = make_update(username="alice", assignment_type="group", score=9)
        shrunk["member_usernames"] = ["alice", "carol"]
        changes = cs.apply_updates(scores, [shrunk])

        assert changes == 1
        entries = scores["assignments"]["hello"]["entries"]
        assert len(entries) == 1
        assert entries[0]["member_usernames"] == ["alice", "carol"]
        err = capsys.readouterr().err
        assert "lost previously-credited member(s) bob" in err

    def test_group_credited_set_grow_does_not_warn(self, capsys):
        # The complement of the shrink test: adding a member (no revocation)
        # must NOT emit the credit-loss warning.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        first = make_update(username="alice", assignment_type="group", score=5)
        first["member_usernames"] = ["alice"]
        cs.apply_updates(scores, [first])
        grown = make_update(username="alice", assignment_type="group", score=6)
        grown["member_usernames"] = ["alice", "bob"]
        cs.apply_updates(scores, [grown])
        assert "previously-credited member" not in capsys.readouterr().err

    def test_owner_field_persisted_in_entry(self):
        # The owner is a first-class entry field and survives ingest.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        cs.apply_updates(scores, [make_update(username="alice")])
        assert scores["assignments"]["hello"]["entries"][0]["owner"] == "alice"

    def test_distinct_owners_are_distinct_entries(self):
        # Two different group repos (different owners) for the same
        # assignment are separate entries even if their member sets overlap.
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        a = make_update(username="alice", assignment_type="group")
        a["member_usernames"] = ["alice", "bob"]
        c = make_update(username="carol", assignment_type="group")
        c["member_usernames"] = ["carol", "bob"]
        cs.apply_updates(scores, [a])
        cs.apply_updates(scores, [c])
        assert len(scores["assignments"]["hello"]["entries"]) == 2

    def test_owner_less_existing_entry_is_not_adopted(self):
        # Legacy migration removed: an existing owner-less entry is
        # unkeyable, so an incoming owner-keyed update does NOT adopt it —
        # it appends a fresh canonical entry and leaves the owner-less one
        # untouched.
        legacy = make_update(username="alice", score=8)
        legacy.pop("owner", None)
        scores = {
            "schema": cs.SCORES_SCHEMA_V1,
            "assignments": {"hello": {"type": "individual", "entries": [legacy]}},
        }

        incoming = make_update(username="alice", score=8)
        changes = cs.apply_updates(scores, [incoming])
        entries = scores["assignments"]["hello"]["entries"]
        assert changes == 1
        assert len(entries) == 2  # owner-less entry left as-is; new one appended
        assert "owner" not in entries[0]
        assert entries[1]["owner"] == "alice"

    def test_owner_less_update_is_skipped(self):
        # An incoming update with no `owner` is unkeyable and skipped
        # entirely (no fallback).
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        update = make_update(username="alice")
        update.pop("owner", None)
        changes = cs.apply_updates(scores, [update])
        assert changes == 0
        assert scores["assignments"] == {}

    def test_update_with_invalid_type_is_skipped_no_bucket_persisted(self):
        # An update whose `_type` is missing/garbage must be skipped — and
        # crucially must NOT create a new bucket with a bad `type` via
        # setdefault (the latent type:None path).
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        for bad_type in (None, "", "squad", 123):
            update = make_update(username="alice")
            update["_type"] = bad_type
            changes = cs.apply_updates(scores, [update])
            assert changes == 0
            assert scores["assignments"] == {}, f"bad _type {bad_type!r} created a bucket"


# validate_result -------------------------------------------------------------


class TestValidateResult:
    def test_canonical_payload_passes(self):
        cs.validate_result(make_result(), "cs-principles", "hello", "alice")

    def test_rejects_wrong_schema(self):
        payload = make_result()
        payload["schema"] = "classroom50/autograde/v1"  # The old name.
        with pytest.raises(ValueError, match="schema"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_v2_schema(self):
        payload = make_result()
        payload["schema"] = "classroom50/result/v2"
        with pytest.raises(ValueError, match="schema"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_mismatched_classroom(self):
        # Hostile-payload defense: a fake classroom can't land in
        # the wrong scores.json.
        payload = make_result(classroom="other-classroom")
        with pytest.raises(ValueError, match="classroom"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_mismatched_assignment(self):
        payload = make_result(assignment="goodbye")
        with pytest.raises(ValueError, match="assignment"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_mismatched_owner(self):
        # owner must match the roster-derived value — that's the link
        # back to scores by student.
        payload = make_result(username="mallory")
        with pytest.raises(ValueError, match="owner"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_owner_match_is_case_insensitive(self):
        # GitHub treats usernames case-insensitively; collect mirrors that.
        payload = make_result(username="Alice")
        cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_missing_owner(self):
        payload = make_result()
        del payload["owner"]
        with pytest.raises(ValueError, match="owner"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_assignment_type_mismatch_individual(self):
        # An individual-mode check rejects a group-typed payload.
        payload = make_result(assignment_type="group")
        with pytest.raises(ValueError, match="assignment_type"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_non_submit_tag(self):
        # Trigger contract: only `submit/*` tags are graded. A
        # payload claiming otherwise must not land in scores.json.
        payload = make_result(submission_tag="manual-2026-06-01")
        with pytest.raises(ValueError, match="submit/"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_score_greater_than_max(self):
        # A hostile custom autograder could emit this.
        payload = make_result(score=50, max_score=10)
        with pytest.raises(ValueError, match=r"score \(50\)"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_negative_score(self):
        payload = make_result(score=-1, max_score=10)
        with pytest.raises(ValueError, match="non-negative"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_boolean_score(self):
        # bool is a subtype of int in Python — a naive
        # isinstance(value, int) would accept True/False.
        payload = make_result()
        payload["score"] = True  # type: ignore[assignment]
        with pytest.raises(ValueError, match="non-negative"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_missing_required_str_field(self):
        for field in ("submission", "commit", "release", "review", "datetime"):
            payload = make_result()
            del payload[field]
            with pytest.raises(ValueError, match=field):
                cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_malformed_test_entry(self):
        payload = make_result()
        payload["tests"] = [{"test-name": "", "passed": True, "score": 0, "max-score": 0}]
        with pytest.raises(ValueError, match="test-name"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_test_score_greater_than_test_max_score(self):
        # Same per-test bound so custom autograders can't emit
        # internally inconsistent rows.
        payload = make_result()
        payload["tests"] = [
            {"test-name": "unit", "passed": True, "score": 11, "max-score": 10}
        ]
        with pytest.raises(ValueError, match=r"tests\[0\]\.score"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_empty_tests_array_is_valid(self):
        # No tests → 0/0 score; still a valid release.
        payload = make_result(score=0, max_score=0)
        payload["tests"] = []
        cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_group_mode_accepts_group_typed_payload(self):
        # A group-typed payload validates under is_group=True.
        payload = make_result(username="alice", assignment_type="group")
        cs.validate_result(payload, "cs-principles", "hello", "alice", is_group=True)

    def test_group_mode_rejects_individual_typed_payload(self):
        # assignment_type must match the manifest-implied mode.
        payload = make_result(username="alice", assignment_type="individual")
        with pytest.raises(ValueError, match="assignment_type"):
            cs.validate_result(payload, "cs-principles", "hello", "alice", is_group=True)

    def test_individual_mode_rejects_group_typed_payload(self):
        payload = make_result(username="alice", assignment_type="group")
        with pytest.raises(ValueError, match="assignment_type"):
            cs.validate_result(payload, "cs-principles", "hello", "alice", is_group=False)

    def test_group_mode_rejects_mismatched_owner(self):
        # Identity defense survives in group mode: owner must match the
        # repo-name-derived owner.
        payload = make_result(username="bob", assignment_type="group")
        with pytest.raises(ValueError, match="owner"):
            cs.validate_result(payload, "cs-principles", "hello", "alice", is_group=True)

    def test_accepts_valid_submitted_by(self):
        payload = make_result()
        payload["submitted_by"] = {"username": "bob", "id": 222}
        cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_accepts_submitted_by_with_null_id(self):
        payload = make_result()
        payload["submitted_by"] = {"username": "bob", "id": None}
        cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_absent_submitted_by_is_valid(self):
        # Back-compat: results produced before submitted_by existed.
        payload = make_result()
        assert "submitted_by" not in payload
        cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_submitted_by_missing_username(self):
        payload = make_result()
        payload["submitted_by"] = {"id": 222}
        with pytest.raises(ValueError, match="submitted_by.username"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")

    def test_rejects_submitted_by_non_int_id(self):
        payload = make_result()
        payload["submitted_by"] = {"username": "bob", "id": "222"}
        with pytest.raises(ValueError, match="submitted_by.id"):
            cs.validate_result(payload, "cs-principles", "hello", "alice")


# Group attribution -----------------------------------------------------------


class TestGroupMemberUsernames:
    def test_includes_owner_and_sorts_deduped(self, monkeypatch):
        monkeypatch.setattr(
            cs, "list_repo_collaborator_logins", lambda *a, **k: ["Carol", "bob", "alice"]
        )
        members = cs.group_member_usernames(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "alice", "token",
            {"alice", "bob", "carol"},
        )
        # Sorted, case-insensitively deduped, owner present. Non-owner
        # members are normalized to lowercase (deterministic across collects,
        # so a casing change from GitHub's /collaborators can't churn the
        # gradebook); the owner keeps its repo-derived casing.
        assert members == ["alice", "bob", "carol"]

    def test_member_casing_is_deterministic_across_collects(self, monkeypatch):
        # Regression for gradebook churn: GitHub's /collaborators may return
        # a login under different casing between collects. Non-owner members
        # must normalize to a stable (lowercase) form so two collects of an
        # unchanged group produce identical member_usernames.
        def run(logins):
            monkeypatch.setattr(cs, "list_repo_collaborator_logins", lambda *a, **k: logins)
            return cs.group_member_usernames(
                "https://api.github.com", "cs50", "cs-principles-hello-alice", "alice", "token",
                {"alice", "bob", "carol"},
            )
        first = run(["Bob", "Carol"])
        second = run(["bob", "carol"])  # same people, different API casing
        assert first == second == ["alice", "bob", "carol"]

    def test_owner_guaranteed_even_if_not_listed(self, monkeypatch):
        # A partial/eventually-consistent collaborator read might omit
        # the owner; we still credit them.
        monkeypatch.setattr(cs, "list_repo_collaborator_logins", lambda *a, **k: ["bob"])
        members = cs.group_member_usernames(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "alice", "token",
            {"alice", "bob"},
        )
        assert members == ["alice", "bob"]

    def test_excludes_non_rostered_collaborator(self, monkeypatch):
        # A collaborator added out-of-band (not on the roster) must not
        # be credited a score, even though they're a non-admin collaborator.
        monkeypatch.setattr(
            cs, "list_repo_collaborator_logins", lambda *a, **k: ["bob", "intruder"]
        )
        members = cs.group_member_usernames(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "alice", "token",
            {"alice", "bob", "carol"},
        )
        assert members == ["alice", "bob"]
        assert "intruder" not in members

    def test_owner_credited_even_if_not_on_roster(self, monkeypatch):
        # The owner is always credited (the repo is named after them and
        # they passed validate_result); roster filtering applies only to
        # the other collaborators.
        monkeypatch.setattr(cs, "list_repo_collaborator_logins", lambda *a, **k: [])
        members = cs.group_member_usernames(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "alice", "token",
            set(),
        )
        assert members == ["alice"]

    def test_owner_casing_wins_on_collision(self, monkeypatch):
        # If the collaborator list returns the owner under a different
        # casing, the owner's own casing (placed first) is kept and not
        # duplicated.
        monkeypatch.setattr(cs, "list_repo_collaborator_logins", lambda *a, **k: ["alice", "bob"])
        members = cs.group_member_usernames(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "Alice", "token",
            {"alice", "bob"},
        )
        assert members == ["Alice", "bob"]

    def test_rostered_admin_teammate_is_credited(self, monkeypatch):
        # Regression: a teammate who is an org OWNER is `admin` on every
        # repo. The old code dropped all admins, crediting only the repo
        # owner. Now crediting is roster-gated, so a rostered admin
        # teammate is credited.
        monkeypatch.setattr(
            cs, "list_repo_collaborator_logins",
            lambda *a, **k: ["cs50-duck"],
        )
        members = cs.group_member_usernames(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "alice", "token",
            {"alice", "cs50-duck"},
        )
        assert members == ["alice", "cs50-duck"]

    def test_non_rostered_admin_is_excluded(self, monkeypatch):
        # A teacher/TA who is admin but NOT on the roster is still
        # excluded — the roster is the gate, and they aren't on it.
        monkeypatch.setattr(
            cs, "list_repo_collaborator_logins", lambda *a, **k: ["prof", "bob"]
        )
        members = cs.group_member_usernames(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "alice", "token",
            {"alice", "bob"},
        )
        assert members == ["alice", "bob"]
        assert "prof" not in members


class TestListRepoCollaboratorLogins:
    def test_returns_all_collaborators_including_admins_and_paginates(self, monkeypatch):
        # Crediting is gated on classroom-team membership downstream
        # (group_member_usernames), NOT on permission level, so this
        # function returns EVERY collaborator regardless of role_name.
        # A group teammate who is an org owner (admin on every repo) or a
        # founder kept as repo admin must NOT be dropped here — that was
        # the attribution bug. Teachers/TAs are filtered later by the
        # roster intersection, not by an admin check.
        page1 = [{"login": f"u{i}", "role_name": "write"} for i in range(100)]
        page2 = [
            {"login": "owner-admin", "role_name": "admin"},
            {"login": "ta-admin", "role_name": "admin"},
            {"login": "student", "role_name": "maintain"},
        ]

        # Drive pagination off the authoritative Link header: page 1
        # advertises rel="next", page 2 omits it -> stop. The fake keys
        # off an explicit cursor so the walk must have followed the
        # server-supplied link, not a synthesized page number.
        class FakeHeaders:
            def __init__(self, link):
                self._link = link

            def get(self, name):
                return self._link if name == "Link" else None

        def fake_http_get_with_headers(url, token, *, accept, max_bytes=None):
            if "cursor=two" in url:
                return json.dumps(page2).encode("utf-8"), FakeHeaders(None)
            link = '<https://api.github.com/x/collaborators?cursor=two>; rel="next"'
            return json.dumps(page1).encode("utf-8"), FakeHeaders(link)

        monkeypatch.setattr(cs, "_http_get_with_headers", fake_http_get_with_headers)
        logins = cs.list_repo_collaborator_logins(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "token"
        )
        # Admins are now RETAINED (roster gate applies downstream).
        assert "owner-admin" in logins
        assert "ta-admin" in logins
        assert "student" in logins
        assert len([x for x in logins if x.startswith("u")]) == 100

    def test_paginates_via_short_page_when_no_link_header(self, monkeypatch):
        # Fallback path: a server that emits no Link header stops on a
        # short page (len < per_page), preserving the prior behavior for
        # endpoints/test servers that don't paginate via Link.
        page1 = [{"login": f"u{i}", "role_name": "write"} for i in range(100)]
        page2 = [{"login": "student", "role_name": "maintain"}]

        class NoHeaders:
            def get(self, name):
                return None

        def fake_http_get_with_headers(url, token, *, accept, max_bytes=None):
            first = "page=1&" in url or url.endswith("page=1")
            return json.dumps(page1 if first else page2).encode("utf-8"), NoHeaders()

        monkeypatch.setattr(cs, "_http_get_with_headers", fake_http_get_with_headers)
        logins = cs.list_repo_collaborator_logins(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "token"
        )
        assert "student" in logins
        assert len([x for x in logins if x.startswith("u")]) == 100

    def test_full_final_page_with_non_next_link_terminates(self, monkeypatch):
        # A full page (len == per_page) carrying a Link header WITHOUT
        # rel="next" is the last page: the walk must stop in one request
        # rather than the length heuristic forcing another fetch. Mirrors
        # the Go "no over-fetch" test.
        page1 = [{"login": f"u{i}", "role_name": "write"} for i in range(100)]
        calls = {"n": 0}

        class PrevOnlyHeaders:
            def get(self, name):
                if name == "Link":
                    return '<https://api.github.com/x?page=1>; rel="prev"'
                return None

        def fake_http_get_with_headers(url, token, *, accept, max_bytes=None):
            calls["n"] += 1
            return json.dumps(page1).encode("utf-8"), PrevOnlyHeaders()

        monkeypatch.setattr(cs, "_http_get_with_headers", fake_http_get_with_headers)
        logins = cs.list_repo_collaborator_logins(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "token"
        )
        assert len(logins) == 100
        assert calls["n"] == 1, "a Link without rel=next must stop after one request"

    def test_off_host_next_link_is_refused(self, monkeypatch):
        # A crafted rel="next" pointing at a different host must be refused
        # (fail closed) so the bearer token is never sent off-host.
        class EvilHeaders:
            def get(self, name):
                if name == "Link":
                    return '<https://evil.example/steal?cursor=two>; rel="next"'
                return None

        def fake_http_get_with_headers(url, token, *, accept, max_bytes=None):
            return json.dumps([{"login": "alice", "role_name": "push"}]).encode("utf-8"), EvilHeaders()

        monkeypatch.setattr(cs, "_http_get_with_headers", fake_http_get_with_headers)
        with pytest.raises(ValueError, match="off-host"):
            cs.list_repo_collaborator_logins(
                "https://api.github.com", "cs50", "cs-principles-hello-alice", "token"
            )

    def test_self_looping_next_link_stops_without_exhausting_cap(self, monkeypatch):
        # A server that points rel="next" back at an already-seen URL must
        # terminate on the repeat rather than running out the 100-page cap.
        calls = {"n": 0}

        class LoopHeaders:
            def get(self, name):
                if name == "Link":
                    return '<https://api.github.com/loop?cursor=same>; rel="next"'
                return None

        def fake_http_get_with_headers(url, token, *, accept, max_bytes=None):
            calls["n"] += 1
            return json.dumps([{"login": "alice", "role_name": "push"}]).encode("utf-8"), LoopHeaders()

        monkeypatch.setattr(cs, "_http_get_with_headers", fake_http_get_with_headers)
        with pytest.raises(cs.IncompleteListing, match="incomplete"):
            cs.list_repo_collaborator_logins(
                "https://api.github.com", "cs50", "cs-principles-hello-alice", "token"
            )
        # Page 1 fetch -> follow next once (page 2 fetch) -> the same next URL
        # is seen again -> stop. Two requests, NOT an exhausted 100-page cap.
        assert calls["n"] == 2, f"self-loop should stop at 2 requests, made {calls['n']}"


class TestGroupCollectClassroom:
    def _group_assignments(self):
        return {"assignments": [{"slug": "project", "mode": "group", "max_group_size": 3}]}

    def _stub_release(self, monkeypatch):
        def fake_all(*args, **kwargs):
            return [{
                "tag_name": "submit/2026-09-16T04-00-00Z",
                "assets": [{"name": "result.json", "url": "https://api.github.com/assets/1"}],
            }]

        monkeypatch.setattr(cs, "all_submit_releases", fake_all)

    def test_group_score_credits_members(self, monkeypatch):
        self._stub_release(monkeypatch)
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(classroom="cs-principles", assignment="project",
                                        username="alice", assignment_type="group"),
        )
        monkeypatch.setattr(
            cs, "list_repo_collaborator_logins", lambda *a, **k: ["alice", "bob", "carol"]
        )
        stub_team_members(monkeypatch, ["alice", "bob", "carol"])

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._group_assignments(),
            service_token="token",
        )
        assert len(results) == 1
        assert results[0]["member_usernames"] == ["alice", "bob", "carol"]
        # End-to-end: collect_classroom stamps the stable owner (the repo
        # owner from the roster), not the credited member set.
        assert results[0]["owner"] == "alice"

    def test_group_excludes_non_rostered_collaborator(self, monkeypatch):
        # A collaborator added out-of-band who is not on the roster must
        # not be credited a score.
        self._stub_release(monkeypatch)
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(classroom="cs-principles", assignment="project",
                                        username="alice", assignment_type="group"),
        )
        monkeypatch.setattr(
            cs, "list_repo_collaborator_logins", lambda *a, **k: ["alice", "bob", "intruder"]
        )
        stub_team_members(monkeypatch, ["alice", "bob"])

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._group_assignments(),
            service_token="token",
        )
        assert results[0]["member_usernames"] == ["alice", "bob"]
        assert "intruder" not in results[0]["member_usernames"]

    def test_group_read_failure_falls_back_to_owner_only(self, monkeypatch, capsys):
        # Regression guard: on a collaborator-read failure the credited
        # member set MUST reduce to the owner only. member_usernames comes
        # solely from the collaborator∩roster read, never from the record.
        import urllib.error

        self._stub_release(monkeypatch)
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(classroom="cs-principles", assignment="project",
                                        username="alice", assignment_type="group"),
        )

        def boom(*a, **k):
            raise urllib.error.HTTPError("u", 403, "Forbidden", None, None)

        monkeypatch.setattr(cs, "list_repo_collaborator_logins", boom)
        stub_team_members(monkeypatch, ["alice"])

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._group_assignments(),
            service_token="token",
        )
        # Only the owner is credited on the entry.
        assert results[0]["member_usernames"] == ["alice"]
        err = capsys.readouterr().err
        assert "could not read group collaborators" in err
        # Aggregate degraded-attribution signal fired.
        assert "credited to the repo owner only" in err

    def test_group_malformed_listing_falls_back_to_owner_only(self, monkeypatch, capsys):
        # The malformed-listing (ValueError) branch must also reset to
        # owner-only — same security guarantee as the HTTPError branch.
        self._stub_release(monkeypatch)
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(classroom="cs-principles", assignment="project",
                                        username="alice", assignment_type="group"),
        )

        def malformed(*a, **k):
            raise ValueError("expected JSON array, got dict")

        monkeypatch.setattr(cs, "list_repo_collaborator_logins", malformed)
        stub_team_members(monkeypatch, ["alice"])

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._group_assignments(),
            service_token="token",
        )
        assert results[0]["member_usernames"] == ["alice"]
        assert "malformed" in capsys.readouterr().err

    def test_teammate_without_repo_is_not_a_miss(self, monkeypatch):
        # bob joined alice's repo, so bob's derived repo 404s
        # (release None). He should not appear as a separate submission;
        # his score comes via alice's entry's member_usernames.
        self._stub_release_only_for(monkeypatch, owner="alice")
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(classroom="cs-principles", assignment="project",
                                        username="alice", assignment_type="group"),
        )
        monkeypatch.setattr(
            cs, "list_repo_collaborator_logins", lambda *a, **k: ["alice", "bob"]
        )
        stub_team_members(monkeypatch, ["alice", "bob"])

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._group_assignments(),
            service_token="token",
        )
        # One submission (alice's repo), crediting both.
        assert len(results) == 1
        assert results[0]["member_usernames"] == ["alice", "bob"]

    def _stub_release_only_for(self, monkeypatch, *, owner):
        def fake_all(api_url, org, repo, token):
            if repo.endswith(f"-{owner}"):
                return [{
                    "tag_name": "submit/2026-09-16T04-00-00Z",
                    "assets": [{"name": "result.json", "url": "https://api.github.com/assets/1"}],
                }]
            return []

        monkeypatch.setattr(cs, "all_submit_releases", fake_all)

    def test_group_owner_only_emits_warning(self, monkeypatch, capsys):
        # A group submission where collaborator read succeeds but finds no
        # other rostered member must WARN (not silently credit owner only) —
        # the symptom of the attribution bug the teacher hit.
        self._stub_release(monkeypatch)
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(classroom="cs-principles", assignment="project",
                                        username="alice", assignment_type="group"),
        )
        monkeypatch.setattr(cs, "list_repo_collaborator_logins", lambda *a, **k: ["alice"])
        stub_team_members(monkeypatch, ["alice"])

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._group_assignments(),
            service_token="token",
        )
        assert results[0]["member_usernames"] == ["alice"]
        err = capsys.readouterr().err
        assert "credited to the owner" in err
        assert "classroom team" in err


# assignment_repo_name --------------------------------------------------------


class TestAssignmentRepoName:
    def test_lowercases_all_three_components(self):
        # Cross-binary contract single-sourced in cli/shared/contract — drift
        # makes the collect releases/latest call 404 for every student.
        assert (
            cs.assignment_repo_name("CS-Principles", "Hello", "Alice")
            == "cs-principles-hello-alice"
        )

    def test_preserves_hyphens_within_components(self):
        # Slug/username with internal hyphens flow through unchanged;
        # joining hyphens come from the formula, not the components.
        assert (
            cs.assignment_repo_name("cs-principles", "hello-world", "ada-l")
            == "cs-principles-hello-world-ada-l"
        )

    def test_shared_fixture_parity(self):
        # Same golden cases the Go contract test asserts, so this mirror can't
        # drift from the single source in cli/shared/contract.
        repo_root = pathlib.Path(__file__).resolve().parents[3]
        fixture = (repo_root / "cli" / "shared" / "testdata"
                   / "assignment_repo_name_cases.json")
        cases = json.loads(fixture.read_text())["cases"]
        assert cases, "shared fixture has no cases"
        for case in cases:
            assert cs.assignment_repo_name(
                case["classroom"], case["assignment"], case["username"]
            ) == case["name"], case["name"]


# Due-date / lateness ---------------------------------------------------------


class TestResolveTeamSlug:
    def test_prefers_persisted_slug(self):
        # classroom.json team.slug is authoritative (GitHub may re-slug on a
        # name collision, e.g., classroom50-cs-1).
        assert (
            cs.resolve_team_slug({"team": {"slug": "classroom50-cs-1"}}, "cs")
            == "classroom50-cs-1"
        )

    def test_falls_back_to_derived_slug(self):
        assert cs.resolve_team_slug({}, "cs-principles") == "classroom50-cs-principles"

    def test_falls_back_when_team_block_lacks_slug(self):
        assert cs.resolve_team_slug({"team": {"id": 7}}, "cs") == "classroom50-cs"

    def test_falls_back_when_slug_blank(self):
        assert cs.resolve_team_slug({"team": {"slug": "  "}}, "cs") == "classroom50-cs"


class TestListTeamMemberLogins:
    def test_returns_member_logins_and_paginates_via_link(self, monkeypatch):
        page1 = [{"login": f"u{i}", "id": i} for i in range(100)]
        page2 = [{"login": "alice", "id": 500}, {"login": "bob", "id": 501}]

        class FakeHeaders:
            def __init__(self, link):
                self._link = link

            def get(self, name):
                return self._link if name == "Link" else None

        def fake_http(url, token, *, accept, max_bytes=None):
            if "cursor=two" in url:
                return json.dumps(page2).encode("utf-8"), FakeHeaders(None)
            link = '<https://api.github.com/x/members?cursor=two>; rel="next"'
            return json.dumps(page1).encode("utf-8"), FakeHeaders(link)

        monkeypatch.setattr(cs, "_http_get_with_headers", fake_http)
        logins = cs.list_team_member_logins(
            "https://api.github.com", "cs50", "classroom50-cs-principles", "token"
        )
        assert "alice" in logins and "bob" in logins
        assert len([x for x in logins if x.startswith("u")]) == 100

    def test_propagates_http_error(self, monkeypatch):
        import urllib.error

        def boom(*a, **k):
            raise urllib.error.HTTPError("u", 404, "Not Found", None, None)

        monkeypatch.setattr(cs, "_http_get_with_headers", boom)
        with pytest.raises(urllib.error.HTTPError):
            cs.list_team_member_logins(
                "https://api.github.com", "cs50", "classroom50-missing", "token"
            )


class TestListEnrolledLogins:
    def test_unions_student_and_staff_dedup_student_first(self, monkeypatch):
        by_slug = {
            "classroom50-cs-principles": ["alice", "Bob"],
            "classroom50-cs-principles-teacher": ["prof"],
            "classroom50-cs-principles-ta": ["bob", "ta1"],
        }
        stub_team_members_by_slug(monkeypatch, by_slug)
        meta = {
            "teams": {
                "teacher": {"slug": "classroom50-cs-principles-teacher"},
                "ta": {"slug": "classroom50-cs-principles-ta"},
            }
        }
        logins, students = cs.list_enrolled_logins(
            "https://api.github.com", "cs50", meta, "cs-principles", "token"
        )
        # Bob (student casing) wins over bob (ta); order is first-seen across the
        # student team then each staff team.
        assert logins == ["alice", "Bob", "prof", "ta1"]
        # Student set is lowercased and holds only student-team members.
        assert students == {"alice", "bob"}

    def test_no_staff_teams_polls_only_student(self, monkeypatch):
        stub_team_members_by_slug(monkeypatch, {"classroom50-cs-principles": ["alice"]})
        logins, students = cs.list_enrolled_logins(
            "https://api.github.com", "cs50", {}, "cs-principles", "token"
        )
        assert logins == ["alice"]
        assert students == {"alice"}

    def test_soft_staff_error_skips_that_team(self, monkeypatch, capsys):
        import urllib.error

        def fake(api_url, org, team_slug, token):
            if team_slug == "classroom50-cs-principles-ta":
                raise urllib.error.HTTPError("u", 404, "Not Found", None, None)
            return ["alice"] if team_slug == "classroom50-cs-principles" else []

        monkeypatch.setattr(cs, "list_team_member_logins", fake)
        meta = {"teams": {"ta": {"slug": "classroom50-cs-principles-ta"}}}
        logins, students = cs.list_enrolled_logins(
            "https://api.github.com", "cs50", meta, "cs-principles", "token"
        )
        assert logins == ["alice"]
        assert students == {"alice"}
        assert "could not read staff team" in capsys.readouterr().err

    def test_hard_staff_error_propagates(self, monkeypatch):
        import urllib.error

        def fake(api_url, org, team_slug, token):
            if team_slug == "classroom50-cs-principles-ta":
                raise urllib.error.HTTPError("u", 403, "Forbidden", None, None)
            return ["alice"] if team_slug == "classroom50-cs-principles" else []

        monkeypatch.setattr(cs, "list_team_member_logins", fake)
        meta = {"teams": {"ta": {"slug": "classroom50-cs-principles-ta"}}}
        with pytest.raises(urllib.error.HTTPError):
            cs.list_enrolled_logins(
                "https://api.github.com", "cs50", meta, "cs-principles", "token"
            )


class TestCollectClassroomTeamDriven:
    def _assignments(self):
        return {"assignments": [{"slug": "hello", "name": "H", "mode": "individual", "tests": []}]}

    def test_team_members_drive_pairs_not_the_csv(self, monkeypatch):
        # The team, not the roster, provides the usernames. Here the CSV is
        # empty but the team has one member — collection must poll that repo.
        stub_team_members(monkeypatch, ["alice"])
        monkeypatch.setattr(
            cs, "all_submit_releases",
            lambda *a, **k: [{"tag_name": "submit/2026-06-01T10-00-00Z",
                              "assets": [{"name": "result.json", "url": "https://api.github.com/a/1"}]}],
        )
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(username="alice"),
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
        )
        assert len(results) == 1
        assert results[0]["owner"] == "alice"

    def test_empty_team_warns_and_collects_nothing(self, monkeypatch, capsys):
        stub_team_members(monkeypatch, [])
        results, mode_flip, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
        )
        assert results == []
        assert mode_flip == 0
        assert "have no members" in capsys.readouterr().err

    def test_unknown_assignment_mode_warns_and_collects_as_individual(
        self, monkeypatch, capsys
    ):
        # A typo'd mode (e.g. "grupo") must not silently collect as an
        # individual assignment: every submission would be rejected by the
        # owner-identity check and read as a mode flip. Warn loudly, then
        # proceed with the individual default (today's fallback behavior).
        stub_team_members(monkeypatch, ["alice"])
        monkeypatch.setattr(cs, "all_submit_releases", lambda *a, **k: [])
        cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [
                {"slug": "hello", "name": "H", "mode": "grupo", "tests": []}
            ]},
            service_token="token",
        )
        err = capsys.readouterr().err
        assert "grupo" in err
        assert "individual" in err

    def test_team_read_404_warns_and_skips(self, monkeypatch, capsys):
        import urllib.error

        def boom(*a, **k):
            raise urllib.error.HTTPError("u", 404, "Not Found", None, None)

        monkeypatch.setattr(cs, "list_team_member_logins", boom)
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
        )
        assert results == []
        assert "could not read team" in capsys.readouterr().err

    def test_team_read_hard_error_propagates(self, monkeypatch):
        import urllib.error

        def boom(*a, **k):
            raise urllib.error.HTTPError("u", 403, "Forbidden", None, None)

        monkeypatch.setattr(cs, "list_team_member_logins", boom)
        with pytest.raises(urllib.error.HTTPError):
            cs.collect_classroom(
                api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
                classroom_meta={}, assignments=self._assignments(), service_token="token",
            )

    def test_assignment_filter_polls_only_that_assignment(self, monkeypatch):
        # The per-assignment scoped collect must not touch sibling assignments'
        # repos (that's the whole point — a classroom-wide walk is slow and
        # rate-limit hungry).
        stub_team_members(monkeypatch, ["alice"])
        seen_repos = []

        def fake_all(api_url, org, repo, token):
            seen_repos.append(repo)
            return []

        monkeypatch.setattr(cs, "all_submit_releases", fake_all)
        cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [
                {"slug": "hello", "name": "H", "mode": "individual", "tests": []},
                {"slug": "world", "name": "W", "mode": "individual", "tests": []},
            ]},
            service_token="token",
            assignment_filter="world",
        )
        assert seen_repos == ["cs-principles-world-alice"]

    def test_dedupes_team_members_case_insensitively(self, monkeypatch):
        stub_team_members(monkeypatch, ["Alice", "alice", "BOB"])
        seen_repos = []

        def fake_all(api_url, org, repo, token):
            seen_repos.append(repo)
            return []

        monkeypatch.setattr(cs, "all_submit_releases", fake_all)
        cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
        )
        # Alice/alice collapse to one repo probe; BOB to another.
        assert seen_repos == ["cs-principles-hello-alice", "cs-principles-hello-bob"]

    def test_malformed_team_listing_warns_and_skips(self, monkeypatch, capsys):
        # A malformed team-member listing (non-array body -> ValueError, or a
        # JSONDecodeError) is a per-classroom data problem, not a run-killer:
        # collect_classroom catches it, warns, and returns no pairs rather than
        # propagating (mirrors the 404 soft-skip; contrasts with the 403 hard
        # error that propagates).
        def boom(*a, **k):
            raise ValueError("expected JSON array, got dict")

        monkeypatch.setattr(cs, "list_team_member_logins", boom)
        results, mode_flip, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
        )
        assert results == []
        assert mode_flip == 0
        assert "member listing malformed" in capsys.readouterr().err

    # Staff collection (the four-team union) ---------------------------------

    def _meta_with_staff(self):
        # A classroom.json `teams` block naming all three staff teams, so
        # resolve_staff_team_slugs yields them and list_enrolled_logins polls
        # each in addition to the student team.
        return {
            "teams": {
                "teacher": {"slug": "classroom50-cs-principles-teacher"},
                "hta": {"slug": "classroom50-cs-principles-hta"},
                "ta": {"slug": "classroom50-cs-principles-ta"},
            }
        }

    def test_polls_union_of_student_and_staff_teams(self, monkeypatch):
        # Every team member (student + staff) is polled, student team first.
        stub_team_members_by_slug(monkeypatch, {
            "classroom50-cs-principles": ["alice"],
            "classroom50-cs-principles-teacher": ["prof"],
            "classroom50-cs-principles-hta": ["headta"],
            "classroom50-cs-principles-ta": ["ta1"],
        })
        seen_repos = []

        def fake_all(api_url, org, repo, token):
            seen_repos.append(repo)
            return []

        monkeypatch.setattr(cs, "all_submit_releases", fake_all)
        cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta=self._meta_with_staff(), assignments=self._assignments(),
            service_token="token",
        )
        assert seen_repos == [
            "cs-principles-hello-alice",
            "cs-principles-hello-prof",
            "cs-principles-hello-headta",
            "cs-principles-hello-ta1",
        ]

    def test_dedupes_across_student_and_staff_teams(self, monkeypatch):
        # A person on both the student team and a staff team is polled once.
        stub_team_members_by_slug(monkeypatch, {
            "classroom50-cs-principles": ["alice", "Bob"],
            "classroom50-cs-principles-ta": ["bob", "ta1"],
        })
        # No teacher/hta teams in meta -> those slugs resolve to nothing polled.
        meta = {"teams": {"ta": {"slug": "classroom50-cs-principles-ta"}}}
        seen_repos = []
        monkeypatch.setattr(
            cs, "all_submit_releases",
            lambda api_url, org, repo, token: seen_repos.append(repo) or [],
        )
        cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta=meta, assignments=self._assignments(), service_token="token",
        )
        # Bob/bob collapse to one probe (student-team casing wins, first seen).
        assert seen_repos == [
            "cs-principles-hello-alice",
            "cs-principles-hello-bob",
            "cs-principles-hello-ta1",
        ]

    def test_staff_member_with_repo_is_collected(self, monkeypatch):
        # A staff member who accepted (their repo exists, has a submit release)
        # is collected exactly like a student.
        stub_team_members_by_slug(monkeypatch, {
            "classroom50-cs-principles": [],
            "classroom50-cs-principles-ta": ["ta1"],
        })
        meta = {"teams": {"ta": {"slug": "classroom50-cs-principles-ta"}}}
        monkeypatch.setattr(
            cs, "all_submit_releases",
            lambda *a, **k: [{"tag_name": "submit/2026-06-01T10-00-00Z",
                              "assets": [{"name": "result.json", "url": "https://api.github.com/a/1"}]}],
        )
        monkeypatch.setattr(
            cs, "download_result_asset", lambda *a, **k: make_result(username="ta1"),
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta=meta, assignments=self._assignments(), service_token="token",
        )
        assert len(results) == 1
        assert results[0]["owner"] == "ta1"

    def test_staff_member_without_repo_is_absent(self, monkeypatch):
        # A staff member who never accepted has no repo: all_submit_releases
        # returns [] (a 404 collapses to []), so no entry is produced — the
        # accepted gate is implicit in the per-repo release read.
        stub_team_members_by_slug(monkeypatch, {
            "classroom50-cs-principles": ["alice"],
            "classroom50-cs-principles-ta": ["ta1"],
        })
        meta = {"teams": {"ta": {"slug": "classroom50-cs-principles-ta"}}}

        def fake_all(api_url, org, repo, token):
            # alice accepted; ta1 did not.
            if repo == "cs-principles-hello-alice":
                return [{"tag_name": "submit/2026-06-01T10-00-00Z",
                         "assets": [{"name": "result.json", "url": "https://api.github.com/a/1"}]}]
            return []

        monkeypatch.setattr(cs, "all_submit_releases", fake_all)
        monkeypatch.setattr(
            cs, "download_result_asset", lambda *a, **k: make_result(username="alice"),
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta=meta, assignments=self._assignments(), service_token="token",
        )
        owners = [r["owner"] for r in results]
        assert owners == ["alice"]
        assert "ta1" not in owners

    def test_staff_team_soft_error_warns_and_continues(self, monkeypatch, capsys):
        # A soft failure (404 on an uncreated staff team) contributes nobody but
        # doesn't abort: the student team is still collected.
        import urllib.error

        def fake(api_url, org, team_slug, token):
            if team_slug == "classroom50-cs-principles-ta":
                raise urllib.error.HTTPError("u", 404, "Not Found", None, None)
            return ["alice"] if team_slug == "classroom50-cs-principles" else []

        monkeypatch.setattr(cs, "list_team_member_logins", fake)
        meta = {"teams": {"ta": {"slug": "classroom50-cs-principles-ta"}}}
        monkeypatch.setattr(
            cs, "all_submit_releases",
            lambda *a, **k: [{"tag_name": "submit/2026-06-01T10-00-00Z",
                              "assets": [{"name": "result.json", "url": "https://api.github.com/a/1"}]}],
        )
        monkeypatch.setattr(
            cs, "download_result_asset", lambda *a, **k: make_result(username="alice"),
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta=meta, assignments=self._assignments(), service_token="token",
        )
        assert [r["owner"] for r in results] == ["alice"]
        assert "could not read staff team" in capsys.readouterr().err

    def test_staff_team_hard_error_propagates(self, monkeypatch):
        # A hard failure (403) on a staff team aborts the whole run, same as the
        # student team — a broken token must not silently under-collect.
        import urllib.error

        def fake(api_url, org, team_slug, token):
            if team_slug == "classroom50-cs-principles-ta":
                raise urllib.error.HTTPError("u", 403, "Forbidden", None, None)
            return ["alice"] if team_slug == "classroom50-cs-principles" else []

        monkeypatch.setattr(cs, "list_team_member_logins", fake)
        meta = {"teams": {"ta": {"slug": "classroom50-cs-principles-ta"}}}
        with pytest.raises(urllib.error.HTTPError):
            cs.collect_classroom(
                api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
                classroom_meta=meta, assignments=self._assignments(), service_token="token",
            )

    def test_summary_denominator_excludes_non_accepting_staff(self, monkeypatch, capsys):
        # "X of Y submitted" counts students (expected to submit) plus staff who
        # actually submitted — a non-accepting staffer (polled, no repo) must not
        # inflate Y. Here: 2 students (alice submits, bob doesn't), 1 TA who
        # submits, 1 TA who doesn't -> 2 of 3 submitted (2 students + 1 staff
        # submitter), NOT 2 of 4.
        stub_team_members_by_slug(monkeypatch, {
            "classroom50-cs-principles": ["alice", "bob"],
            "classroom50-cs-principles-ta": ["ta1", "ta2"],
        })
        meta = {"teams": {"ta": {"slug": "classroom50-cs-principles-ta"}}}

        def fake_all(api_url, org, repo, token):
            if repo in ("cs-principles-hello-alice", "cs-principles-hello-ta1"):
                return [{"tag_name": "submit/2026-06-01T10-00-00Z",
                         "assets": [{"name": "result.json", "url": "https://api.github.com/a/1"}]}]
            return []

        monkeypatch.setattr(cs, "all_submit_releases", fake_all)

        # download_result_asset is called right after all_submit_releases for the
        # same repo; thread the owner through the repo the loop is on.
        owners = {"cs-principles-hello-alice": "alice", "cs-principles-hello-ta1": "ta1"}
        seen = {"owner": None}

        def fake_all2(api_url, org, repo, token):
            seen["owner"] = owners.get(repo)
            return fake_all(api_url, org, repo, token)

        monkeypatch.setattr(cs, "all_submit_releases", fake_all2)
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(username=seen["owner"]),
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta=meta, assignments=self._assignments(), service_token="token",
        )
        assert sorted(r["owner"] for r in results) == ["alice", "ta1"]
        assert "cs-principles/hello: 2/3 submitted" in capsys.readouterr().out


class TestLateness:
    @pytest.mark.parametrize("value", [
        "2026-09-15T23:59:00-04:00",
        "2026-09-15T23:59:00Z",
        "2026-09-15T23:59:00.123Z",
    ])
    def test_parse_rfc3339_accepts_cli_shapes(self, value):
        assert cs.parse_rfc3339(value) is not None

    @pytest.mark.parametrize("value", [
        "2026-09-15",
        "2026-09-15T23:59:00",
        "2026-09-15t23:59:00z",
        "next Tuesday",
        "",
        None,
    ])
    def test_parse_rfc3339_rejects_ambiguous_shapes(self, value):
        assert cs.parse_rfc3339(value) is None

    def test_mark_late_compares_across_timezones(self):
        due = cs.parse_rfc3339("2026-09-15T23:59:00-04:00")
        assert due is not None

        before = make_result(datetime="2026-09-16T03:58:59Z")
        at_deadline = make_result(datetime="2026-09-16T03:59:00Z")
        after = make_result(datetime="2026-09-16T03:59:01Z")

        assert cs.mark_late(before, due) is True
        assert before["late"] is False
        assert cs.mark_late(at_deadline, due) is True
        assert at_deadline["late"] is False
        assert cs.mark_late(after, due) is True
        assert after["late"] is True

    def test_mark_late_leaves_unparseable_datetime_unmarked(self):
        due = cs.parse_rfc3339("2026-09-15T23:59:00-04:00")
        assert due is not None
        payload = make_result(datetime="2026-09-16T03:59:01")

        assert cs.mark_late(payload, due) is False
        assert "late" not in payload

    def test_collect_classroom_marks_lateness_on_payloads(self, monkeypatch):
        def fake_all(*args, **kwargs):
            return [{
                "tag_name": "submit/2026-09-16T04-00-00Z",
                "assets": [{"name": "result.json", "url": "https://api.github.com/assets/1"}],
            }]

        def fake_download(*args, **kwargs):
            return make_result(datetime="2026-09-16T04:00:00Z")

        monkeypatch.setattr(cs, "all_submit_releases", fake_all)
        monkeypatch.setattr(cs, "download_result_asset", fake_download)
        stub_team_members(monkeypatch, ["alice"])

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [{"slug": "hello", "due": "2026-09-15T23:59:00-04:00"}]},
            service_token="token",
        )

        # Lateness is marked per submission, inside the row's submissions list.
        assert results[0]["submissions"][0]["late"] is True


# roster.csv header lockstep --------------------------------------------------


def test_full_roster_header_matches_go_constant():
    # The exact 7-column header must stay in lockstep with FullRosterHeader
    # in cli/gh-teacher/internal/configrepo/students_csv.go (asserted there by
    # TestFullRosterHeader) and classroom50-web's STUDENT_CSV_FIELDS. If this
    # fails, a column or its order drifted between the codebases. Collection is
    # team-driven and only reads the roster for best-effort metadata, but the Go
    # download-metadata join and the web writer still share this header, so the
    # Python leg of the 3-way lockstep is retained.
    assert cs.FULL_ROSTER_HEADER == "username,first_name,last_name,email,section,github_id,role"


def test_roster_filename_matches_go_constant():
    # The roster filename must stay in lockstep with contract.RosterFilename in
    # cli/shared/contract/contract.go (pinned by TestContractLiterals) and the
    # web's src/util/rosterPath.ts. There is no compile-time link across the
    # three tools; a Python-only drift would otherwise ship green while readers
    # stopped agreeing on which file to read.
    assert cs.ROSTER_FILENAME == "roster.csv"


# Roster metadata join (best-effort) ------------------------------------------


class TestRosterMetadataJoin:
    def _assignments(self):
        return {"assignments": [{"slug": "hello", "name": "H", "mode": "individual", "tests": []}]}

    def _collect(self, tmp_path, monkeypatch):
        stub_team_members(monkeypatch, ["alice"])
        monkeypatch.setattr(
            cs, "all_submit_releases",
            lambda *a, **k: [{"tag_name": "submit/2026-06-01T10-00-00Z",
                              "assets": [{"name": "result.json", "url": "https://api.github.com/a/1"}]}],
        )
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(username="alice"),
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
            roster_meta=cs.load_roster_metadata(tmp_path),
        )
        return results

    def test_joins_metadata_from_roster_csv(self, tmp_path, monkeypatch):
        # roster.csv present: its name/section/email land on the entry.
        write_roster(tmp_path / "roster.csv", [{
            "username": "alice", "first_name": "Ada", "last_name": "Lovelace",
            "email": "ada@uni.edu", "section": "A", "github_id": "1",
        }])
        results = self._collect(tmp_path, monkeypatch)
        assert len(results) == 1
        assert results[0]["first_name"] == "Ada"
        assert results[0]["last_name"] == "Lovelace"
        assert results[0]["email"] == "ada@uni.edu"
        assert results[0]["section"] == "A"

    def test_role_column_tolerated_metadata_still_joins(self, tmp_path, monkeypatch):
        # A roster.csv carrying the role column joins its display metadata
        # normally; role is recorded metadata the collector does not consume.
        write_roster(tmp_path / "roster.csv", [{
            "username": "alice", "first_name": "Ada", "last_name": "Lovelace",
            "email": "ada@uni.edu", "section": "A", "github_id": "1", "role": "teacher",
        }])
        results = self._collect(tmp_path, monkeypatch)
        assert len(results) == 1
        assert results[0]["first_name"] == "Ada"
        assert results[0]["email"] == "ada@uni.edu"
        # role is not surfaced onto the result entry (best-effort metadata only).
        assert "role" not in results[0]

    def test_legacy_pre_role_roster_still_joins(self, tmp_path, monkeypatch):
        # A pre-role file (no role column) must still join — DictReader is
        # header-keyed, so an absent role just doesn't appear.
        path = tmp_path / "roster.csv"
        with path.open("w", newline="") as fh:
            fh.write("username,first_name,last_name,email,section,github_id\n")
            fh.write("alice,Ada,Lovelace,ada@uni.edu,A,1\n")
        results = self._collect(tmp_path, monkeypatch)
        assert results[0]["first_name"] == "Ada"
        assert results[0]["section"] == "A"

    def test_missing_roster_yields_blank_metadata_no_crash(self, tmp_path, monkeypatch):
        # Neither file present: best-effort, so collection still succeeds and
        # the entry simply carries no display metadata.
        results = self._collect(tmp_path, monkeypatch)
        assert len(results) == 1
        assert "first_name" not in results[0]
        assert "email" not in results[0]

    def test_load_roster_metadata_missing_returns_empty(self, tmp_path):
        assert cs.load_roster_metadata(tmp_path) == {}


# load_scores / save_scores ---------------------------------------------------


class TestScoresIO:
    def test_load_returns_skeleton_for_missing_file(self, tmp_path):
        scores = cs.load_scores(tmp_path / "scores.json")
        assert scores == {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}

    def test_load_returns_skeleton_for_empty_file(self, tmp_path):
        path = tmp_path / "scores.json"
        path.write_text("")
        scores = cs.load_scores(path)
        assert scores == {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}

    def test_load_raises_on_malformed_json(self, tmp_path):
        path = tmp_path / "scores.json"
        path.write_text("{garbage}")
        with pytest.raises(cs.ScoresFileError, match="malformed JSON"):
            cs.load_scores(path)

    def test_load_raises_on_wrong_schema(self, tmp_path):
        path = tmp_path / "scores.json"
        path.write_text(json.dumps({"schema": "classroom50/scores/v2", "assignments": {}}))
        with pytest.raises(cs.ScoresFileError, match="schema"):
            cs.load_scores(path)

    def test_load_normalizes_null_assignments(self, tmp_path):
        # `"assignments": null` normalizes to {} so a hand-edit
        # doesn't crash the collector.
        path = tmp_path / "scores.json"
        path.write_text(json.dumps({"schema": cs.SCORES_SCHEMA_V1, "assignments": None}))
        scores = cs.load_scores(path)
        assert scores["assignments"] == {}

    def test_load_rejects_stringified_map(self, tmp_path):
        # Legacy "{}" string wrapper is no longer migrated — hard-fail.
        path = tmp_path / "scores.json"
        path.write_text(json.dumps({"schema": cs.SCORES_SCHEMA_V1, "assignments": "{}"}))
        with pytest.raises(cs.ScoresFileError, match="must be an object"):
            cs.load_scores(path)

    def test_load_rejects_legacy_flat_array(self, tmp_path):
        # A legacy flat-array assignments value is no longer migrated —
        # backward compatibility was intentionally dropped; hard-fail.
        path = tmp_path / "scores.json"
        path.write_text(
            json.dumps(
                {
                    "schema": cs.SCORES_SCHEMA_V1,
                    "assignments": [make_result(assignment="hello", username="alice")],
                }
            )
        )
        with pytest.raises(cs.ScoresFileError, match="must be an object"):
            cs.load_scores(path)

    def test_load_raises_when_bucket_entries_is_not_a_list(self, tmp_path):
        # Defensive -- a dict-shaped `entries` value is corrupt; don't
        # silently repair it.
        path = tmp_path / "scores.json"
        path.write_text(
            json.dumps(
                {
                    "schema": cs.SCORES_SCHEMA_V1,
                    "assignments": {"hello": {"type": "individual", "entries": {}}},
                }
            )
        )
        with pytest.raises(cs.ScoresFileError, match="must be a list"):
            cs.load_scores(path)

    def test_load_raises_when_bucket_missing_type(self, tmp_path):
        # A bucket without a `type` is not canonical — hard-fail.
        path = tmp_path / "scores.json"
        path.write_text(
            json.dumps(
                {"schema": cs.SCORES_SCHEMA_V1, "assignments": {"hello": {"entries": []}}}
            )
        )
        with pytest.raises(cs.ScoresFileError, match="type"):
            cs.load_scores(path)

    def test_load_raises_when_bucket_has_bad_type(self, tmp_path):
        # A bucket with an out-of-domain `type` hard-fails.
        path = tmp_path / "scores.json"
        path.write_text(
            json.dumps(
                {
                    "schema": cs.SCORES_SCHEMA_V1,
                    "assignments": {"hello": {"type": "solo", "entries": []}},
                }
            )
        )
        with pytest.raises(cs.ScoresFileError, match="type"):
            cs.load_scores(path)

    def test_load_rejects_non_finite_numbers(self, tmp_path):
        # Python's json accepts NaN/Infinity; Go's encoding/json
        # doesn't. scores.json has to stay valid for both.
        path = tmp_path / "scores.json"
        path.write_text(
            '{"schema":"classroom50/scores/v1","assignments":'
            '{"hello":{"type":"individual","entries":[{"owner":"alice","score":NaN}]}}}'
        )
        with pytest.raises(cs.ScoresFileError, match="non-finite"):
            cs.load_scores(path)

    def test_save_writes_atomically_and_cleans_up_tmp(self, tmp_path):
        path = tmp_path / "scores.json"
        scores = {
            "schema": cs.SCORES_SCHEMA_V1,
            "assignments": {
                "hello": {"type": "individual", "entries": [cs.entry_from_result(make_update())]}
            },
        }
        cs.save_scores(path, scores)

        round_trip = json.loads(path.read_text())
        assert round_trip == scores

        # .tmp was renamed into place, not left behind.
        assert not (tmp_path / "scores.json.tmp").exists()

    def test_save_rejects_non_finite_numbers(self, tmp_path):
        # allow_nan=False keeps a bad custom score from writing
        # Go-invalid JSON.
        path = tmp_path / "scores.json"
        entry = cs.entry_from_result(make_update(score=1))
        entry["score"] = float("nan")
        scores = {
            "schema": cs.SCORES_SCHEMA_V1,
            "assignments": {"hello": {"type": "individual", "entries": [entry]}},
        }
        with pytest.raises(cs.ScoresFileError, match="encode failed"):
            cs.save_scores(path, scores)
        assert not path.exists()

    def test_save_preserves_existing_file_when_replace_fails(self, tmp_path, monkeypatch):
        # On os.replace failure (e.g., permissions), the original is
        # untouched and the temp file is cleaned up.
        path = tmp_path / "scores.json"
        path.write_text(json.dumps({"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}))
        original = path.read_text()

        def fail_replace(*args, **kwargs):
            raise OSError("simulated permission denied")

        monkeypatch.setattr(os, "replace", fail_replace)
        with pytest.raises(cs.ScoresFileError, match="atomic write failed"):
            cs.save_scores(
                path,
                {
                    "schema": cs.SCORES_SCHEMA_V1,
                    "assignments": {
                        "hello": {
                            "type": "individual",
                            "entries": [cs.entry_from_result(make_update())],
                        }
                    },
                },
            )

        assert path.read_text() == original
        assert not (tmp_path / "scores.json.tmp").exists()


# error classification ---------------------------------------------------------


class TestErrorClassification:
    def test_missing_result_asset_has_its_own_exception_type(self):
        # Missing result.json is a malformed release, not an HTTP
        # 404 — distinct type keeps logs unambiguous.
        with pytest.raises(cs.AssetMissingError, match="result.json"):
            cs.download_result_asset(
                "https://api.github.com",
                {"url": "https://api.github.com/repos/o/r/releases/1", "assets": []},
                "token",
            )

    def test_missing_asset_error_names_the_release_not_latest(self):
        # download_result_asset runs once PER release (the full history walk),
        # so its error must name the release it inspected — "latest submit
        # release" would misdirect debugging toward the wrong release.
        with pytest.raises(cs.AssetMissingError, match="submit/2026-06-01T10-00-00Z"):
            cs.download_result_asset(
                "https://api.github.com",
                {"tag_name": "submit/2026-06-01T10-00-00Z", "assets": []},
                "token",
            )

    def test_duplicate_result_assets_are_rejected(self):
        # Normal releases have a single result.json (library uses
        # --clobber). Duplicates make grading ambiguous, so reject.
        release = {
            "url": "https://api.github.com/repos/o/r/releases/1",
            "assets": [
                {"name": "result.json", "url": "https://api.github.com/repos/o/r/releases/assets/1"},
                {"name": "result.json", "url": "https://api.github.com/repos/o/r/releases/assets/2"},
            ],
        }
        with pytest.raises(ValueError, match="2 result.json assets"):
            cs.download_result_asset("https://api.github.com", release, "token")

    def test_download_result_asset_uses_bounded_read(self, monkeypatch):
        # MAX_RESULT_BYTES must be enforced at read time, not
        # post-hoc — pin that _http_get gets max_bytes=cap+1.
        seen = {}

        def fake_http_get(url, token, *, accept, max_bytes=None):
            seen["max_bytes"] = max_bytes
            return json.dumps(make_result()).encode()

        monkeypatch.setattr(cs, "_http_get", fake_http_get)
        release = {
            "url": "https://api.github.com/repos/o/r/releases/1",
            "assets": [
                {
                    "name": "result.json",
                    "url": "https://api.github.com/repos/o/r/releases/assets/1",
                }
            ],
        }
        cs.download_result_asset("https://api.github.com", release, "token")
        assert seen["max_bytes"] == cs.MAX_RESULT_BYTES + 1


# release lookup ---------------------------------------------------------------


class TestReleaseLookup:
    def test_collect_classroom_warns_and_skips_malformed_latest_release(self, monkeypatch, capsys):
        # One malformed release listing is a per-repo
        # failure, not a run-killer like auth/network errors.
        def malformed_listing(*args, **kwargs):
            raise ValueError("expected JSON array")

        monkeypatch.setattr(cs, "all_submit_releases", malformed_listing)
        stub_team_members(monkeypatch, ["alice"])
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [{"slug": "hello"}]},
            service_token="token",
        )
        assert results == []
        assert "release listing malformed" in capsys.readouterr().err


# asset URL rewrite ------------------------------------------------------------


class TestRewriteAssetURL:
    def test_rewrites_only_scheme_and_host_for_local_test_server(self):
        # GH_API_URL can point at a local test server while release
        # payloads still carry api.github.com URLs — swap scheme+host
        # only, preserve path/query.
        got = cs.rewrite_asset_url(
            "https://api.github.com/repos/o/r/releases/assets/123?name=result.json",
            "http://127.0.0.1:9999",
        )
        assert got == "http://127.0.0.1:9999/repos/o/r/releases/assets/123?name=result.json"

    def test_github_enterprise_paths_are_not_prefix_sliced(self):
        # GHES API URLs carry a path prefix like /api/v3; parsing
        # preserves the asset path instead of corrupting non-
        # api.github.com URLs.
        got = cs.rewrite_asset_url(
            "https://ghe.example.test/api/v3/repos/o/r/releases/assets/123",
            "https://mirror.example.test/api/v3",
        )
        assert got == "https://mirror.example.test/api/v3/repos/o/r/releases/assets/123"

    def test_github_enterprise_api_prefix_is_added_when_missing(self):
        # When the API URL is GHES /api/v3 but the asset URL is
        # host-only, keep the /api/v3 prefix in the result.
        got = cs.rewrite_asset_url(
            "https://api.github.com/repos/o/r/releases/assets/123",
            "https://ghe.example.test/api/v3",
        )
        assert got == "https://ghe.example.test/api/v3/repos/o/r/releases/assets/123"

    def test_relative_asset_url_is_left_alone(self):
        # Defensive — don't invent a host when the source URL
        # wasn't absolute.
        assert cs.rewrite_asset_url("/repos/o/r/releases/assets/123", "http://127.0.0.1") == (
            "/repos/o/r/releases/assets/123"
        )


# multi-submission history ----------------------------------------------------


class TestCollectAllSubmissions:
    def _stub_releases(self, monkeypatch, tags):
        # all_submit_releases returns releases newest-first; each tag maps
        # to a distinct result payload via download_result_asset below.
        releases = [
            {"tag_name": t, "assets": [{"name": "result.json", "url": f"https://api.github.com/{t}"}]}
            for t in tags
        ]
        monkeypatch.setattr(cs, "all_submit_releases", lambda *a, **k: releases)
        # Collection is team-driven; these tests exercise a single student.
        stub_team_members(monkeypatch, ["alice"])

    def test_row_carries_full_history_newest_first(self, monkeypatch):
        # A student who pushed three times yields one scored row (the
        # newest) plus a `submissions` history of all three, newest first.
        tags = [
            "submit/2026-06-03T10-00-00Z",
            "submit/2026-06-02T10-00-00Z",
            "submit/2026-06-01T10-00-00Z",
        ]
        self._stub_releases(monkeypatch, tags)

        def fake_download(api_url, release, token):
            tag = release["tag_name"]
            score = {tags[0]: 9, tags[1]: 6, tags[2]: 3}[tag]
            return make_result(username="alice", score=score, max_score=10, submission_tag=tag)

        monkeypatch.setattr(cs, "download_result_asset", fake_download)

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [{"slug": "hello"}]},
            service_token="token",
        )
        assert len(results) == 1
        row = results[0]
        # The entry holds identity + the full submission history; the
        # per-submission detail lives only inside `submissions`.
        assert row["owner"] == "alice"
        assert "score" not in row
        assert "submission" not in row
        # The history holds every submission, newest first.
        history = row["submissions"]
        assert [h["submission"] for h in history] == tags
        assert [h["score"] for h in history] == [9, 6, 3]
        # History records are result/v1 shapes (no nested `submissions`,
        # no bucket-key `assignment`).
        for h in history:
            assert "submissions" not in h
            assert "assignment" not in h

    def test_bad_submission_in_history_is_skipped_not_fatal(self, monkeypatch, capsys):
        # A single malformed/older result.json warns and is dropped from
        # the history without sinking the other submissions.
        tags = ["submit/2026-06-02T10-00-00Z", "submit/2026-06-01T10-00-00Z"]
        self._stub_releases(monkeypatch, tags)

        def fake_download(api_url, release, token):
            if release["tag_name"] == tags[1]:
                raise ValueError("malformed json")
            return make_result(username="alice", submission_tag=tags[0])

        monkeypatch.setattr(cs, "download_result_asset", fake_download)

        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [{"slug": "hello"}]},
            service_token="token",
        )
        assert len(results) == 1
        assert [h["submission"] for h in results[0]["submissions"]] == [tags[0]]
        assert "malformed" in capsys.readouterr().err

    def test_all_submissions_invalid_yields_no_row(self, monkeypatch):
        # If every submission fails validation/download there is nothing
        # creditable — the repo produces no row.
        self._stub_releases(monkeypatch, ["submit/2026-06-01T10-00-00Z"])
        monkeypatch.setattr(
            cs, "download_result_asset", lambda *a, **k: (_ for _ in ()).throw(ValueError("bad"))
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [{"slug": "hello"}]},
            service_token="token",
        )
        assert results == []

    def test_entry_has_no_duplicated_top_level_result_fields(self, monkeypatch):
        # Regression for the flattening change: the entry must NOT repeat the
        # newest submission's result fields at the top level. For an
        # individual entry the keys are exactly {_assignment, _type, owner,
        # submissions} (the transport hints are stripped only on store).
        self._stub_releases(monkeypatch, ["submit/2026-06-01T10-00-00Z"])
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(username="alice", score=7, max_score=10),
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [{"slug": "hello"}]},
            service_token="token",
        )
        row = results[0]
        assert set(row) == {"_assignment", "_type", "owner", "submissions"}
        for leaked in ("score", "max-score", "datetime", "submission", "tests", "commit"):
            assert leaked not in row, f"{leaked} leaked to the entry top level"

    def test_apply_updates_stores_flattened_entry_and_is_idempotent(self, monkeypatch):
        # End-to-end: a collected entry stores as {owner, submissions} (the
        # transport hints stripped), and re-applying the identical entry is
        # a no-op.
        self._stub_releases(monkeypatch, ["submit/2026-06-01T10-00-00Z"])
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(username="alice", score=7, max_score=10),
        )
        results, _, _, _ = cs.collect_classroom(
            api_url="https://api.github.com",
            org="cs50",
            classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [{"slug": "hello"}]},
            service_token="token",
        )
        scores = {"schema": cs.SCORES_SCHEMA_V1, "assignments": {}}
        assert cs.apply_updates(scores, results) == 1
        stored = scores["assignments"]["hello"]["entries"][0]
        assert set(stored) == {"owner", "submissions"}  # transport hints dropped
        assert len(stored["submissions"]) == 1
        # Re-applying the same collected results changes nothing.
        assert cs.apply_updates(scores, results) == 0


class TestAllSubmitReleases:
    def test_filters_non_submit_and_keeps_order(self, monkeypatch):
        body = json.dumps([
            {"tag_name": "submit/2026-06-03T10-00-00Z"},
            {"tag_name": "v2.0.0"},
            {"tag_name": "submit/2026-06-01T10-00-00Z"},
        ]).encode("utf-8")

        class NoHeaders:
            def get(self, name):
                return None

        monkeypatch.setattr(cs, "_http_get_with_headers", lambda *a, **k: (body, NoHeaders()))
        releases = cs.all_submit_releases("https://api.github.com", "o", "r", "token")
        assert [r["tag_name"] for r in releases] == [
            "submit/2026-06-03T10-00-00Z",
            "submit/2026-06-01T10-00-00Z",
        ]

    def test_404_returns_empty(self, monkeypatch):
        def boom(*a, **k):
            raise cs.urllib.error.HTTPError("u", 404, "Not Found", None, None)

        monkeypatch.setattr(cs, "_http_get_with_headers", boom)
        assert cs.all_submit_releases("https://api.github.com", "o", "r", "token") == []

    def test_skips_draft_releases(self, monkeypatch):
        # A read-write token also sees draft releases. The runner never
        # publishes drafts, so a draft submit/* tag is hand-made noise — a
        # draft's assets aren't downloadable via the public asset URL either,
        # so ingesting it would fail downstream. Skip drafts entirely.
        body = json.dumps([
            {"tag_name": "submit/2026-06-03T10-00-00Z", "draft": True},
            {"tag_name": "submit/2026-06-01T10-00-00Z", "draft": False},
            {"tag_name": "submit/2026-05-01T10-00-00Z"},
        ]).encode("utf-8")

        class NoHeaders:
            def get(self, name):
                return None

        monkeypatch.setattr(cs, "_http_get_with_headers", lambda *a, **k: (body, NoHeaders()))
        releases = cs.all_submit_releases("https://api.github.com", "o", "r", "token")
        assert [r["tag_name"] for r in releases] == [
            "submit/2026-06-01T10-00-00Z",
            "submit/2026-05-01T10-00-00Z",
        ]

    def test_paginates_via_link_header(self, monkeypatch):
        page1 = json.dumps([{"tag_name": f"submit/p1-{i}"} for i in range(100)]).encode("utf-8")
        page2 = json.dumps([{"tag_name": "submit/last"}]).encode("utf-8")

        class Headers:
            def __init__(self, link):
                self._link = link

            def get(self, name):
                return self._link if name == "Link" else None

        def fake(url, token, *, accept, max_bytes=None):
            if "cursor=two" in url:
                return page2, Headers(None)
            return page1, Headers('<https://api.github.com/x?cursor=two>; rel="next"')

        monkeypatch.setattr(cs, "_http_get_with_headers", fake)
        releases = cs.all_submit_releases("https://api.github.com", "o", "r", "token")
        assert len(releases) == 101
        assert releases[-1]["tag_name"] == "submit/last"

    def test_looping_next_link_raises_instead_of_returning_partial(self, monkeypatch):
        # A looping Link chain means the listing cannot be completed. Returning
        # the pages walked so far would persist a TRUNCATED submission history
        # over the student's richer prior entry — raise IncompleteListing so the
        # caller's warn-and-skip preserves it instead (same invariant as every
        # other paginated walk).
        body = json.dumps(
            [{"tag_name": f"submit/p-{i}"} for i in range(100)]
        ).encode("utf-8")

        class LoopHeaders:
            def get(self, name):
                if name == "Link":
                    return '<https://api.github.com/releases?cursor=same>; rel="next"'
                return None

        monkeypatch.setattr(
            cs, "_http_get_with_headers", lambda *a, **k: (body, LoopHeaders())
        )
        with pytest.raises(cs.IncompleteListing, match="incomplete"):
            cs.all_submit_releases("https://api.github.com", "o", "r", "token")


class TestCommitWalkEarlyStop:
    def test_stops_paging_once_the_baseline_page_is_reached(self, monkeypatch):
        # Commits arrive newest-first, so every page past the one carrying the
        # accept baseline is pre-accept history the caller cuts anyway — the
        # walk must not spend requests on it.
        page1 = json.dumps(
            [{"sha": f"student{i}"} for i in range(100)]
        ).encode("utf-8")
        page2 = json.dumps(
            [{"sha": "baseline"}, {"sha": "template1"}]
        ).encode("utf-8")

        class Headers:
            def __init__(self, link):
                self._link = link

            def get(self, name):
                return self._link if name == "Link" else None

        calls = {"n": 0}

        def fake(url, token, *, accept, max_bytes=None):
            calls["n"] += 1
            if "cursor=two" in url:
                return page2, Headers(
                    '<https://api.github.com/x?cursor=three>; rel="next"'
                )
            return page1, Headers('<https://api.github.com/x?cursor=two>; rel="next"')

        monkeypatch.setattr(cs, "_http_get_with_headers", fake)
        commits = cs.list_default_branch_commits(
            "https://api.github.com", "o", "r", "main", "token",
            stop_at_sha="baseline",
        )
        assert calls["n"] == 2, "must stop on the baseline's page"
        # The whole baseline page is returned so the caller cuts precisely.
        assert commits[-1]["sha"] == "template1"
        assert cs.detect_branch_submissions(commits, "baseline") == [
            {"sha": f"student{i}", "datetime": None} for i in range(100)
        ]


# main() hard-failure handling -------------------------------------------------


class TestMain:
    def test_api_url_prefers_explicit_override_then_actions_value(
        self, tmp_path, monkeypatch
    ):
        write_minimal_classroom(tmp_path)
        seen = []

        def fake_collect(**kwargs):
            seen.append(kwargs["api_url"])
            return [], 0, {}, {}

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setenv("GITHUB_API_URL", "https://ghe.example.test/api/v3")
        monkeypatch.setattr(cs, "collect_classroom", fake_collect)

        assert cs.main() == 0
        assert seen == ["https://ghe.example.test/api/v3"]

        seen.clear()
        monkeypatch.setenv("GH_API_URL", "http://127.0.0.1:9999")
        assert cs.main() == 0
        assert seen == ["http://127.0.0.1:9999"]

    def test_filter_matching_no_classroom_exits_nonzero(self, tmp_path, monkeypatch, capsys):
        # A dispatch scoped to a classroom that doesn't exist in the config
        # repo (typo, or the repo checkout predates the classroom) must FAIL,
        # not report a successful run that collected nothing — the web app's
        # freshness tracking treats a green run as "collected".
        write_minimal_classroom(tmp_path)
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setenv("CLASSROOM_FILTER", "no-such-classroom")

        assert cs.main() == 1
        err = capsys.readouterr().err
        assert "no-such-classroom" in err

    def test_no_classrooms_without_filter_still_exits_zero(self, tmp_path, monkeypatch):
        # An empty config repo with an org-wide collect run legitimately has
        # nothing to collect — that stays a clean no-op, unlike a no-match
        # explicit filter.
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.delenv("CLASSROOM_FILTER", raising=False)

        assert cs.main() == 0

    def test_assignment_filter_threads_into_collect_classroom(self, tmp_path, monkeypatch):
        # ASSIGNMENT_FILTER narrows collection to one assignment (the web app's
        # per-assignment "Sync now"); main() must hand it to collect_classroom.
        write_minimal_classroom(tmp_path)
        seen = []

        def fake_collect(**kwargs):
            seen.append(kwargs.get("assignment_filter"))
            return [], 0, {}, {}

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setenv("ASSIGNMENT_FILTER", "hello")
        monkeypatch.setattr(cs, "collect_classroom", fake_collect)

        assert cs.main() == 0
        assert seen == ["hello"]

    def test_assignment_filter_matching_nothing_exits_nonzero(
        self, tmp_path, monkeypatch, capsys
    ):
        # Same contract as the classroom filter: a scoped dispatch naming an
        # assignment that exists in NO collected classroom is a failed run, not
        # a green no-op the web app would read as "collected".
        write_minimal_classroom(tmp_path)
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setenv("ASSIGNMENT_FILTER", "no-such-assignment")
        monkeypatch.setattr(cs, "collect_classroom", lambda **k: ([], 0, {}, {}))

        assert cs.main() == 1
        assert "no-such-assignment" in capsys.readouterr().err

    def test_hard_http_error_prints_actionable_message(self, tmp_path, monkeypatch, capsys):
        # Hard HTTP failures must surface a clean workflow error,
        # not a Python traceback.
        write_minimal_classroom(tmp_path)

        def fail_collect(**kwargs):
            raise cs.urllib.error.HTTPError(
                url="https://api.github.com/repos/o/r/releases/latest",
                code=401,
                msg="bad credentials",
                hdrs=None,
                fp=None,
            )

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "bad-token")
        monkeypatch.setattr(cs, "collect_classroom", fail_collect)

        assert cs.main() == 1
        err = capsys.readouterr().err
        assert "rotate-service-token cs50" in err
        assert "HTTP 401" in err

    def test_network_hard_error_prints_non_token_message(self, tmp_path, monkeypatch, capsys):
        write_minimal_classroom(tmp_path)

        def fail_collect(**kwargs):
            raise cs.urllib.error.HTTPError(
                url="https://api.github.com/repos/o/r/releases/latest",
                code=599,
                msg="network error",
                hdrs=None,
                fp=None,
            )

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "collect_classroom", fail_collect)

        assert cs.main() == 1
        err = capsys.readouterr().err
        assert "HTTP 599" in err
        assert "rotate-service-token" not in err

    def test_warns_when_zero_submissions_across_roster(self, tmp_path, monkeypatch, capsys):
        # The 404 blind spot: a service token that can't read the
        # student repos makes collect_classroom report everyone as
        # unsubmitted, so the run exits 0 with an empty gradebook and
        # no signal. A non-empty roster x assignment set that yields
        # zero readable submissions must warn so the silence isn't
        # mistaken for "nobody submitted."
        write_minimal_classroom(tmp_path)
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "collect_classroom", lambda **kwargs: ([], 0, {}, {}))

        assert cs.main() == 0
        err = capsys.readouterr().err
        assert "::warning::" in err
        assert "collected 0 submissions" in err
        assert "rotate-service-token cs50" in err
        # The gradebook is left untouched -- no false entries written.
        scores = json.loads((tmp_path / "cs-principles" / "scores.json").read_text())
        assert scores["assignments"] == {}

    def test_no_warning_when_a_submission_is_collected(self, tmp_path, monkeypatch, capsys):
        # At least one readable submission proves the token works --
        # don't cry wolf.
        write_minimal_classroom(tmp_path)
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(
            cs, "collect_classroom", lambda **kwargs: ([make_update(username="alice")], 0, {"hello": "individual"}, {})
        )

        assert cs.main() == 0
        assert "::warning::" not in capsys.readouterr().err

    def test_warns_when_zero_collected_but_assignments_exist(self, tmp_path, monkeypatch, capsys):
        # Team-driven collection: an empty roster no longer means
        # "nothing to collect" (the CSV is only metadata now). When
        # assignments exist and zero submissions come back, main() warns —
        # the cause is either an empty classroom team or a token that can't
        # read the student repos. (The empty-team case additionally emits its
        # own specific warning inside collect_classroom, which is mocked here.)
        write_minimal_classroom(tmp_path)
        write_roster(tmp_path / "cs-principles" / "roster.csv", [])
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "collect_classroom", lambda **kwargs: ([], 0, {}, {}))

        assert cs.main() == 0
        assert "collected 0 submissions" in capsys.readouterr().err

    def test_no_warning_when_no_assignments_registered(self, tmp_path, monkeypatch, capsys):
        # A classroom with no assignments registered yet also has
        # nothing to collect -- the assignment-count guard keeps it
        # quiet so an empty manifest isn't mistaken for a token problem.
        write_minimal_classroom(tmp_path)
        (tmp_path / "cs-principles" / "assignments.json").write_text(
            json.dumps({"schema": cs.ASSIGNMENTS_SCHEMA_V1, "assignments": []})
        )
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "collect_classroom", lambda **kwargs: ([], 0, {}, {}))

        assert cs.main() == 0
        assert "collected 0 submissions" not in capsys.readouterr().err

    def test_grant_hard_error_does_not_abort_collection(self, tmp_path, monkeypatch, capsys):
        # Decoupling: a staff-grant hard error (403 missing Administration) must
        # NOT abort score collection. The classroom is still collected, the run
        # exits non-zero (loud), and the error names the Administration scope.
        write_minimal_classroom(tmp_path)
        # A teams block so grant_classroom_team_access does real work (then fails).
        (tmp_path / "cs-principles" / "classroom.json").write_text(
            json.dumps(
                {
                    "schema": cs.CLASSROOM_SCHEMA_V1,
                    "short_name": "cs-principles",
                    "team": {"id": 1, "slug": "classroom50-cs-principles"},
                    "teams": {"ta": {"id": 2, "slug": "classroom50-cs-principles-ta"}},
                }
            )
        )
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")

        def grant_403(**kwargs):
            raise cs.urllib.error.HTTPError(
                url="https://api.github.com/orgs/cs50/teams/classroom50-cs-principles-ta/repos/cs50/x",
                code=403,
                msg="forbidden",
                hdrs=None,
                fp=None,
            )

        collected = {"called": False}

        def fake_collect(**kwargs):
            collected["called"] = True
            return [make_update(username="alice")], 0, {"hello": "individual"}, {}

        monkeypatch.setattr(cs, "grant_classroom_team_access", grant_403)
        monkeypatch.setattr(cs, "collect_classroom", fake_collect)

        rc = cs.main()
        err = capsys.readouterr().err
        # Collection ran despite the grant failure.
        assert collected["called"] is True
        # The gradebook was written (collection was not skipped).
        scores = json.loads((tmp_path / "cs-principles" / "scores.json").read_text())
        assert scores["assignments"]  # non-empty -> a submission landed
        # The run still exits non-zero and names the Administration scope.
        assert rc == 1
        assert "Administration: Read and write" in err
        assert "Score collection continues" in err

    def test_one_malformed_scores_json_does_not_block_other_classrooms(
        self, tmp_path, monkeypatch, capsys
    ):
        # Failure isolation: a malformed scores.json in ONE classroom must
        # not abort the whole run and strand alphabetically-later classrooms.
        # The bad classroom is skipped (run still exits non-zero), but the
        # good one is collected and its gradebook updated.
        # "a-bad" sorts before "z-good" so the old `return 1` would have
        # skipped z-good entirely.
        bad = tmp_path / "a-bad"
        bad.mkdir()
        (bad / "classroom.json").write_text(
            json.dumps({"schema": cs.CLASSROOM_SCHEMA_V1, "short_name": "a-bad"})
        )
        (bad / "assignments.json").write_text(
            json.dumps({"schema": cs.ASSIGNMENTS_SCHEMA_V1,
                        "assignments": [{"slug": "hello", "name": "H", "mode": "individual", "tests": []}]})
        )
        write_roster(bad / "roster.csv", [{"username": "alice", "github_id": "1"}])
        # Malformed: assignments is a list, not the canonical object.
        (bad / "scores.json").write_text(
            json.dumps({"schema": cs.SCORES_SCHEMA_V1, "assignments": []})
        )

        good = tmp_path / "z-good"
        good.mkdir()
        (good / "classroom.json").write_text(
            json.dumps({"schema": cs.CLASSROOM_SCHEMA_V1, "short_name": "z-good"})
        )
        (good / "assignments.json").write_text(
            json.dumps({"schema": cs.ASSIGNMENTS_SCHEMA_V1,
                        "assignments": [{"slug": "hello", "name": "H", "mode": "individual", "tests": []}]})
        )
        write_roster(good / "roster.csv", [{"username": "alice", "github_id": "1"}])
        (good / "scores.json").write_text(
            json.dumps({"schema": cs.SCORES_SCHEMA_V1, "assignments": {}})
        )

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(
            cs, "collect_classroom",
            lambda **kwargs: ([make_update(username="alice")], 0, {"hello": "individual"}, {}) if kwargs["classroom_short"] == "z-good" else ([], 0, {}, {}),
        )

        # Run fails (a classroom was bad) but the good classroom is collected.
        assert cs.main() == 1
        err = capsys.readouterr().err
        assert "a-bad" in err  # the bad classroom is named in the error
        good_scores = json.loads((good / "scores.json").read_text())
        assert "hello" in good_scores["assignments"], (
            "z-good must still be collected even though a-bad failed first"
        )


class TestDetectedPersistence:
    """main()'s `detected` merge: a repo the run couldn't read keeps its prior
    record, a visited repo with nothing detected loses its record, and an
    all-clear run still writes [] so "collected, nobody submitted" is
    distinguishable from "never collected"."""

    def _env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")

    def _seed(self, tmp_path, detected):
        path = tmp_path / "cs-principles" / "scores.json"
        path.write_text(json.dumps({
            "schema": "classroom50/scores/v1",
            "assignments": {
                "hello": {"type": "individual", "entries": [], "detected": detected}
            },
        }))
        return path

    def _read(self, tmp_path):
        path = tmp_path / "cs-principles" / "scores.json"
        return json.loads(path.read_text())["assignments"]["hello"]

    def test_unreadable_repo_keeps_its_prior_record(self, tmp_path, monkeypatch):
        # bob's repo read failed this run (not in `visited`), so his recorded
        # submission must NOT be deleted — a transient 500 must not make a
        # submitter vanish from the gradebook.
        write_minimal_classroom(tmp_path)
        self._env(tmp_path, monkeypatch)
        self._seed(tmp_path, [
            {"owner": "alice", "count": 1},
            {"owner": "bob", "count": 2},
        ])
        monkeypatch.setattr(
            cs, "collect_classroom",
            lambda **kwargs: ([], 0, {}, {
                "hello": ("individual", [{"owner": "alice", "count": 3}], {"alice"})
            }),
        )

        assert cs.main() == 0

        detected = self._read(tmp_path)["detected"]
        by_owner = {r["owner"]: r for r in detected}
        assert by_owner["alice"]["count"] == 3   # refreshed
        assert by_owner["bob"]["count"] == 2     # preserved

    def test_visited_repo_with_no_detection_loses_its_record(
        self, tmp_path, monkeypatch
    ):
        # bob WAS read and detected nothing (he withdrew/force-pushed away his
        # work), so the stale record goes.
        write_minimal_classroom(tmp_path)
        self._env(tmp_path, monkeypatch)
        self._seed(tmp_path, [{"owner": "bob", "count": 2}])
        monkeypatch.setattr(
            cs, "collect_classroom",
            lambda **kwargs: ([], 0, {}, {
                "hello": ("individual", [], {"bob"})
            }),
        )

        assert cs.main() == 0
        assert self._read(tmp_path)["detected"] == []

    def test_empty_result_writes_a_list_not_a_missing_key(
        self, tmp_path, monkeypatch
    ):
        # The web reads an ABSENT key as "never collected" and shows a
        # not-collected label; a real collect that found nobody must write [] so
        # it renders an honest 0 / N instead.
        write_minimal_classroom(tmp_path)
        self._env(tmp_path, monkeypatch)
        monkeypatch.setattr(
            cs, "collect_classroom",
            lambda **kwargs: ([], 0, {}, {
                "hello": ("individual", [], {"alice"})
            }),
        )

        assert cs.main() == 0
        assert self._read(tmp_path)["detected"] == []


class TestCollectedAtStamp:
    """Per-bucket `collected_at`: main() stamps every bucket the run actually
    walked (even unchanged/empty), a skipped bucket keeps its old stamp, and
    the load path preserves the field across read-modify-write."""

    def _env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")

    def test_utc_now_iso_matches_schema_shape(self):
        # The writer's stamp source must emit the schema's UTC-Z shape directly
        # (no offset, no fractional seconds) — the direct guard on the helper so
        # a drift is caught even if the end-to-end stamping tests change.
        assert SCHEMA_UTC_Z_RE.fullmatch(cs.utc_now_iso())

    def test_walked_bucket_is_stamped(self, tmp_path, monkeypatch):
        write_minimal_classroom(tmp_path)
        self._env(tmp_path, monkeypatch)
        monkeypatch.setattr(
            cs, "collect_classroom",
            lambda **kwargs: ([make_update(username="alice")], 0, {"hello": "individual"}, {}),
        )

        assert cs.main() == 0
        scores = json.loads((tmp_path / "cs-principles" / "scores.json").read_text())
        stamp = scores["assignments"]["hello"]["collected_at"]
        # Strict UTC-Z shape, not just cs.RFC3339_RE (which also accepts offsets
        # / fractional seconds): the schema and the Go/TS readers require this
        # exact form, so a drift of utc_now_iso() must fail here.
        assert SCHEMA_UTC_Z_RE.fullmatch(stamp), stamp

    def test_walked_bucket_with_no_submissions_is_created_empty_and_stamped(
        self, tmp_path, monkeypatch
    ):
        # Zero submissions is still a completed walk — "checked at T, nothing
        # found" must be distinguishable from "never collected".
        write_minimal_classroom(tmp_path)
        self._env(tmp_path, monkeypatch)
        monkeypatch.setattr(
            cs, "collect_classroom", lambda **kwargs: ([], 0, {"hello": "individual"}, {})
        )

        assert cs.main() == 0
        scores = json.loads((tmp_path / "cs-principles" / "scores.json").read_text())
        bucket = scores["assignments"]["hello"]
        assert bucket["type"] == "individual"
        assert bucket["entries"] == []
        assert SCHEMA_UTC_Z_RE.fullmatch(bucket["collected_at"])

    def test_unwalked_bucket_keeps_its_old_stamp(self, tmp_path, monkeypatch):
        # A scoped run must not refresh (or drop) a sibling bucket's stamp —
        # this also exercises load_scores preserving unknown bucket fields.
        classroom = write_minimal_classroom(tmp_path)
        (classroom / "scores.json").write_text(
            json.dumps(
                {
                    "schema": cs.SCORES_SCHEMA_V1,
                    "assignments": {
                        "sibling": {
                            "type": "individual",
                            "entries": [],
                            "collected_at": "2026-01-01T00:00:00Z",
                        }
                    },
                }
            )
        )
        self._env(tmp_path, monkeypatch)
        monkeypatch.setattr(
            cs, "collect_classroom", lambda **kwargs: ([], 0, {"hello": "individual"}, {})
        )

        assert cs.main() == 0
        scores = json.loads((classroom / "scores.json").read_text())
        assert scores["assignments"]["sibling"]["collected_at"] == "2026-01-01T00:00:00Z"
        assert "collected_at" in scores["assignments"]["hello"]

    def test_walked_bucket_type_resyncs_without_updates(self, tmp_path, monkeypatch):
        # A mode flip must reach the bucket `type` even when the walk produced
        # no entry updates (apply_updates only syncs buckets it touches) — a
        # detected-only or update-less bucket would otherwise keep the stale
        # mode forever and the web would render the wrong assignment type.
        classroom = write_minimal_classroom(tmp_path)
        (classroom / "scores.json").write_text(
            json.dumps(
                {
                    "schema": cs.SCORES_SCHEMA_V1,
                    "assignments": {
                        "hello": {"type": "group", "entries": []},
                    },
                }
            )
        )
        self._env(tmp_path, monkeypatch)
        monkeypatch.setattr(
            cs, "collect_classroom", lambda **kwargs: ([], 0, {"hello": "individual"}, {})
        )

        assert cs.main() == 0
        scores = json.loads((classroom / "scores.json").read_text())
        assert scores["assignments"]["hello"]["type"] == "individual"

    def test_skipped_classroom_returns_no_walked_slugs(self, monkeypatch):
        # Team unreadable -> collection skipped wholesale; nothing may be
        # stamped, or a skipped classroom would read as freshly collected.
        stub_team_members(monkeypatch, [])
        _, _, collected, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={},
            assignments={"assignments": [{"slug": "hello", "name": "H", "mode": "individual", "tests": []}]},
            service_token="token",
        )
        assert collected == {}

    def test_collect_classroom_reports_only_walked_slugs(self, monkeypatch):
        # The filtered-out sibling and the never-grading assignment are not
        # walked, so neither may be stamped; the group assignment reports its
        # mode so an absent bucket can be scaffolded with the right type.
        stub_team_members(monkeypatch, ["alice"])
        monkeypatch.setattr(cs, "all_submit_releases", lambda *a, **k: [])
        _, _, collected, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={},
            assignments={
                "assignments": [
                    {"slug": "hello", "name": "H", "mode": "group", "tests": []},
                    {"slug": "other", "name": "O", "mode": "individual", "tests": []},
                    {"slug": "reading", "name": "R", "mode": "individual", "empty_repo": True, "tests": []},
                ]
            },
            service_token="token",
            assignment_filter="hello",
        )
        assert collected == {"hello": "group"}


class TestCollectClassroomModeFlip:
    def _assignments(self, mode):
        return {"assignments": [{"slug": "hello", "name": "H", "mode": mode, "tests": []}]}

    def test_mode_flip_rejects_all_and_warns_loudly(self, monkeypatch, capsys):
        # An assignment switched individual->group mid-term: every prior
        # release's assignment_type now mismatches the new mode and is
        # rejected by validate_result, so history is empty. The repo HAD
        # releases, so collection must emit the loud consolidated mode-flip
        # warning (rather than silently treating it as not-submitted) and
        # signal the mode-flip to main() via the returned count.
        monkeypatch.setattr(
            cs, "all_submit_releases",
            lambda *a, **k: [{"tag_name": "submit/2026-06-01T10-00-00Z",
                              "assets": [{"name": "result.json", "url": "https://api.github.com/a/1"}]}],
        )
        # The published result is still individual-typed (graded before the flip).
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(username="alice", assignment_type="individual"),
        )
        # Manifest now says group.
        stub_team_members(monkeypatch, ["alice"])
        results, mode_flip, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._assignments("group"),
            service_token="token",
        )
        assert results == []
        assert mode_flip == 1
        err = capsys.readouterr().err
        assert "NONE were creditable" in err
        assert "individual<->group" in err
        # The affected repo is named explicitly in the consolidated warning.
        assert "cs-principles-hello-alice" in err

    def test_missing_asset_does_not_trip_mode_flip_signal(self, monkeypatch, capsys):
        # A release whose result.json asset is simply absent (a benign / in-
        # flight state) must NOT be misreported as a mode flip: it produces
        # empty history but is not a validation rejection, so the mode-flip
        # count stays 0 and the loud mode-flip warning is not emitted.
        monkeypatch.setattr(
            cs, "all_submit_releases",
            lambda *a, **k: [{"tag_name": "submit/2026-06-01T10-00-00Z", "assets": []}],
        )

        def _no_asset(*a, **k):
            raise cs.AssetMissingError("no result.json asset on release")

        monkeypatch.setattr(cs, "download_result_asset", _no_asset)
        stub_team_members(monkeypatch, ["alice"])
        results, mode_flip, _, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._assignments("individual"),
            service_token="token",
        )
        assert results == []
        assert mode_flip == 0
        err = capsys.readouterr().err
        assert "NONE were creditable" not in err


# empty_repo skip -------------------------------------------------------------


def test_valid_assignment_slugs_excludes_empty_repo():
    # empty_repo assignments never autograde, so they don't count toward the
    # "collectable assignments" total main() uses for its zero-submission guard.
    assignments = {
        "assignments": [
            {"slug": "hello"},
            {"slug": "actions-lab", "empty_repo": True},
            {"slug": "world", "empty_repo": False},
        ]
    }
    assert cs.valid_assignment_slugs(assignments) == ["hello", "world"]


def test_is_empty_repo_is_strict_boolean_true():
    # The wire contract is a JSON boolean (Go decodes a strict bool; TS uses
    # === true). is_empty_repo must agree: only the literal True is empty_repo,
    # so a non-boolean value from a hand-edited manifest is NOT treated as bare
    # (it would otherwise diverge from the Go/TS readers).
    assert cs.is_empty_repo({"empty_repo": True}) is True
    assert cs.is_empty_repo({"empty_repo": False}) is False
    assert cs.is_empty_repo({}) is False
    for non_bool in ("true", "yes", 1, [1], {"x": 1}):
        assert cs.is_empty_repo({"empty_repo": non_bool}) is False, non_bool
    # A non-boolean truthy value must still be COLLECTED (not silently skipped).
    assert cs.valid_assignment_slugs(
        {"assignments": [{"slug": "a", "empty_repo": "yes"}]}
    ) == ["a"]


def test_runner_empty_repo_guard_uses_strict_predicate():
    # The autograde runner's inline guard is student-repo-facing (a hand-added
    # workflow could call it), so it must skip bare assignments with the SAME
    # strict predicate as the importable readers — a truthiness check here
    # would diverge from Go/TS and from is_empty_repo.
    runner = (
        pathlib.Path(__file__).resolve().parent.parent
        / "skeleton"
        / "dotgithub"
        / "workflows"
        / "autograde-runner.yaml"
    ).read_text()
    assert 'entry.get("empty_repo") is True' in runner, (
        "runner empty_repo guard must use the strict `is True` predicate "
        "(matching is_empty_repo / Go bool / TS === true)"
    )
    assert "autograding is disabled for it" in runner


def test_valid_assignment_slugs_excludes_no_autograder():
    # A templated no_autograder assignment (teacher-supplied CI) never produces
    # submit/* releases, so it is not collectable — same skip as empty_repo.
    assignments = {
        "assignments": [
            {"slug": "hello"},
            {"slug": "ci-lab", "no_autograder": True},
            {"slug": "world", "no_autograder": False},
        ]
    }
    assert cs.valid_assignment_slugs(assignments) == ["hello", "world"]


def test_is_no_autograder_is_strict_boolean_true():
    # Same strict-boolean wire contract as is_empty_repo, so all tools agree.
    assert cs.is_no_autograder({"no_autograder": True}) is True
    assert cs.is_no_autograder({"no_autograder": False}) is False
    assert cs.is_no_autograder({}) is False
    for non_bool in ("true", "yes", 1, [1], {"x": 1}):
        assert cs.is_no_autograder({"no_autograder": non_bool}) is False, non_bool
    # skips_grading unifies the two "does not autograde" states.
    assert cs.skips_grading({"empty_repo": True}) is True
    assert cs.skips_grading({"no_autograder": True}) is True
    assert cs.skips_grading({"slug": "x"}) is False


def test_is_init_shim_is_strict_boolean_and_still_grades():
    # init_shim commits the default shim and DOES autograde, so it is strictly
    # NOT part of skips_grading — the key regression guard for this feature.
    assert cs.is_init_shim({"init_shim": True}) is True
    assert cs.is_init_shim({"init_shim": False}) is False
    assert cs.is_init_shim({}) is False
    for non_bool in ("true", "yes", 1, [1], {"x": 1}):
        assert cs.is_init_shim({"init_shim": non_bool}) is False, non_bool
    # The whole point: an init_shim assignment is NOT skipped.
    assert cs.skips_grading({"init_shim": True}) is False


def test_valid_assignment_slugs_includes_init_shim():
    # An init_shim assignment autogrades and produces submit/* releases, so it
    # IS collectable — unlike empty_repo/no_autograder.
    assignments = {
        "assignments": [
            {"slug": "hello"},
            {"slug": "scratch", "init_shim": True},
        ]
    }
    assert cs.valid_assignment_slugs(assignments) == ["hello", "scratch"]


def test_runner_no_autograder_guard_uses_strict_predicate():
    # The runner's student-repo-facing guard must skip a no_autograder
    # assignment with the same strict predicate as the importable readers.
    runner = (
        pathlib.Path(__file__).resolve().parent.parent
        / "skeleton"
        / "dotgithub"
        / "workflows"
        / "autograde-runner.yaml"
    ).read_text()
    assert 'entry.get("no_autograder") is True' in runner, (
        "runner no_autograder guard must use the strict `is True` predicate "
        "(matching is_no_autograder / Go bool / TS === true)"
    )
    # Assert the guard's fail() body too, not just the predicate line: a guard
    # that keeps the predicate but has a broken/no-op body would still pass a
    # predicate-only check green (mirrors the empty_repo guard's twin).
    assert "built-in autograding is disabled for it" in runner


def test_collect_classroom_detects_no_autograder_assignment(monkeypatch, capsys):
    # A no_autograder assignment is never polled for releases (there are none),
    # but its submissions ARE detected from repo state (#659) and recorded as
    # presence/count — never as a graded entry.
    def fail_releases(*args, **kwargs):
        raise AssertionError("no_autograder repos must not be polled for releases")

    monkeypatch.setattr(cs, "all_submit_releases", fail_releases)
    monkeypatch.setattr(
        cs,
        "detect_repo_submissions",
        lambda *a, **k: [
            {"sha": "c2", "datetime": "2026-06-02T10:00:00Z"},
            {"sha": "c1", "datetime": "2026-06-01T10:00:00Z"},
        ],
    )
    stub_team_members(monkeypatch, ["alice"])

    results, _, collected, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={"assignments": [{"slug": "ci-lab", "no_autograder": True}]},
        service_token="token",
    )

    # No graded results — the gradebook stays score-free for this assignment.
    assert results == []
    assert "no_autograder" in capsys.readouterr().out
    # ...but the submitter is recorded, with a count and the newest instant.
    atype, records, _visited = detected["ci-lab"]
    assert atype == "individual"
    assert records == [
        {
            "owner": "alice",
            "count": 2,
            "latest_datetime": "2026-06-02T10:00:00Z",
            "kind": "commit",
        }
    ]
    # The bucket is walked, so it gets a collected_at stamp like any other.
    assert collected["ci-lab"] == "individual"


def test_no_autograder_detection_records_no_score(monkeypatch):
    # Guard the contract that keeps grades uncontaminated: a detected record
    # carries presence/count only — never score, max-score, tests or a release.
    monkeypatch.setattr(
        cs,
        "detect_repo_submissions",
        lambda *a, **k: [{"sha": "c1", "datetime": "2026-06-01T10:00:00Z"}],
    )
    stub_team_members(monkeypatch, ["alice"])

    _, _, _, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={"assignments": [{"slug": "ci-lab", "no_autograder": True}]},
        service_token="token",
    )

    (record,) = detected["ci-lab"][1]
    for forbidden in ("score", "max-score", "tests", "release", "review", "submissions"):
        assert forbidden not in record


def test_no_autograder_detection_omits_non_submitters(monkeypatch):
    # A repo with nothing detected is OMITTED rather than recorded as 0, so the
    # record list is exactly the submitter set (what the progress bar counts).
    def per_user(api_url, org, repo_name, token, mode, tags):
        return [{"sha": "c1", "datetime": "2026-06-01T10:00:00Z"}] if "alice" in repo_name else []

    monkeypatch.setattr(cs, "detect_repo_submissions", per_user)
    stub_team_members(monkeypatch, ["alice", "bob"])

    _, _, _, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={"assignments": [{"slug": "ci-lab", "no_autograder": True}]},
        service_token="token",
    )

    assert [r["owner"] for r in detected["ci-lab"][1]] == ["alice"]


def test_no_autograder_detection_marks_late(monkeypatch):
    monkeypatch.setattr(
        cs,
        "detect_repo_submissions",
        lambda *a, **k: [{"sha": "c1", "datetime": "2026-06-10T10:00:00Z"}],
    )
    stub_team_members(monkeypatch, ["alice"])

    _, _, _, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={
            "assignments": [
                {
                    "slug": "ci-lab",
                    "no_autograder": True,
                    "due": "2026-06-01T00:00:00Z",
                }
            ]
        },
        service_token="token",
    )

    (record,) = detected["ci-lab"][1]
    assert record["late"] is True


def test_no_autograder_detection_tag_mode_reads_tags(monkeypatch):
    # Tag mode must detect tags, not commits — the mode the web app's
    # detectTagSubmissions mirrors.
    seen = {}

    def capture(api_url, org, repo_name, token, mode, tags):
        seen["mode"] = mode
        seen["tags"] = tags
        return [{"count": 2, "datetime": "2026-06-02T10:00:00Z"}]

    monkeypatch.setattr(cs, "detect_repo_submissions", capture)
    stub_team_members(monkeypatch, ["alice"])

    _, _, _, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={
            "assignments": [
                {
                    "slug": "ci-lab",
                    "no_autograder": True,
                    "submission_mode": "tag",
                    "submission_tags": ["v*"],
                }
            ]
        },
        service_token="token",
    )

    assert seen["mode"] == "tag"
    assert seen["tags"] == ["v*"]
    (record,) = detected["ci-lab"][1]
    assert record["count"] == 2
    assert record["kind"] == "tag"


def test_no_autograder_detection_skips_unreadable_repo(monkeypatch, capsys):
    # One unreadable repo warns and is skipped; it must not void the assignment.
    def flaky(api_url, org, repo_name, token, mode, tags):
        if "bob" in repo_name:
            raise http_error(500, "Server Error")
        return [{"sha": "c1", "datetime": "2026-06-01T10:00:00Z"}]

    monkeypatch.setattr(cs, "detect_repo_submissions", flaky)
    stub_team_members(monkeypatch, ["alice", "bob"])

    _, _, _, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={"assignments": [{"slug": "ci-lab", "no_autograder": True}]},
        service_token="token",
    )

    assert [r["owner"] for r in detected["ci-lab"][1]] == ["alice"]
    assert "detection failed" in capsys.readouterr().err


def test_matches_submission_tag_shared_fixture_parity():
    # The collector's copy of the matcher joins the same lockstep as Go's
    # contract.MatchesSubmissionTag, the web matchesSubmissionTag, and
    # regrade_repos.py — pinned to one golden fixture. Detection must claim the
    # same tags the shim actually triggers on, or the collected counts and the
    # submissions page disagree for exactly the tag-mode assignments this
    # feature targets.
    fixture = (
        pathlib.Path(__file__).resolve().parents[2]
        / "shared"
        / "testdata"
        / "submission_tag_match_cases.json"
    )
    doc = json.loads(fixture.read_text())
    cases = doc["cases"]
    assert cases, "shared fixture has no cases; did the file move?"
    for case in cases:
        got = cs.matches_submission_tag(case["patterns"], case["tag"])
        assert got is case["matches"], (
            f"matches_submission_tag({case['patterns']}, {case['tag']!r}) = {got}, "
            f"want {case['matches']}"
        )


def test_matches_submission_tag_fails_closed_on_bad_pattern():
    assert cs.matches_submission_tag(["[z-a]"], "m") is False
    assert cs.matches_submission_tag(["[z-a]", "good"], "good") is True


def test_no_autograder_detection_tag_mode_does_not_trust_tag_times(monkeypatch):
    # A submit/<ts> tag NAME is student-authored, so it can be backdated to dodge
    # a late flag or forge a "last submitted" instant. The web refuses tag times
    # for lateness for the same reason; the count still stands (tag existence
    # isn't forgeable).
    monkeypatch.setattr(
        cs,
        "detect_repo_submissions",
        lambda *a, **k: [{"count": 1, "datetime": "2020-01-01T00:00:00Z"}],
    )
    stub_team_members(monkeypatch, ["alice"])

    _, _, _, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={
            "assignments": [
                {
                    "slug": "ci-lab",
                    "no_autograder": True,
                    "submission_mode": "tag",
                    "due": "2026-06-01T00:00:00Z",
                }
            ]
        },
        service_token="token",
    )

    (record,) = detected["ci-lab"][1]
    assert record["count"] == 1
    assert "late" not in record
    assert "latest_datetime" not in record


def test_no_autograder_detection_reports_visited_owners(monkeypatch):
    # `visited` names owners whose repo was actually read, so main() can tell a
    # failed read apart from "nothing detected" and preserve the prior record.
    def flaky(api_url, org, repo_name, token, mode, tags):
        if "bob" in repo_name:
            raise http_error(500, "Server Error")
        return [{"sha": "c1", "datetime": "2026-06-01T10:00:00Z"}]

    monkeypatch.setattr(cs, "detect_repo_submissions", flaky)
    stub_team_members(monkeypatch, ["alice", "bob"])

    _, _, _, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={"assignments": [{"slug": "ci-lab", "no_autograder": True}]},
        service_token="token",
    )

    _, _, visited = detected["ci-lab"]
    assert "alice" in visited
    # bob's read failed, so he is NOT visited — his prior record must survive.
    assert "bob" not in visited


def test_collect_classroom_skips_empty_repo_assignment(monkeypatch, capsys):
    # An empty_repo assignment is skipped with a log line: its bare repos are
    # never polled for releases, so no dead gradebook rows are produced. Unlike
    # no_autograder it is not detected either — a bare repo carries no
    # submission definition to detect against.
    def fail_releases(*args, **kwargs):
        raise AssertionError("empty_repo repos must not be polled for releases")

    def fail_detect(*args, **kwargs):
        raise AssertionError("empty_repo repos must not be detected")

    monkeypatch.setattr(cs, "all_submit_releases", fail_releases)
    monkeypatch.setattr(cs, "detect_repo_submissions", fail_detect)
    stub_team_members(monkeypatch, ["alice"])

    results, _, _, detected = cs.collect_classroom(
        api_url="https://api.github.com",
        org="cs50",
        classroom_short="cs-principles",
        classroom_meta={},
        assignments={"assignments": [{"slug": "actions-lab", "empty_repo": True}]},
        service_token="token",
    )

    assert results == []
    assert detected == {}
    assert "empty_repo" in capsys.readouterr().out


# Staff-team repo-access grant ------------------------------------------------


class TestStaffTeamPermissions:
    def test_ta_maps_to_pull(self):
        assert cs.STAFF_TEAM_PERMISSIONS["ta"] == "pull"

    def test_hta_maps_to_pull(self):
        # The head-TA team, like the TA team, is a non-owner staff team that needs
        # explicit read on private in-org templates/student repos.
        assert cs.STAFF_TEAM_PERMISSIONS["hta"] == "pull"

    def test_teacher_not_granted_at_collect_time(self):
        # The teacher team's members are org owners with repo access via
        # ownership; the collector must not grant it (parity with Go
        # StaffTeamRepoPermissions).
        assert "teacher" not in cs.STAFF_TEAM_PERMISSIONS

    def test_all_permissions_are_valid_github_values(self):
        valid = {"pull", "triage", "push", "maintain", "admin"}
        assert set(cs.STAFF_TEAM_PERMISSIONS.values()) <= valid


class TestResolveStaffTeamSlugs:
    def test_returns_present_roles_with_slugs(self):
        meta = {
            "teams": {
                "teacher": {"id": 1, "slug": "classroom50-cs-teacher"},
                "ta": {"id": 2, "slug": "classroom50-cs-ta"},
            }
        }
        assert cs.resolve_staff_team_slugs(meta) == {
            "teacher": "classroom50-cs-teacher",
            "ta": "classroom50-cs-ta",
        }

    def test_no_teams_block_yields_empty(self):
        assert cs.resolve_staff_team_slugs({}) == {}

    def test_skips_role_without_slug(self):
        meta = {"teams": {"ta": {"id": 2}, "teacher": {"slug": "  "}}}
        assert cs.resolve_staff_team_slugs(meta) == {}


class TestAssignmentTemplateRef:
    def test_returns_owner_repo(self):
        entry = {"slug": "hw", "template": {"owner": "cs50", "repo": "hw-starter", "branch": "main"}}
        assert cs.assignment_template_ref(entry) == ("cs50", "hw-starter")

    def test_no_template_is_none(self):
        assert cs.assignment_template_ref({"slug": "hw"}) is None

    def test_malformed_template_is_none(self):
        assert cs.assignment_template_ref({"template": {"owner": "cs50"}}) is None


class TestGrantTeamRepo:
    def test_skips_put_when_already_granted(self, monkeypatch):
        calls: list[tuple[str, str]] = []

        def fake_send(method, url, token, *, accept, body, _retries=3):
            calls.append((method, url))
            # GET pre-check: 2xx means already has access.
            return 200, b"{}"

        monkeypatch.setattr(cs, "_http_send", fake_send)
        granted = cs.grant_team_repo(
            "https://api.github.com", "cs50", "classroom50-cs-ta", "cs50", "cs-hw-alice", "pull", "tok"
        )
        assert granted is False
        # Only the GET pre-check ran; no PUT.
        assert [m for m, _ in calls] == ["GET"]

    def test_puts_when_not_yet_granted(self, monkeypatch):
        calls: list[tuple[str, str, bytes | None]] = []

        def fake_send(method, url, token, *, accept, body, _retries=3):
            calls.append((method, url, body))
            if method == "GET":
                raise cs.urllib.error.HTTPError(url=url, code=404, msg="no", hdrs=None, fp=None)
            return 204, b""

        monkeypatch.setattr(cs, "_http_send", fake_send)
        granted = cs.grant_team_repo(
            "https://api.github.com", "cs50", "classroom50-cs-ta", "cs50", "cs-hw-alice", "pull", "tok"
        )
        assert granted is True
        methods = [m for m, _, _ in calls]
        assert methods == ["GET", "PUT"]
        # The PUT body carries the mapped permission.
        put_body = next(b for m, _, b in calls if m == "PUT")
        assert json.loads(put_body.decode()) == {"permission": "pull"}

    def test_hard_error_on_precheck_propagates(self, monkeypatch):
        # A 403 (token lacks Administration) on the pre-check must propagate so
        # main() aborts the run — classify() reports FATAL for a bare 403.
        def fake_send(method, url, token, *, accept, body, _retries=3):
            raise cs.urllib.error.HTTPError(url=url, code=403, msg="forbidden", hdrs=None, fp=None)

        monkeypatch.setattr(cs, "_http_send", fake_send)
        with pytest.raises(cs.urllib.error.HTTPError) as ei:
            cs.grant_team_repo(
                "https://api.github.com", "cs50", "classroom50-cs-ta", "cs50", "cs-hw-alice", "pull", "tok"
            )
        assert ei.value.code == 403
        assert cs.classify(ei.value) is cs.FATAL


class TestGrantClassroomTeamAccess:
    """Behavior of the per-classroom grant pass. Network is mocked at
    grant_team_repo / get_repo / list_team_member_logins so these stay
    pure-helper tests (the live PUT path is smoke-tested)."""

    ASSIGNMENTS = {
        "schema": cs.ASSIGNMENTS_SCHEMA_V1,
        "assignments": [
            {"slug": "hw1", "name": "HW1", "mode": "individual"},
            {"slug": "hw2", "name": "HW2", "mode": "individual"},
        ],
    }
    META = {
        "schema": cs.CLASSROOM_SCHEMA_V1,
        "short_name": "cs",
        "team": {"id": 1, "slug": "classroom50-cs"},
        "teams": {"ta": {"id": 2, "slug": "classroom50-cs-ta"}},
    }

    def _capture_grants(self, monkeypatch):
        grants: list[tuple[str, str, str, str]] = []

        def fake_grant(api_url, org, team_slug, owner, repo, permission, token, **kwargs):
            grants.append((team_slug, owner, repo, permission))
            return True

        monkeypatch.setattr(cs, "grant_team_repo", fake_grant)
        # The bulk read of the team's current repos is network; "unknown" (None)
        # is the fallback that leaves grant_team_repo deciding per repo.
        monkeypatch.setattr(cs, "known_team_repos", lambda *a, **k: None)
        return grants

    def test_grants_ta_pull_on_each_student_repo(self, monkeypatch):
        grants = self._capture_grants(monkeypatch)
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: ["alice", "bob"])
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
        )
        student_grants = {(r, p) for _, _, r, p in grants}
        # 2 assignments x 2 members = 4 student repos, all TA pull.
        assert ("cs-hw1-alice", "pull") in student_grants
        assert ("cs-hw2-bob", "pull") in student_grants
        assert len([g for g in grants if g[2].startswith("cs-")]) == 4
        assert all(team == "classroom50-cs-ta" and perm == "pull" for team, _, _, perm in grants)

    def test_no_teams_block_is_noop(self, monkeypatch):
        grants = self._capture_grants(monkeypatch)
        called = {"members": False}

        def fake_members(*a, **k):
            called["members"] = True
            return ["alice"]

        monkeypatch.setattr(cs, "list_team_member_logins", fake_members)
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta={"schema": cs.CLASSROOM_SCHEMA_V1, "short_name": "cs"},
            assignments=self.ASSIGNMENTS, service_token="tok",
        )
        assert grants == []
        # No team block => no membership read either (fully short-circuited).
        assert called["members"] is False

    def test_grants_private_in_org_template_skips_public_and_out_of_org(self, monkeypatch):
        grants = self._capture_grants(monkeypatch)
        # No students, but the TA team has a member — templates must still be
        # granted so a TA can read the starter code before anyone accepts.
        stub_team_members_by_slug(
            monkeypatch, {"classroom50-cs": [], "classroom50-cs-ta": ["ta1"]}
        )
        assignments = {
            "schema": cs.ASSIGNMENTS_SCHEMA_V1,
            "assignments": [
                {"slug": "priv", "mode": "individual", "template": {"owner": "cs50", "repo": "priv-tmpl"}},
                {"slug": "pub", "mode": "individual", "template": {"owner": "cs50", "repo": "pub-tmpl"}},
                {"slug": "ext", "mode": "individual", "template": {"owner": "other-org", "repo": "ext-tmpl"}},
            ],
        }

        def fake_get_repo(api_url, owner, repo, token):
            return {"private": repo == "priv-tmpl"}

        monkeypatch.setattr(cs, "get_repo", fake_get_repo)
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META, assignments=assignments, service_token="tok",
        )
        template_grants = {repo for _, _, repo, _ in grants}
        assert template_grants == {"priv-tmpl"}  # public + out-of-org skipped

    def test_idempotent_skip_grants_nothing_new(self, monkeypatch, capsys):
        # grant_team_repo returns False when the team already has access; the
        # pass must not report any new grant.
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: ["alice"])
        monkeypatch.setattr(cs, "known_team_repos", lambda *a, **k: None)
        monkeypatch.setattr(cs, "grant_team_repo", lambda *a, **k: False)
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META,
            assignments={"schema": cs.ASSIGNMENTS_SCHEMA_V1, "assignments": [{"slug": "hw1", "mode": "individual"}]},
            service_token="tok",
        )
        assert "granted" not in capsys.readouterr().out

    def test_per_repo_404_warns_and_continues(self, monkeypatch, capsys):
        # A student repo not accepted yet (404) is skipped, not fatal; the rest
        # still get granted.
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: ["alice", "bob"])
        monkeypatch.setattr(cs, "known_team_repos", lambda *a, **k: None)
        seen: list[str] = []

        def fake_grant(api_url, org, team_slug, owner, repo, permission, token, **kwargs):
            seen.append(repo)
            if repo == "cs-hw1-alice":
                raise cs.urllib.error.HTTPError(url="u", code=404, msg="no", hdrs=None, fp=None)
            return True

        monkeypatch.setattr(cs, "grant_team_repo", fake_grant)
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META,
            assignments={"schema": cs.ASSIGNMENTS_SCHEMA_V1, "assignments": [{"slug": "hw1", "mode": "individual"}]},
            service_token="tok",
        )
        assert "cs-hw1-bob" in seen  # bob still processed after alice's 404
        assert "::warning::" in capsys.readouterr().err

    def test_hard_error_propagates(self, monkeypatch):
        # A 403 that is NOT a throttle (missing Administration) must abort the
        # pass so main() fails — see TestGrantThrottled for the other 403.
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: ["alice"])
        monkeypatch.setattr(cs, "known_team_repos", lambda *a, **k: None)

        def fake_grant(*a, **k):
            raise cs.urllib.error.HTTPError(url="u", code=403, msg="forbidden", hdrs=None, fp=None)

        monkeypatch.setattr(cs, "grant_team_repo", fake_grant)
        with pytest.raises(cs.urllib.error.HTTPError) as ei:
            cs.grant_classroom_team_access(
                api_url="https://api.github.com", org="cs50", classroom_short="cs",
                classroom_meta=self.META,
                assignments={"schema": cs.ASSIGNMENTS_SCHEMA_V1, "assignments": [{"slug": "hw1", "mode": "individual"}]},
                service_token="tok",
            )
        assert ei.value.code == 403

    # --- empty-staff-team skip (change 1) ---

    META_TA_HTA = {
        "schema": cs.CLASSROOM_SCHEMA_V1,
        "short_name": "cs",
        "team": {"id": 1, "slug": "classroom50-cs"},
        "teams": {
            "ta": {"id": 2, "slug": "classroom50-cs-ta"},
            "hta": {"id": 3, "slug": "classroom50-cs-hta"},
        },
    }

    def test_empty_staff_team_grants_nothing_and_stays_green(self, monkeypatch, capsys):
        # A ta team with no members must not sweep any student repo. The bulk
        # known_team_repos read and every PUT are skipped, and the run is green.
        grants = self._capture_grants(monkeypatch)
        known_read = {"hit": False}

        def fake_known(*a, **k):
            known_read["hit"] = True
            return None

        monkeypatch.setattr(cs, "known_team_repos", fake_known)
        stub_team_members_by_slug(
            monkeypatch, {"classroom50-cs": ["alice", "bob"], "classroom50-cs-ta": []}
        )
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
        )
        assert grants == []
        assert known_read["hit"] is False  # no bulk read for an empty team

    def test_empty_team_skip_is_per_slug_not_all_or_nothing(self, monkeypatch):
        # ta is empty, hta is populated: the hta team still gets its grants.
        grants = self._capture_grants(monkeypatch)
        stub_team_members_by_slug(
            monkeypatch,
            {
                "classroom50-cs": ["alice"],
                "classroom50-cs-ta": [],
                "classroom50-cs-hta": ["prof"],
            },
        )
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META_TA_HTA, assignments=self.ASSIGNMENTS, service_token="tok",
        )
        granted_teams = {team for team, _, _, _ in grants}
        assert granted_teams == {"classroom50-cs-hta"}  # ta skipped, hta granted

    def test_non_404_skippable_staff_read_skips_that_team(self, monkeypatch, capsys):
        # A 422 (not 401/403/599/throttle) reading staff membership is SKIPPABLE:
        # skip that team for the run without failing, and don't grant.
        grants = self._capture_grants(monkeypatch)

        def fake_members(api_url, org, team_slug, token):
            if team_slug == "classroom50-cs-ta":
                raise cs.urllib.error.HTTPError(url="u", code=422, msg="unproc", hdrs=None, fp=None)
            return ["alice"]

        monkeypatch.setattr(cs, "list_team_member_logins", fake_members)
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
        )
        assert grants == []
        assert "::warning::" in capsys.readouterr().err

    def test_hard_error_on_staff_read_propagates(self, monkeypatch):
        # A 403 (missing Members scope) reading staff membership is FATAL and
        # must abort so main() reports it.
        self._capture_grants(monkeypatch)

        def fake_members(api_url, org, team_slug, token):
            if team_slug == "classroom50-cs-ta":
                raise cs.urllib.error.HTTPError(url="u", code=403, msg="forbidden", hdrs=None, fp=None)
            return ["alice"]

        monkeypatch.setattr(cs, "list_team_member_logins", fake_members)
        with pytest.raises(cs.urllib.error.HTTPError) as ei:
            cs.grant_classroom_team_access(
                api_url="https://api.github.com", org="cs50", classroom_short="cs",
                classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
            )
        assert ei.value.code == 403

    def test_throttled_staff_read_propagates_for_deferral(self, monkeypatch):
        # A throttle reading staff membership is NOT SKIPPABLE, so it re-raises;
        # main() turns a raw throttled HTTPError from the grant pass into a
        # deferral (see test_raw_throttled_httperror_from_grant_pass_defers).
        self._capture_grants(monkeypatch)

        def fake_members(api_url, org, team_slug, token):
            if team_slug == "classroom50-cs-ta":
                raise http_error(403, {"Retry-After": "30"})
            return ["alice"]

        monkeypatch.setattr(cs, "list_team_member_logins", fake_members)
        with pytest.raises(cs.urllib.error.HTTPError) as ei:
            cs.grant_classroom_team_access(
                api_url="https://api.github.com", org="cs50", classroom_short="cs",
                classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
            )
        assert cs.classify(ei.value) is cs.THROTTLED

    def test_malformed_staff_member_listing_warns_and_skips(self, monkeypatch, capsys):
        grants = self._capture_grants(monkeypatch)

        def fake_members(api_url, org, team_slug, token):
            if team_slug == "classroom50-cs-ta":
                raise ValueError("bad JSON")
            return ["alice"]

        monkeypatch.setattr(cs, "list_team_member_logins", fake_members)
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
        )
        assert grants == []
        assert "::warning::" in capsys.readouterr().err

    # --- per-assignment scoping (change 2) ---

    def test_assignment_filter_scopes_student_repos_and_template(self, monkeypatch):
        grants = self._capture_grants(monkeypatch)
        stub_team_members_by_slug(
            monkeypatch, {"classroom50-cs": ["alice"], "classroom50-cs-ta": ["ta1"]}
        )
        assignments = {
            "schema": cs.ASSIGNMENTS_SCHEMA_V1,
            "assignments": [
                {"slug": "hw1", "mode": "individual", "template": {"owner": "cs50", "repo": "hw1-tmpl"}},
                {"slug": "hw2", "mode": "individual", "template": {"owner": "cs50", "repo": "hw2-tmpl"}},
            ],
        }
        monkeypatch.setattr(cs, "get_repo", lambda *a, **k: {"private": True})
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META, assignments=assignments, service_token="tok",
            assignment_filter="hw1",
        )
        repos = {repo for _, _, repo, _ in grants}
        assert repos == {"cs-hw1-alice", "hw1-tmpl"}  # hw2 repo + template untouched

    def test_assignment_filter_unknown_slug_is_a_silent_noop(self, monkeypatch, capsys):
        # Mirrors collect_classroom: a classroom lacking the scoped slug is
        # skipped silently (main's run-level guard owns the single loud error),
        # so a multi-classroom Sync now doesn't spam per-classroom warnings.
        grants = self._capture_grants(monkeypatch)
        stub_team_members_by_slug(
            monkeypatch, {"classroom50-cs": ["alice"], "classroom50-cs-ta": ["ta1"]}
        )
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
            assignment_filter="does-not-exist",
        )
        assert grants == []
        assert "::warning::" not in capsys.readouterr().err


# Throttling vs. refusal ------------------------------------------------------


class TestErrorBodySnippet:
    def test_reads_once_and_caches(self):
        # The body stream is consumable exactly once, and the retry decision
        # reads it before the log line does — without caching the message would
        # print an empty body for every throttle it just diagnosed.
        exc = http_error(403, body=b'{"message":  "You have exceeded a secondary rate  limit"}')
        first = cs.error_body_snippet(exc)
        assert "secondary rate limit" in first
        # Whitespace collapsed, and the second read still sees it.
        assert "  " not in first
        assert cs.error_body_snippet(exc) == first

    def test_unreadable_body_is_empty_not_an_error(self):
        exc = http_error(403, body=None)
        assert cs.error_body_snippet(exc) == ""
        assert cs.body_note(exc) == ""

    def test_truncates_to_limit(self):
        exc = http_error(403, body=b"x" * 5000)
        assert len(cs.error_body_snippet(exc)) == 300


class TestRateLimitReason:
    def test_retry_after_header_is_a_throttle(self):
        assert cs.rate_limit_reason(http_error(403, {"Retry-After": "60"})) == "Retry-After: 60s"

    def test_exhausted_primary_budget_names_the_reset(self):
        reason = cs.rate_limit_reason(
            http_error(403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1787120877"})
        )
        assert reason is not None
        assert "X-RateLimit-Remaining: 0" in reason
        assert "resets at 2026-08-1" in reason

    def test_secondary_limit_recognized_from_the_body(self):
        # The shape that actually bit us: no Retry-After, budget not exhausted,
        # only the body says what happened.
        exc = http_error(403, {}, b'{"message": "You have exceeded a secondary rate limit"}')
        reason = cs.rate_limit_reason(exc)
        assert reason is not None and "secondary rate limit" in reason

    def test_plain_403_is_not_a_throttle(self):
        # An under-scoped token: no header, no marker. This is the one case
        # that may still tell the operator to rotate.
        exc = http_error(403, {}, b'{"message": "Resource not accessible by personal access token"}')
        assert cs.rate_limit_reason(exc) is None

    def test_other_statuses_are_never_throttles(self):
        assert cs.rate_limit_reason(http_error(404, {"Retry-After": "60"})) is None
        assert cs.rate_limit_reason(http_error(500)) is None


class TestRetryDelay:
    def test_throttled_403_waits_retry_after(self):
        assert cs.retry_delay(http_error(403, {"Retry-After": "5"}), 0) == 5

    def test_retry_after_is_capped(self):
        assert cs.retry_delay(http_error(403, {"Retry-After": "9999"}), 0) == cs.MAX_RETRY_SLEEP_SECONDS

    def test_secondary_limit_without_header_waits_a_minute(self):
        exc = http_error(403, {}, b'{"message": "You have exceeded a secondary rate limit"}')
        assert cs.retry_delay(exc, 0) == cs.MAX_RETRY_SLEEP_SECONDS

    def test_exhausted_primary_budget_is_not_retried(self):
        # Its window runs up to an hour — a named error beats a sleeping job.
        exc = http_error(403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1787120877"})
        assert cs.retry_delay(exc, 0) is None

    def test_plain_403_is_not_retried(self):
        assert cs.retry_delay(http_error(403, {}, b"nope"), 0) is None

    def test_transient_statuses_keep_the_old_contract(self):
        assert cs.retry_delay(http_error(500), 0) == 1
        assert cs.retry_delay(http_error(502), 2) == 4
        assert cs.retry_delay(http_error(503, {"Retry-After": "9999"}), 0) == 30
        assert cs.retry_delay(http_error(404), 0) is None


class TestClassify:
    """One verdict, checked throttle-first: a rate limit arrives as 403 as often
    as 429, so classifying on status alone puts every throttle in FATAL."""

    def test_throttle_beats_the_status_code(self):
        # The whole point: a rate limit arrives as 403 as often as 429, so
        # classifying on status alone put every throttle in FATAL.
        assert cs.classify(http_error(403, {"Retry-After": "30"})) is cs.THROTTLED
        assert cs.classify(http_error(429, {"X-RateLimit-Remaining": "0"})) is cs.THROTTLED
        body = b'{"message": "You have exceeded a secondary rate limit"}'
        assert cs.classify(http_error(403, {}, body)) is cs.THROTTLED

    def test_bare_auth_errors_are_fatal(self):
        # 401/403 = the PAT is missing, expired, or under-scoped. 599 is the
        # synthetic code _http_get raises after a final URLError (GitHub/DNS
        # unreachable), not "student didn't submit".
        for code in (401, 403, 599):
            assert cs.classify(http_error(code)) is cs.FATAL

    def test_per_repo_errors_are_skippable(self):
        for code in (404, 422, 500):
            assert cs.classify(http_error(code)) is cs.SKIPPABLE

    def test_plain_429_is_skippable_not_fatal(self):
        # No throttle signal on the response: a bare 429 keeps the old
        # warn-and-skip contract rather than aborting the run.
        assert cs.classify(http_error(429)) is cs.SKIPPABLE

    def test_a_bare_403_is_fatal_a_throttled_one_is_not(self):
        assert cs.classify(http_error(403)) is cs.FATAL
        # ...and a THROTTLED 403 is NOT fatal, which is why handlers that
        # warn-and-skip ask `classify(exc) is not SKIPPABLE`.
        assert cs.classify(http_error(403, {"Retry-After": "5"})) is cs.THROTTLED


class TestEpochToIso:
    def test_formats_a_plain_epoch(self):
        assert cs.epoch_to_iso("1787120877").endswith("Z")

    def test_out_of_range_epoch_does_not_raise(self):
        # GitHub occasionally sends a MILLISECOND epoch. This runs inside an
        # `except HTTPError` block, so raising here escapes every throttle
        # handler as a traceback — the run would crash on the very header that
        # exists to explain the throttle.
        assert cs.epoch_to_iso("1787120877000") == "1787120877000"

    def test_throttle_with_a_millisecond_reset_still_classifies(self):
        exc = http_error(403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1787120877000"})
        assert cs.classify(exc) is cs.THROTTLED
        assert cs.retry_delay(exc, 0) is None  # primary budget: never waited out


class TestThrottlePropagatesInsteadOfDegrading:
    def test_repo_index_reraises_a_throttle(self, monkeypatch, capsys):
        # Falling back to per-repo probing would issue the thousands of requests
        # the index exists to avoid, mid-throttle.
        def throttled(*a, **k):
            raise http_error(403, {"Retry-After": "60"}, b"secondary rate limit")

        monkeypatch.setattr(cs, "list_org_repos", throttled)
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        with pytest.raises(cs.urllib.error.HTTPError):
            index.contains("cs-hw1-alice")

    def test_repo_index_still_degrades_on_a_soft_failure(self, monkeypatch, capsys):
        def soft(*a, **k):
            raise http_error(404, {}, b"nope")

        monkeypatch.setattr(cs, "list_org_repos", soft)
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        assert index.contains("anything") is True
        assert "::warning::" in capsys.readouterr().err

    def test_team_repo_listing_reraises_a_throttled_429(self, monkeypatch):
        # Previously swallowed: a 429 isn't "hard", so the grant pass fell back
        # to a per-repo access check for every target, mid-throttle.
        def throttled(*a, **k):
            raise http_error(429, {"Retry-After": "60"})

        monkeypatch.setattr(cs, "list_team_repo_full_names", throttled)
        with pytest.raises(cs.urllib.error.HTTPError):
            cs.known_team_repos(
                "https://api.github.com", "cs50", "classroom50-cs-ta", "tok", "cs"
            )


class TestTransportRetriesThrottles:
    def test_throttled_403_is_retried_then_succeeds(self, monkeypatch):
        slept: list[float] = []
        attempts: list[int] = []

        def fake_open(req, timeout=None):
            attempts.append(1)
            if len(attempts) == 1:
                raise http_error(403, {"Retry-After": "1"}, b"secondary rate limit")
            return FakeResponse(b"", status=204)

        monkeypatch.setattr(cs._OPENER, "open", fake_open)
        monkeypatch.setattr(cs.time, "sleep", lambda s: slept.append(s))

        status, _ = cs._http_send(
            "PUT", "https://api.github.com/x", "tok", accept="application/vnd.github+json", body=b"{}"
        )
        assert status == 204
        assert len(attempts) == 2
        assert slept == [1]

    def test_plain_403_is_not_retried(self, monkeypatch):
        # The regression that made a healthy token look under-scoped only ever
        # mattered because the request was never retried; the inverse must hold
        # too — a real permission failure must not be slept on three times.
        attempts: list[int] = []

        def fake_open(req, timeout=None):
            attempts.append(1)
            raise http_error(403, {}, b'{"message": "Resource not accessible"}')

        monkeypatch.setattr(cs._OPENER, "open", fake_open)
        monkeypatch.setattr(cs.time, "sleep", lambda s: pytest.fail("must not sleep"))

        with pytest.raises(cs.urllib.error.HTTPError) as ei:
            cs._http_get_with_headers(
                "https://api.github.com/x", "tok", accept="application/vnd.github+json"
            )
        assert ei.value.code == 403
        assert len(attempts) == 1


class TestGrantThrottled:
    META = {
        "schema": cs.CLASSROOM_SCHEMA_V1,
        "short_name": "cs",
        "team": {"id": 1, "slug": "classroom50-cs"},
        "teams": {"ta": {"id": 2, "slug": "classroom50-cs-ta"}},
    }
    ASSIGNMENTS = {
        "schema": cs.ASSIGNMENTS_SCHEMA_V1,
        "assignments": [
            {"slug": "hw1", "mode": "individual"},
            {"slug": "hw2", "mode": "individual"},
        ],
    }

    def test_throttle_reports_progress_and_remainder(self, monkeypatch):
        # 2 assignments x 3 members = 6 targets; the third call is throttled.
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: ["alice", "bob", "carol"])
        monkeypatch.setattr(cs, "known_team_repos", lambda *a, **k: None)
        calls: list[str] = []

        def fake_grant(api_url, org, team_slug, owner, repo, permission, token, **kwargs):
            calls.append(repo)
            if len(calls) == 3:
                raise http_error(403, {"Retry-After": "60"}, b"secondary rate limit")
            return True

        monkeypatch.setattr(cs, "grant_team_repo", fake_grant)
        with pytest.raises(cs.GrantThrottled) as ei:
            cs.grant_classroom_team_access(
                api_url="https://api.github.com", org="cs50", classroom_short="cs",
                classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
            )
        assert ei.value.granted == 2
        assert ei.value.deferred == 4  # 6 targets, throttled on the third
        assert "Retry-After: 60s" in ei.value.reason

    def test_main_stays_green_and_never_says_rotate(self, tmp_path, monkeypatch, capsys):
        # The core of #652: a throttled grant pass is a deferral, not a failed
        # run, and must not send the operator to rotate a working token.
        classroom = write_minimal_classroom(tmp_path)
        (classroom / "classroom.json").write_text(json.dumps(self.META))

        def fake_grant_pass(**kwargs):
            raise cs.GrantThrottled("Retry-After: 60s", "classroom50-cs-ta", 12, 340)

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "grant_classroom_team_access", fake_grant_pass)
        monkeypatch.setattr(cs, "collect_classroom", lambda **k: ([], 0, {}, {}))

        assert cs.main() == 0
        err = capsys.readouterr().err
        assert "::error::" not in err
        throttle_line = next(line for line in err.splitlines() if "throttled" in line)
        assert "340 target(s) deferred" in throttle_line
        assert "do NOT rotate" in throttle_line
        # The scope hint belongs to a real 403 only (the unrelated
        # "collected 0 submissions" warning has its own token advice).
        assert "rotate-service-token" not in throttle_line

    def test_main_still_fails_on_a_real_scope_403(self, tmp_path, monkeypatch, capsys):
        classroom = write_minimal_classroom(tmp_path)
        (classroom / "classroom.json").write_text(json.dumps(self.META))

        def fake_grant_pass(**kwargs):
            raise http_error(403, {}, b'{"message": "Resource not accessible by personal access token"}')

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "grant_classroom_team_access", fake_grant_pass)
        monkeypatch.setattr(cs, "collect_classroom", lambda **k: ([], 0, {}, {}))

        assert cs.main() == 1
        err = capsys.readouterr().err
        assert "Administration: Read and write" in err
        # The body is logged now, so the next reader can tell the two apart.
        assert "Resource not accessible" in err

    def test_collection_throttle_is_fatal_but_named(self, tmp_path, monkeypatch, capsys):
        # Collection can't defer — an incomplete gradebook must not report
        # success — but the message still must not blame the token.
        write_minimal_classroom(tmp_path)

        def fail_collect(**kwargs):
            raise http_error(403, {"Retry-After": "60"}, b"secondary rate limit")

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "collect_classroom", fail_collect)

        assert cs.main() == 1
        err = capsys.readouterr().err
        assert "throttled by GitHub" in err
        assert "rotate-service-token" not in err


# Repo index ------------------------------------------------------------------


class TestRepoIndex:
    def test_reads_once_and_answers_from_the_set(self, monkeypatch, capsys):
        calls: list[str] = []

        def fake_list(api_url, org, token):
            calls.append(org)
            return {"cs-hw1-alice": False, "cs-hw1-bob": False}

        monkeypatch.setattr(cs, "list_org_repos", fake_list)
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        assert calls == []  # lazy: nothing read yet
        assert index.contains("cs-hw1-ALICE") is True  # case-insensitive
        assert index.contains("cs-hw1-carol") is False
        assert calls == ["cs50"]  # and only once
        assert "2 repo(s) visible" in capsys.readouterr().out

    def test_failed_listing_hides_nothing(self, monkeypatch, capsys):
        def fail(*a, **k):
            raise http_error(404, {}, b"nope")

        monkeypatch.setattr(cs, "list_org_repos", fail)
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        assert index.contains("cs-hw1-alice") is True
        assert index.contains("anything-at-all") is True
        err = capsys.readouterr().err
        assert "::warning::" in err
        assert err.count("could not list") == 1  # warned once, not per lookup

    def test_empty_listing_is_unknown_not_empty(self, monkeypatch):
        # A token scoped to zero repos must not silently skip every poll.
        monkeypatch.setattr(cs, "list_org_repos", lambda *a, **k: {})
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        assert index.contains("cs-hw1-alice") is True


class StubIndex:
    """RepoIndex stand-in with a fixed answer set."""

    def __init__(self, names):
        self._names = {n.lower() for n in names}

    def contains(self, repo_name):
        return repo_name.lower() in self._names


class TestPassesSkipMissingRepos:
    META = TestGrantThrottled.META
    ASSIGNMENTS = TestGrantThrottled.ASSIGNMENTS

    def test_grant_pass_only_touches_existing_repos(self, monkeypatch):
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: ["alice", "bob"])
        monkeypatch.setattr(cs, "known_team_repos", lambda *a, **k: None)
        seen: list[str] = []

        def fake_grant(api_url, org, team_slug, owner, repo, permission, token, **kwargs):
            seen.append(repo)
            return True

        monkeypatch.setattr(cs, "grant_team_repo", fake_grant)
        cs.grant_classroom_team_access(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META, assignments=self.ASSIGNMENTS, service_token="tok",
            repo_index=StubIndex({"cs-hw1-alice"}),
        )
        # 4 names in the product, one repo — three requests not made.
        assert seen == ["cs-hw1-alice"]

    def test_collection_skips_names_without_a_repo(self, monkeypatch):
        polled: list[str] = []

        def fake_releases(api_url, org, repo, token):
            polled.append(repo)
            return []

        monkeypatch.setattr(cs, "list_enrolled_logins", lambda *a, **k: (["alice", "bob"], {"alice", "bob"}))
        monkeypatch.setattr(cs, "all_submit_releases", fake_releases)
        cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META,
            assignments={"schema": cs.ASSIGNMENTS_SCHEMA_V1, "assignments": [{"slug": "hw1", "mode": "individual"}]},
            service_token="tok",
            repo_index=StubIndex({"cs-hw1-bob"}),
        )
        assert polled == ["cs-hw1-bob"]

    def test_unknown_index_polls_everything(self, monkeypatch):
        polled: list[str] = []
        monkeypatch.setattr(cs, "list_enrolled_logins", lambda *a, **k: (["alice", "bob"], {"alice", "bob"}))
        monkeypatch.setattr(cs, "all_submit_releases", lambda a, o, repo, t: polled.append(repo) or [])
        cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs",
            classroom_meta=self.META,
            assignments={"schema": cs.ASSIGNMENTS_SCHEMA_V1, "assignments": [{"slug": "hw1", "mode": "individual"}]},
            service_token="tok",
            repo_index=None,
        )
        assert polled == ["cs-hw1-alice", "cs-hw1-bob"]


class TestBulkAccessCheck:
    def test_repo_in_known_set_skips_every_request(self, monkeypatch):
        monkeypatch.setattr(
            cs, "_http_send", lambda *a, **k: pytest.fail("no request expected")
        )
        # Set is lowercased; the target's casing must not matter.
        assert cs.grant_team_repo(
            "https://api.github.com", "cs50", "classroom50-cs-ta", "CS50", "CS-HW1-Alice",
            "pull", "tok", known_repos={"cs50/cs-hw1-alice"},
        ) is False

    def test_repo_absent_from_known_set_puts_without_a_precheck(self, monkeypatch):
        calls: list[str] = []

        def fake_send(method, url, token, *, accept, body, _retries=3):
            calls.append(method)
            return 204, b""

        monkeypatch.setattr(cs, "_http_send", fake_send)
        assert cs.grant_team_repo(
            "https://api.github.com", "cs50", "classroom50-cs-ta", "cs50", "cs-hw1-bob",
            "pull", "tok", known_repos={"cs50/cs-hw1-alice"},
        ) is True
        assert calls == ["PUT"]

    def test_listing_failure_falls_back_to_per_repo_checks(self, monkeypatch, capsys):
        def fail(*a, **k):
            raise http_error(404, {}, b"no team")

        monkeypatch.setattr(cs, "list_team_repo_full_names", fail)
        assert cs.known_team_repos(
            "https://api.github.com", "cs50", "classroom50-cs-ta", "tok", "cs"
        ) is None
        assert "::warning::" in capsys.readouterr().err

    def test_hard_listing_failure_propagates(self, monkeypatch):
        def fail(*a, **k):
            raise http_error(401, {}, b"bad credentials")

        monkeypatch.setattr(cs, "list_team_repo_full_names", fail)
        with pytest.raises(cs.urllib.error.HTTPError):
            cs.known_team_repos(
                "https://api.github.com", "cs50", "classroom50-cs-ta", "tok", "cs"
            )

    def test_unknown_listing_falls_back_to_the_per_repo_check(self, monkeypatch):
        checked: list[str] = []
        monkeypatch.setattr(
            cs,
            "team_has_repo_access",
            lambda a, o, t, owner, repo, tok: checked.append(repo) or True,
        )
        monkeypatch.setattr(
            cs, "_http_send", lambda *a, **k: pytest.fail("no PUT expected")
        )
        assert cs.grant_team_repo(
            "https://api.github.com", "cs50", "classroom50-cs-ta", "cs50", "cs-hw1-alice",
            "pull", "tok", known_repos=None,
        ) is False
        assert checked == ["cs-hw1-alice"]


class TestGrantDeferralIsPerClassroom:
    """A throttled grant pass defers only ITS classroom: a secondary limit clears
    in about a minute, so a later grant may well succeed in the same run. The
    sleep budget, not skipping classrooms, is what protects the job timeout."""

    def _two_classrooms(self, tmp_path):
        for short in ("cs", "ds"):
            classroom = tmp_path / short
            (classroom / ".github").mkdir(parents=True, exist_ok=True)
            (classroom / "classroom.json").write_text(json.dumps({
                "schema": cs.CLASSROOM_SCHEMA_V1, "short_name": short,
                "team": {"id": 1, "slug": f"classroom50-{short}"},
                "teams": {"ta": {"id": 2, "slug": f"classroom50-{short}-ta"}},
            }))
            (classroom / "assignments.json").write_text(json.dumps({
                "schema": cs.ASSIGNMENTS_SCHEMA_V1,
                "assignments": [{"slug": "hw1", "mode": "individual"}],
            }))
        return tmp_path

    def _run(self, tmp_path, monkeypatch, grant_pass):
        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "grant_classroom_team_access", grant_pass)
        monkeypatch.setattr(cs, "collect_classroom", lambda **k: ([], 0, {}, {}))
        return cs.main()

    def test_a_throttled_classroom_does_not_skip_the_next(self, tmp_path, monkeypatch, capsys):
        self._two_classrooms(tmp_path)
        attempts: list[str] = []

        def flaky(**kwargs):
            attempts.append(kwargs["classroom_short"])
            if len(attempts) == 1:
                raise cs.GrantThrottled("Retry-After: 60s", "classroom50-cs-ta", 3, 97)

        assert self._run(tmp_path, monkeypatch, flaky) == 0
        # BOTH classrooms attempted: the second is not punished for the first's
        # throttle, and its grant succeeded.
        assert len(attempts) == 2
        err = capsys.readouterr().err
        assert "::error::" not in err
        assert "do NOT rotate" in err
        assert err.count("throttled") == 1  # only the classroom that hit it

    def test_every_classroom_grants_when_nothing_throttles(self, tmp_path, monkeypatch):
        self._two_classrooms(tmp_path)
        attempts: list[str] = []
        assert self._run(
            tmp_path, monkeypatch,
            lambda **k: attempts.append(k["classroom_short"]),
        ) == 0
        assert len(attempts) == 2


class TestTeamMembersReadOnce:
    def test_both_passes_share_one_student_team_read(self, monkeypatch):
        reads: list[str] = []

        def fake_list(api_url, org, slug, token):
            reads.append(slug)
            return ["alice", "bob"]

        monkeypatch.setattr(cs, "list_team_member_logins", fake_list)
        members = cs.TeamMembers("https://api.github.com", "cs50", "tok")
        assert members.logins("classroom50-cs") == ["alice", "bob"]
        assert members.logins("classroom50-cs") == ["alice", "bob"]
        assert reads == ["classroom50-cs"]  # second call served from the cache

    def test_a_failure_is_not_cached(self, monkeypatch):
        calls: list[int] = []

        def flaky(api_url, org, slug, token):
            calls.append(1)
            if len(calls) == 1:
                raise http_error(404, {}, b"no team")
            return ["alice"]

        monkeypatch.setattr(cs, "list_team_member_logins", flaky)
        members = cs.TeamMembers("https://api.github.com", "cs50", "tok")
        with pytest.raises(cs.urllib.error.HTTPError):
            members.logins("classroom50-cs")
        # Each caller keeps its own error handling, so the read is retried.
        assert members.logins("classroom50-cs") == ["alice"]

    def test_mutating_the_result_does_not_poison_the_cache(self, monkeypatch):
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a: ["alice"])
        members = cs.TeamMembers("https://api.github.com", "cs50", "tok")
        members.logins("t").append("mallory")
        assert members.logins("t") == ["alice"]


class TestPaginateFieldList:
    def test_collects_the_requested_field(self, monkeypatch):
        # One short page: no Link header, so the short-page heuristic stops.
        def fake_get(url, token, *, accept, max_bytes=None, _retries=3):
            return json.dumps([{"name": "a"}, {"name": "b"}]).encode(), {}

        monkeypatch.setattr(cs, "_http_get_with_headers", fake_get)
        got = cs._paginate_field_list(
            page_url=lambda page: f"https://api.github.com/orgs/cs50/repos?per_page=100&page={page}",
            api_url="https://api.github.com",
            token="tok",
            resource_label="orgs/cs50/repos",
            field="name",
        )
        assert got == ["a", "b"]


class TestOrgAndTeamListings:
    """The bulk listings the request-volume fix depends on. Every other test stubs
    them, so their lowercasing — which RepoIndex.contains needs to not read a real
    submission as "not submitted" — is asserted only here."""

    def _fake_page(self, payload):
        def fake_get(url, token, *, accept, max_bytes=None, _retries=3):
            self.seen_url = url
            return json.dumps(payload).encode(), {}

        return fake_get

    def test_org_repos_are_lowercased_with_private_flags(self, monkeypatch):
        monkeypatch.setattr(
            cs,
            "_http_get_with_headers",
            self._fake_page([
                {"name": "CS-HW1-Alice", "private": True},
                {"name": "cs-hw2-BOB", "private": False},
                {"name": "starter", "private": "yes"},
            ]),
        )
        repos = cs.list_org_repos("https://api.github.com", "CS50", "tok")
        # The private flag rides along from the same bodies, so the grant pass
        # doesn't re-read each template. Strict boolean: a non-bool is not True.
        assert repos == {"cs-hw1-alice": True, "cs-hw2-bob": False, "starter": False}
        # type=all keeps private student repos in the listing; without it the
        # index would call every private repo missing and skip its poll.
        assert "type=all" in self.seen_url and "per_page=100" in self.seen_url

    def test_team_repo_full_names_are_lowercased(self, monkeypatch):
        monkeypatch.setattr(
            cs,
            "_http_get_with_headers",
            self._fake_page([{"full_name": "CS50/CS-HW1-Alice"}]),
        )
        full = cs.list_team_repo_full_names(
            "https://api.github.com", "CS50", "classroom50-cs-ta", "tok"
        )
        assert full == {"cs50/cs-hw1-alice"}

    def test_mixed_case_listing_still_matches_the_index(self, monkeypatch):
        # The end-to-end reason the .lower() matters: a repo GitHub reports as
        # mixed-case must still answer contains() for the lowercased name the
        # repo-name formula produces.
        monkeypatch.setattr(cs, "list_org_repos", lambda *a, **k: {"cs-hw1-alice": False})
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        assert index.contains("CS-HW1-Alice") is True


class TestTemplatePrivacyFromTheIndex:
    """The org listing already carried each repo's `private` flag, so resolving
    template targets must not re-read them one by one."""

    ASSIGNMENTS = {
        "schema": cs.ASSIGNMENTS_SCHEMA_V1,
        "assignments": [
            {"slug": "hw1", "template": {"owner": "cs50", "repo": "priv-tmpl"}},
            {"slug": "hw2", "template": {"owner": "cs50", "repo": "pub-tmpl"}},
        ],
    }

    def test_index_answers_privacy_without_a_per_template_read(self, monkeypatch):
        monkeypatch.setattr(
            cs, "list_org_repos",
            lambda *a, **k: {"priv-tmpl": True, "pub-tmpl": False},
        )
        monkeypatch.setattr(
            cs, "get_repo", lambda *a, **k: pytest.fail("no per-template read expected")
        )
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        targets = cs.private_template_targets(
            "https://api.github.com", "cs50", self.ASSIGNMENTS, "tok", repo_index=index
        )
        assert targets == [("cs50", "priv-tmpl")]  # public one skipped

    def test_name_absent_from_the_index_falls_back_to_the_read(self, monkeypatch):
        # An out-of-scope or brand-new template isn't in the listing; the index
        # says "unknown" and the per-repo read still settles it.
        read: list[str] = []

        def fake_get_repo(api_url, owner, repo, token):
            read.append(repo)
            return {"private": True}

        monkeypatch.setattr(cs, "list_org_repos", lambda *a, **k: {"other": False})
        monkeypatch.setattr(cs, "get_repo", fake_get_repo)
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        targets = cs.private_template_targets(
            "https://api.github.com", "cs50",
            {"schema": cs.ASSIGNMENTS_SCHEMA_V1,
             "assignments": [{"slug": "hw1", "template": {"owner": "cs50", "repo": "priv-tmpl"}}]},
            "tok", repo_index=index,
        )
        assert targets == [("cs50", "priv-tmpl")]
        assert read == ["priv-tmpl"]

    def test_no_index_keeps_the_per_template_read(self, monkeypatch):
        read: list[str] = []

        def fake_get_repo(api_url, owner, repo, token):
            read.append(repo)
            return {"private": repo == "priv-tmpl"}

        monkeypatch.setattr(cs, "get_repo", fake_get_repo)
        targets = cs.private_template_targets(
            "https://api.github.com", "cs50", self.ASSIGNMENTS, "tok"
        )
        assert targets == [("cs50", "priv-tmpl")]
        assert read == ["priv-tmpl", "pub-tmpl"]

    def test_assignment_filter_limits_to_one_assignments_template(self, monkeypatch):
        read: list[str] = []

        def fake_get_repo(api_url, owner, repo, token):
            read.append(repo)
            return {"private": True}

        monkeypatch.setattr(cs, "get_repo", fake_get_repo)
        targets = cs.private_template_targets(
            "https://api.github.com", "cs50", self.ASSIGNMENTS, "tok",
            assignment_filter="hw1",
        )
        assert targets == [("cs50", "priv-tmpl")]  # hw2's template not read at all
        assert read == ["priv-tmpl"]


class TestRepoIndexLatch:
    def test_propagated_throttle_does_not_latch_unknown(self, monkeypatch):
        # If the failure latched, every later lookup would answer True and
        # collection would fan out the per-repo probes — mid-throttle.
        calls: list[int] = []

        def flaky(*a, **k):
            calls.append(1)
            if len(calls) == 1:
                raise http_error(403, {"Retry-After": "60"}, b"secondary rate limit")
            return {"cs-hw1-alice"}

        monkeypatch.setattr(cs, "list_org_repos", flaky)
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        with pytest.raises(cs.urllib.error.HTTPError):
            index.contains("cs-hw1-alice")
        # The retry reads the listing for real instead of returning "unknown".
        assert index.contains("cs-hw1-alice") is True
        assert index.contains("cs-hw1-carol") is False
        assert len(calls) == 2

    def test_soft_failure_still_latches_and_warns_once(self, monkeypatch):
        calls: list[int] = []

        def soft(*a, **k):
            calls.append(1)
            raise http_error(404, {}, b"nope")

        monkeypatch.setattr(cs, "list_org_repos", soft)
        index = cs.RepoIndex("https://api.github.com", "cs50", "tok")
        assert index.contains("a") is True
        assert index.contains("b") is True
        assert len(calls) == 1  # read once, warned once


class TestIncompleteListingNeverPersists:
    """A truncated listing is indistinguishable from a complete one, so it must
    not be written as truth — the same principle the throttle re-raise added."""

    def test_incomplete_listing_is_a_valueerror_subclass(self):
        # Callers that fall back on ValueError keep working unchanged.
        assert issubclass(cs.IncompleteListing, ValueError)

    def test_attribute_group_members_propagates_incomplete(self, monkeypatch):
        def incomplete(*a, **k):
            raise cs.IncompleteListing("orgs/x: the listing is incomplete")

        monkeypatch.setattr(cs, "list_repo_collaborator_logins", incomplete)
        with pytest.raises(cs.IncompleteListing):
            cs.attribute_group_members(
                "https://api.github.com", "cs50", "cs-project-alice", "alice", "tok", {"alice", "bob"}
            )

    def test_attribute_group_members_propagates_a_throttle(self, monkeypatch):
        # Degrading here would PERSIST owner-only crediting to scores.json,
        # silently uncrediting real teammates over a transient rate limit.
        def throttled(*a, **k):
            raise http_error(403, {"Retry-After": "60"}, b"secondary rate limit")

        monkeypatch.setattr(cs, "list_repo_collaborator_logins", throttled)
        with pytest.raises(cs.urllib.error.HTTPError):
            cs.attribute_group_members(
                "https://api.github.com", "cs50", "cs-project-alice", "alice", "tok", {"alice", "bob"}
            )

    def test_malformed_body_still_degrades_to_owner_only(self, monkeypatch):
        # No usable list to be partial about — the owner is the only
        # defensible credit, and this path keeps its warning.
        def malformed(*a, **k):
            raise ValueError("expected JSON array, got dict")

        monkeypatch.setattr(cs, "list_repo_collaborator_logins", malformed)
        members, warning = cs.attribute_group_members(
            "https://api.github.com", "cs50", "cs-project-alice", "alice", "tok", {"alice"}
        )
        assert members == ["alice"]
        assert warning is not None and "malformed" in warning

    def test_collection_skips_the_repo_and_keeps_prior_credit(self, monkeypatch, capsys):
        # The repo is skipped entirely, so no entry is produced for it and its
        # existing scores.json record (with real teammates) survives.
        def incomplete(*a, **k):
            raise cs.IncompleteListing("collaborators: the listing is incomplete")

        monkeypatch.setattr(cs, "all_submit_releases", lambda *a, **k: [{
            "tag_name": "submit/2026-09-16T04-00-00Z",
            "assets": [{"name": "result.json", "url": "https://api.github.com/assets/1"}],
        }])
        monkeypatch.setattr(
            cs, "download_result_asset",
            lambda *a, **k: make_result(classroom="cs-principles", assignment="project",
                                        username="alice", assignment_type="group"),
        )
        stub_team_members(monkeypatch, ["alice"])
        monkeypatch.setattr(cs, "attribute_group_members", incomplete)

        results, _flips, _collected, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50",
            classroom_short="cs-principles", classroom_meta={},
            assignments={"schema": cs.ASSIGNMENTS_SCHEMA_V1,
                         "assignments": [{"slug": "project", "mode": "group", "max_group_size": 3}]},
            service_token="tok",
        )
        assert results == []
        err = capsys.readouterr().err
        assert "incomplete" in err and "preserved" in err


class TestMainThrottleBranches:
    """main()-level coverage for the throttle verdicts: a deferral must stay
    green and never advise rotation; collection must fail loudly but named."""

    def test_raw_throttled_httperror_from_grant_pass_defers(self, tmp_path, monkeypatch, capsys):
        # A throttle that hits the grant pass BEFORE its first repo arrives as a
        # bare HTTPError, not GrantThrottled — the same deferral verdict applies.
        classroom = write_minimal_classroom(tmp_path)
        (classroom / "classroom.json").write_text(json.dumps(TestGrantThrottled.META))

        def throttled_pass(**kwargs):
            raise http_error(403, {"Retry-After": "60"}, b"secondary rate limit")

        monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
        monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "cs50")
        monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "token")
        monkeypatch.setattr(cs, "grant_classroom_team_access", throttled_pass)
        monkeypatch.setattr(cs, "collect_classroom", lambda **k: ([], 0, {}, {}))

        assert cs.main() == 0
        err = capsys.readouterr().err
        assert "::error::" not in err
        line = next(ln for ln in err.splitlines() if "throttled" in ln)
        assert "do NOT rotate" in line
        assert "rotate-service-token" not in line
