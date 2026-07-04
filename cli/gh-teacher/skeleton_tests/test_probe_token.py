"""Unit tests for `probe_token.py`.

The probe's transport is stubbed (monkeypatched `http_get`); these tests cover
the per-scope check outcomes, the team-slug resolution and classroom iteration,
the 404-team "skip as pass" behavior, and main()'s exit-code contract. The
side-effect-free promise is enforced structurally: the checks only ever call
`http_get` (a GET), never any write helper — there is none.
"""

from __future__ import annotations

import json
import urllib.error

import pytest

from conftest import probe_token as pt


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="https://api.github.com/x", code=code, msg="e", hdrs=None, fp=None
    )


# Pure helpers ----------------------------------------------------------------


def test_resolve_team_slug_prefers_persisted():
    meta = {"team": {"slug": "classroom50-cs-1"}}
    assert pt.resolve_team_slug(meta, "cs") == "classroom50-cs-1"


def test_resolve_team_slug_derives_when_absent():
    assert pt.resolve_team_slug({}, "cs") == "classroom50-cs"
    assert pt.resolve_team_slug({"team": {}}, "cs") == "classroom50-cs"
    assert pt.resolve_team_slug({"team": {"slug": "  "}}, "cs") == "classroom50-cs"


def test_iter_classroom_meta_skips_non_v1_and_unreadable(tmp_path):
    # v1 classroom
    good = tmp_path / "cs1"
    good.mkdir()
    (good / "classroom.json").write_text(
        json.dumps({"schema": pt.CLASSROOM_SCHEMA_V1, "team": {"slug": "t1"}})
    )
    # wrong schema — skipped
    bad = tmp_path / "cs2"
    bad.mkdir()
    (bad / "classroom.json").write_text(json.dumps({"schema": "other"}))
    # malformed — skipped
    ugly = tmp_path / "cs3"
    ugly.mkdir()
    (ugly / "classroom.json").write_text("{not json")
    # no classroom.json — skipped
    (tmp_path / "cs4").mkdir()

    got = dict(pt.iter_classroom_meta(tmp_path))
    assert list(got.keys()) == ["cs1"]


# Scope checks — Contents R/W -------------------------------------------------


def test_config_contents_read_and_write_both_pass(monkeypatch):
    monkeypatch.setattr(
        pt, "http_get", lambda *a, **k: (200, json.dumps({"permissions": {"push": True}}).encode())
    )
    checks = pt.check_config_contents_and_write("https://api", "cs50", "tok")
    assert all(c.ok for c in checks)
    assert any("Read" in c.name for c in checks)
    assert any("Write" in c.name for c in checks)


def test_config_contents_read_only_token_fails_write(monkeypatch):
    monkeypatch.setattr(
        pt, "http_get", lambda *a, **k: (200, json.dumps({"permissions": {"push": False}}).encode())
    )
    checks = pt.check_config_contents_and_write("https://api", "cs50", "tok")
    read = next(c for c in checks if "Read" in c.name)
    write = next(c for c in checks if "Write" in c.name)
    assert read.ok is True
    assert write.ok is False
    assert "read-only" in write.message.lower() or "read and write" in write.message.lower()


def test_config_contents_unreadable_fails_both(monkeypatch):
    def boom(*a, **k):
        raise _http_error(404)

    monkeypatch.setattr(pt, "http_get", boom)
    checks = pt.check_config_contents_and_write("https://api", "cs50", "tok")
    assert all(c.ok is False for c in checks)


# Scope checks — Actions / Metadata / Members ---------------------------------


def test_actions_reachable_passes(monkeypatch):
    monkeypatch.setattr(pt, "http_get", lambda *a, **k: (200, b"{}"))
    assert pt.check_actions("https://api", "cs50", "tok").ok is True


def test_actions_forbidden_fails(monkeypatch):
    def boom(*a, **k):
        raise _http_error(403)

    monkeypatch.setattr(pt, "http_get", boom)
    check = pt.check_actions("https://api", "cs50", "tok")
    assert check.ok is False
    assert "Actions" in check.name


def test_metadata_reachable_passes(monkeypatch):
    monkeypatch.setattr(pt, "http_get", lambda *a, **k: (200, b"[]"))
    assert pt.check_metadata("https://api", "cs50", "tok").ok is True


def test_org_members_forbidden_fails(monkeypatch):
    def boom(*a, **k):
        raise _http_error(403)

    monkeypatch.setattr(pt, "http_get", boom)
    check = pt.check_org_members("https://api", "cs50", "tok")
    assert check.ok is False
    assert "Members" in check.name


def test_org_members_ok_passes(monkeypatch):
    monkeypatch.setattr(pt, "http_get", lambda *a, **k: (200, b"[]"))
    assert pt.check_org_members("https://api", "cs50", "tok").ok is True


# Scope checks — per-classroom team read --------------------------------------


def test_team_members_ok(monkeypatch):
    monkeypatch.setattr(pt, "http_get", lambda *a, **k: (200, b"[]"))
    check = pt.check_classroom_team("https://api", "cs50", "tok", "cs1", "classroom50-cs1")
    assert check.ok is True and check.skipped is False


def test_team_members_404_is_skip_not_fail(monkeypatch):
    # A missing team (never provisioned / renamed) is NOT a token scope
    # problem — the probe must treat it as a skip-pass, not a failure.
    def boom(*a, **k):
        raise _http_error(404)

    monkeypatch.setattr(pt, "http_get", boom)
    check = pt.check_classroom_team("https://api", "cs50", "tok", "cs1", "classroom50-cs1")
    assert check.ok is True
    assert check.skipped is True


def test_team_members_403_fails(monkeypatch):
    # A 403 (as opposed to 404) means the token genuinely can't read the team —
    # the visibility/secret-team gap the org-members proxy can miss. Fail.
    def boom(*a, **k):
        raise _http_error(403)

    monkeypatch.setattr(pt, "http_get", boom)
    check = pt.check_classroom_team("https://api", "cs50", "tok", "cs1", "classroom50-cs1")
    assert check.ok is False
    assert check.skipped is False


# main() exit-code contract ---------------------------------------------------


def _set_env(monkeypatch, tmp_path, *, org="cs50", token="tok"):
    monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", org)
    monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", token)
    monkeypatch.setenv("GITHUB_WORKSPACE", str(tmp_path))
    monkeypatch.delenv("GH_API_URL", raising=False)
    monkeypatch.delenv("GITHUB_API_URL", raising=False)


def test_main_missing_org_exits_1(monkeypatch, tmp_path, capsys):
    _set_env(monkeypatch, tmp_path)
    monkeypatch.setenv("GITHUB_REPOSITORY_OWNER", "")
    assert pt.main() == 1
    assert "GITHUB_REPOSITORY_OWNER" in capsys.readouterr().err


def test_main_missing_token_exits_1(monkeypatch, tmp_path, capsys):
    _set_env(monkeypatch, tmp_path)
    monkeypatch.setenv("CLASSROOM50_SERVICE_TOKEN", "")
    assert pt.main() == 1
    assert "CLASSROOM50_SERVICE_TOKEN" in capsys.readouterr().err


def test_main_all_scopes_pass_exits_0(monkeypatch, tmp_path, capsys):
    _set_env(monkeypatch, tmp_path)
    # No classroom dirs -> per-team reads skipped; org/config checks all pass.
    monkeypatch.setattr(
        pt, "http_get", lambda url, token, **k: (200, json.dumps({"permissions": {"push": True}}).encode())
    )
    assert pt.main() == 0
    err = capsys.readouterr().err
    assert "PASSED" in err


def test_main_missing_members_scope_exits_1(monkeypatch, tmp_path, capsys):
    _set_env(monkeypatch, tmp_path)

    def selective(url, token, **k):
        # Members probe 403s; everything else is fine.
        if "/members" in url and "/teams/" not in url:
            raise _http_error(403)
        return (200, json.dumps({"permissions": {"push": True}}).encode())

    monkeypatch.setattr(pt, "http_get", selective)
    assert pt.main() == 1
    err = capsys.readouterr().err
    assert "FAILED" in err and "Members" in err


def test_main_no_student_repos_is_pass(monkeypatch, tmp_path, capsys):
    # A classroom with a resolvable team but no repos: the team read passes,
    # and the run exits 0 (no student-repo dependency to fail on).
    cs = tmp_path / "cs1"
    cs.mkdir()
    cs.joinpath("classroom.json").write_text(
        json.dumps({"schema": pt.CLASSROOM_SCHEMA_V1, "team": {"slug": "classroom50-cs1"}})
    )
    _set_env(monkeypatch, tmp_path)
    monkeypatch.setattr(
        pt, "http_get", lambda url, token, **k: (200, json.dumps({"permissions": {"push": True}}).encode())
    )
    assert pt.main() == 0
    assert "PASSED" in capsys.readouterr().err
