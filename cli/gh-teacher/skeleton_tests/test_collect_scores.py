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

import pytest

from conftest import collect_scores as cs


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
        # A previously-credited teammate (bob) is dropped on re-collect (e.g. he
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
        # An instructor/TA who is admin but NOT on the roster is still
        # excluded — the roster is the gate, and they aren't on it.
        monkeypatch.setattr(
            cs, "list_repo_collaborator_logins", lambda *a, **k: ["instructor", "bob"]
        )
        members = cs.group_member_usernames(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "alice", "token",
            {"alice", "bob"},
        )
        assert members == ["alice", "bob"]
        assert "instructor" not in members


class TestListRepoCollaboratorLogins:
    def test_returns_all_collaborators_including_admins_and_paginates(self, monkeypatch):
        # Crediting is gated on classroom-team membership downstream
        # (group_member_usernames), NOT on permission level, so this
        # function returns EVERY collaborator regardless of role_name.
        # A group teammate who is an org owner (admin on every repo) or a
        # founder kept as repo admin must NOT be dropped here — that was
        # the attribution bug. Instructors/TAs are filtered later by the
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
        logins = cs.list_repo_collaborator_logins(
            "https://api.github.com", "cs50", "cs-principles-hello-alice", "token"
        )
        # Page 1 fetch (alice) -> follow next once (page 2 fetch, alice
        # again) -> the same next URL is seen again -> stop. So two
        # requests and the two collected entries, NOT an exhausted cap.
        assert logins == ["alice", "alice"]
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

        results, _ = cs.collect_classroom(
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

        results, _ = cs.collect_classroom(
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

        results, _ = cs.collect_classroom(
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

        results, _ = cs.collect_classroom(
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

        results, _ = cs.collect_classroom(
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

        results, _ = cs.collect_classroom(
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
        # name collision, e.g. classroom50-cs-1).
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
        results, _ = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
        )
        assert len(results) == 1
        assert results[0]["owner"] == "alice"

    def test_empty_team_warns_and_collects_nothing(self, monkeypatch, capsys):
        stub_team_members(monkeypatch, [])
        results, mode_flip = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
        )
        assert results == []
        assert mode_flip == 0
        assert "has no members" in capsys.readouterr().err

    def test_team_read_404_warns_and_skips(self, monkeypatch, capsys):
        import urllib.error

        def boom(*a, **k):
            raise urllib.error.HTTPError("u", 404, "Not Found", None, None)

        monkeypatch.setattr(cs, "list_team_member_logins", boom)
        results, _ = cs.collect_classroom(
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
        results, mode_flip = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={}, assignments=self._assignments(), service_token="token",
        )
        assert results == []
        assert mode_flip == 0
        assert "member listing malformed" in capsys.readouterr().err


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

        results, _ = cs.collect_classroom(
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
    # The roster filename must stay in lockstep with contract.RosterFilename /
    # contract.LegacyRosterFilename in cli/shared/contract/contract.go (pinned by
    # TestContractLiterals) and the web's src/util/rosterPath.ts. There is no
    # compile-time link across the three tools; a Python-only drift would
    # otherwise ship green while readers stopped agreeing on which file to read.
    assert cs.ROSTER_FILENAME == "roster.csv"
    assert cs.LEGACY_ROSTER_FILENAME == "students.csv"


# Roster metadata join (best-effort) + roster.csv/students.csv fallback -------


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
        results, _ = cs.collect_classroom(
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

    def test_falls_back_to_legacy_students_csv(self, tmp_path, monkeypatch):
        # No roster.csv — only the legacy students.csv exists (a classroom
        # bootstrapped before the rename). The read must fall back and still
        # join the metadata. This is the fallback under test: with only the
        # pre-rename read (roster.csv), the metadata would be blank.
        write_roster(tmp_path / "students.csv", [{
            "username": "alice", "first_name": "Grace", "last_name": "Hopper",
            "email": "grace@uni.edu", "section": "B", "github_id": "2",
        }])
        results = self._collect(tmp_path, monkeypatch)
        assert len(results) == 1
        assert results[0]["first_name"] == "Grace"
        assert results[0]["email"] == "grace@uni.edu"
        assert results[0]["section"] == "B"

    def test_roster_csv_preferred_over_legacy(self, tmp_path, monkeypatch):
        # Both present during the rename window: roster.csv wins, the legacy
        # students.csv is ignored.
        write_roster(tmp_path / "roster.csv", [{"username": "alice", "first_name": "New"}])
        write_roster(tmp_path / "students.csv", [{"username": "alice", "first_name": "Old"}])
        results = self._collect(tmp_path, monkeypatch)
        assert results[0]["first_name"] == "New"

    def test_role_column_tolerated_metadata_still_joins(self, tmp_path, monkeypatch):
        # A roster.csv carrying the role column joins its display metadata
        # normally; role is recorded metadata the collector does not consume.
        write_roster(tmp_path / "roster.csv", [{
            "username": "alice", "first_name": "Ada", "last_name": "Lovelace",
            "email": "ada@uni.edu", "section": "A", "github_id": "1", "role": "instructor",
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
        # On os.replace failure (e.g. permissions), the original is
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
    def test_auth_errors_are_hard_failures(self):
        # 401/403 means the collect PAT is missing, expired, or
        # under-scoped — fail the run instead of warn-and-skip.
        for code in (401, 403):
            exc = cs.urllib.error.HTTPError(
                url="https://api.github.com/x",
                code=code,
                msg="auth failed",
                hdrs=None,
                fp=None,
            )
            assert cs.is_hard_http_error(exc) is True

    def test_network_error_is_a_hard_failure(self):
        # _http_get raises synthetic 599 on final URLError —
        # GitHub/DNS unreachable, not "student didn't submit".
        exc = cs.urllib.error.HTTPError(
            url="https://api.github.com/x",
            code=599,
            msg="network error",
            hdrs=None,
            fp=None,
        )
        assert cs.is_hard_http_error(exc) is True

    def test_non_auth_http_errors_are_per_repo_warnings(self):
        # Transient/per-repo failures warn-and-skip at the call
        # site; only auth errors poison the whole run.
        for code in (404, 429, 500):
            exc = cs.urllib.error.HTTPError(
                url="https://api.github.com/x",
                code=code,
                msg="not auth",
                hdrs=None,
                fp=None,
            )
            assert cs.is_hard_http_error(exc) is False

    def test_missing_result_asset_has_its_own_exception_type(self):
        # Missing result.json is a malformed release, not an HTTP
        # 404 — distinct type keeps logs unambiguous.
        with pytest.raises(cs.AssetMissingError, match="result.json"):
            cs.download_result_asset(
                "https://api.github.com",
                {"url": "https://api.github.com/repos/o/r/releases/1", "assets": []},
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
        results, _ = cs.collect_classroom(
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

        results, _ = cs.collect_classroom(
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

        results, _ = cs.collect_classroom(
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
        results, _ = cs.collect_classroom(
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
        results, _ = cs.collect_classroom(
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
        results, _ = cs.collect_classroom(
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


# main() hard-failure handling -------------------------------------------------


class TestMain:
    def test_api_url_prefers_explicit_override_then_actions_value(
        self, tmp_path, monkeypatch
    ):
        write_minimal_classroom(tmp_path)
        seen = []

        def fake_collect(**kwargs):
            seen.append(kwargs["api_url"])
            return [], 0

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
        monkeypatch.setattr(cs, "collect_classroom", lambda **kwargs: ([], 0))

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
            cs, "collect_classroom", lambda **kwargs: ([make_update(username="alice")], 0)
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
        monkeypatch.setattr(cs, "collect_classroom", lambda **kwargs: ([], 0))

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
        monkeypatch.setattr(cs, "collect_classroom", lambda **kwargs: ([], 0))

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
            return [make_update(username="alice")], 0

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
            lambda **kwargs: ([make_update(username="alice")], 0) if kwargs["classroom_short"] == "z-good" else ([], 0),
        )

        # Run fails (a classroom was bad) but the good classroom is collected.
        assert cs.main() == 1
        err = capsys.readouterr().err
        assert "a-bad" in err  # the bad classroom is named in the error
        good_scores = json.loads((good / "scores.json").read_text())
        assert "hello" in good_scores["assignments"], (
            "z-good must still be collected even though a-bad failed first"
        )


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
        results, mode_flip = cs.collect_classroom(
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
        results, mode_flip = cs.collect_classroom(
            api_url="https://api.github.com", org="cs50", classroom_short="cs-principles",
            classroom_meta={},
            assignments=self._assignments("individual"),
            service_token="token",
        )
        assert results == []
        assert mode_flip == 0
        err = capsys.readouterr().err
        assert "NONE were creditable" not in err


# Staff-team repo-access grant ------------------------------------------------


class TestStaffTeamPermissions:
    def test_ta_maps_to_pull(self):
        assert cs.STAFF_TEAM_PERMISSIONS["ta"] == "pull"

    def test_instructor_not_granted_at_collect_time(self):
        # The instructor team gets its access at classroom setup; the collector
        # must not grant it (parity with Go StaffTeamRepoPermissions).
        assert "instructor" not in cs.STAFF_TEAM_PERMISSIONS

    def test_all_permissions_are_valid_github_values(self):
        valid = {"pull", "triage", "push", "maintain", "admin"}
        assert set(cs.STAFF_TEAM_PERMISSIONS.values()) <= valid


class TestResolveStaffTeamSlugs:
    def test_returns_present_roles_with_slugs(self):
        meta = {
            "teams": {
                "instructor": {"id": 1, "slug": "classroom50-cs-instructor"},
                "ta": {"id": 2, "slug": "classroom50-cs-ta"},
            }
        }
        assert cs.resolve_staff_team_slugs(meta) == {
            "instructor": "classroom50-cs-instructor",
            "ta": "classroom50-cs-ta",
        }

    def test_no_teams_block_yields_empty(self):
        assert cs.resolve_staff_team_slugs({}) == {}

    def test_skips_role_without_slug(self):
        meta = {"teams": {"ta": {"id": 2}, "instructor": {"slug": "  "}}}
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
        # main() aborts the run — is_hard_http_error treats 403 as hard.
        def fake_send(method, url, token, *, accept, body, _retries=3):
            raise cs.urllib.error.HTTPError(url=url, code=403, msg="forbidden", hdrs=None, fp=None)

        monkeypatch.setattr(cs, "_http_send", fake_send)
        with pytest.raises(cs.urllib.error.HTTPError) as ei:
            cs.grant_team_repo(
                "https://api.github.com", "cs50", "classroom50-cs-ta", "cs50", "cs-hw-alice", "pull", "tok"
            )
        assert ei.value.code == 403
        assert cs.is_hard_http_error(ei.value)


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

        def fake_grant(api_url, org, team_slug, owner, repo, permission, token):
            grants.append((team_slug, owner, repo, permission))
            return True

        monkeypatch.setattr(cs, "grant_team_repo", fake_grant)
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
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: [])  # no students
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
        seen: list[str] = []

        def fake_grant(api_url, org, team_slug, owner, repo, permission, token):
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
        # A 403 (missing Administration) must abort the pass so main() fails.
        monkeypatch.setattr(cs, "list_team_member_logins", lambda *a, **k: ["alice"])

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
