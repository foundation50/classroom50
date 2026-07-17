"""Unit tests for `regrade_repos.py`.

The GitHub-API transport is exercised end-to-end by the functional smoke test;
these focus on the pure helpers and per-repo decision logic (tag construction,
idempotent reuse, missing-repo handling, hard-vs-skip error classification) and
the roster/manifest loader, with the HTTP layer stubbed.
"""

from __future__ import annotations

import io
import json
import pathlib
import urllib.error
import urllib.request
import email.message

import pytest

from conftest import regrade_repos as rr


# Pure helpers ----------------------------------------------------------------


def test_assignment_repo_name_lowercases():
    assert rr.assignment_repo_name("CS-Principles", "Hello", "Alice") == (
        "cs-principles-hello-alice"
    )


def test_assignment_repo_name_shared_fixture_parity():
    # Same golden cases the Go contract test asserts, so this mirror can't
    # drift from the single source in cli/shared/contract.
    repo_root = pathlib.Path(__file__).resolve().parents[3]
    fixture = (repo_root / "cli" / "shared" / "testdata"
               / "assignment_repo_name_cases.json")
    cases = json.loads(fixture.read_text())["cases"]
    assert cases, "shared fixture has no cases"
    for case in cases:
        assert rr.assignment_repo_name(
            case["classroom"], case["assignment"], case["username"]
        ) == case["name"], case["name"]


def test_build_submit_tag_shape():
    tag = rr.build_submit_tag("abcdef1234567890")
    assert tag.startswith("submit/")
    # submit/<ISO-ish timestamp>Z-<7-char short sha>
    assert tag.endswith("-abcdef1")
    assert "T" in tag and tag.count("-") >= 3


def test_is_hard_http_error():
    for code in (401, 403, 599):
        assert rr.is_hard_http_error(_http_error(code))
    for code in (404, 422, 500):
        assert not rr.is_hard_http_error(_http_error(code))


# regrade_repo decision logic -------------------------------------------------


def test_regrade_repo_reruns_latest_run(monkeypatch):
    calls = {}
    monkeypatch.setattr(rr, "latest_autograde_run_id", lambda *a, **k: 4242)

    def fake_rerun(api_url, org, repo, token, run_id):
        calls["run_id"] = run_id

    monkeypatch.setattr(rr, "rerun_workflow_run", fake_rerun)
    # main_head_sha / tagging must NOT be reached when a run exists.
    monkeypatch.setattr(
        rr, "main_head_sha", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )

    assert rr.regrade_repo("https://api", "cs50", "cs50-hello-alice", "tok") == "rerun"
    assert calls["run_id"] == 4242


def test_regrade_repo_first_grades_when_no_prior_run(monkeypatch):
    calls = {}
    monkeypatch.setattr(rr, "latest_autograde_run_id", lambda *a, **k: None)
    monkeypatch.setattr(rr, "main_head_sha", lambda *a, **k: "deadbeefcafe")
    monkeypatch.setattr(rr, "existing_submit_tag_at", lambda *a, **k: None)

    def fake_create(api_url, org, repo, token, tag, sha):
        calls["tag"] = tag
        calls["sha"] = sha

    monkeypatch.setattr(rr, "create_tag_ref", fake_create)

    assert rr.regrade_repo("https://api", "cs50", "cs50-hello-alice", "tok") == "tagged"
    assert calls["sha"] == "deadbeefcafe"
    assert calls["tag"].startswith("submit/")


def test_regrade_repo_first_grade_reuses_existing_tag(monkeypatch):
    monkeypatch.setattr(rr, "latest_autograde_run_id", lambda *a, **k: None)
    monkeypatch.setattr(rr, "main_head_sha", lambda *a, **k: "deadbeef")
    monkeypatch.setattr(
        rr, "existing_submit_tag_at", lambda *a, **k: "submit/2026-01-01T00-00-00Z-deadbee"
    )

    def boom(*a, **k):
        raise AssertionError("create_tag_ref called despite an existing tag")

    monkeypatch.setattr(rr, "create_tag_ref", boom)
    assert rr.regrade_repo("https://api", "cs50", "cs50-hello-alice", "tok") == "tagged"


def test_regrade_repo_missing_repo(monkeypatch):
    monkeypatch.setattr(rr, "latest_autograde_run_id", lambda *a, **k: None)
    monkeypatch.setattr(rr, "main_head_sha", lambda *a, **k: None)
    monkeypatch.setattr(
        rr, "existing_submit_tag_at", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    assert rr.regrade_repo("https://api", "cs50", "cs50-hello-alice", "tok") == "missing"


def test_latest_autograde_run_id_parses_newest(monkeypatch):
    body = json.dumps({"workflow_runs": [{"id": 999}]}).encode("utf-8")
    monkeypatch.setattr(rr, "_http_get", lambda *a, **k: body)
    assert rr.latest_autograde_run_id("https://api", "cs50", "repo", "tok") == 999


def test_latest_autograde_run_id_none_when_no_runs(monkeypatch):
    body = json.dumps({"workflow_runs": []}).encode("utf-8")
    monkeypatch.setattr(rr, "_http_get", lambda *a, **k: body)
    assert rr.latest_autograde_run_id("https://api", "cs50", "repo", "tok") is None


def test_latest_autograde_run_id_none_on_404(monkeypatch):
    def fake_get(url, token, *, accept, _retries=3):
        raise _http_error(404)

    monkeypatch.setattr(rr, "_http_get", fake_get)
    assert rr.latest_autograde_run_id("https://api", "cs50", "repo", "tok") is None


def test_rerun_workflow_run_posts_to_rerun_endpoint(monkeypatch):
    seen = {}

    def fake_request(method, url, token, *, accept, body=None, _retries=3):
        seen["method"] = method
        seen["url"] = url
        return b""

    monkeypatch.setattr(rr, "_http_request", fake_request)
    rr.rerun_workflow_run("https://api", "cs50", "repo", "tok", 77)
    assert seen["method"] == "POST"
    assert seen["url"].endswith("/actions/runs/77/rerun")


def test_rerun_workflow_run_403_raises_skiprepo(monkeypatch):
    def fake_request(method, url, token, *, accept, body=None, _retries=3):
        raise _http_error(403)

    monkeypatch.setattr(rr, "_http_request", fake_request)
    with pytest.raises(rr._SkipRepo):
        rr.rerun_workflow_run("https://api", "cs50", "repo", "tok", 5)


def test_main_head_sha_returns_none_on_404(monkeypatch):
    def fake_get(url, token, *, accept, _retries=3):
        raise _http_error(404)

    monkeypatch.setattr(rr, "_http_get", fake_get)
    assert rr.main_head_sha("https://api", "cs50", "repo", "tok") is None


def test_main_head_sha_parses_object_sha(monkeypatch):
    body = json.dumps({"object": {"sha": "1234abcd"}}).encode("utf-8")
    monkeypatch.setattr(rr, "_http_get", lambda *a, **k: body)
    assert rr.main_head_sha("https://api", "cs50", "repo", "tok") == "1234abcd"


def test_main_head_sha_resolves_master_default_branch(monkeypatch):
    # A master-default student repo must be regraded off heads/master, not a
    # nonexistent heads/main.
    seen = {}

    def fake_get(url, token, *, accept, _retries=3):
        if url.endswith("/repos/cs50/repo"):
            return json.dumps({"default_branch": "master"}).encode("utf-8")
        seen["ref_url"] = url
        return json.dumps({"object": {"sha": "cafe"}}).encode("utf-8")

    monkeypatch.setattr(rr, "_http_get", fake_get)
    assert rr.main_head_sha("https://api", "cs50", "repo", "tok") == "cafe"
    assert seen["ref_url"].endswith("/git/ref/heads/master")


def test_main_head_sha_returns_none_when_repo_missing(monkeypatch):
    # 404 on the repo read (student never accepted) → None, no ref read.
    def fake_get(url, token, *, accept, _retries=3):
        if url.endswith("/repos/cs50/repo"):
            raise _http_error(404)
        raise AssertionError("ref read should not happen when the repo is 404")

    monkeypatch.setattr(rr, "_http_get", fake_get)
    assert rr.main_head_sha("https://api", "cs50", "repo", "tok") is None


def test_existing_submit_tag_matches_sha(monkeypatch):
    body = json.dumps(
        [
            {"ref": "refs/tags/submit/2026-01-01T00-00-00Z-aaaaaaa", "object": {"sha": "other"}},
            {"ref": "refs/tags/submit/2026-02-02T00-00-00Z-bbbbbbb", "object": {"sha": "target"}},
        ]
    ).encode("utf-8")
    monkeypatch.setattr(rr, "_http_get", lambda *a, **k: body)
    got = rr.existing_submit_tag_at("https://api", "cs50", "repo", "tok", "target")
    assert got == "submit/2026-02-02T00-00-00Z-bbbbbbb"


def test_existing_submit_tag_no_match_returns_none(monkeypatch):
    body = json.dumps(
        [{"ref": "refs/tags/submit/x", "object": {"sha": "nope"}}]
    ).encode("utf-8")
    monkeypatch.setattr(rr, "_http_get", lambda *a, **k: body)
    assert rr.existing_submit_tag_at("https://api", "cs50", "repo", "tok", "target") is None


def test_existing_submit_tag_dereferences_annotated_tag(monkeypatch):
    # An annotated submit/* tag's ref points at a TAG object, not the commit;
    # its target commit must be fetched via git/tags/<sha> before matching, or
    # a duplicate tag/release would be minted on the first-grade fallback.
    refs = json.dumps(
        [
            {
                "ref": "refs/tags/submit/2026-03-03T00-00-00Z-ccccccc",
                "object": {"sha": "tagobjsha", "type": "tag"},
            }
        ]
    ).encode("utf-8")
    tag_obj = json.dumps({"object": {"sha": "target", "type": "commit"}}).encode("utf-8")

    def fake_get(url, token, *, accept, _retries=3):
        return tag_obj if "/git/tags/" in url else refs

    monkeypatch.setattr(rr, "_http_get", fake_get)
    got = rr.existing_submit_tag_at("https://api", "cs50", "repo", "tok", "target")
    assert got == "submit/2026-03-03T00-00-00Z-ccccccc"


def test_existing_submit_tag_annotated_tag_pointing_elsewhere_no_match(monkeypatch):
    refs = json.dumps(
        [
            {
                "ref": "refs/tags/submit/2026-03-03T00-00-00Z-ccccccc",
                "object": {"sha": "tagobjsha", "type": "tag"},
            }
        ]
    ).encode("utf-8")
    tag_obj = json.dumps({"object": {"sha": "someothercommit", "type": "commit"}}).encode("utf-8")

    def fake_get(url, token, *, accept, _retries=3):
        return tag_obj if "/git/tags/" in url else refs

    monkeypatch.setattr(rr, "_http_get", fake_get)
    assert rr.existing_submit_tag_at("https://api", "cs50", "repo", "tok", "target") is None


def test_existing_submit_tag_annotated_deref_failure_is_no_match(monkeypatch):
    # A failed dereference falls back to "no existing tag" (worst case: a
    # duplicate release, never a missed regrade).
    refs = json.dumps(
        [
            {
                "ref": "refs/tags/submit/2026-03-03T00-00-00Z-ccccccc",
                "object": {"sha": "tagobjsha", "type": "tag"},
            }
        ]
    ).encode("utf-8")

    def fake_get(url, token, *, accept, _retries=3):
        if "/git/tags/" in url:
            raise _http_error(404)
        return refs

    monkeypatch.setattr(rr, "_http_get", fake_get)
    assert rr.existing_submit_tag_at("https://api", "cs50", "repo", "tok", "target") is None


def test_create_tag_ref_swallows_ref_already_exists_422(monkeypatch):
    def fake_request(method, url, token, *, accept, body=None, _retries=3):
        raise _http_error(422, body={"message": "Reference already exists"})

    monkeypatch.setattr(rr, "_http_request", fake_request)
    # Should NOT raise — a 422 whose body says the ref exists is a benign
    # concurrent-regrade race.
    rr.create_tag_ref("https://api", "cs50", "repo", "tok", "submit/t", "sha")


def test_create_tag_ref_propagates_other_422(monkeypatch):
    # A 422 that is NOT "already exists" (e.g. invalid sha) is a real failure
    # and must propagate so the caller records the repo as failed rather than
    # mis-counting it as first-graded (phantom-tagged).
    def fake_request(method, url, token, *, accept, body=None, _retries=3):
        raise _http_error(422, body={"message": "Object does not exist"})

    monkeypatch.setattr(rr, "_http_request", fake_request)
    with pytest.raises(urllib.error.HTTPError):
        rr.create_tag_ref("https://api", "cs50", "repo", "tok", "submit/t", "sha")


def test_create_tag_ref_propagates_bodyless_422(monkeypatch):
    # A 422 with an unreadable/empty body fails safe toward surfacing the
    # error rather than silently swallowing an unconfirmed "already exists".
    def fake_request(method, url, token, *, accept, body=None, _retries=3):
        raise _http_error(422)

    monkeypatch.setattr(rr, "_http_request", fake_request)
    with pytest.raises(urllib.error.HTTPError):
        rr.create_tag_ref("https://api", "cs50", "repo", "tok", "submit/t", "sha")


def test_create_tag_ref_propagates_other_errors(monkeypatch):
    def fake_request(method, url, token, *, accept, body=None, _retries=3):
        raise _http_error(500)

    monkeypatch.setattr(rr, "_http_request", fake_request)
    with pytest.raises(urllib.error.HTTPError):
        rr.create_tag_ref("https://api", "cs50", "repo", "tok", "submit/t", "sha")


# main() orchestration ---------------------------------------------------------


def _set_main_env(monkeypatch, **overrides):
    env = {
        "GITHUB_WORKSPACE": ".",
        "CLASSROOM_FILTER": "cs50",
        "ASSIGNMENT_FILTER": "hello",
        "OWNER_FILTER": "",
        "GITHUB_REPOSITORY_OWNER": "cs50org",
        "CLASSROOM50_SERVICE_TOKEN": "tok",
    }
    env.update(overrides)
    for key in (
        "GITHUB_WORKSPACE", "CLASSROOM_FILTER", "ASSIGNMENT_FILTER", "OWNER_FILTER",
        "GITHUB_REPOSITORY_OWNER", "CLASSROOM50_SERVICE_TOKEN", "GH_API_URL", "GITHUB_API_URL",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)


@pytest.mark.parametrize(
    "missing",
    ["CLASSROOM_FILTER", "ASSIGNMENT_FILTER", "GITHUB_REPOSITORY_OWNER", "CLASSROOM50_SERVICE_TOKEN"],
)
def test_main_returns_1_on_missing_required_input(monkeypatch, missing):
    _set_main_env(monkeypatch, **{missing: ""})
    # load_roster must not be reached when a required input is empty.
    monkeypatch.setattr(
        rr, "load_roster", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    assert rr.main() == 1


def test_main_all_success_returns_0(monkeypatch):
    _set_main_env(monkeypatch)
    monkeypatch.setattr(rr, "load_roster", lambda *a, **k: ["alice", "bob"])
    outcomes = {"cs50-hello-alice": "rerun", "cs50-hello-bob": "tagged"}

    def fake_regrade(api_url, org, repo, token):
        return outcomes[repo]

    monkeypatch.setattr(rr, "regrade_repo", fake_regrade)
    assert rr.main() == 0


def test_main_hard_http_error_aborts_immediately(monkeypatch):
    _set_main_env(monkeypatch)
    monkeypatch.setattr(rr, "load_roster", lambda *a, **k: ["alice", "bob"])
    seen = []

    def fake_regrade(api_url, org, repo, token):
        seen.append(repo)
        raise _http_error(403)  # hard error -> abort the whole run

    monkeypatch.setattr(rr, "regrade_repo", fake_regrade)
    assert rr.main() == 1
    # Aborts on the FIRST repo — does not continue iterating the roster.
    assert seen == ["cs50-hello-alice"]


def test_main_soft_http_error_skips_and_exits_1(monkeypatch):
    _set_main_env(monkeypatch)
    monkeypatch.setattr(rr, "load_roster", lambda *a, **k: ["alice", "bob"])

    def fake_regrade(api_url, org, repo, token):
        if repo.endswith("alice"):
            raise _http_error(500)  # non-hard -> warn-and-skip, continue
        return "rerun"

    monkeypatch.setattr(rr, "regrade_repo", fake_regrade)
    # One repo failed (appended to failed[]) but the other regraded -> exit 1.
    assert rr.main() == 1


def test_main_load_roster_hard_http_error_reports_token_scope(monkeypatch, capsys):
    # A hard team-listing failure (401/403/599) must exit 1 AND emit the
    # token-scope remediation (Members: Read / rotate-service-token). Both this
    # and the transient branch return 1, so assert on the message, not just code.
    _set_main_env(monkeypatch)

    def boom(*a, **k):
        raise _http_error(403)

    monkeypatch.setattr(rr, "load_roster", boom)
    monkeypatch.setattr(
        rr, "regrade_repo", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    assert rr.main() == 1
    err = capsys.readouterr().err
    assert "Members: Read" in err
    assert "rotate-service-token" in err


def test_main_load_roster_transient_http_error_reports_generic(monkeypatch, capsys):
    # A non-hard team-listing failure (e.g. 404 missing/re-slugged team) exits 1
    # with the generic "listing the classroom team failed" message — distinct
    # from the hard-error token-scope guidance.
    _set_main_env(monkeypatch)

    def boom(*a, **k):
        raise _http_error(404)

    monkeypatch.setattr(rr, "load_roster", boom)
    monkeypatch.setattr(
        rr, "regrade_repo", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    assert rr.main() == 1
    err = capsys.readouterr().err
    assert "listing the classroom team failed" in err
    assert "Members: Read" not in err


def test_main_load_roster_valueerror_is_reported_not_crashed(monkeypatch, capsys):
    # A malformed team-listing body / pagination cap raises ValueError from
    # _paginate_login_list; main() must surface it as an error and exit 1 rather
    # than let the traceback escape (mirrors collect_scores.py).
    _set_main_env(monkeypatch)

    def boom(*a, **k):
        raise ValueError("expected JSON array, got dict")

    monkeypatch.setattr(rr, "load_roster", boom)
    monkeypatch.setattr(
        rr, "regrade_repo", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    assert rr.main() == 1
    err = capsys.readouterr().err
    assert "malformed" in err


def test_main_empty_team_warns_and_exits_0(monkeypatch, capsys):
    # An empty classroom team (no owner_filter) is nothing to regrade: succeed,
    # but emit an empty-team warning so a green 0-repo run isn't mistaken for a
    # real regrade.
    _set_main_env(monkeypatch)
    monkeypatch.setattr(rr, "load_roster", lambda *a, **k: [])
    monkeypatch.setattr(
        rr, "regrade_repo", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    assert rr.main() == 0
    err = capsys.readouterr().err
    assert "no members" in err


def test_main_skiprepo_counts_as_skipped_not_failed(monkeypatch):
    _set_main_env(monkeypatch)
    monkeypatch.setattr(rr, "load_roster", lambda *a, **k: ["alice", "bob"])

    def fake_regrade(api_url, org, repo, token):
        if repo.endswith("alice"):
            raise rr._SkipRepo()  # benign per-repo skip
        return "rerun"

    monkeypatch.setattr(rr, "regrade_repo", fake_regrade)
    # A _SkipRepo is counted as skipped, not failed -> exit 0.
    assert rr.main() == 0


def test_main_owner_filter_narrows_to_one(monkeypatch):
    _set_main_env(monkeypatch, OWNER_FILTER="Bob")  # case-insensitive match
    monkeypatch.setattr(rr, "load_roster", lambda *a, **k: ["alice", "bob"])
    seen = []

    def fake_regrade(api_url, org, repo, token):
        seen.append(repo)
        return "rerun"

    monkeypatch.setattr(rr, "regrade_repo", fake_regrade)
    assert rr.main() == 0
    assert seen == ["cs50-hello-bob"]


def test_main_owner_filter_no_match_returns_1(monkeypatch):
    _set_main_env(monkeypatch, OWNER_FILTER="carol")
    monkeypatch.setattr(rr, "load_roster", lambda *a, **k: ["alice", "bob"])
    monkeypatch.setattr(
        rr, "regrade_repo", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    assert rr.main() == 1


def test_main_logs_incremental_progress(monkeypatch, capsys):
    # A killed-by-timeout run must leave per-repo accounting in the log, so the
    # fan-out emits a progress line every PROGRESS_EVERY repos (and on the last).
    monkeypatch.setattr(rr, "PROGRESS_EVERY", 2)
    _set_main_env(monkeypatch)
    monkeypatch.setattr(rr, "load_roster", lambda *a, **k: ["a", "b", "c"])
    monkeypatch.setattr(rr, "regrade_repo", lambda *a, **k: "rerun")

    assert rr.main() == 0
    out = capsys.readouterr().out
    # One checkpoint at index 2 (PROGRESS_EVERY) and one at index 3 (== total).
    assert out.count("progress 2/3") == 1
    assert out.count("progress 3/3") == 1


# Team / manifest loader ------------------------------------------------------


def _write_classroom(tmp_path: pathlib.Path, *, slug="hello", team=None):
    cdir = tmp_path / "cs50"
    cdir.mkdir()
    (cdir / "assignments.json").write_text(
        json.dumps(
            {
                "schema": rr.ASSIGNMENTS_SCHEMA_V1,
                "assignments": [{"slug": slug, "name": slug, "mode": "individual", "autograder": "default"}],
            }
        )
    )
    meta = {"schema": rr.CLASSROOM_SCHEMA_V1, "short_name": "cs50"}
    if team is not None:
        meta["team"] = team
    (cdir / "classroom.json").write_text(json.dumps(meta))
    return cdir


def test_load_roster_returns_team_members(monkeypatch, tmp_path):
    cdir = _write_classroom(tmp_path)
    monkeypatch.setattr(rr, "list_team_member_logins", lambda *a, **k: ["alice", "bob"])
    assert rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok") == ["alice", "bob"]


def test_load_roster_uses_persisted_team_slug(monkeypatch, tmp_path):
    # classroom.json's team.slug is authoritative (GitHub may re-slug); the team
    # read must target it, not the derived classroom50-<short>.
    cdir = _write_classroom(tmp_path, team={"slug": "classroom50-cs-1", "id": 7})
    seen = {}

    def fake_members(api_url, org, team_slug, token):
        seen["team_slug"] = team_slug
        return ["alice"]

    monkeypatch.setattr(rr, "list_team_member_logins", fake_members)
    assert rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok") == ["alice"]
    assert seen["team_slug"] == "classroom50-cs-1"


def test_load_roster_derives_team_slug_without_team_block(monkeypatch, tmp_path):
    cdir = _write_classroom(tmp_path)  # no team block
    seen = {}

    def fake_members(api_url, org, team_slug, token):
        seen["team_slug"] = team_slug
        return []

    monkeypatch.setattr(rr, "list_team_member_logins", fake_members)
    rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok")
    assert seen["team_slug"] == "classroom50-cs50"


def test_load_roster_dedupes_case_insensitively(monkeypatch, tmp_path):
    cdir = _write_classroom(tmp_path)
    monkeypatch.setattr(
        rr, "list_team_member_logins", lambda *a, **k: ["Alice", "alice", "BOB"]
    )
    # First-seen casing wins; the case-insensitive duplicate is dropped.
    assert rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok") == ["Alice", "BOB"]


def test_load_roster_skips_malformed_login(monkeypatch, tmp_path):
    cdir = _write_classroom(tmp_path)
    monkeypatch.setattr(
        rr, "list_team_member_logins", lambda *a, **k: ["alice", "bad/name", "bob"]
    )
    # A malformed login is skipped with a warning; valid members survive.
    assert rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok") == ["alice", "bob"]


def test_load_roster_propagates_team_http_error(monkeypatch, tmp_path):
    # A team-listing HTTP error is NOT swallowed — it propagates so main() can
    # classify hard (auth/network) vs. transient.
    cdir = _write_classroom(tmp_path)

    def boom(*a, **k):
        raise _http_error(403)

    monkeypatch.setattr(rr, "list_team_member_logins", boom)
    with pytest.raises(urllib.error.HTTPError):
        rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok")


def test_load_roster_rejects_unregistered_assignment(monkeypatch, tmp_path):
    cdir = _write_classroom(tmp_path, slug="hello")
    monkeypatch.setattr(
        rr, "list_team_member_logins", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    with pytest.raises(rr.RegradeInputError, match="not registered"):
        rr.load_roster(cdir, "nope", "https://api", "cs50org", "tok")


def test_load_roster_missing_classroom(tmp_path):
    with pytest.raises(rr.RegradeInputError, match="not found"):
        rr.load_roster(tmp_path / "missing", "hello", "https://api", "cs50org", "tok")


def test_load_roster_bad_schema(tmp_path):
    cdir = tmp_path / "cs50"
    cdir.mkdir()
    (cdir / "assignments.json").write_text(json.dumps({"schema": "wrong", "assignments": []}))
    with pytest.raises(rr.RegradeInputError, match="schema"):
        rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok")


def test_load_roster_missing_assignments_json(tmp_path):
    cdir = tmp_path / "cs50"
    cdir.mkdir()
    with pytest.raises(rr.RegradeInputError, match="assignments.json not found"):
        rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok")


def test_load_roster_unparseable_assignments_json(tmp_path):
    cdir = tmp_path / "cs50"
    cdir.mkdir()
    (cdir / "assignments.json").write_text("{not json")
    with pytest.raises(rr.RegradeInputError, match="assignments.json"):
        rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok")


def test_load_roster_unparseable_classroom_json(monkeypatch, tmp_path):
    cdir = _write_classroom(tmp_path)
    (cdir / "classroom.json").write_text("{not json")
    monkeypatch.setattr(
        rr, "list_team_member_logins", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    with pytest.raises(rr.RegradeInputError, match="classroom.json"):
        rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok")


# resolve_team_slug / list_team_member_logins --------------------------------


def test_resolve_team_slug_prefers_persisted():
    assert rr.resolve_team_slug({"team": {"slug": "classroom50-cs-1"}}, "cs") == "classroom50-cs-1"


def test_resolve_team_slug_derives_when_absent():
    assert rr.resolve_team_slug({}, "cs-principles") == "classroom50-cs-principles"
    assert rr.resolve_team_slug({"team": {"id": 7}}, "cs") == "classroom50-cs"
    assert rr.resolve_team_slug({"team": {"slug": "  "}}, "cs") == "classroom50-cs"


def test_list_team_member_logins_paginates(monkeypatch):
    # Two pages via a Link: rel="next" header, then a header-less short page.
    pages = {
        "https://api/orgs/cs50org/teams/classroom50-cs50/members?per_page=100&page=1": (
            json.dumps([{"login": "alice"}, {"login": "bob"}]).encode("utf-8"),
            {"Link": '<https://api/orgs/cs50org/teams/classroom50-cs50/members?per_page=100&page=2>; rel="next"'},
        ),
        "https://api/orgs/cs50org/teams/classroom50-cs50/members?per_page=100&page=2": (
            json.dumps([{"login": "carol"}]).encode("utf-8"),
            {},
        ),
    }

    def fake_get(url, token, *, accept, _retries=3):
        return pages[url]

    monkeypatch.setattr(rr, "_http_get_with_headers", fake_get)
    got = rr.list_team_member_logins("https://api", "cs50org", "classroom50-cs50", "tok")
    assert got == ["alice", "bob", "carol"]


def test_list_team_member_logins_propagates_404(monkeypatch):
    def fake_get(url, token, *, accept, _retries=3):
        raise _http_error(404)

    monkeypatch.setattr(rr, "_http_get_with_headers", fake_get)
    with pytest.raises(urllib.error.HTTPError):
        rr.list_team_member_logins("https://api", "cs50org", "missing-team", "tok")


def test_list_team_member_logins_raises_valueerror_on_non_array(monkeypatch):
    # A non-array body (e.g. a GitHub error envelope during a partial outage)
    # raises ValueError from _paginate_login_list rather than silently yielding
    # no members — main() converts this to a loud error, not a crash.
    def fake_get(url, token, *, accept, _retries=3):
        return json.dumps({"message": "Server Error"}).encode("utf-8"), {}

    monkeypatch.setattr(rr, "_http_get_with_headers", fake_get)
    with pytest.raises(ValueError):
        rr.list_team_member_logins("https://api", "cs50org", "classroom50-cs50", "tok")


def test_list_team_member_logins_refuses_off_host_next_link(monkeypatch):
    # The pagination loop attaches the bearer service token to whatever rel="next"
    # points at, so a crafted off-host Link must fail closed rather than pivot the
    # token to an attacker host (mirrors collect_scores.py's off-host refusal).
    def fake_get(url, token, *, accept, _retries=3):
        return (
            json.dumps([{"login": "alice"}]).encode("utf-8"),
            {"Link": '<https://evil.example/members?page=2>; rel="next"'},
        )

    monkeypatch.setattr(rr, "_http_get_with_headers", fake_get)
    with pytest.raises(ValueError, match="off-host"):
        rr.list_team_member_logins("https://api", "cs50org", "classroom50-cs50", "tok")


def test_list_team_member_logins_stops_on_self_looping_next_link(monkeypatch):
    # A rel="next" that points back at an already-seen URL must terminate via the
    # seen_next guard instead of exhausting the page cap (mirrors collect_scores.py).
    page1 = "https://api/orgs/cs50org/teams/classroom50-cs50/members?per_page=100&page=1"
    calls = {"n": 0}

    def fake_get(url, token, *, accept, _retries=3):
        calls["n"] += 1
        return (
            json.dumps([{"login": "alice"}]).encode("utf-8"),
            {"Link": f'<{page1}>; rel="next"'},
        )

    monkeypatch.setattr(rr, "_http_get_with_headers", fake_get)
    got = rr.list_team_member_logins("https://api", "cs50org", "classroom50-cs50", "tok")
    # Page 1 fetch (alice) -> follow next once (fetch again, alice) -> the same
    # next URL is now seen -> stop. Two requests, not an exhausted 100-page cap.
    assert got == ["alice", "alice"]
    assert calls["n"] == 2


def test_auth_stripping_redirect_drops_authorization_cross_host():
    # CPython's default redirect handler replays every request header (including
    # Authorization) across a cross-host 3xx, which would leak the service token;
    # _AuthStrippingRedirect must remove it on the redirected request.
    req = urllib.request.Request(
        "https://api.github.com/orgs/o/teams/t/members",
        headers={"Authorization": "Bearer sekret", "Accept": "application/json"},
    )
    handler = rr._AuthStrippingRedirect()
    fp = io.BytesIO(b"")
    hdrs = email.message.Message()
    new_req = handler.redirect_request(
        req, fp, 302, "Found", hdrs, "https://codeload.example/redirected"
    )
    assert new_req is not None
    assert new_req.get_header("Authorization") is None
    assert "authorization" not in {k.lower() for k in new_req.headers}


# Helpers ---------------------------------------------------------------------


def _http_error(code: int, *, body: dict | None = None) -> urllib.error.HTTPError:
    fp = io.BytesIO(json.dumps(body).encode("utf-8")) if body is not None else None
    return urllib.error.HTTPError(url="https://api", code=code, msg="x", hdrs=None, fp=fp)


# empty_repo skip -------------------------------------------------------------


def test_is_empty_repo_is_strict_boolean_true():
    # Must be byte-identical in meaning to collect_scores.is_empty_repo and the
    # runner guard: only the literal True is empty_repo, so a non-boolean from a
    # hand-edited manifest is NOT treated as bare (matching Go bool / TS ===
    # true). A truthiness check here would let regrade silently no-op on a
    # non-boolean the other readers would still grade.
    assert rr.is_empty_repo({"empty_repo": True}) is True
    assert rr.is_empty_repo({"empty_repo": False}) is False
    assert rr.is_empty_repo({}) is False
    for non_bool in ("true", "yes", 1, [1], {"x": 1}):
        assert rr.is_empty_repo({"empty_repo": non_bool}) is False, non_bool


def test_load_roster_empty_repo_raises_sentinel(monkeypatch, tmp_path):
    # An empty_repo assignment raises EmptyRepoAssignment BEFORE the team
    # listing — bare repos carry no autograde workflow, so there is nothing to
    # re-run and the first-grade fallback would push useless submit/* tags.
    cdir = tmp_path / "cs50"
    cdir.mkdir()
    (cdir / "assignments.json").write_text(
        json.dumps(
            {
                "schema": rr.ASSIGNMENTS_SCHEMA_V1,
                "assignments": [
                    {
                        "slug": "actions-lab",
                        "name": "Actions Lab",
                        "mode": "individual",
                        "autograder": "default",
                        "empty_repo": True,
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(
        rr, "list_team_member_logins", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    with pytest.raises(rr.EmptyRepoAssignment):
        rr.load_roster(cdir, "actions-lab", "https://api", "cs50org", "tok")


def test_load_roster_empty_repo_false_proceeds(monkeypatch, tmp_path):
    # An explicit empty_repo: false (the GUI may write it) is NOT a skip.
    cdir = tmp_path / "cs50"
    cdir.mkdir()
    (cdir / "assignments.json").write_text(
        json.dumps(
            {
                "schema": rr.ASSIGNMENTS_SCHEMA_V1,
                "assignments": [
                    {
                        "slug": "hello",
                        "name": "Hello",
                        "mode": "individual",
                        "autograder": "default",
                        "empty_repo": False,
                    }
                ],
            }
        )
    )
    monkeypatch.setattr(rr, "list_team_member_logins", lambda *a, **k: ["alice"])
    assert rr.load_roster(cdir, "hello", "https://api", "cs50org", "tok") == ["alice"]


def test_main_empty_repo_assignment_is_successful_noop(monkeypatch, capsys):
    # main() converts the sentinel into exit 0 with an explanatory line — a
    # manual regrade.yaml dispatch against an empty_repo assignment must not
    # show a red X the teacher can't act on.
    _set_main_env(monkeypatch)

    def raise_empty(*a, **k):
        raise rr.EmptyRepoAssignment("hello")

    monkeypatch.setattr(rr, "load_roster", raise_empty)
    monkeypatch.setattr(
        rr, "regrade_repo", lambda *a, **k: (_ for _ in ()).throw(AssertionError())
    )
    assert rr.main() == 0
    out = capsys.readouterr().out
    assert "empty_repo" in out
    assert "nothing to regrade" in out
