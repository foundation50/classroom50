"""Tests for ensure_feedback_pr.py — the Feedback PR maintainer the
autograde-runner fetches from Pages (like runner.py) and runs.

The script routes every GitHub call through the module-level `gh()`, so these
tests monkeypatch that single seam with a fake that dispatches on the `gh`
argument tuple, then assert the (state, description, url) the orchestrator
returns and the status it emits. Covers the branch matrix the former inline bash
couldn't test: empty base -> create + open; wrong base -> failure, no PR; no PR
-> create; create race lost -> re-query success; existing open -> in place;
closed-unmerged -> reopen (and failed-reopen -> failure, the F8 fix); merged ->
leave; HEAD_BRANCH lookup failure -> error status (the F3 fix).
"""

from __future__ import annotations

import json

import pytest

from conftest import _SCRIPTS_DIR, _load_module

efp = _load_module("ensure_feedback_pr", _SCRIPTS_DIR / "ensure_feedback_pr.py")

REPO = "cs50/cs-principles-hello-alice"
SHA = "deadbeef" * 5
BASE_SHA = "a" * 40
SERVER = "https://github.com"
RUN_ID = "12345"


def _pr_list_json(number="", state="", merged=""):
    """A `gh pr list --json number,state,mergedAt` array (find_pr parses JSON)."""
    if number == "":
        return "[]"
    return json.dumps([{"number": int(number), "state": state, "mergedAt": merged}])


class FakeGh:
    """A stub for efp.gh. Routes calls by a key built from the gh subcommand +
    a few distinguishing args; returns scripted output or raises GhError.
    Records every call for assertions.
    """

    def __init__(self, responses: dict[str, object]):
        self._responses = responses
        self.calls: list[tuple[str, ...]] = []

    def _key(self, args: tuple[str, ...]) -> str:
        # First 2 args, plus the api path or pr number where it disambiguates.
        if args[0] == "api":
            path = args[1]
            if path.startswith(f"repos/{REPO}/git/ref/heads/"):
                return "base_sha"
            if path.endswith("/git/refs"):
                return "create_base"
            if "/statuses/" in path:
                return "status"
        if args[0] == "repo" and args[1] == "view":
            return "head_branch"
        if args[0] == "pr":
            if args[1] == "list":
                # Disambiguate find_pr (--json number,state,mergedAt) from
                # existing_pr_url (--json url) so the race-recovery query can
                # be driven through the stub, not monkeypatched out.
                return "pr_list_url" if "url" in args else "pr_list"
            return f"pr_{args[1]}"
        if args[0] == "label":
            return "label"
        return args[0]

    def __call__(self, *args: str, check: bool = True) -> str:
        self.calls.append(args)
        key = self._key(args)
        resp = self._responses.get(key, "")
        if isinstance(resp, Exception):
            if check:
                raise resp
            return ""
        return resp  # type: ignore[return-value]

    def made(self, prefix: str) -> bool:
        """Did any recorded call start with these tokens?"""
        return any(c[:len(prefix.split())] == tuple(prefix.split()) for c in self.calls)


def _run(monkeypatch, responses):
    fake = FakeGh(responses)
    monkeypatch.setattr(efp, "gh", fake)
    state, desc, url = efp.ensure_feedback_pr(REPO, BASE_SHA, "individual", SERVER, RUN_ID)
    return fake, state, desc, url


def _absent():
    """A base_sha stub that mimics `gh api` 404 (branch absent)."""
    return efp.GhError(["api", "git/ref"], 1, "gh: Not Found (HTTP 404)")


def test_no_base_no_pr_creates_both(monkeypatch):
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": _absent(),                # 404 -> branch absent
        "create_base": "",                    # creation succeeds
        "pr_list": "[]",                      # no existing PR
        "pr_create": "https://github.com/cs50/x/pull/1",
    })
    assert state == "success"
    assert desc == "Feedback PR opened"
    assert url == "https://github.com/cs50/x/pull/1"
    assert fake.made("api -X POST")           # created the base
    assert fake.made("pr create")


def test_wrong_base_refuses_and_fails(monkeypatch):
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": "b" * 40,                 # poisoned base at the wrong sha
    })
    assert state == "failure"
    assert "wrong commit" in desc
    # Must NOT create or touch a PR against an unverified base.
    assert not fake.made("pr create")
    assert not fake.made("pr list")


def test_base_check_transient_error_does_not_open_pr(monkeypatch):
    # Adversarial finding: a NON-404 error on the base existence check must
    # NOT be treated as "absent" (which would create over / open a PR against
    # an unverified, possibly poisoned base). It must raise -> main() reports
    # error and NO PR is created.
    fake = FakeGh({
        "head_branch": "main",
        "base_sha": efp.GhError(["api", "git/ref"], 1, "gh: HTTP 403 (rate limited)"),
    })
    monkeypatch.setattr(efp, "gh", fake)
    with pytest.raises(efp.GhError):
        efp.ensure_feedback_pr(REPO, BASE_SHA, "individual", SERVER, RUN_ID)
    assert not fake.made("api -X POST")       # did NOT create over the base
    assert not fake.made("pr create")
    # And main() turns that into an error status, never a false success.
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    monkeypatch.setenv("GITHUB_SHA", SHA)
    monkeypatch.setenv("BASE_SHA", BASE_SHA)
    monkeypatch.setenv("GITHUB_SERVER_URL", SERVER)
    monkeypatch.setenv("GITHUB_RUN_ID", RUN_ID)
    fake2 = FakeGh({
        "head_branch": "main",
        "base_sha": efp.GhError(["api", "git/ref"], 1, "gh: HTTP 500"),
        "status": "",
    })
    monkeypatch.setattr(efp, "gh", fake2)
    assert efp.main() == 0
    status = [c for c in fake2.calls if c[0] == "api" and "/statuses/" in c[1]]
    assert status and any("state=error" in c for c in status[-1])


def test_existing_open_pr_left_in_place(monkeypatch):
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": BASE_SHA,                 # base already correct
        "pr_list": _pr_list_json("7", "OPEN", ""),
    })
    assert state == "success"
    assert desc == "Feedback PR in place"
    assert url.endswith("/pull/7")
    assert not fake.made("pr create")
    assert not fake.made("pr reopen")


def test_closed_unmerged_pr_reopened(monkeypatch):
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": BASE_SHA,
        "pr_list": _pr_list_json("7", "CLOSED", ""),  # closed, empty mergedAt
        "pr_reopen": "",
        "pr_view": "OPEN",                    # reopen took
    })
    assert state == "success"
    assert desc == "Feedback PR reopened"
    assert fake.made("pr reopen 7")


def test_failed_reopen_reports_failure(monkeypatch):
    # F8: a reopen that genuinely errors must NOT report success.
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": BASE_SHA,
        "pr_list": _pr_list_json("7", "CLOSED", ""),
        "pr_reopen": efp.GhError(["pr", "reopen"], 1, "not allowed"),
    })
    assert state == "failure"
    assert "reopen" in desc


def test_reopen_transient_view_still_success(monkeypatch):
    # Adversarial finding: reopen SUCCEEDS but the follow-up `pr view` returns
    # "" transiently. That must NOT flip a reopened PR to a false failure —
    # only a CONFIRMED still-CLOSED state downgrades to failure.
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": BASE_SHA,
        "pr_list": _pr_list_json("7", "CLOSED", ""),
        "pr_reopen": "",                      # reopen did not error
        "pr_view": "",                        # transient empty view
    })
    assert state == "success"
    assert desc == "Feedback PR reopened"


def test_merged_pr_left_alone(monkeypatch):
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": BASE_SHA,
        "pr_list": _pr_list_json("7", "MERGED", "2026-06-01T00:00:00Z"),
    })
    assert state == "success"
    assert desc == "Feedback PR in place"
    assert not fake.made("pr reopen")


def test_create_race_lost_recovers_to_success(monkeypatch):
    # Driven entirely through FakeGh (no monkeypatching existing_pr_url): the
    # find_pr `pr list` sees none, create 422s, and the recovery `pr list
    # --json url` (keyed pr_list_url) returns the concurrently-created PR.
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": _absent(),
        "create_base": "",
        "pr_list": "[]",                      # find_pr: none
        "pr_create": efp.GhError(["pr", "create"], 1, "already exists"),
        "pr_list_url": "https://github.com/cs50/x/pull/9",  # recovery query
    })
    assert state == "success"
    assert "concurrently" in desc
    assert url.endswith("/pull/9")
    assert fake.made("pr list")               # the recovery query really ran


def test_create_base_failure_still_opens_pr(monkeypatch):
    # create_base failing (non-fatal notice) must still proceed to open the PR.
    fake, state, desc, url = _run(monkeypatch, {
        "head_branch": "main",
        "base_sha": _absent(),
        "create_base": efp.GhError(["api"], 1, "transient"),
        "pr_list": "[]",
        "pr_create": "https://github.com/cs50/x/pull/3",
    })
    assert state == "success"
    assert desc == "Feedback PR opened"


def test_create_failure_no_race_reports_error(monkeypatch):
    fake = FakeGh({
        "head_branch": "main",
        "base_sha": _absent(),
        "create_base": "",
        "pr_list": "[]",                      # find_pr: none; recovery: none
        "pr_list_url": "",                    # no race winner
        "pr_create": efp.GhError(["pr", "create"], 1, "not permitted to create pull requests"),
    })
    monkeypatch.setattr(efp, "gh", fake)
    state, desc, url = efp.ensure_feedback_pr(REPO, BASE_SHA, "individual", SERVER, RUN_ID)
    assert state == "error"
    assert "org Actions-PR setting off" in desc
    assert url.endswith(f"/actions/runs/{RUN_ID}")


def test_head_branch_failure_yields_error_status(monkeypatch):
    # F3: if the very first lookup fails, main() must still post an `error`
    # status (the former inline bash aborted before its trap was armed).
    fake = FakeGh({"head_branch": efp.GhError(["repo", "view"], 1, "boom")})
    monkeypatch.setattr(efp, "gh", fake)
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    monkeypatch.setenv("GITHUB_SHA", SHA)
    monkeypatch.setenv("BASE_SHA", BASE_SHA)
    monkeypatch.setenv("GITHUB_SERVER_URL", SERVER)
    monkeypatch.setenv("GITHUB_RUN_ID", RUN_ID)
    monkeypatch.setenv("MODE", "individual")
    rc = efp.main()
    assert rc == 0
    # A status was posted, and it was the error default.
    status_calls = [c for c in fake.calls if c[0] == "api" and "/statuses/" in c[1]]
    assert status_calls, "expected a feedback-pr status to be posted"
    assert any("state=error" in c for c in status_calls[-1])


def test_main_missing_env_exits_nonzero(monkeypatch):
    for var in ("GITHUB_REPOSITORY", "GITHUB_SHA", "BASE_SHA"):
        monkeypatch.delenv(var, raising=False)
    assert efp.main() == 1


@pytest.mark.parametrize("mode, want_label", [
    ("group", "Group Assignment"),
    ("individual", "Individual Assignment"),
    ("", "Individual Assignment"),
    ("GROUP", "Group Assignment"),
    (None, "Individual Assignment"),
])
def test_label_for_mode(mode, want_label):
    label, color = efp.label_for_mode(mode)
    assert label == want_label
    assert color in ("5319E7", "0E8A16")


def test_pr_body_mentions_head_and_base(monkeypatch):
    body = efp.pr_body("main")
    assert "`main`" in body
    assert f"`{efp.BASE_BRANCH}`" in body
    assert "Classroom 50" in body


@pytest.mark.parametrize("out, want", [
    ("[]", None),                                                  # no PR
    ("", None),                                                    # empty output (gh error)
    ('[{"number": 7, "state": "OPEN", "mergedAt": ""}]',
     {"number": "7", "state": "OPEN", "mergedAt": ""}),
    ('[{"number": 7, "state": "MERGED", "mergedAt": "2026-01-01T00:00:00Z"}]',
     {"number": "7", "state": "MERGED", "mergedAt": "2026-01-01T00:00:00Z"}),
    ('[{"number": null}]', None),                                  # no number -> no PR
    ("not json", None),                                            # malformed -> no PR (no phantom)
    ('{"number": 7}', None),                                       # object, not array -> no PR
])
def test_find_pr_parses_json_not_tsv(monkeypatch, out, want):
    # Regression for the phantom-PR bug: a strip()+split('\t') on a leading-
    # empty TSV field fabricated a PR numbered "OPEN". JSON parsing can't.
    monkeypatch.setattr(efp, "gh", lambda *a, check=True: out)
    assert efp.find_pr(REPO, "main") == want


def test_main_posts_success_status(monkeypatch):
    # main() must post a success feedback-pr status carrying the PR url when
    # the orchestrator succeeds (only F3's error path was previously covered).
    fake = FakeGh({
        "head_branch": "main",
        "base_sha": BASE_SHA,
        "pr_list": _pr_list_json("7", "OPEN", ""),
        "status": "",
    })
    monkeypatch.setattr(efp, "gh", fake)
    for k, v in {
        "GITHUB_REPOSITORY": REPO, "GITHUB_SHA": SHA, "BASE_SHA": BASE_SHA,
        "GITHUB_SERVER_URL": SERVER, "GITHUB_RUN_ID": RUN_ID, "MODE": "individual",
    }.items():
        monkeypatch.setenv(k, v)
    assert efp.main() == 0
    status = [c for c in fake.calls if c[0] == "api" and "/statuses/" in c[1]]
    assert status, "expected a feedback-pr status to be posted"
    assert any("state=success" in c for c in status[-1])
    assert any("/pull/7" in c for c in status[-1])


def test_emit_status_swallows_gh_error(monkeypatch):
    # emit_status is best-effort: a failing status POST must not raise.
    monkeypatch.setattr(efp, "gh", lambda *a, **k: (_ for _ in ()).throw(
        efp.GhError(list(a), 1, "boom")))
    efp.emit_status(REPO, SHA, "success", "ok", "https://x/pull/1")  # no raise
