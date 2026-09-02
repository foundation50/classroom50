"""Tests for runner.run_entrypoint's CLASSROOM50_BUNDLE_DIR: the env var must
name the extracted per-assignment bundle even when the entrypoint is the
classroom DEFAULT autograder.py (written beside the bundle, not inside it)."""

from __future__ import annotations

import pathlib
import subprocess
from types import SimpleNamespace

from conftest import _load_module, _SCRIPTS_DIR

runner = _load_module("runner", _SCRIPTS_DIR / "runner.py")


def _finalize() -> SimpleNamespace:
    return SimpleNamespace(
        username="alice",
        assignment_type="individual",
        commit_link="c",
        release_link="r",
        review_link="v",
        error=lambda message: 1,
    )


def _capture_env(monkeypatch) -> dict[str, str]:
    seen: dict[str, str] = {}

    def fake_run(argv, cwd, env, check):
        seen.update(env)
        return subprocess.CompletedProcess(args=argv, returncode=0)

    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    return seen


def test_default_entrypoint_gets_the_extracted_bundle(tmp_path: pathlib.Path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    bundle_dir = runtime_dir / "hw1"
    bundle_dir.mkdir(parents=True)
    (bundle_dir / "check.sh").write_text("exit 0\n")
    entrypoint = runtime_dir / runner.ENTRYPOINT_FILENAME
    entrypoint.write_text("")
    env = _capture_env(monkeypatch)

    rc = runner.run_entrypoint(
        _finalize(), entrypoint, tmp_path / "ws", bundle_dir=bundle_dir,
    )

    assert rc is None
    assert env[runner.BUNDLE_DIR_ENV] == str(bundle_dir.resolve())


def test_no_bundle_falls_back_to_the_entrypoint_directory(tmp_path: pathlib.Path, monkeypatch):
    # The bundle 404ed, so nothing was extracted; the classroom default still
    # gets a real directory to point at.
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    entrypoint = runtime_dir / runner.ENTRYPOINT_FILENAME
    entrypoint.write_text("")
    env = _capture_env(monkeypatch)

    runner.run_entrypoint(
        _finalize(), entrypoint, tmp_path / "ws", bundle_dir=runtime_dir / "hw1",
    )

    assert env[runner.BUNDLE_DIR_ENV] == str(runtime_dir.resolve())


def test_per_assignment_entrypoint_is_inside_the_bundle(tmp_path: pathlib.Path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    bundle_dir = runtime_dir / "hw1"
    bundle_dir.mkdir(parents=True)
    entrypoint = bundle_dir / runner.ENTRYPOINT_FILENAME
    entrypoint.write_text("")
    env = _capture_env(monkeypatch)

    runner.run_entrypoint(_finalize(), entrypoint, tmp_path / "ws", bundle_dir=bundle_dir)

    assert env[runner.BUNDLE_DIR_ENV] == str(bundle_dir.resolve())
