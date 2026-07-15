"""Tests for the runner-side bootstrap (`runner.py`).

The runner (1) downloads + extracts the per-assignment bundle, (2) resolves the
entrypoint (per-assignment override, classroom default, or vacuous-pass
fallback), (3) execs it with the right env/cwd, and (4) validates/synthesizes
the autograder's outputs. These cover the data-shape invariants the loop
depends on plus the URL helpers and HTTP retry logic.

Integration testing of the diagnostic-stub autograder.py (shipped inside
gh-teacher) lives in test_default_autograder.py (subprocess-driven).
"""

from __future__ import annotations

import datetime
import io
import json
import pathlib
import subprocess
import tarfile
import urllib.error

import pytest

from conftest import runner as ag, collect_scores as cs

# Repo root: this file is cli/gh-teacher/autograders_tests/test_runner.py.
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]


# ---------------------------------------------------------------------------
# username_from_repo
# ---------------------------------------------------------------------------


class TestUsernameFromRepo:
    def test_canonical_repo_strips_classroom_assignment_prefix(self):
        # Repo name is `<classroom>-<assignment>-<username>`
        # (lowercased by gh student accept). Strip the prefix.
        assert ag.username_from_repo(
            "cs50/cs-principles-hello-alice",
            "cs-principles",
            "hello",
            "alice",
        ) == "alice"

    def test_case_insensitive_prefix_match(self):
        assert ag.username_from_repo(
            "cs50/cs-principles-hello-alice",
            "CS-Principles",
            "Hello",
            "fallback",
        ) == "alice"

    def test_repo_without_prefix_falls_back_to_actor(self):
        assert ag.username_from_repo(
            "cs50/some-other-repo",
            "cs-principles",
            "hello",
            "fallback-actor",
        ) == "fallback-actor"

    def test_repository_without_slash_is_treated_as_bare_repo(self):
        assert ag.username_from_repo(
            "cs-principles-hello-alice",
            "cs-principles",
            "hello",
            "actor",
        ) == "alice"

    def test_empty_repository_falls_back_to_actor(self):
        assert ag.username_from_repo("", "cs-principles", "hello", "actor") == "actor"

    def test_username_with_hyphens_preserved(self):
        # Usernames can contain hyphens; only the prefix is stripped.
        assert ag.username_from_repo(
            "cs50/cs-principles-hello-alice-the-second",
            "cs-principles",
            "hello",
            "fallback",
        ) == "alice-the-second"

    def test_shared_fixture_parity(self):
        # Same golden cases the Go contract test asserts, so the naming formula
        # and this mirror can't drift: recover each fixture owner by stripping
        # the <classroom>-<assignment>- prefix from the fixture repo name.
        fixture = (_REPO_ROOT / "cli" / "shared" / "testdata"
                   / "assignment_repo_name_cases.json")
        cases = json.loads(fixture.read_text())["cases"]
        assert cases, "shared fixture has no cases"
        for case in cases:
            assert ag.username_from_repo(
                f"owner/{case['name']}",
                case["classroom"],
                case["assignment"],
                "fallback",
            ) == case["owner"], case["name"]


# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------


class TestUrlConstruction:
    def test_bundle_url_basic(self):
        assert ag.bundle_url(
            "https://cs50.github.io/classroom50", "cs-principles", "hello"
        ) == "https://cs50.github.io/classroom50/cs-principles/autograders/hello.tar.gz"

    def test_bundle_url_url_encodes_segments(self):
        # Slug + classroom validation upstream limits both to
        # [a-z0-9-]; defensive URL-encoding catches any hand-edit
        # that smuggles other chars through.
        assert ag.bundle_url(
            "https://cs50.github.io/classroom50", "cs principles", "hello world"
        ) == "https://cs50.github.io/classroom50/cs%20principles/autograders/hello%20world.tar.gz"

    def test_classroom_default_autograder_url(self):
        # The classroom default lives under the classroom's prefix on
        # Pages — one fetch per submission when no per-assignment
        # override is in the bundle. Different classrooms can have
        # different defaults.
        assert ag.classroom_default_autograder_url(
            "https://cs50.github.io/classroom50",
            "cs-principles",
        ) == "https://cs50.github.io/classroom50/cs-principles/autograder.py"

    def test_classroom_default_autograder_url_quotes_classroom(self):
        # Classroom names with characters that need URL-escaping must
        # round-trip safely (defense in depth — validateShortName
        # blocks most of these at write time).
        assert ag.classroom_default_autograder_url(
            "https://cs50.github.io/classroom50",
            "cs principles",
        ) == "https://cs50.github.io/classroom50/cs%20principles/autograder.py"

    def test_bundle_url_with_secret(self):
        # A protected classroom inserts the capability-URL segment between
        # the classroom and the resource. Must match publish-pages.yaml's
        # <classroom>/<secret>/autograders/<slug>.tar.gz layout exactly.
        assert ag.bundle_url(
            "https://cs50.github.io/classroom50", "cs-principles", "hello", "abc123"
        ) == "https://cs50.github.io/classroom50/cs-principles/abc123/autograders/hello.tar.gz"

    def test_bundle_url_empty_secret_is_plain_path(self):
        # An empty secret (unprotected classroom, the default) must
        # produce exactly the legacy path — disabling the feature is a
        # true no-op.
        assert ag.bundle_url(
            "https://cs50.github.io/classroom50", "cs-principles", "hello", ""
        ) == ag.bundle_url(
            "https://cs50.github.io/classroom50", "cs-principles", "hello"
        )

    def test_classroom_default_autograder_url_with_secret(self):
        assert ag.classroom_default_autograder_url(
            "https://cs50.github.io/classroom50", "cs-principles", "abc123",
        ) == "https://cs50.github.io/classroom50/cs-principles/abc123/autograder.py"

    def test_commit_url(self):
        assert ag.commit_url(
            "https://github.com", "cs50/cs-principles-hello-alice", "abc123"
        ) == "https://github.com/cs50/cs-principles-hello-alice/commit/abc123"

    def test_release_url_encodes_submit_slash(self):
        # The submit tag's '/' must be URL-encoded so GitHub's
        # release path resolves correctly.
        result = ag.release_url(
            "https://github.com",
            "cs50/cs-principles-hello-alice",
            "submit/2026-06-01T14-32-05Z",
        )
        assert "submit%2F2026-06-01T14-32-05Z" in result
        assert "/releases/tag/" in result

    def test_compare_url(self):
        assert ag.compare_url(
            "https://github.com", "cs50/cs-principles-hello-alice", "base1", "head2"
        ) == "https://github.com/cs50/cs-principles-hello-alice/compare/base1...head2"

    def test_review_url_is_full_diff_when_baseline_known(self):
        assert ag.review_url(
            "https://github.com", "cs50/cs-principles-hello-alice", "base1", "head2"
        ) == "https://github.com/cs50/cs-principles-hello-alice/compare/base1...head2"

    def test_review_url_falls_back_to_commit_view_without_baseline(self):
        # No usable history -> degrade to the commit view.
        assert ag.review_url(
            "https://github.com", "cs50/cs-principles-hello-alice", None, "head2"
        ) == "https://github.com/cs50/cs-principles-hello-alice/commit/head2"

    def test_review_url_falls_back_when_baseline_is_head(self):
        # base == head renders an empty diff on GitHub.
        assert ag.review_url(
            "https://github.com", "cs50/cs-principles-hello-alice", "same", "same"
        ) == "https://github.com/cs50/cs-principles-hello-alice/commit/same"


# ---------------------------------------------------------------------------
# baseline_sha
# ---------------------------------------------------------------------------


def _git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo),
         "-c", "user.name=t", "-c", "user.email=t@example.com",
         *args],
        capture_output=True, text=True, check=True,
    )


# The accept commit is identified by the file it adds
# (ag.ACCEPT_MARKER_PATH), not its subject. The marker `"accept"` in a
# `_make_repo` spec means "this commit adds the marker file"; everything
# else is a plain commit touching an unrelated file.
ACCEPT = "accept"


def _make_repo(path, specs):
    """A real git repo with one commit per spec. A spec of ACCEPT adds
    `.classroom50.yaml` (the structural accept marker); any other value
    is used as the commit subject and touches an unrelated file. Returns
    the SHAs in commit order (oldest first)."""
    path.mkdir()
    _git(path, "init", "-q", "-b", "main")
    shas = []
    for i, spec in enumerate(specs):
        if spec == ACCEPT:
            (path / ag.ACCEPT_MARKER_PATH).write_text("classroom: x\n")
            subject = "Accept whatever/the-client-wants"
        else:
            (path / f"f{i}.txt").write_text(f"{i}\n")
            subject = spec
        _git(path, "add", "-A")
        _git(path, "commit", "-q", "-m", subject)
        shas.append(_git(path, "rev-parse", "HEAD").stdout.strip())
    return shas


class TestBaselineSha:
    def test_accept_marker_history_baselines_at_accept_commit(self, tmp_path):
        # Canonical history: template commit, accept commit (adds
        # .classroom50.yaml), submissions. Baseline = accept commit so
        # the plumbing files don't diff as student work.
        shas = _make_repo(tmp_path / "repo", [
            "Initial commit",
            ACCEPT,
            "Submit hello",
            "Submit hello",
        ])
        assert ag.baseline_sha(tmp_path / "repo") == shas[1]

    def test_accept_commit_subject_is_irrelevant(self, tmp_path):
        # The baseline is found by the added .classroom50.yaml, NOT the
        # commit subject. A repo whose accept commit carries an arbitrary
        # subject (e.g. the web GUI's "Accept <classroom>/<assignment>")
        # still baselines correctly -- _make_repo's ACCEPT spec already
        # uses a non-CLI subject.
        shas = _make_repo(tmp_path / "repo", [
            "Initial commit",
            ACCEPT,
            "Submit hello",
        ])
        assert ag.baseline_sha(tmp_path / "repo") == shas[1]

    def test_accept_commit_beyond_position_one_is_found(self, tmp_path):
        # Today the accept commit is usually second (template-generate
        # squashes the starter); the scan keeps working if a future
        # creation flow lands it later.
        shas = _make_repo(tmp_path / "repo", [
            "Initial commit",
            "Starter follow-up",
            ACCEPT,
            "Submit hello",
        ])
        assert ag.baseline_sha(tmp_path / "repo") == shas[2]

    def test_earliest_marker_add_wins(self, tmp_path):
        # If a student deletes then re-adds .classroom50.yaml later in
        # history, the EARLIEST add must win (a later re-add can't move
        # the baseline forward and hide work from the review diff).
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "main")
        (repo / "f0.txt").write_text("0\n")
        _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "Initial commit")
        # First add of the marker -- the real accept commit.
        (repo / ag.ACCEPT_MARKER_PATH).write_text("classroom: x\n")
        _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "Accept x/y")
        accept_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
        # Delete it, then re-add it -- a later re-add must NOT win.
        _git(repo, "rm", "-q", ag.ACCEPT_MARKER_PATH)
        _git(repo, "commit", "-q", "-m", "Submit (oops removed config)")
        (repo / ag.ACCEPT_MARKER_PATH).write_text("classroom: x\n")
        _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "Restore config")
        assert ag.baseline_sha(repo) == accept_sha

    def test_hand_created_repo_baselines_at_root_commit(self, tmp_path):
        # Hand-created repo without the accept marker -> root commit.
        shas = _make_repo(tmp_path / "repo", [
            "Initial commit",
            "Submit hello",
        ])
        assert ag.baseline_sha(tmp_path / "repo") == shas[0]

    def test_single_commit_repo_baselines_at_that_commit(self, tmp_path):
        # baseline == HEAD; review_url falls back to the commit view.
        shas = _make_repo(tmp_path / "repo", ["Initial commit"])
        assert ag.baseline_sha(tmp_path / "repo") == shas[0]

    def test_non_repo_returns_none(self, tmp_path):
        # Tarball-fallback checkout in git-less containers: no .git.
        (tmp_path / "plain").mkdir()
        assert ag.baseline_sha(tmp_path / "plain") is None

    def test_shallow_clone_is_deepened(self, tmp_path):
        # Older workflows check out at depth 1; baseline_sha must
        # unshallow or the graft boundary would pose as the root.
        shas = _make_repo(tmp_path / "src", [
            "Initial commit",
            ACCEPT,
            "Submit hello",
        ])
        clone = tmp_path / "clone"
        subprocess.run(
            ["git", "clone", "-q", "--depth", "1",
             f"file://{tmp_path / 'src'}", str(clone)],
            capture_output=True, text=True, check=True,
        )
        assert ag.baseline_sha(clone) == shas[1]


class TestIsAcceptanceCommit:
    # True only when the trusted accept commit is the tip; everything
    # uncertain fails open (False -> grade).

    def _head(self, path):
        return _git(path, "rev-parse", "HEAD").stdout.strip()

    def test_templated_repo_accept_commit_is_tip(self, tmp_path):
        # Templated repo, default branch main: squashed template + accept
        # on top -> accept commit is the tip.
        shas = _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT])
        assert ag.is_acceptance_commit(tmp_path / "repo", shas[1]) is True

    def test_submission_on_top_of_accept_grades(self, tmp_path):
        repo = tmp_path / "repo"
        shas = _make_repo(repo, ["Initial commit", ACCEPT, "Submit hello"])
        assert ag.is_acceptance_commit(repo, self._head(repo)) is False
        assert ag.is_acceptance_commit(repo, shas[1]) is True

    def test_template_less_auto_init_then_accept_is_tip(self, tmp_path):
        # auto_init README commit + accept on top -> accept commit is the tip.
        shas = _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT])
        assert ag.is_acceptance_commit(tmp_path / "repo", shas[1]) is True

    def test_empty_submit_right_after_accept_grades(self, tmp_path):
        # submit uses --allow-empty, so HEAD advances past accept.
        repo = tmp_path / "repo"
        _make_repo(repo, ["Initial commit", ACCEPT])
        _git(repo, "commit", "-q", "--allow-empty", "-m", "Submit hello")
        assert ag.is_acceptance_commit(repo, self._head(repo)) is False

    def test_non_main_default_first_main_submission_grades(self, tmp_path):
        # master-default template: accept on master (no run), first submit
        # creates main with a commit on top -> first run is a submission.
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "master")
        (repo / "starter.txt").write_text("x\n")
        _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "Initial commit")
        (repo / ag.ACCEPT_MARKER_PATH).write_text("classroom: x\n")
        _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "Accept x/y")
        _git(repo, "checkout", "-q", "-b", "main")
        _git(repo, "commit", "-q", "--allow-empty", "-m", "Submit hello")
        assert ag.is_acceptance_commit(repo, self._head(repo)) is False

    def test_accept_commit_subject_is_irrelevant(self, tmp_path):
        # Detected by the added marker, not the subject (ACCEPT uses GUI wording).
        shas = _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT])
        assert ag.is_acceptance_commit(tmp_path / "repo", shas[1]) is True

    def test_root_commit_marker_repo_is_acceptance(self, tmp_path):
        # Root commit adds the marker -> it is the accept commit.
        shas = _make_repo(tmp_path / "repo", [ACCEPT])
        assert ag.is_acceptance_commit(tmp_path / "repo", shas[0]) is True

    def test_hand_created_repo_without_marker_grades(self, tmp_path):
        # No marker -> SOURCE_ROOT, not a trusted accept -> grade.
        shas = _make_repo(tmp_path / "repo", ["Initial commit"])
        assert ag.is_acceptance_commit(tmp_path / "repo", shas[0]) is False

    def test_re_added_marker_does_not_skip(self, tmp_path):
        # earliest-add-wins: a re-add can't move the accept commit to HEAD.
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "main")
        (repo / "f0.txt").write_text("0\n")
        _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "Initial commit")
        (repo / ag.ACCEPT_MARKER_PATH).write_text("classroom: x\n")
        _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "Accept x/y")
        _git(repo, "rm", "-q", ag.ACCEPT_MARKER_PATH)
        _git(repo, "commit", "-q", "-m", "Oops removed config")
        (repo / ag.ACCEPT_MARKER_PATH).write_text("classroom: x\n")
        _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "Restore config")
        assert ag.is_acceptance_commit(repo, self._head(repo)) is False

    def test_empty_head_sha_grades(self, tmp_path):
        _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT])
        assert ag.is_acceptance_commit(tmp_path / "repo", "") is False

    def test_non_repo_grades(self, tmp_path):
        # No history -> SOURCE_NONE -> grade.
        (tmp_path / "plain").mkdir()
        assert ag.is_acceptance_commit(tmp_path / "plain", "deadbeef") is False

    def test_git_error_grades(self, tmp_path, monkeypatch):
        # Unreadable history -> SOURCE_GIT_ERROR -> grade.
        _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT])
        head = self._head(tmp_path / "repo")
        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            if isinstance(cmd, (list, tuple)) and cmd[0] == "git":
                return subprocess.CompletedProcess(
                    cmd, 128, stdout="",
                    stderr="fatal: detected dubious ownership in repository",
                )
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", fake_run)
        assert ag.is_acceptance_commit(tmp_path / "repo", head) is False

    def test_accept_commit_with_extra_work_at_tip_grades(self, tmp_path):
        # Amended/squashed accept: the marker-introducing commit is the
        # tip AND adds real work. Skipping it would silently drop the
        # work, so the setup-files-only guard fails open -> grade.
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "main")
        (repo / ag.ACCEPT_MARKER_PATH).write_text("classroom: x\n")
        (repo / "solution.py").write_text("print('graded work')\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "Accept x/y (and sneak in work)")
        assert ag.is_acceptance_commit(repo, self._head(repo)) is False

    def test_accept_commit_adding_marker_and_workflow_is_acceptance(self, tmp_path):
        # The real accept commit lands BOTH setup paths atomically
        # (ACCEPT_COMMIT_PATHS); the guard must still treat that as
        # acceptance, not as extra work.
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "main")
        (repo / ag.ACCEPT_MARKER_PATH).write_text("classroom: x\n")
        wf = repo / ".github" / "workflows"
        wf.mkdir(parents=True)
        (wf / "autograde.yaml").write_text("name: Autograde\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", "Initialize .classroom50.yaml and autograde workflow")
        assert ag.is_acceptance_commit(repo, self._head(repo)) is True

    def test_setup_only_guard_git_error_grades(self, tmp_path, monkeypatch):
        # The accept commit is the tip, but reading its touched paths
        # errors -> fail open (grade) rather than skip on partial info.
        repo = tmp_path / "repo"
        shas = _make_repo(repo, ["Initial commit", ACCEPT])
        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            # Only the `git show` path-listing fails; _baseline_scan's
            # earlier calls succeed so we reach the guard.
            if (isinstance(cmd, (list, tuple)) and "show" in cmd
                    and "--name-only" in cmd):
                return subprocess.CompletedProcess(cmd, 128, stdout="", stderr="boom")
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", fake_run)
        assert ag.is_acceptance_commit(repo, shas[1]) is False
    # `runner.py --detect-acceptance`: writes is-acceptance to
    # $GITHUB_OUTPUT from cwd, always exits 0.
    def _run(self, repo, head_sha, tmp_path, monkeypatch):
        out = tmp_path / "ghout"
        out.write_text("")
        monkeypatch.chdir(repo)
        monkeypatch.setenv("GITHUB_SHA", head_sha)
        monkeypatch.setenv("GITHUB_OUTPUT", str(out))
        rc = ag.detect_acceptance_mode()
        return rc, out.read_text()

    def test_acceptance_commit_emits_true(self, tmp_path, monkeypatch):
        repo = tmp_path / "repo"
        shas = _make_repo(repo, ["Initial commit", ACCEPT])
        rc, text = self._run(repo, shas[1], tmp_path, monkeypatch)
        assert rc == 0
        assert "is-acceptance=true\n" in text

    def test_submission_emits_false(self, tmp_path, monkeypatch):
        repo = tmp_path / "repo"
        _make_repo(repo, ["Initial commit", ACCEPT, "Submit hello"])
        head = _git(repo, "rev-parse", "HEAD").stdout.strip()
        rc, text = self._run(repo, head, tmp_path, monkeypatch)
        assert rc == 0
        assert "is-acceptance=false\n" in text

    def test_main_dispatches_on_flag(self, tmp_path, monkeypatch):
        # The flag short-circuits before main()'s env checks.
        repo = tmp_path / "repo"
        shas = _make_repo(repo, ["Initial commit", ACCEPT])
        out = tmp_path / "ghout"
        out.write_text("")
        monkeypatch.chdir(repo)
        monkeypatch.setenv("GITHUB_SHA", shas[1])
        monkeypatch.setenv("GITHUB_OUTPUT", str(out))
        monkeypatch.setattr(ag.sys, "argv", ["runner.py", "--detect-acceptance"])
        assert ag.main() == 0
        assert "is-acceptance=true\n" in out.read_text()

    def test_no_output_path_does_not_crash(self, tmp_path, monkeypatch):
        repo = tmp_path / "repo"
        shas = _make_repo(repo, ["Initial commit", ACCEPT])
        monkeypatch.chdir(repo)
        monkeypatch.setenv("GITHUB_SHA", shas[1])
        monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
        assert ag.detect_acceptance_mode() == 0


class TestFeedbackBaseOutcome:
    # feedback_base_outcome returns (sha, source) in one scan so main()
    # can freeze the PR base AND choose the annotation. "accept"/"root"
    # yield a non-None sha (both open the PR); "git-error"/"none" yield
    # None (both skip).
    def test_accept_marker_yields_sha_and_accept_source(self, tmp_path):
        shas = _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT, "Submit"])
        assert ag.feedback_base_outcome(tmp_path / "repo") == (shas[1], "accept")

    def test_marker_absent_yields_root_sha_and_root_source(self, tmp_path):
        # The root commit is an openable base (with an untrusted warning),
        # so it returns a non-None sha.
        shas = _make_repo(tmp_path / "repo", ["Initial commit", "Submit"])
        assert ag.feedback_base_outcome(tmp_path / "repo") == (shas[0], "root")

    def test_non_repo_yields_none_and_none_source(self, tmp_path):
        (tmp_path / "plain").mkdir()
        assert ag.feedback_base_outcome(tmp_path / "plain") == (None, "none")

    def test_git_failure_yields_none_and_git_error_source(self, tmp_path, monkeypatch):
        # Dubious-ownership case: a real repo git refuses to read. sha is
        # None (skip), source is "git-error".
        _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT])
        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            if isinstance(cmd, (list, tuple)) and cmd[0] == "git":
                return subprocess.CompletedProcess(
                    cmd, 128, stdout="",
                    stderr="fatal: detected dubious ownership in repository",
                )
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", fake_run)
        assert ag.feedback_base_outcome(tmp_path / "repo") == (None, "git-error")


class TestNoBaselineWarning:
    # The Feedback-PR-skip message is a GitHub *workflow annotation*, not
    # a plain log line -- the `::warning::` prefix is what routes it to
    # the annotation stream so a skipped PR is diagnosable without
    # scraping job logs. A regression in that prefix silently degrades it
    # back to an unscannable log line, so pin the prefix and the content.
    def test_is_a_github_warning_annotation(self):
        assert ag.no_baseline_warning().startswith(
            "::warning title=classroom50 Feedback PR::"
        )

    def test_git_error_source_is_also_a_warning_annotation(self):
        assert ag.no_baseline_warning("git-error").startswith(
            "::warning title=classroom50 Feedback PR::"
        )

    def test_names_the_marker_path_for_git_error(self):
        # "none" names the marker; "git-error" intentionally doesn't (it's
        # about git failing, not a missing file).
        assert ag.ACCEPT_MARKER_PATH not in ag.no_baseline_warning("none")
        assert "could not read git history" in ag.no_baseline_warning("git-error")

    def test_none_source_reports_no_git_history(self):
        # "none" = not a git repository; no commit to anchor a base. Must
        # NOT claim a commit "added" the marker.
        msg = ag.no_baseline_warning("none")
        assert "no git history found" in msg
        assert "accept flow" in msg

    def test_git_error_does_not_blame_a_missing_accept_commit(self):
        # A git failure must NOT claim the accept commit is missing -- the
        # baseline may exist; git just couldn't read it.
        msg = ag.no_baseline_warning("git-error")
        assert "could not read git history" in msg
        assert "not a git repository" not in msg

    def test_is_a_single_line(self):
        # An embedded newline would split the annotation, breaking the
        # `::warning::` parse.
        assert "\n" not in ag.no_baseline_warning()
        assert "\n" not in ag.no_baseline_warning("git-error")


class TestUntrustedBaselineWarning:
    # Emitted when the Feedback PR opened against the root commit (no
    # accept commit detected) -- a heads-up, not a skip.
    def test_is_a_github_warning_annotation(self):
        assert ag.untrusted_baseline_warning().startswith(
            "::warning title=classroom50 Feedback PR::"
        )

    def test_signals_opened_against_root_and_untrusted(self):
        msg = ag.untrusted_baseline_warning()
        assert "root commit" in msg
        assert "UNTRUSTED" in msg
        # Must NOT say the step skipped -- the PR opened.
        assert "skip" not in msg.lower()

    def test_names_the_marker_path(self):
        assert ag.ACCEPT_MARKER_PATH in ag.untrusted_baseline_warning()

    def test_is_a_single_line(self):
        assert "\n" not in ag.untrusted_baseline_warning()


class TestBaselineScanSource:
    # _baseline_scan returns (sha, source); source drives both the
    # feedback base and main()'s annotation. These pin the discriminator
    # directly.
    def test_accept_marker_source_is_accept(self, tmp_path):
        shas = _make_repo(tmp_path / "repo", [
            "Initial commit",
            ACCEPT,
            "Submit hello",
        ])
        assert ag._baseline_scan(tmp_path / "repo") == (shas[1], "accept")

    def test_no_marker_source_is_root(self, tmp_path):
        shas = _make_repo(tmp_path / "repo", [
            "Initial commit",
            "Submit hello",
        ])
        assert ag._baseline_scan(tmp_path / "repo") == (shas[0], "root")

    def test_failed_marker_query_yields_git_error_not_root(self, tmp_path, monkeypatch):
        # A failed marker query must surface as "git-error", NOT degrade
        # to "root" -- git-error skips the PR, "root" would open it
        # against the wrong commit and mislabel the cause. Fail only the
        # --diff-filter=A query; let other git calls pass.
        shas = _make_repo(tmp_path / "repo", [
            "Initial commit",
            ACCEPT,
            "Submit hello",
        ])
        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            if isinstance(cmd, (list, tuple)) and "--diff-filter=A" in cmd:
                return subprocess.CompletedProcess(cmd, 128, stdout="", stderr="boom")
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", fake_run)
        assert ag._baseline_scan(tmp_path / "repo") == (None, ag.SOURCE_GIT_ERROR)
        assert ag.feedback_base_outcome(tmp_path / "repo") == (None, ag.SOURCE_GIT_ERROR)

    def test_git_error_when_rev_parse_fails(self, tmp_path, monkeypatch):
        # Dubious-ownership case: git and the repo are real, but every
        # git command exits non-zero. The first call (rev-parse --git-dir)
        # fails with a non-"not a git repository" error, so the scan must
        # report SOURCE_GIT_ERROR.
        shas = _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT])
        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            if isinstance(cmd, (list, tuple)) and cmd[0] == "git":
                return subprocess.CompletedProcess(
                    cmd, 128, stdout="",
                    stderr="fatal: detected dubious ownership in repository",
                )
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", fake_run)
        assert ag._baseline_scan(tmp_path / "repo") == (None, ag.SOURCE_GIT_ERROR)
        assert ag.feedback_base_outcome(tmp_path / "repo") == (None, ag.SOURCE_GIT_ERROR)

    def test_git_calls_pass_safe_directory(self, tmp_path, monkeypatch):
        # Every git invocation must carry `-c safe.directory=*` so
        # baseline resolution works inside a container where git's
        # dubious-ownership guard would otherwise fail every call.
        _make_repo(tmp_path / "repo", ["Initial commit", ACCEPT])
        seen = []
        real_run = subprocess.run

        def spy_run(cmd, *args, **kwargs):
            if isinstance(cmd, (list, tuple)) and cmd[0] == "git":
                seen.append(list(cmd))
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", spy_run)
        ag._baseline_scan(tmp_path / "repo")
        assert seen, "expected at least one git invocation"
        for cmd in seen:
            joined = " ".join(cmd)
            assert "safe.directory=*" in joined, f"missing safe.directory in: {joined}"


# ---------------------------------------------------------------------------
# empty_result
# ---------------------------------------------------------------------------


class TestActorIdentity:
    def test_returns_username_and_int_id(self, monkeypatch):
        monkeypatch.setenv("GITHUB_ACTOR", "bob")
        monkeypatch.setenv("GITHUB_ACTOR_ID", "222")
        assert ag.actor_identity() == {"username": "bob", "id": 222}

    def test_id_null_when_missing_or_nonnumeric(self, monkeypatch):
        monkeypatch.setenv("GITHUB_ACTOR", "bob")
        monkeypatch.delenv("GITHUB_ACTOR_ID", raising=False)
        assert ag.actor_identity() == {"username": "bob", "id": None}
        monkeypatch.setenv("GITHUB_ACTOR_ID", "not-a-number")
        assert ag.actor_identity() == {"username": "bob", "id": None}

    def test_returns_none_when_actor_absent(self, monkeypatch):
        monkeypatch.delenv("GITHUB_ACTOR", raising=False)
        assert ag.actor_identity() is None


class TestEmptyResult:
    WHEN = datetime.datetime(2026, 6, 1, 14, 33, 11, tzinfo=datetime.timezone.utc)

    BASE_KWARGS = dict(
        classroom="cs-principles",
        assignment="hello",
        username="alice",
        submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
        commit_link="https://github.com/cs50/cs-principles-hello-alice/commit/abc",
        release_link="https://github.com/cs50/cs-principles-hello-alice/releases/tag/submit%2F2026-06-01T14-32-05Z-a1b2c3d",
        assignment_type="individual",
    )

    def test_schema_and_identity_populated(self):
        result = ag.empty_result(when=self.WHEN, **self.BASE_KWARGS)
        assert result["schema"] == ag.RESULT_SCHEMA_V1
        assert result["classroom"] == "cs-principles"
        assert result["assignment"] == "hello"
        assert result["owner"] == "alice"
        assert result["assignment_type"] == "individual"
        assert result["submission"] == "submit/2026-06-01T14-32-05Z-a1b2c3d"

    def test_zero_scores_and_empty_tests(self):
        result = ag.empty_result(when=self.WHEN, **self.BASE_KWARGS)
        assert result["score"] == 0
        assert result["max-score"] == 0
        assert result["tests"] == []

    def test_review_url_defaults_to_commit_link(self):
        # No review_link (history unavailable) -> commit view.
        result = ag.empty_result(when=self.WHEN, **self.BASE_KWARGS)
        assert result["review"] == result["commit"]

    def test_review_link_used_when_provided(self):
        review = "https://github.com/cs50/cs-principles-hello-alice/compare/base...abc"
        result = ag.empty_result(when=self.WHEN, review_link=review, **self.BASE_KWARGS)
        assert result["review"] == review

    def test_datetime_formatted_as_utc_iso8601(self):
        result = ag.empty_result(when=self.WHEN, **self.BASE_KWARGS)
        assert result["datetime"] == "2026-06-01T14:33:11Z"

    def test_submitted_by_omitted_when_none(self):
        result = ag.empty_result(when=self.WHEN, **self.BASE_KWARGS)
        assert "submitted_by" not in result

    def test_submitted_by_included_when_provided(self):
        result = ag.empty_result(
            when=self.WHEN, submitted_by={"username": "bob", "id": 222}, **self.BASE_KWARGS
        )
        assert result["submitted_by"] == {"username": "bob", "id": 222}


class TestSubmissionVsGradedTime:
    """The submission time (`datetime`) is the graded commit's committer
    date — invariant across regrades; `graded_at` is the wall-clock instant
    grading ran — moves on every regrade. This is what keeps a teacher
    regrade from changing a student's submission time / late flag."""

    WHEN = datetime.datetime(2026, 6, 1, 14, 33, 11, tzinfo=datetime.timezone.utc)

    BASE_KWARGS = dict(
        classroom="cs-principles",
        assignment="hello",
        username="alice",
        submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
        commit_link="https://github.com/x/commit/abc",
        release_link="https://github.com/x/releases/tag/y",
        assignment_type="individual",
    )

    def test_graded_at_present_and_defaults_to_now(self, monkeypatch):
        fixed = datetime.datetime(2027, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)
        monkeypatch.setattr(ag, "now_utc", lambda: fixed)
        result = ag.empty_result(when=self.WHEN, **self.BASE_KWARGS)
        # datetime = submission instant (passed `when`); graded_at = now.
        assert result["datetime"] == "2026-06-01T14:33:11Z"
        assert result["graded_at"] == "2027-01-02T03:04:05Z"

    def test_graded_at_explicit_value_used(self):
        graded = datetime.datetime(2027, 5, 5, 5, 5, 5, tzinfo=datetime.timezone.utc)
        result = ag.make_result(
            when=self.WHEN,
            score=0,
            max_score=0,
            tests=[],
            graded_at=graded,
            **self.BASE_KWARGS,
        )
        assert result["datetime"] == "2026-06-01T14:33:11Z"
        assert result["graded_at"] == "2027-05-05T05:05:05Z"

    def test_regrade_invariant_datetime_stable_graded_at_moves(self, monkeypatch):
        # The core regrade promise: grading the SAME commit twice yields an
        # IDENTICAL `datetime` (the committer-date submission instant) while
        # `graded_at` moves to each run's wall clock. Asserting them together
        # guards against a regression that re-derives `datetime` from now_utc.
        first_now = datetime.datetime(2027, 1, 1, 0, 0, 0, tzinfo=datetime.timezone.utc)
        second_now = datetime.datetime(2027, 3, 3, 9, 9, 9, tzinfo=datetime.timezone.utc)

        monkeypatch.setattr(ag, "now_utc", lambda: first_now)
        first = ag.make_result(
            when=self.WHEN, score=0, max_score=0, tests=[], **self.BASE_KWARGS
        )
        monkeypatch.setattr(ag, "now_utc", lambda: second_now)
        second = ag.make_result(
            when=self.WHEN, score=0, max_score=0, tests=[], **self.BASE_KWARGS
        )

        # Same commit (same `when`) -> identical submission time across regrades.
        assert first["datetime"] == second["datetime"] == "2026-06-01T14:33:11Z"
        # graded_at moves on every (re)grade.
        assert first["graded_at"] == "2027-01-01T00:00:00Z"
        assert second["graded_at"] == "2027-03-03T09:09:09Z"
        assert first["graded_at"] != second["graded_at"]

    def test_commit_submitted_at_reads_committer_date(self, monkeypatch, tmp_path):
        # %cI with a non-UTC offset must normalize to UTC Z form.
        class _Proc:
            returncode = 0
            stdout = "2026-06-30T12:00:00+01:00\n"

        monkeypatch.setattr(ag.subprocess, "run", lambda *a, **k: _Proc())
        got = ag.commit_submitted_at("deadbeef", tmp_path)
        assert got == datetime.datetime(
            2026, 6, 30, 11, 0, 0, tzinfo=datetime.timezone.utc
        )

    def test_commit_submitted_at_falls_back_on_empty_sha(self, monkeypatch, tmp_path):
        fixed = datetime.datetime(2027, 1, 1, tzinfo=datetime.timezone.utc)
        monkeypatch.setattr(ag, "now_utc", lambda: fixed)
        assert ag.commit_submitted_at("", tmp_path) == fixed

    def test_commit_submitted_at_falls_back_on_git_failure(self, monkeypatch, tmp_path):
        fixed = datetime.datetime(2027, 1, 1, tzinfo=datetime.timezone.utc)
        monkeypatch.setattr(ag, "now_utc", lambda: fixed)

        class _Proc:
            returncode = 128
            stdout = ""

        monkeypatch.setattr(ag.subprocess, "run", lambda *a, **k: _Proc())
        assert ag.commit_submitted_at("deadbeef", tmp_path) == fixed

    def test_commit_submitted_at_falls_back_on_unparseable(self, monkeypatch, tmp_path):
        fixed = datetime.datetime(2027, 1, 1, tzinfo=datetime.timezone.utc)
        monkeypatch.setattr(ag, "now_utc", lambda: fixed)

        class _Proc:
            returncode = 0
            stdout = "not-a-date\n"

        monkeypatch.setattr(ag.subprocess, "run", lambda *a, **k: _Proc())
        assert ag.commit_submitted_at("deadbeef", tmp_path) == fixed


# ---------------------------------------------------------------------------
# derive_status_and_summary
# ---------------------------------------------------------------------------


class TestDeriveStatusAndSummary:
    def _result(self, tests, *, score=0, max_score=0, assignment="hello"):
        return {
            "tests": tests,
            "score": score,
            "max-score": max_score,
            "assignment": assignment,
        }

    def test_empty_tests_yields_success_with_no_autograder_summary(self):
        # Vacuous pass — the runner's `Finalizer.no_autograder()` path
        # (and any per-assignment autograder that produces an empty
        # tests array) routes through this branch so the framing
        # stays consistent.
        result = self._result(tests=[])
        status, summary = ag.derive_status_and_summary(result)
        assert status == "success"
        assert "no autograder configured" in summary
        assert "hello" in summary

    def test_all_passed_yields_success(self):
        tests = [
            {"test-name": "a", "passed": True, "score": 3, "max-score": 3},
            {"test-name": "b", "passed": True, "score": 2, "max-score": 2},
        ]
        result = self._result(tests=tests, score=5, max_score=5)
        status, summary = ag.derive_status_and_summary(result)
        assert status == "success"
        assert "5/5" in summary
        assert "all tests passed" in summary

    def test_some_failed_yields_failure(self):
        tests = [
            {"test-name": "a", "passed": True, "score": 3, "max-score": 3},
            {"test-name": "b", "passed": False, "score": 0, "max-score": 2},
        ]
        result = self._result(tests=tests, score=3, max_score=5)
        status, summary = ag.derive_status_and_summary(result)
        assert status == "failure"
        assert "3/5" in summary
        assert "1/2" in summary

    def test_all_failed_yields_failure(self):
        tests = [
            {"test-name": "a", "passed": False, "score": 0, "max-score": 3},
            {"test-name": "b", "passed": False, "score": 0, "max-score": 2},
        ]
        result = self._result(tests=tests, score=0, max_score=5)
        status, summary = ag.derive_status_and_summary(result)
        assert status == "failure"
        assert "0/5" in summary
        assert "0/2" in summary


# ---------------------------------------------------------------------------
# render_release_body
# ---------------------------------------------------------------------------


class TestRenderReleaseBody:
    def test_renders_score_header_and_test_table(self):
        result = {
            "score": 3,
            "max-score": 5,
            "tests": [
                {"test-name": "test_a", "passed": True, "score": 3, "max-score": 3},
                {"test-name": "test_b", "passed": False, "score": 0, "max-score": 2},
            ],
        }
        body = ag.render_release_body(result, summary="3/5 passed")
        assert "### classroom50 autograde: 3/5" in body
        assert "| Test | Result | Score |" in body
        assert "| test_a | PASS | 3 / 3 |" in body
        assert "| test_b | FAIL | 0 / 2 |" in body
        assert "Status: 3/5 passed" in body

    def test_empty_tests_renders_summary_only(self):
        result = {"score": 0, "max-score": 0, "tests": []}
        body = ag.render_release_body(
            result, summary="submitted — no autograder configured"
        )
        assert "### classroom50 autograde: 0/0" in body
        assert "no autograder configured" in body
        assert "| Test | Result | Score |" not in body

    def test_pipe_in_test_name_is_escaped(self):
        # Pipes in test names would otherwise break the Markdown table.
        result = {
            "score": 1,
            "max-score": 1,
            "tests": [
                {"test-name": "test_a|with|pipes", "passed": True, "score": 1, "max-score": 1},
            ],
        }
        body = ag.render_release_body(result, summary="all passed")
        assert "test_a\\|with\\|pipes" in body


# ---------------------------------------------------------------------------
# validate_result
# ---------------------------------------------------------------------------


class TestValidateResult:
    # validate_result mirrors collect_scores's strictness so a payload
    # passing the runner also passes the gradebook ingest. The BASE
    # below is a minimum v1-valid payload — every required string,
    # int, and list field present.
    BASE = {
        "schema": "classroom50/result/v1",
        "classroom": "cs-principles",
        "assignment": "hello",
        "owner": "alice",
        "assignment_type": "individual",
        "submission": "submit/2026-06-01T14-32-05Z-a1b2c3d",
        "commit": "https://github.com/cs50/cs-principles-hello-alice/commit/abc",
        "release": "https://github.com/cs50/cs-principles-hello-alice/releases/tag/submit%2F...",
        "review": "https://github.com/cs50/cs-principles-hello-alice/commit/abc",
        "datetime": "2026-06-01T14:33:11Z",
        "score": 0,
        "max-score": 0,
        "tests": [],
    }

    def test_valid_payload_returns_none(self):
        assert ag.validate_result(
            self.BASE, classroom="cs-principles", assignment="hello"
        ) is None

    def test_valid_submitted_by_returns_none(self):
        ok = {**self.BASE, "submitted_by": {"username": "bob", "id": 222}}
        assert ag.validate_result(ok, classroom="cs-principles", assignment="hello") is None

    def test_submitted_by_null_id_ok(self):
        ok = {**self.BASE, "submitted_by": {"username": "bob", "id": None}}
        assert ag.validate_result(ok, classroom="cs-principles", assignment="hello") is None

    def test_submitted_by_missing_username_rejected(self):
        bad = {**self.BASE, "submitted_by": {"id": 222}}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None and "submitted_by" in err

    def test_submitted_by_non_int_id_rejected(self):
        bad = {**self.BASE, "submitted_by": {"username": "bob", "id": "222"}}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None and "submitted_by" in err

    def test_non_dict_rejected(self):
        err = ag.validate_result(
            ["not", "a", "dict"], classroom="cs-principles", assignment="hello"
        )
        assert err is not None
        assert "not a JSON object" in err

    def test_wrong_schema_rejected(self):
        bad = {**self.BASE, "schema": "classroom50/result/v2"}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None
        assert "schema" in err

    def test_classroom_mismatch_rejected(self):
        bad = {**self.BASE, "classroom": "wrong-room"}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None
        assert "classroom" in err

    def test_assignment_mismatch_rejected(self):
        bad = {**self.BASE, "assignment": "wrong-slug"}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None
        assert "assignment" in err

    def test_tests_not_a_list_rejected(self):
        bad = {**self.BASE, "tests": {"not": "a-list"}}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None
        assert "tests" in err

    def test_owner_wrong_shape_rejected(self):
        # owner is the identity anchor: must be a non-empty string. A
        # missing or blank owner fails the runner so a malformed payload
        # never reaches the gradebook.
        for bad_owner in (None, "", 42, ["alice"]):
            bad = {**self.BASE, "owner": bad_owner}
            err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
            assert err is not None, f"{bad_owner!r} should be rejected"
            assert "owner" in err
        missing = {k: v for k, v in self.BASE.items() if k != "owner"}
        err = ag.validate_result(missing, classroom="cs-principles", assignment="hello")
        assert err is not None and "owner" in err

    def test_owner_kwarg_mismatch_rejected(self):
        # When the runner passes the repo-derived owner, the payload's
        # owner must match it (case-insensitively).
        assert ag.validate_result(
            self.BASE, classroom="cs-principles", assignment="hello", owner="ALICE"
        ) is None
        err = ag.validate_result(
            self.BASE, classroom="cs-principles", assignment="hello", owner="bob"
        )
        assert err is not None and "owner" in err

    def test_assignment_type_validated_against_mode(self):
        # assignment_type must be "individual"/"group" and match the run's
        # mode. A bogus value, or an individual payload graded as a group
        # run (and vice versa), is rejected.
        bad = {**self.BASE, "assignment_type": "bogus"}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None and "assignment_type" in err

        # is_group default False, payload says individual -> ok already
        # (covered by test_valid_payload_returns_none). Group run with an
        # individual payload must fail.
        err = ag.validate_result(
            self.BASE, classroom="cs-principles", assignment="hello", is_group=True
        )
        assert err is not None and "assignment_type" in err

        group = {**self.BASE, "assignment_type": "group"}
        assert ag.validate_result(
            group, classroom="cs-principles", assignment="hello", is_group=True
        ) is None

    def test_submission_wrong_shape_rejected(self):
        for bad_sub in (None, 42, "not-a-submit-tag", "submit", ""):
            bad = {**self.BASE, "submission": bad_sub}
            err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
            assert err is not None, f"{bad_sub!r} should be rejected"
            assert "submission" in err

    def test_score_must_be_non_negative_int(self):
        for bad in (-1, "5", 5.5, True):
            payload = {**self.BASE, "score": bad}
            err = ag.validate_result(payload, classroom="cs-principles", assignment="hello")
            assert err is not None, f"{bad!r} should be rejected"
            assert "score" in err

    def test_score_greater_than_max_rejected(self):
        bad = {**self.BASE, "score": 5, "max-score": 4}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None
        assert "score" in err and "max-score" in err

    def test_test_entry_must_be_dict(self):
        bad = {**self.BASE, "tests": ["just a string"]}
        err = ag.validate_result(bad, classroom="cs-principles", assignment="hello")
        assert err is not None
        assert "tests[0]" in err

    def test_test_entry_field_validation(self):
        for bad_test, expected in [
            ({"test-name": "", "passed": True, "score": 0, "max-score": 0}, "test-name"),
            ({"test-name": "x", "passed": "yes", "score": 0, "max-score": 0}, "passed"),
            ({"test-name": "x", "passed": True, "score": -1, "max-score": 0}, "score"),
            ({"test-name": "x", "passed": True, "score": True, "max-score": 1}, "score"),
            ({"test-name": "x", "passed": True, "score": 0, "max-score": -1}, "max-score"),
            ({"test-name": "x", "passed": True, "score": 5, "max-score": 4}, "score"),
        ]:
            payload = {**self.BASE, "tests": [bad_test]}
            err = ag.validate_result(payload, classroom="cs-principles", assignment="hello")
            assert err is not None, f"{bad_test!r} should be rejected"
            assert expected in err

    def test_extra_fields_allowed(self):
        # The autograder is free to add fields beyond the v1 baseline
        # (e.g. its own diagnostic block); we only check the contract.
        ok = {**self.BASE, "extra_field": "anything"}
        assert ag.validate_result(
            ok, classroom="cs-principles", assignment="hello"
        ) is None


# ---------------------------------------------------------------------------
# extract_tarball
# ---------------------------------------------------------------------------


class TestExtractTarball:
    def _build_tarball(self, files: dict[str, str]) -> bytes:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for name, content in files.items():
                data = content.encode("utf-8")
                info = tarfile.TarInfo(name=name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        return buf.getvalue()

    def test_extracts_files_to_dest(self, tmp_path):
        data = self._build_tarball({
            "hello/autograder.py": "# entrypoint\n",
            "hello/test_helper.py": "# fixture\n",
        })
        ag.extract_tarball(data, tmp_path)
        assert (tmp_path / "hello" / "autograder.py").is_file()
        assert (tmp_path / "hello" / "test_helper.py").is_file()

    def test_corrupt_tarball_raises(self, tmp_path):
        with pytest.raises(tarfile.TarError):
            ag.extract_tarball(b"not a tarball", tmp_path)

    def test_path_traversal_blocked(self, tmp_path):
        # Python 3.12+ filter='data' refuses members with absolute
        # paths or `..` segments. Defense-in-depth even though the
        # bundle comes from the teacher's config repo.
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            data = b"hostile"
            info = tarfile.TarInfo(name="../../etc/evil")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        with pytest.raises((tarfile.TarError, OSError, ValueError)):
            ag.extract_tarball(buf.getvalue(), tmp_path)


class TestSafeExtractallLegacy:
    """Exercises the <3.12 fallback explicitly, regardless of the
    interpreter pytest itself runs on. Teachers can pin
    `runtime.python: 3.10` (or run inside a container with an older
    python), and runner.py must produce identical safety guarantees
    on both code paths."""

    def _build_tarball(self, mutate) -> bytes:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            mutate(tar)
        return buf.getvalue()

    def _open(self, blob: bytes) -> tarfile.TarFile:
        return tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz")

    def test_extracts_regular_files(self, tmp_path):
        def mutate(tar):
            for name, content in (("hello/autograder.py", b"# entry\n"),
                                  ("hello/fixture.py", b"# helper\n")):
                info = tarfile.TarInfo(name=name)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
        with self._open(self._build_tarball(mutate)) as tar:
            ag._safe_extractall_legacy(tar, tmp_path)
        assert (tmp_path / "hello" / "autograder.py").is_file()
        assert (tmp_path / "hello" / "fixture.py").is_file()

    def test_rejects_parent_traversal(self, tmp_path):
        def mutate(tar):
            info = tarfile.TarInfo(name="../../etc/evil")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
        with self._open(self._build_tarball(mutate)) as tar:
            with pytest.raises(ValueError, match="unsafe tar path"):
                ag._safe_extractall_legacy(tar, tmp_path)

    def test_rejects_absolute_path(self, tmp_path):
        def mutate(tar):
            info = tarfile.TarInfo(name="/etc/evil")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
        with self._open(self._build_tarball(mutate)) as tar:
            with pytest.raises(ValueError, match="unsafe tar path"):
                ag._safe_extractall_legacy(tar, tmp_path)

    def test_rejects_symlink(self, tmp_path):
        def mutate(tar):
            info = tarfile.TarInfo(name="link")
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            tar.addfile(info)
        with self._open(self._build_tarball(mutate)) as tar:
            with pytest.raises(ValueError, match="unsupported tar member type"):
                ag._safe_extractall_legacy(tar, tmp_path)

    def test_rejects_hardlink(self, tmp_path):
        def mutate(tar):
            info = tarfile.TarInfo(name="link")
            info.type = tarfile.LNKTYPE
            info.linkname = "/etc/passwd"
            tar.addfile(info)
        with self._open(self._build_tarball(mutate)) as tar:
            with pytest.raises(ValueError, match="unsupported tar member type"):
                ag._safe_extractall_legacy(tar, tmp_path)

    def test_rejects_fifo(self, tmp_path):
        def mutate(tar):
            info = tarfile.TarInfo(name="pipe")
            info.type = tarfile.FIFOTYPE
            tar.addfile(info)
        with self._open(self._build_tarball(mutate)) as tar:
            with pytest.raises(ValueError, match="unsupported tar member type"):
                ag._safe_extractall_legacy(tar, tmp_path)


# ---------------------------------------------------------------------------
# fetch_url (HTTP layer with retry)
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self, n: int | None = None) -> bytes:
        if n is None:
            return self._body
        return self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestFetchUrl:
    def test_returns_body_on_200(self, monkeypatch):
        def fake_urlopen(req, timeout=None):
            return _FakeResponse(b"some bytes")

        monkeypatch.setattr(ag.urllib.request, "urlopen", fake_urlopen)
        body = ag.fetch_url("https://example.invalid/x")
        assert body == b"some bytes"

    def test_returns_none_on_404(self, monkeypatch):
        # 404 is the "not present" signal — for the bundle URL it
        # means "no per-assignment override"; for the default-
        # autograder URL it means publish-pages.yaml hasn't run yet.
        def fake_urlopen(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

        monkeypatch.setattr(ag.urllib.request, "urlopen", fake_urlopen)
        assert ag.fetch_url("https://example.invalid/x") is None

    def test_retries_on_5xx_then_succeeds(self, monkeypatch):
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):
            calls["n"] += 1
            if calls["n"] < 3:
                raise urllib.error.HTTPError(req.full_url, 503, "Service Unavailable", {}, None)
            return _FakeResponse(b"ok")

        monkeypatch.setattr(ag.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setattr(ag.time, "sleep", lambda _s: None)
        assert ag.fetch_url("https://example.invalid/x") == b"ok"
        assert calls["n"] == 3

    def test_non_404_4xx_raises_immediately(self, monkeypatch):
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):
            calls["n"] += 1
            raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

        monkeypatch.setattr(ag.urllib.request, "urlopen", fake_urlopen)
        with pytest.raises(urllib.error.HTTPError):
            ag.fetch_url("https://example.invalid/x")
        assert calls["n"] == 1

    def test_exceeds_max_size_raises(self, monkeypatch):
        oversized = b"x" * (ag.MAX_FETCH_BYTES + 100)

        def fake_urlopen(req, timeout=None):
            return _FakeResponse(oversized)

        monkeypatch.setattr(ag.urllib.request, "urlopen", fake_urlopen)
        with pytest.raises(ValueError, match="exceeds.*byte ceiling"):
            ag.fetch_url("https://example.invalid/x")

    def test_retries_on_url_error_then_succeeds(self, monkeypatch):
        # URLError is the network-layer fallback (DNS, TCP reset,
        # truncated body). Same retry contract as 5xx: backoff up to
        # FETCH_ATTEMPTS times, succeed on later attempt.
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):
            calls["n"] += 1
            if calls["n"] < 3:
                raise urllib.error.URLError("connection reset")
            return _FakeResponse(b"ok")

        monkeypatch.setattr(ag.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setattr(ag.time, "sleep", lambda _s: None)
        assert ag.fetch_url("https://example.invalid/x") == b"ok"
        assert calls["n"] == 3

    def test_5xx_retry_exhaustion_raises(self, monkeypatch):
        # All attempts fail with 5xx → raise the last error rather
        # than swallowing it.
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):
            calls["n"] += 1
            raise urllib.error.HTTPError(req.full_url, 503, "Service Unavailable", {}, None)

        monkeypatch.setattr(ag.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setattr(ag.time, "sleep", lambda _s: None)
        with pytest.raises(urllib.error.HTTPError):
            ag.fetch_url("https://example.invalid/x")
        assert calls["n"] == ag.FETCH_ATTEMPTS

    def test_url_error_retry_exhaustion_raises(self, monkeypatch):
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):
            calls["n"] += 1
            raise urllib.error.URLError("connection reset")

        monkeypatch.setattr(ag.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.setattr(ag.time, "sleep", lambda _s: None)
        with pytest.raises(urllib.error.URLError):
            ag.fetch_url("https://example.invalid/x")
        assert calls["n"] == ag.FETCH_ATTEMPTS


# ---------------------------------------------------------------------------
# output_has_status / append_outputs
# ---------------------------------------------------------------------------


class TestOutputHasStatus:
    def test_returns_false_when_unset(self):
        assert ag.output_has_status(None) is False

    def test_returns_false_when_file_missing(self, tmp_path):
        assert ag.output_has_status(str(tmp_path / "does-not-exist")) is False

    def test_returns_false_when_file_empty(self, tmp_path):
        path = tmp_path / "empty"
        path.write_text("")
        assert ag.output_has_status(str(path)) is False

    def test_returns_true_when_status_present(self, tmp_path):
        path = tmp_path / "out"
        path.write_text("status=success\nsummary=ok\n")
        assert ag.output_has_status(str(path)) is True

    def test_returns_false_when_only_unrelated_keys(self, tmp_path):
        path = tmp_path / "out"
        path.write_text("other-key=value\nanother=foo\n")
        assert ag.output_has_status(str(path)) is False


class TestAppendOutputs:
    def test_writes_status_and_summary(self, tmp_path):
        path = tmp_path / "out"
        path.write_text("")
        ag.append_outputs(str(path), "success", "all good")
        text = path.read_text()
        assert "status=success\n" in text
        assert "summary=all good\n" in text

    def test_summary_newlines_replaced_with_spaces(self, tmp_path):
        # $GITHUB_OUTPUT is line-oriented; newlines in values would
        # break parsing. Defensive scrub.
        path = tmp_path / "out"
        path.write_text("")
        ag.append_outputs(str(path), "error", "line one\nline two\rline three")
        text = path.read_text()
        assert "summary=line one line two line three\n" in text
        assert text.count("\n") == 2

    def test_no_path_does_not_crash(self):
        # Running locally for development — GITHUB_OUTPUT may not be set.
        ag.append_outputs(None, "success", "ok")  # no exception


class TestAppendShaOutputs:
    def test_writes_both_when_baseline_known(self, tmp_path):
        path = tmp_path / "out"
        path.write_text("")
        ag.append_sha_outputs(str(path), "b" * 40, "a" * 40)
        text = path.read_text()
        assert f"head-sha={'a' * 40}\n" in text
        assert f"baseline-sha={'b' * 40}\n" in text

    def test_omits_baseline_when_unknown(self, tmp_path):
        # No usable baseline → only head-sha; the workflow step's
        # baseline-sha guard then skips opening the PR.
        path = tmp_path / "out"
        path.write_text("")
        ag.append_sha_outputs(str(path), None, "a" * 40)
        text = path.read_text()
        assert f"head-sha={'a' * 40}\n" in text
        assert "baseline-sha=" not in text

    def test_no_path_does_not_crash(self):
        ag.append_sha_outputs(None, "b" * 40, "a" * 40)  # no exception


# ---------------------------------------------------------------------------
# Finalizer (error path synthesis)
# ---------------------------------------------------------------------------


class TestFinalizer:
    def _finalizer(self, *, workspace, github_output):
        return ag.Finalizer(
            workspace=workspace,
            github_output=str(github_output) if github_output else None,
            classroom="cs-principles",
            assignment="hello",
            username="alice",
            submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            commit_link="https://github.com/cs50/cs-principles-hello-alice/commit/abc",
            release_link="https://github.com/cs50/cs-principles-hello-alice/releases/tag/submit%2F2026-06-01T14-32-05Z-a1b2c3d",
        )

    def test_writes_synthesized_result_and_release_body(self, tmp_path):
        gh_output = tmp_path / "out"
        gh_output.write_text("")
        f = self._finalizer(workspace=tmp_path, github_output=gh_output)

        assert f.error("bundle fetch failed: Connection refused") == 0

        result = json.loads((tmp_path / "result.json").read_text())
        assert result["schema"] == ag.RESULT_SCHEMA_V1
        assert result["classroom"] == "cs-principles"
        assert result["assignment"] == "hello"
        assert result["tests"] == []
        assert result["score"] == 0
        assert result["max-score"] == 0

        body = (tmp_path / "release-body.md").read_text()
        assert "### classroom50 autograde: 0/0" in body
        assert "bundle fetch failed" in body

    def test_writes_status_error_to_github_output(self, tmp_path):
        gh_output = tmp_path / "out"
        gh_output.write_text("")
        f = self._finalizer(workspace=tmp_path, github_output=gh_output)
        f.error("something broke")
        text = gh_output.read_text()
        assert "status=error\n" in text
        assert "something broke" in text

    def test_overwrites_stale_status_from_autograder(self, tmp_path):
        # Autograder may have written status=success before exiting
        # non-zero. The finalizer appends status=error so the final
        # state in the file ends with the error — append_outputs is
        # always called regardless of prior content.
        gh_output = tmp_path / "out"
        gh_output.write_text("status=success\nsummary=fake\n")
        f = self._finalizer(workspace=tmp_path, github_output=gh_output)
        f.error("real failure")
        lines = gh_output.read_text().splitlines()
        # Last status= line wins by GitHub Actions semantics; ours is appended.
        last_status = next(l for l in reversed(lines) if l.startswith("status="))
        assert last_status == "status=error"

    def test_no_github_output_does_not_crash(self, tmp_path):
        f = self._finalizer(workspace=tmp_path, github_output=None)
        f.error("no env var set")
        # result.json + release-body.md still written.
        assert (tmp_path / "result.json").is_file()
        assert (tmp_path / "release-body.md").is_file()

    def test_review_link_threaded_into_error_result(self, tmp_path):
        # Error paths carry the full-diff review link too.
        review = "https://github.com/cs50/cs-principles-hello-alice/compare/base...abc"
        f = ag.Finalizer(
            workspace=tmp_path,
            github_output=None,
            classroom="cs-principles",
            assignment="hello",
            username="alice",
            submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            commit_link="https://github.com/cs50/cs-principles-hello-alice/commit/abc",
            release_link="https://github.com/cs50/cs-principles-hello-alice/releases/tag/x",
            review_link=review,
        )
        f.error("bundle fetch failed")
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["review"] == review

    def test_no_autograder_synthesizes_vacuous_pass(self, tmp_path):
        # Lean-scaffold path: classroom hasn't run set-default and
        # the assignment has no override either. Distinct from
        # error() — this is a valid mid-setup state, so status is
        # success (not error) and the gradebook records 0/0.
        gh_output = tmp_path / "out"
        gh_output.write_text("")
        f = self._finalizer(workspace=tmp_path, github_output=gh_output)

        assert f.no_autograder() == 0

        result = json.loads((tmp_path / "result.json").read_text())
        assert result["schema"] == ag.RESULT_SCHEMA_V1
        assert result["tests"] == []
        assert result["score"] == 0
        assert result["max-score"] == 0

        body = (tmp_path / "release-body.md").read_text()
        assert "### classroom50 autograde: 0/0" in body
        assert "no autograder configured" in body

        text = gh_output.read_text()
        assert "status=success\n" in text
        assert "no autograder configured" in text


class TestFinalizeResult:
    # Pins the stamp-before-validate path: finalize_result reads the
    # autograder's own result.json, stamps owner/assignment_type/submitted_by
    # authoritatively (a custom autograder may omit/forge them), then validates.
    def _finalizer(self, tmp_path, *, submitted_by=None, assignment_type="individual"):
        return ag.Finalizer(
            workspace=tmp_path,
            github_output=None,
            classroom="cs-principles",
            assignment="hello",
            username="alice",
            submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            commit_link="https://github.com/cs50/cs-principles-hello-alice/commit/abc",
            release_link="https://github.com/cs50/cs-principles-hello-alice/releases/tag/x",
            submitted_by=submitted_by,
            assignment_type=assignment_type,
        )

    def _autograder_result(self, **overrides):
        # A minimal result.json a custom autograder might write — deliberately
        # WITHOUT owner/assignment_type to prove the runner supplies them.
        r = {
            "schema": ag.RESULT_SCHEMA_V1,
            "classroom": "cs-principles",
            "assignment": "hello",
            "submission": "submit/2026-06-01T14-32-05Z-a1b2c3d",
            "commit": "c", "release": "r", "review": "v",
            "datetime": "2026-06-01T14:33:11Z",
            "score": 5, "max-score": 10, "tests": [],
        }
        r.update(overrides)
        return r

    def test_stamps_owner_and_type_on_autograder_result_then_validates(self, tmp_path):
        # Custom autograder omits owner/assignment_type; the runner stamps
        # them and the result validates (rc 0).
        (tmp_path / "result.json").write_text(json.dumps(self._autograder_result()))
        f = self._finalizer(tmp_path, submitted_by={"username": "bob", "id": 222})
        assert ag.finalize_result(f, is_group=False) == 0
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["owner"] == "alice"
        assert result["assignment_type"] == "individual"
        assert result["submitted_by"] == {"username": "bob", "id": 222}

    def test_overwrites_forged_owner_and_type(self, tmp_path):
        # A student-influenced result.json claiming a different owner/type
        # is overwritten with the runner-authoritative values.
        (tmp_path / "result.json").write_text(json.dumps(
            self._autograder_result(owner="victim", assignment_type="group")
        ))
        f = self._finalizer(tmp_path)
        assert ag.finalize_result(f, is_group=False) == 0
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["owner"] == "alice"
        assert result["assignment_type"] == "individual"

    def test_overwrites_datetime_with_submission_time_and_stamps_graded_at(
        self, tmp_path, monkeypatch
    ):
        # The runner stamps `datetime` (the invariant submission instant) and
        # `graded_at` (this run's wall clock) authoritatively — a custom
        # autograder can't set its own submission time / late flag.
        graded_now = datetime.datetime(2027, 9, 9, 9, 9, 9, tzinfo=datetime.timezone.utc)
        monkeypatch.setattr(ag, "now_utc", lambda: graded_now)
        (tmp_path / "result.json").write_text(json.dumps(
            self._autograder_result(datetime="2099-01-01T00:00:00Z")
        ))
        f = self._finalizer(tmp_path)
        # Pin a known submission instant (committer date) on the finalizer.
        f.submitted_at = datetime.datetime(
            2026, 6, 1, 14, 33, 11, tzinfo=datetime.timezone.utc
        )
        assert ag.finalize_result(f, is_group=False) == 0
        result = json.loads((tmp_path / "result.json").read_text())
        # The autograder's forged far-future datetime is replaced by the
        # committer-date submission instant; graded_at records "now".
        assert result["datetime"] == "2026-06-01T14:33:11Z"
        assert result["graded_at"] == "2027-09-09T09:09:09Z"

    def test_drops_forged_submitted_by_when_actor_unknown(self, tmp_path):
        # submitted_by is stamped unconditionally: when the runner couldn't
        # resolve the actor (None), a result.json's self-asserted submitted_by
        # must be DROPPED, never trusted.
        (tmp_path / "result.json").write_text(json.dumps(
            self._autograder_result(submitted_by={"username": "forged", "id": 999})
        ))
        f = self._finalizer(tmp_path, submitted_by=None)
        assert ag.finalize_result(f, is_group=False) == 0
        result = json.loads((tmp_path / "result.json").read_text())
        assert "submitted_by" not in result


# ---------------------------------------------------------------------------
# Schema sentinel pinning
# ---------------------------------------------------------------------------


def test_result_schema_sentinel_matches_collect_scores():
    # Cross-binary contract — must match RESULT_SCHEMA_V1 in
    # cli/gh-teacher/skeleton/dotgithub/scripts/collect_scores.py
    # and the Go-side consts.
    # Compare the live constants from both modules instead of
    # asserting against a hardcoded string — a bump in one without
    # the other was previously invisible to the test suite.
    assert ag.RESULT_SCHEMA_V1 == cs.RESULT_SCHEMA_V1
    assert ag.RESULT_SCHEMA_V1 == "classroom50/result/v1"


def test_submit_tag_prefix_matches_collect_scores():
    # Cross-binary contract: collect_scores filters releases on this
    # prefix; the runner workflow tags with it. A drift would silently
    # drop submissions from the gradebook.
    assert cs.SUBMIT_TAG_PREFIX == "submit/"


def test_result_asset_name_matches_collect_scores():
    # Cross-binary contract: the runner workflow uploads `result.json`;
    # collect_scores fetches by this exact name.
    assert cs.RESULT_ASSET_NAME == "result.json"


def test_runner_output_filenames_match_go_contract():
    # Cross-binary contract: runner.py's RESULT_FILENAME / RELEASE_BODY_FILENAME
    # are single-sourced in Go as contract.ResultFilename / ReleaseBodyFilename
    # (cli/shared/contract/contract.go, pinned by contract_test.go), and the
    # allowed_files control-path force-keep on both sides depends on them
    # matching exactly. Pin the Python literals so a one-sided edit fails here.
    assert ag.RESULT_FILENAME == "result.json"
    assert ag.RELEASE_BODY_FILENAME == "release-body.md"


def _make_workspace(path, files):
    """A real git repo at path containing the given relative files
    (trivial content), all committed so `git ls-files` enumerates them."""
    path.mkdir()
    _git(path, "init", "-q", "-b", "main")
    for rel in files:
        p = path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x\n")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "submission")


class TestParseAllowedFiles:
    def test_empty_and_absent(self):
        assert ag.parse_allowed_files(None) == []
        assert ag.parse_allowed_files("") == []
        assert ag.parse_allowed_files("   ") == []

    def test_valid_array(self):
        assert ag.parse_allowed_files('["*", "!hello.py"]') == ["*", "!hello.py"]

    def test_malformed_json_is_ignored(self):
        assert ag.parse_allowed_files("not json") == []

    def test_non_string_entries_ignored(self):
        assert ag.parse_allowed_files('["*", 3]') == []
        assert ag.parse_allowed_files('"hello.py"') == []


class TestEnforceAllowedFiles:
    def test_allowlist_removes_disallowed_keeps_match_and_control(self, tmp_path):
        ws = tmp_path / "repo"
        _make_workspace(ws, [
            "hello.py",
            "scratch.py",
            "build/out.o",
            ag.ACCEPT_MARKER_PATH,
            ".github/workflows/autograde.yaml",
        ])
        removed = ag.enforce_allowed_files(ws, ["*", "!hello.py"])

        assert removed == ["build/out.o", "scratch.py"]
        assert (ws / "hello.py").exists()
        assert (ws / ag.ACCEPT_MARKER_PATH).exists()
        assert (ws / ".github/workflows/autograde.yaml").exists()
        assert not (ws / "scratch.py").exists()
        assert not (ws / "build/out.o").exists()

    def test_empty_patterns_remove_nothing(self, tmp_path):
        ws = tmp_path / "repo"
        _make_workspace(ws, ["a.py", "b.py"])
        assert ag.enforce_allowed_files(ws, []) == []
        assert (ws / "a.py").exists() and (ws / "b.py").exists()

    def test_control_files_kept_even_under_bare_star(self, tmp_path):
        ws = tmp_path / "repo"
        _make_workspace(ws, [
            "anything.py",
            ag.ACCEPT_MARKER_PATH,
            ".github/workflows/autograde.yaml",
        ])
        removed = ag.enforce_allowed_files(ws, ["*"])
        assert removed == ["anything.py"]
        assert (ws / ag.ACCEPT_MARKER_PATH).exists()
        assert (ws / ".github/workflows/autograde.yaml").exists()
        assert not (ws / "anything.py").exists()

    def test_nested_git_repo_cannot_hide_disallowed_files(self, tmp_path):
        # `git ls-files` won't recurse into a nested repo, so the walk
        # must catch files hidden there or they escape the allowlist.
        ws = tmp_path / "repo"
        _make_workspace(ws, ["hello.py"])
        nested = ws / "nested"
        nested.mkdir()
        _git(nested, "init", "-q")
        (nested / "sneaky.py").write_text("disallowed\n")

        removed = ag.enforce_allowed_files(ws, ["*", "!hello.py"])

        assert (ws / "hello.py").exists()
        assert not (nested / "sneaky.py").exists(), "nested-repo file escaped enforcement"
        assert "nested/sneaky.py" in removed
        assert (nested / ".git").exists()  # .git metadata never touched

    def test_control_name_prefix_sibling_is_not_force_kept(self, tmp_path):
        # Only exact control names are kept; `result.json.bak` is subject
        # to the allowlist.
        ws = tmp_path / "repo"
        _make_workspace(ws, [
            "hello.py",
            "result.json.bak",
            ag.ACCEPT_MARKER_PATH + ".bak",
        ])
        removed = ag.enforce_allowed_files(ws, ["*", "!hello.py"])
        assert "result.json.bak" in removed
        assert f"{ag.ACCEPT_MARKER_PATH}.bak" in removed
        assert not (ws / "result.json.bak").exists()

    def test_ignores_ambient_global_excludesfile(self, tmp_path, monkeypatch):
        # A host global ignore of `*.log` must not leak in: with patterns
        # that don't match app.log, it stays allowed.
        home = tmp_path / "home"
        home.mkdir()
        (home / "globalignore").write_text("*.log\n")
        (home / ".gitconfig").write_text(
            f"[core]\n\texcludesFile = {home / 'globalignore'}\n")
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)
        monkeypatch.delenv("GIT_CONFIG_NOSYSTEM", raising=False)

        ws = tmp_path / "repo"
        _make_workspace(ws, ["app.log", "secret.txt", "keep.py"])
        removed = ag.enforce_allowed_files(ws, ["secret.txt"])
        assert removed == ["secret.txt"]
        assert (ws / "app.log").exists(), "ambient global excludesFile leaked into the matcher"

    def test_shared_fixture_parity(self):
        # Same golden cases the Go ignorematch test asserts, so the two
        # parallel matcher implementations stay in lockstep.
        fixture = (_REPO_ROOT / "cli" / "shared" / "testdata"
                   / "allowed_files_matcher_cases.json")
        cases = json.loads(fixture.read_text())["cases"]
        assert cases, "shared fixture has no cases"
        for case in cases:
            disallowed = ag._classify_disallowed(case["patterns"], case["paths"])
            assert disallowed is not None, f"{case['name']}: matcher failed"
            assert sorted(disallowed) == sorted(case["disallowed"]), case["name"]

    def test_control_path_shared_fixture_parity(self):
        # Same golden cases the Go isControlPath test asserts, so the
        # force-keep control-path sets stay in lockstep across languages.
        fixture = (_REPO_ROOT / "cli" / "shared" / "testdata"
                   / "control_path_cases.json")
        cases = json.loads(fixture.read_text())["cases"]
        assert cases, "shared control-path fixture has no cases"
        for case in cases:
            assert ag._is_control_path(case["path"]) == case["is_control"], case["path"]


class TestEnforceAllowedFilesDegradation:
    """The fail-safe branches the design relies on: on any git failure,
    skip enforcement (fail open — grade the unfiltered tree) rather than
    delete the wrong files or block the grade. enforce_allowed_files returns
    [] and the files survive. (See its docstring for how to flip to
    fail-closed if allowed_files should ever be an authoritative boundary.)"""

    def test_walk_failure_skips_enforcement(self, tmp_path, monkeypatch):
        ws = tmp_path / "repo"
        _make_workspace(ws, ["hello.py", "scratch.py"])

        def boom(_workspace):
            raise OSError("walk blew up")

        monkeypatch.setattr(ag, "_walk_workspace_files", boom)
        removed = ag.enforce_allowed_files(ws, ["*", "!hello.py"])
        assert removed == []
        assert (ws / "scratch.py").exists(), "files must survive when enumeration fails"

    def test_matcher_init_failure_skips_enforcement(self, tmp_path, monkeypatch):
        ws = tmp_path / "repo"
        _make_workspace(ws, ["hello.py", "scratch.py"])

        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            # Fail the throwaway matcher repo's `git init`.
            if "init" in cmd:
                return subprocess.CompletedProcess(cmd, 1, "", "init failed")
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", fake_run)
        removed = ag.enforce_allowed_files(ws, ["*", "!hello.py"])
        assert removed == []
        assert (ws / "scratch.py").exists()

    def test_check_ignore_error_skips_enforcement(self, tmp_path, monkeypatch):
        ws = tmp_path / "repo"
        _make_workspace(ws, ["hello.py", "scratch.py"])

        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            if "check-ignore" in cmd:
                return subprocess.CompletedProcess(cmd, 2, "", "fatal: boom")
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", fake_run)
        removed = ag.enforce_allowed_files(ws, ["*", "!hello.py"])
        assert removed == []
        assert (ws / "scratch.py").exists()

    def test_check_ignore_timeout_skips_enforcement(self, tmp_path, monkeypatch):
        # A hung git raises subprocess.TimeoutExpired (a SubprocessError, not
        # an OSError). _classify_disallowed catches it and returns None, so
        # enforcement is skipped (fail open) rather than crashing the runner
        # before grading.
        ws = tmp_path / "repo"
        _make_workspace(ws, ["hello.py", "scratch.py"])

        real_run = subprocess.run

        def fake_run(cmd, *args, **kwargs):
            if "check-ignore" in cmd:
                raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(ag.subprocess, "run", fake_run)
        removed = ag.enforce_allowed_files(ws, ["*", "!hello.py"])
        assert removed == []
        assert (ws / "scratch.py").exists(), "a git timeout fails open, not crash or delete"

    def test_unlink_oserror_keeps_going_and_omits_from_removed(self, tmp_path, monkeypatch):
        ws = tmp_path / "repo"
        _make_workspace(ws, ["hello.py", "a.py", "b.py"])

        real_unlink = pathlib.Path.unlink

        def flaky_unlink(self, *args, **kwargs):
            if self.name == "a.py":
                raise PermissionError("locked")
            return real_unlink(self, *args, **kwargs)

        monkeypatch.setattr(ag.pathlib.Path, "unlink", flaky_unlink)
        removed = ag.enforce_allowed_files(ws, ["*", "!hello.py"])
        # b.py removed; a.py failed and is NOT reported as removed. A single
        # un-removable file is best-effort and does NOT fail the whole grade.
        assert "b.py" in removed
        assert "a.py" not in removed
        assert not (ws / "b.py").exists()


class TestRemovedFilesReporting:
    def test_note_appended_to_release_body(self, tmp_path):
        body = tmp_path / ag.RELEASE_BODY_FILENAME
        body.write_text("### classroom50 autograde: 0/0\n")
        ag.append_removed_files_note(tmp_path, ["scratch.py", "build/out.o"])
        text = body.read_text()
        assert "classroom50 autograde: 0/0" in text
        assert "Removed 2 file(s)" in text
        assert "`scratch.py`" in text and "`build/out.o`" in text

    def test_no_note_when_nothing_removed(self, tmp_path):
        body = tmp_path / ag.RELEASE_BODY_FILENAME
        body.write_text("body\n")
        ag.append_removed_files_note(tmp_path, [])
        assert body.read_text() == "body\n"

