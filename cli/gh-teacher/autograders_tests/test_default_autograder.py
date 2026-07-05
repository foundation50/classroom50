"""Subprocess-driven tests for the diagnostic-stub autograder.py shipped inside
gh-teacher (`cli/gh-teacher/embed/autograder.py`).

The stub does its work at module-execution time (no functions to unit-test), so
we run it as a subprocess with synthesized env vars + a temp cwd and inspect the
side effects: result.json, release-body.md, and $GITHUB_OUTPUT.

`gh teacher autograder set-default <org> <classroom>` writes this stub to
`<classroom>/autograder.py` when the teacher omits `--from`, so the runner
pipeline can be verified end-to-end before any real grading logic is in place.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from conftest import DEFAULT_AUTOGRADER_PATH


BASE_ENV = {
    "CLASSROOM": "cs-test",
    "ASSIGNMENT": "hello",
    "USERNAME": "alice",
    "SUBMISSION_TAG": "submit/2026-06-01T14-32-05Z-a1b2c3d",
    "COMMIT_URL": "https://github.com/cs-test/cs-test-hello-alice/commit/abc123",
    "RELEASE_URL": (
        "https://github.com/cs-test/cs-test-hello-alice/releases/tag/"
        "submit%2F2026-06-01T14-32-05Z-a1b2c3d"
    ),
    "PAGES_BASE_URL": "https://cs-test.github.io/classroom50",
    "GITHUB_REPOSITORY": "cs-test/cs-test-hello-alice",
    "GITHUB_SHA": "abc123",
}


def _run(workspace, gh_output, env_overrides=None):
    """Invoke the default autograder in `workspace` with the
    synthesized env. Returns (returncode, stdout, stderr)."""
    env = {**os.environ, **BASE_ENV, "GITHUB_OUTPUT": str(gh_output)}
    if env_overrides:
        env.update(env_overrides)
    proc = subprocess.run(
        [sys.executable, str(DEFAULT_AUTOGRADER_PATH)],
        cwd=str(workspace),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc


class TestDefaultAutograder:
    def test_exits_zero(self, tmp_path):
        gh = tmp_path / "github_output"
        gh.write_text("")
        proc = _run(tmp_path, gh)
        assert proc.returncode == 0, (
            f"default autograder exited {proc.returncode}\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
        )

    def test_writes_v1_valid_result_json(self, tmp_path):
        gh = tmp_path / "github_output"
        gh.write_text("")
        _run(tmp_path, gh)

        result_path = tmp_path / "result.json"
        assert result_path.is_file(), "default autograder did not write result.json"

        result = json.loads(result_path.read_text())
        assert result["schema"] == "classroom50/result/v1"
        assert result["classroom"] == BASE_ENV["CLASSROOM"]
        assert result["assignment"] == BASE_ENV["ASSIGNMENT"]
        # No `usernames` field anymore; identity is `owner` (falls back to
        # USERNAME when OWNER is unset) and `assignment_type` (defaults to
        # individual when ASSIGNMENT_TYPE is unset).
        assert "usernames" not in result
        assert result["owner"] == BASE_ENV["USERNAME"]
        assert result["assignment_type"] == "individual"
        assert result["submission"] == BASE_ENV["SUBMISSION_TAG"]
        assert result["commit"] == BASE_ENV["COMMIT_URL"]
        assert result["release"] == BASE_ENV["RELEASE_URL"]

    def test_emits_vacuous_pass(self, tmp_path):
        # Default's whole point: empty tests array, score 0/0 — the
        # "submitted, no autograder configured" signal.
        gh = tmp_path / "github_output"
        gh.write_text("")
        _run(tmp_path, gh)

        result = json.loads((tmp_path / "result.json").read_text())
        assert result["tests"] == []
        assert result["score"] == 0
        assert result["max-score"] == 0

    def test_writes_release_body_with_no_autograder_summary(self, tmp_path):
        gh = tmp_path / "github_output"
        gh.write_text("")
        _run(tmp_path, gh)

        body = (tmp_path / "release-body.md").read_text()
        assert "### classroom50 autograde: 0/0" in body
        assert "no autograder configured" in body
        assert BASE_ENV["ASSIGNMENT"] in body

    def test_writes_status_success_to_github_output(self, tmp_path):
        gh = tmp_path / "github_output"
        gh.write_text("")
        _run(tmp_path, gh)

        text = gh.read_text()
        assert "status=success\n" in text
        assert "summary=" in text
        assert "no autograder configured" in text

    def test_echoes_metadata_to_stdout_for_diagnostics(self, tmp_path):
        # Teachers debugging "did the runner pick up my classroom
        # config?" should be able to read the workflow log and see
        # every env var the runner exposed.
        gh = tmp_path / "github_output"
        gh.write_text("")
        proc = _run(tmp_path, gh)

        out = proc.stdout
        for label, value in [
            ("CLASSROOM", BASE_ENV["CLASSROOM"]),
            ("ASSIGNMENT", BASE_ENV["ASSIGNMENT"]),
            ("USERNAME", BASE_ENV["USERNAME"]),
            ("SUBMISSION_TAG", BASE_ENV["SUBMISSION_TAG"]),
            ("COMMIT_URL", BASE_ENV["COMMIT_URL"]),
            ("RELEASE_URL", BASE_ENV["RELEASE_URL"]),
        ]:
            assert label in out, f"stdout missing {label} echo:\n{out}"
            assert value in out, f"stdout missing {label} value:\n{out}"

    def test_runs_without_github_output(self, tmp_path):
        # Running locally for development — GITHUB_OUTPUT may not be
        # set. Default should still produce result.json + body, just
        # not write to a non-existent output file.
        env = {**os.environ, **BASE_ENV}
        env.pop("GITHUB_OUTPUT", None)
        proc = subprocess.run(
            [sys.executable, str(DEFAULT_AUTOGRADER_PATH)],
            cwd=str(tmp_path),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert proc.returncode == 0
        assert (tmp_path / "result.json").is_file()
        assert (tmp_path / "release-body.md").is_file()

    def test_review_prefers_review_url_env(self, tmp_path):
        gh = tmp_path / "github_output"
        gh.write_text("")
        review = "https://github.com/cs-test/cs-test-hello-alice/compare/aaa...abc123"
        _run(tmp_path, gh, env_overrides={"REVIEW_URL": review})
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["review"] == review

    def test_review_falls_back_to_commit_url_without_review_url(self, tmp_path):
        # Older runners don't export REVIEW_URL; review stays at the
        # commit view.
        gh = tmp_path / "github_output"
        gh.write_text("")
        _run(tmp_path, gh, env_overrides={"REVIEW_URL": ""})
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["review"] == BASE_ENV["COMMIT_URL"]

    def test_handles_missing_optional_env(self, tmp_path):
        # If the bootstrap somehow doesn't pass USERNAME / COMMIT_URL
        # (defensive — shouldn't happen in production), the default
        # still runs and writes valid v1 with empty strings.
        gh = tmp_path / "github_output"
        gh.write_text("")
        env_overrides = {"USERNAME": "", "COMMIT_URL": "", "RELEASE_URL": ""}
        proc = _run(tmp_path, gh, env_overrides=env_overrides)
        assert proc.returncode == 0

        result = json.loads((tmp_path / "result.json").read_text())
        assert result["schema"] == "classroom50/result/v1"
        # owner falls back to the (empty) USERNAME; no usernames field.
        assert "usernames" not in result
        assert result["owner"] == ""
        assert result["assignment_type"] == "individual"
