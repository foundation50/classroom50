"""Integration tests for `runner.py::main()`.

The pure helpers (URL composition, validate_result, fetch_url retries, etc.)
are unit-tested in test_runner.py. This covers the orchestration glue — bundle
fetch, extraction, entrypoint resolution (per-assignment vs classroom default
vs vacuous pass), subprocess exec, result.json validation, and Finalizer-driven
error synthesis.

Each test stubs `runner.fetch_url` and the autograder subprocess so no real
network or pytest invocation happens. Verifies side-effects on the workspace
(`result.json`, `release-body.md`) and on `$GITHUB_OUTPUT`.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import tarfile
from typing import Callable

import pytest

from conftest import runner as ag


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_tarball(files: dict[str, str]) -> bytes:
    """Pack `path → content` pairs into a gzipped tarball."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _v1_payload(*, classroom: str, assignment: str, username: str,
                submission: str, score: int = 0, max_score: int = 0,
                tests: list | None = None) -> dict:
    """Minimum v1-shaped result.json the runner's validate_result accepts."""
    return {
        "schema": "classroom50/result/v1",
        "classroom": classroom,
        "assignment": assignment,
        "usernames": [username],
        "submission": submission,
        "commit": "https://github.com/x/y/commit/abc",
        "release": "https://github.com/x/y/releases/tag/" + submission.replace("/", "%2F"),
        "review": "https://github.com/x/y/commit/abc",
        "datetime": "2026-06-01T14:33:11Z",
        "score": score,
        "max-score": max_score,
        "tests": tests or [],
    }


@pytest.fixture
def harness(tmp_path, monkeypatch):
    """Standard harness: chdir to a fresh workspace, set up env vars,
    a stub `RUNNER_TEMP` so runner_root() picks it up, and the
    GITHUB_OUTPUT path. Returns a callable that runs main() with
    optional fetch_url and subprocess.run overrides."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    gh_output = tmp_path / "github-output"
    gh_output.write_text("")

    monkeypatch.chdir(workspace)
    monkeypatch.setenv("PAGES_BASE_URL", "https://x.github.io/classroom50")
    monkeypatch.setenv("CLASSROOM", "cs-test")
    monkeypatch.setenv("ASSIGNMENT", "hello")
    monkeypatch.setenv("SUBMISSION_TAG", "submit/2026-06-01T14-32-05Z-a1b2c3d")
    monkeypatch.setenv("GITHUB_REPOSITORY", "cs-test/cs-test-hello-alice")
    monkeypatch.setenv("GITHUB_SHA", "abc123")
    monkeypatch.setenv("GITHUB_SERVER_URL", "https://github.com")
    monkeypatch.setenv("GITHUB_ACTOR", "alice")
    monkeypatch.setenv("GITHUB_OUTPUT", str(gh_output))
    monkeypatch.setenv("RUNNER_TEMP", str(runner_temp))

    state = {
        "workspace": workspace,
        "runner_temp": runner_temp,
        "gh_output": gh_output,
        "fetched_urls": [],
    }

    def run(
        *,
        bundle_response: bytes | None = None,
        default_response: bytes | None = b"# default autograder",
        fetch_raises: Exception | None = None,
        autograder_writes: Callable[[], None] | None = None,
        autograder_rc: int = 0,
        subprocess_raises: OSError | None = None,
        baseline: str | None = None,
        baseline_source: str | None = None,
    ) -> int:
        """Invoke runner.main() with stubbed fetch + subprocess."""
        def fake_fetch(url: str):
            state["fetched_urls"].append(url)
            if fetch_raises is not None:
                raise fetch_raises
            if url.endswith(".tar.gz"):
                return bundle_response
            if url.endswith("/autograder.py"):
                return default_response
            return None

        monkeypatch.setattr(ag, "fetch_url", fake_fetch)

        # Workspace isn't a git repo; tests set the baseline directly.
        # `baseline_source` overrides the scan outcome to exercise the
        # accept / root / git-error / none branches; defaults to "accept"
        # when a baseline is set, else "none". main() resolves the scan
        # once via _baseline_scan and derives both the review-link
        # baseline and the Feedback PR outcome from it, so stub that
        # single seam and let the real baseline_sha / feedback_base_outcome
        # logic (incl. the null-sha gate for non-openable sources) run.
        eff_source = baseline_source or ("accept" if baseline else "none")
        monkeypatch.setattr(
            ag, "_baseline_scan", lambda workspace: (baseline, eff_source)
        )

        def fake_subprocess_run(cmd, cwd=None, env=None, check=False, **kwargs):
            # commit_submitted_at reads the graded commit's committer date via
            # `git show -s --format=%cI <sha>`. The workspace isn't a real git
            # repo here, so stub a deterministic committer date (capture_output
            # style call) → main() stamps a fixed `datetime`.
            if isinstance(cmd, (list, tuple)) and cmd[:2] == ["git", "show"]:
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0, stdout="2026-06-01T14:33:11+00:00\n"
                )
            if subprocess_raises is not None:
                raise subprocess_raises
            state["exec_env"] = env
            if autograder_writes:
                autograder_writes()
            # subprocess.CompletedProcess shim for the autograder exec.
            return subprocess.CompletedProcess(args=cmd, returncode=autograder_rc)

        monkeypatch.setattr(ag.subprocess, "run", fake_subprocess_run)

        return ag.main()

    state["run"] = run
    return state


def _read_outputs(harness) -> tuple[dict, str, str]:
    """Decode result.json, release-body.md, and $GITHUB_OUTPUT."""
    result_path = harness["workspace"] / "result.json"
    body_path = harness["workspace"] / "release-body.md"
    return (
        json.loads(result_path.read_text()) if result_path.exists() else {},
        body_path.read_text() if body_path.exists() else "",
        harness["gh_output"].read_text(),
    )


# ---------------------------------------------------------------------------
# main() — environment validation
# ---------------------------------------------------------------------------


class TestMainEnv:
    def test_missing_required_env_returns_1(self, harness, monkeypatch):
        monkeypatch.delenv("PAGES_BASE_URL")
        rc = harness["run"]()
        assert rc == 1
        # Pre-env-validation, no result.json is written — this is the
        # one error path that doesn't go through Finalizer (the
        # Finalizer needs the env to construct identity).
        assert not (harness["workspace"] / "result.json").exists()

    @pytest.mark.parametrize("missing", ["CLASSROOM", "ASSIGNMENT", "SUBMISSION_TAG"])
    def test_missing_individual_env_var_returns_1(self, missing, harness, monkeypatch):
        monkeypatch.delenv(missing)
        assert harness["run"]() == 1


# ---------------------------------------------------------------------------
# main() — entrypoint resolution
# ---------------------------------------------------------------------------


class TestEntrypointResolution:
    """The single most consequential decision in the new architecture:
    does the runner exec the per-assignment override, the classroom
    default, or fall through to a vacuous-pass synthesis? Bundle
    contents and the classroom default URL drive the choice."""

    def test_bundle_with_per_assignment_autograder_uses_override(self, harness):
        # Bundle includes <slug>/autograder.py — runner uses it.
        per_assignment_body = (
            'import json, os, pathlib\n'
            'import datetime\n'
            'pathlib.Path("result.json").write_text(json.dumps({\n'
            '    "schema": "classroom50/result/v1",\n'
            '    "classroom": os.environ["CLASSROOM"],\n'
            '    "assignment": os.environ["ASSIGNMENT"],\n'
            '    "usernames": [os.environ["USERNAME"]],\n'
            '    "submission": os.environ["SUBMISSION_TAG"],\n'
            '    "commit": "https://x/c", "release": "https://x/r", "review": "https://x/c",\n'
            '    "datetime": "2026-06-01T14:33:11Z", "score": 0, "max-score": 0, "tests": [],\n'
            '}))\n'
        )

        # The harness stubs subprocess.run so the actual python3 doesn't
        # execute — we verify that `runner.py` *picks* the per-assignment
        # entrypoint by inspecting which URLs it fetched.
        def fake_writes():
            (harness["workspace"] / "result.json").write_text(json.dumps(_v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )))

        rc = harness["run"](
            bundle_response=_build_tarball({"hello/autograder.py": per_assignment_body}),
            autograder_writes=fake_writes,
        )
        assert rc == 0

        # Only the bundle URL was fetched — the default autograder URL
        # is never consulted when the bundle has its own entrypoint.
        assert any(".tar.gz" in u for u in harness["fetched_urls"])
        assert not any(u.endswith("/autograder.py") for u in harness["fetched_urls"])

    def test_bundle_without_autograder_falls_back_to_default(self, harness):
        # Bundle has fixtures but no autograder.py — runner fetches the
        # classroom default at <classroom>/autograder.py.
        def fake_writes():
            (harness["workspace"] / "result.json").write_text(json.dumps(_v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )))

        rc = harness["run"](
            bundle_response=_build_tarball({"hello/fixture.py": "# fixture"}),
            default_response=b"# default autograder body",
            autograder_writes=fake_writes,
        )
        assert rc == 0

        # Both URLs fetched: bundle then classroom default.
        # Tightened to /cs-test/autograder.py so a regression that
        # restored a site-root <base>/autograder.py URL would fail.
        assert any(".tar.gz" in u for u in harness["fetched_urls"])
        assert any(
            u.endswith("/cs-test/autograder.py")
            for u in harness["fetched_urls"]
        ), harness["fetched_urls"]

    def test_bundle_404_falls_back_to_default(self, harness):
        # No per-assignment bundle at all (Pages 404) — runner uses the
        # classroom default autograder. Same outcome as a
        # bundle-without-autograder but exercises a different code path.
        def fake_writes():
            (harness["workspace"] / "result.json").write_text(json.dumps(_v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )))

        rc = harness["run"](
            bundle_response=None,  # 404
            default_response=b"# default autograder body",
            autograder_writes=fake_writes,
        )
        assert rc == 0
        # Classroom-scoped, not site-root: <base>/<classroom>/autograder.py.
        assert any(
            u.endswith("/cs-test/autograder.py")
            for u in harness["fetched_urls"]
        ), harness["fetched_urls"]

    def test_no_bundle_and_no_default_synthesizes_vacuous_pass(self, harness):
        # Lean-scaffold path: no per-assignment bundle AND no
        # classroom default published. "No autograder configured" is
        # a valid mid-setup state, not an error — synthesize a
        # vacuous-pass result so the workflow still publishes the
        # submit-tag release with status=success and a clear
        # "no autograder configured" summary.
        rc = harness["run"](bundle_response=None, default_response=None)
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert result["schema"] == "classroom50/result/v1"
        assert result["tests"] == []
        assert result["score"] == 0 and result["max-score"] == 0
        assert "no autograder configured" in body
        assert "status=success" in output
        assert "no autograder configured" in output


# ---------------------------------------------------------------------------
# main() — review link (full diff from the student's baseline)
# ---------------------------------------------------------------------------


class TestReviewLink:
    def _fake_writes(self, harness):
        def writes():
            (harness["workspace"] / "result.json").write_text(json.dumps(_v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )))
        return writes

    def test_review_url_env_is_full_diff_when_baseline_known(self, harness):
        rc = harness["run"](
            bundle_response=_build_tarball({"hello/autograder.py": "# grader"}),
            autograder_writes=self._fake_writes(harness),
            baseline="base999",
        )
        assert rc == 0
        assert harness["exec_env"]["REVIEW_URL"] == (
            "https://github.com/cs-test/cs-test-hello-alice/compare/base999...abc123"
        )

    def test_review_url_env_falls_back_to_commit_view_without_baseline(self, harness):
        rc = harness["run"](
            bundle_response=_build_tarball({"hello/autograder.py": "# grader"}),
            autograder_writes=self._fake_writes(harness),
            baseline=None,
        )
        assert rc == 0
        assert harness["exec_env"]["REVIEW_URL"] == (
            "https://github.com/cs-test/cs-test-hello-alice/commit/abc123"
        )

    def test_error_result_carries_full_diff_review(self, harness):
        # Synthesized error results carry the full diff too.
        import urllib.error
        rc = harness["run"](
            fetch_raises=urllib.error.URLError("connection refused"),
            baseline="base999",
        )
        assert rc == 0
        result, _, _ = _read_outputs(harness)
        assert result["review"] == (
            "https://github.com/cs-test/cs-test-hello-alice/compare/base999...abc123"
        )


# ---------------------------------------------------------------------------
# main() — Feedback PR baseline annotations + gate output
# ---------------------------------------------------------------------------


class TestFeedbackPrBaselineGate:
    """main() emits baseline-sha (the open/skip gate) and the right
    annotation per scan outcome: accept opens silently, root opens with
    an untrusted-baseline warning, git-error/none skip."""

    def _fake_writes(self, harness):
        def writes():
            (harness["workspace"] / "result.json").write_text(json.dumps(_v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )))
        return writes

    def test_accept_baseline_opens_silently(self, harness, capsys):
        rc = harness["run"](
            bundle_response=_build_tarball({"hello/autograder.py": "# grader"}),
            autograder_writes=self._fake_writes(harness),
            baseline="base999", baseline_source="accept",
        )
        assert rc == 0
        _, _, gh_output = _read_outputs(harness)
        assert "baseline-sha=base999" in gh_output  # gate: PR opens
        out = capsys.readouterr().out
        assert "untrusted" not in out.lower()
        assert "Feedback PR step will skip" not in out

    def test_root_baseline_opens_with_untrusted_warning(self, harness, capsys):
        # A root baseline still emits baseline-sha (PR opens) but warns
        # it's untrusted.
        rc = harness["run"](
            bundle_response=_build_tarball({"hello/autograder.py": "# grader"}),
            autograder_writes=self._fake_writes(harness),
            baseline="root111", baseline_source="root",
        )
        assert rc == 0
        _, _, gh_output = _read_outputs(harness)
        assert "baseline-sha=root111" in gh_output  # gate: PR still opens
        out = capsys.readouterr().out
        assert ag.untrusted_baseline_warning() in out

    def test_git_error_skips_with_git_error_warning(self, harness, capsys):
        rc = harness["run"](
            bundle_response=_build_tarball({"hello/autograder.py": "# grader"}),
            autograder_writes=self._fake_writes(harness),
            baseline=None, baseline_source="git-error",
        )
        assert rc == 0
        _, _, gh_output = _read_outputs(harness)
        assert "baseline-sha=" not in gh_output  # gate: PR skips
        out = capsys.readouterr().out
        assert "could not read git history" in out

    def test_no_repo_skips_with_no_history_warning(self, harness, capsys):
        rc = harness["run"](
            bundle_response=_build_tarball({"hello/autograder.py": "# grader"}),
            autograder_writes=self._fake_writes(harness),
            baseline=None, baseline_source="none",
        )
        assert rc == 0
        _, _, gh_output = _read_outputs(harness)
        assert "baseline-sha=" not in gh_output  # gate: PR skips
        out = capsys.readouterr().out
        assert "no git history found" in out


# ---------------------------------------------------------------------------
# main() — error paths route through Finalizer
# ---------------------------------------------------------------------------


class TestFinalizerRouting:
    """Every failure beyond env-validation should produce a synthetic
    v1 result.json + status=error so the workflow's release/commit-status
    steps still have something to publish. Without this, the gradebook
    silently drops the submission."""

    def test_bundle_fetch_failure_synthesizes_error(self, harness):
        import urllib.error
        rc = harness["run"](
            fetch_raises=urllib.error.URLError("connection refused")
        )
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert result["schema"] == "classroom50/result/v1"
        assert "bundle fetch failed" in body
        assert "status=error" in output

    def test_corrupt_bundle_synthesizes_error(self, harness):
        rc = harness["run"](bundle_response=b"not a tarball")
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert "bundle extraction failed" in body
        assert "status=error" in output

    def test_subprocess_oserror_synthesizes_error(self, harness):
        rc = harness["run"](
            subprocess_raises=OSError("python3 not found"),
        )
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert "failed to invoke" in body or "python3" in body
        assert "status=error" in output

    def test_autograder_nonzero_exit_synthesizes_error(self, harness):
        rc = harness["run"](autograder_rc=42)
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert "exited 42" in body
        assert "status=error" in output

    def test_no_result_json_synthesizes_error(self, harness):
        # Autograder ran (rc=0) but didn't write result.json.
        rc = harness["run"](autograder_rc=0)
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert "did not produce" in body
        assert "status=error" in output

    def test_malformed_result_json_synthesizes_error(self, harness):
        def fake_writes():
            (harness["workspace"] / "result.json").write_text("not json {{{")

        rc = harness["run"](autograder_writes=fake_writes)
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert "not valid JSON" in body
        assert "status=error" in output

    def test_invalid_result_schema_synthesizes_error(self, harness):
        def fake_writes():
            payload = _v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )
            payload["schema"] = "classroom50/result/v0"  # wrong version
            (harness["workspace"] / "result.json").write_text(json.dumps(payload))

        rc = harness["run"](autograder_writes=fake_writes)
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert "schema" in body
        assert "status=error" in output

    def test_result_json_with_wrong_classroom_synthesizes_error(self, harness):
        # Hand-edited .classroom50.yaml could direct a submission at
        # the wrong classroom. The runner refuses to publish a release
        # whose classroom doesn't match the env-passed value.
        def fake_writes():
            payload = _v1_payload(
                classroom="DIFFERENT-CLASSROOM", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )
            (harness["workspace"] / "result.json").write_text(json.dumps(payload))

        rc = harness["run"](autograder_writes=fake_writes)
        assert rc == 0
        result, body, output = _read_outputs(harness)
        assert "classroom" in body
        assert "status=error" in output


# ---------------------------------------------------------------------------
# main() — happy path output synthesis
# ---------------------------------------------------------------------------


class TestHappyPathSynthesis:
    """When the autograder produces a valid result.json, runner
    synthesizes release-body and status= ONLY when the autograder
    didn't write them itself. Verifies the autograder's outputs are
    preserved when present."""

    def test_minimal_autograder_only_writes_result(self, harness):
        # Autograder wrote only result.json — runner synthesizes
        # release-body.md and status=/summary= from it.
        def fake_writes():
            (harness["workspace"] / "result.json").write_text(json.dumps(_v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
                tests=[
                    {"test-name": "compiles", "passed": True, "score": 1, "max-score": 1},
                    {"test-name": "outputs_correct", "passed": False, "score": 0, "max-score": 1},
                ],
                score=1, max_score=2,
            )))

        rc = harness["run"](autograder_writes=fake_writes)
        assert rc == 0
        result, body, output = _read_outputs(harness)

        assert result["score"] == 1 and result["max-score"] == 2
        # Synthesized body has per-test table.
        assert "| compiles | PASS |" in body
        assert "| outputs_correct | FAIL |" in body
        # Synthesized status reflects 1/2 → failure.
        assert "status=failure" in output

    def test_autograder_status_summary_passthrough(self, harness):
        # Autograder wrote both result.json AND status=/summary= in
        # GITHUB_OUTPUT — runner uses those as-is, doesn't override.
        def fake_writes():
            (harness["workspace"] / "result.json").write_text(json.dumps(_v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )))
            with open(harness["gh_output"], "a") as fh:
                fh.write("status=success\n")
                fh.write("summary=autograder-set\n")

        rc = harness["run"](autograder_writes=fake_writes)
        assert rc == 0
        out = harness["gh_output"].read_text()
        # Only the autograder-set entries — runner didn't append.
        assert out.count("status=") == 1
        assert "status=success" in out
        assert "summary=autograder-set" in out

    def test_autograder_release_body_passthrough(self, harness):
        # Autograder wrote release-body.md — runner doesn't overwrite.
        def fake_writes():
            (harness["workspace"] / "result.json").write_text(json.dumps(_v1_payload(
                classroom="cs-test", assignment="hello", username="alice",
                submission="submit/2026-06-01T14-32-05Z-a1b2c3d",
            )))
            (harness["workspace"] / "release-body.md").write_text("CUSTOM BODY")

        rc = harness["run"](autograder_writes=fake_writes)
        assert rc == 0
        body = (harness["workspace"] / "release-body.md").read_text()
        assert body == "CUSTOM BODY"


# ---------------------------------------------------------------------------
# runtime_root() helper — dispatches on RUNNER_TEMP
# ---------------------------------------------------------------------------


class TestRuntimeRoot:
    def test_uses_runner_temp_when_set(self, monkeypatch, tmp_path):
        rt = tmp_path / "runner-temp"
        rt.mkdir()
        monkeypatch.setenv("RUNNER_TEMP", str(rt))
        assert ag.runtime_root() == rt / "classroom50-runtime"

    def test_falls_back_to_tempfile_when_runner_temp_unset(self, monkeypatch):
        monkeypatch.delenv("RUNNER_TEMP", raising=False)
        path = ag.runtime_root()
        # tempfile.mkdtemp returns an existing dir; verify it's usable.
        assert path.exists()
        assert path.is_dir()
        # And the prefix matches the convention.
        assert path.name.startswith("classroom50-runtime-")
