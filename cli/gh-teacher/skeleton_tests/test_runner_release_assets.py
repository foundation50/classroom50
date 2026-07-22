"""Exact release-asset validation and staging tests."""

from __future__ import annotations

import json
import os
import pathlib

import pytest

from conftest import _load_module, _SCRIPTS_DIR

runner = _load_module("release_assets_runner", _SCRIPTS_DIR / "runner.py")


@pytest.mark.parametrize(
    "paths",
    [
        [],
        ["report.pdf", "plots/chart.png", ".github/summary.txt"],
        ["generated*/report.pdf", "plots[2026]/chart.png"],
        ["nested/.git/report.pdf", "résumés 2026/summary.txt"],
        ["😀/report.pdf"],
        ["archive..old/report.pdf"],
        ["a" * 251 + ".pdf"],
        ["a/report.pdf", "b/Report.pdf"],
    ],
)
def test_validate_release_asset_paths_accepts_exact_paths(paths):
    assert runner.validate_release_asset_paths(paths) == paths


def test_validate_release_asset_paths_accepts_exact_cap():
    paths = [f"f{i}.pdf" for i in range(50)]
    assert runner.validate_release_asset_paths(paths) == paths


def test_validate_release_asset_paths_enforces_aggregate_utf8_path_byte_cap():
    p1 = "a" * 4094 + "/x"
    exact_p2 = "é" * 2047 + "/y"
    assert runner.validate_release_asset_paths([p1, exact_p2]) == [p1, exact_p2]

    over_p2 = "é" * 2047 + "z/y"
    with pytest.raises(ValueError):
        runner.validate_release_asset_paths([p1, over_p2])


@pytest.mark.parametrize("path", ["\ud800/report.pdf", "\udc00/report.pdf"])
def test_validate_release_asset_paths_rejects_unpaired_surrogates(path):
    with pytest.raises(ValueError, match="must not contain Unicode surrogates"):
        runner.validate_release_asset_paths([path])


@pytest.mark.parametrize(
    "value",
    [
        None, "report.pdf", {}, [1], [f"f{i}.pdf" for i in range(51)],
        [""], ["  "], ["/tmp/report.pdf"], ["C:/report.pdf"],
        [r"plots\\chart.png"], ["plots//chart.png"], ["./report.pdf"],
        ["plots/./chart.png"], ["../report.pdf"], ["plots/../report.pdf"],
        ["plots/"], ["a\nreport.pdf"], ["a\x7freport.pdf"],
        ["a\u0085report.pdf"],
        [".git/report.pdf"], [".GiT/report.pdf"], [".report.pdf"],
        ["report.pdf."], ["*.pdf"], ["résumé.pdf"],
        ["a" * 252 + ".pdf"], ["result.json"], ["nested/RESULT.JSON"],
        ["release-body.md"], ["nested/Release-Body.MD"],
        ["report..pdf"],
        ["report.pdf", "report.pdf"],
        ["one/report.pdf", "two/report.pdf"],
    ],
)
def test_validate_release_asset_paths_rejects_invalid_values(value):
    with pytest.raises(ValueError):
        runner.validate_release_asset_paths(value)


def test_parse_release_assets_handles_disabled_and_canonical_json():
    assert runner.parse_release_assets(None) == []
    assert runner.parse_release_assets("") == []
    assert runner.parse_release_assets("[]") == []
    assert runner.parse_release_assets(
        json.dumps(["report.pdf", "plots/chart.png"])
    ) == ["report.pdf", "plots/chart.png"]


@pytest.mark.parametrize("raw", ["null", "{}", '"report.pdf"', "not json"])
def test_parse_release_assets_rejects_invalid_json_shape(raw):
    with pytest.raises(ValueError):
        runner.parse_release_assets(raw)


def _write_file(root: pathlib.Path, relative: str, data: bytes = b"x") -> pathlib.Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _workspace(tmp_path: pathlib.Path) -> pathlib.Path:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return workspace


def test_copy_release_asset_cleanup_failure_preserves_copy_error(
    tmp_path, monkeypatch
):
    source = _write_file(tmp_path, "source.bin", b"12")
    destination = tmp_path / "destination.bin"
    real_unlink = pathlib.Path.unlink

    def fail_destination_unlink(path, missing_ok=False):
        if path == destination:
            raise OSError("cleanup failed")
        return real_unlink(path, missing_ok=missing_ok)

    monkeypatch.setattr(pathlib.Path, "unlink", fail_destination_unlink)

    source_fd = os.open(source, os.O_RDONLY)
    try:
        with pytest.raises(ValueError, match="exceeds the remaining byte budget"):
            runner._copy_release_asset(source_fd, destination, max_bytes=1)
    finally:
        os.close(source_fd)


def test_stage_release_assets_recreates_destination_and_preserves_order(tmp_path):
    workspace = _workspace(tmp_path)
    _write_file(workspace, "reports/report.pdf", b"report")
    _write_file(workspace, "plots/chart.png", b"chart")
    destination = _write_file(tmp_path, "staged/stale.txt", b"stale").parent

    accepted = runner.stage_release_assets(
        workspace,
        destination,
        ["reports/report.pdf", "plots/chart.png"],
    )

    assert accepted == ["report.pdf", "chart.png"]
    assert not (destination / "stale.txt").exists()
    assert (destination / "report.pdf").read_bytes() == b"report"
    assert (destination / "chart.png").read_bytes() == b"chart"


def test_stage_release_assets_skips_missing_symlink_and_oversized_files(
    tmp_path, monkeypatch, capsys
):
    workspace = _workspace(tmp_path)
    _write_file(workspace, "large.bin", b"12345")
    _write_file(workspace, "later.bin", b"1")
    if hasattr(os, "symlink"):
        (workspace / "linked.bin").symlink_to(workspace / "later.bin")
    monkeypatch.setattr(runner, "RELEASE_ASSETS_MAX_BYTES", 1)

    configured = ["missing.bin", "large.bin"]
    if hasattr(os, "symlink"):
        configured.append("linked.bin")
    configured.append("later.bin")
    accepted = runner.stage_release_assets(
        workspace, tmp_path / "staged", configured
    )

    assert accepted == ["later.bin"]
    assert "::warning::" in capsys.readouterr().out


def test_stage_release_assets_failed_copy_leaves_no_accepted_partial(
    tmp_path, monkeypatch
):
    workspace = _workspace(tmp_path)
    _write_file(workspace, "report.pdf", b"report")
    destination = tmp_path / "staged"
    real_copy = runner._copy_release_asset

    def fail_copy(source, target, max_bytes):
        target.write_bytes(b"partial")
        raise OSError("copy failed")

    monkeypatch.setattr(runner, "_copy_release_asset", fail_copy)
    assert runner.stage_release_assets(
        workspace, destination, ["report.pdf"]
    ) == []
    assert not (destination / "report.pdf").exists()
    monkeypatch.setattr(runner, "_copy_release_asset", real_copy)


def test_stage_release_assets_cleanup_failure_still_permits_later_asset(
    tmp_path, monkeypatch, capsys
):
    workspace = _workspace(tmp_path)
    _write_file(workspace, "failed.bin", b"12")
    _write_file(workspace, "later.bin", b"1")
    destination = tmp_path / "staged"
    failed_target = destination / "failed.bin"
    real_unlink = pathlib.Path.unlink

    def fail_target_unlink(path, missing_ok=False):
        if path == failed_target:
            raise OSError("cleanup failed")
        return real_unlink(path, missing_ok=missing_ok)

    monkeypatch.setattr(pathlib.Path, "unlink", fail_target_unlink)
    monkeypatch.setattr(runner, "RELEASE_ASSETS_MAX_BYTES", 1)

    accepted = runner.stage_release_assets(
        workspace, destination, ["failed.bin", "later.bin"]
    )

    assert accepted == ["later.bin"]
    assert (destination / "later.bin").read_bytes() == b"1"
    assert "failed.bin" not in accepted
    assert failed_target.exists()
    output = capsys.readouterr().out
    assert output.count("::warning::") == 1
    assert "'failed.bin'" in output


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unsupported")
def test_open_release_asset_source_rejects_parent_and_leaf_symlinks(tmp_path):
    workspace = _workspace(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    _write_file(outside, "report.pdf", b"outside")
    (workspace / "linked").symlink_to(outside, target_is_directory=True)
    (workspace / "report.pdf").symlink_to(outside / "report.pdf")

    for configured_path in ("linked/report.pdf", "report.pdf"):
        with pytest.raises(ValueError, match="contains a symlink"):
            runner.open_release_asset_source(workspace, configured_path)


def test_open_release_asset_source_returns_regular_file_fd(tmp_path):
    workspace = _workspace(tmp_path)
    _write_file(workspace, "reports/report.pdf", b"report")
    source_fd = runner.open_release_asset_source(workspace, "reports/report.pdf")
    try:
        assert os.read(source_fd, 1024) == b"report"
    finally:
        os.close(source_fd)


def test_open_release_asset_source_rejects_non_regular_leaf(tmp_path):
    workspace = _workspace(tmp_path)
    (workspace / "adir").mkdir()
    with pytest.raises(ValueError, match="is not a regular file"):
        runner.open_release_asset_source(workspace, "adir")


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unsupported")
def test_open_release_asset_source_rejects_toctou_symlink_swap(tmp_path):
    # The leaf is a real file at validation time; a swap to an out-of-workspace
    # symlink between validation and open must be rejected by O_NOFOLLOW rather
    # than silently followed (the validate-then-reopen TOCTOU).
    workspace = _workspace(tmp_path)
    outside = _write_file(tmp_path, "secret.txt", b"secret")
    leaf = _write_file(workspace, "report.pdf", b"report")

    real_validate = runner.validate_release_asset_paths

    def swap_then_validate(value):
        result = real_validate(value)
        leaf.unlink()
        leaf.symlink_to(outside)
        return result

    # Swap right after the in-function validate call, before the segment opens.
    import unittest.mock as mock

    with mock.patch.object(
        runner, "validate_release_asset_paths", side_effect=swap_then_validate
    ):
        with pytest.raises(ValueError, match="contains a symlink"):
            runner.open_release_asset_source(workspace, "report.pdf")


def test_stage_release_assets_case_folded_collision_keeps_first_file(
    tmp_path, capsys
):
    probe = _write_file(tmp_path, "case-probe", b"probe")
    if not probe.with_name("CASE-PROBE").exists():
        pytest.skip("case-insensitive filesystem required")

    workspace = _workspace(tmp_path)
    _write_file(workspace, "first/report.pdf", b"first")
    _write_file(workspace, "second/Report.pdf", b"second")
    destination = tmp_path / "staged"

    accepted = runner.stage_release_assets(
        workspace,
        destination,
        ["first/report.pdf", "second/Report.pdf"],
    )

    assert accepted == ["report.pdf"]
    assert (destination / "report.pdf").read_bytes() == b"first"
    assert capsys.readouterr().out.count("::warning::") == 1


def test_stage_release_assets_later_small_file_fits_remaining_budget(
    tmp_path, monkeypatch, capsys
):
    workspace = _workspace(tmp_path)
    _write_file(workspace, "first.bin", b"1234")
    _write_file(workspace, "too-large.bin", b"5678")
    _write_file(workspace, "later.bin", b"9")
    monkeypatch.setattr(runner, "RELEASE_ASSETS_MAX_BYTES", 5)

    destination = tmp_path / "staged"
    accepted = runner.stage_release_assets(
        workspace,
        destination,
        ["first.bin", "too-large.bin", "later.bin"],
    )

    assert accepted == ["first.bin", "later.bin"]
    assert sorted(path.name for path in destination.iterdir()) == [
        "first.bin",
        "later.bin",
    ]
    assert "too-large.bin" in capsys.readouterr().out


def _run_release_asset_staging(
    tmp_path, monkeypatch, *, configured, runner_temp, prestage=None
):
    """Drive main()'s post-grade release-asset staging block in isolation.

    main()'s full grading path needs network fetches, so we stub _grade to a
    no-op and run only the staging + $GITHUB_OUTPUT emission that follows it,
    exercising the same code the workflow's upload step depends on. Returns
    (returncode, parsed GITHUB_OUTPUT dict).
    """
    workspace = _workspace(tmp_path)
    if prestage:
        for rel, data in prestage.items():
            _write_file(workspace, rel, data)

    gh_output = tmp_path / "gh_output.txt"
    env = {
        "PAGES_BASE_URL": "https://example.invalid/pages",
        "CLASSROOM": "cs",
        "ASSIGNMENT": "hello",
        "SUBMISSION_TAG": "submit/1",
        "GITHUB_REPOSITORY": "test-org/cs-hello-student",
        "GITHUB_OUTPUT": str(gh_output),
        "RELEASE_ASSETS": json.dumps(configured),
    }
    if runner_temp is not None:
        env["RUNNER_TEMP"] = str(runner_temp)
    else:
        env.pop("RUNNER_TEMP", None)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    if runner_temp is None:
        monkeypatch.delenv("RUNNER_TEMP", raising=False)

    monkeypatch.chdir(workspace)
    rc = runner._stage_release_assets_and_emit(
        workspace, os.environ.get("GITHUB_OUTPUT"), rc=0
    )

    outputs = {}
    for line in gh_output.read_text().splitlines():
        key, _, value = line.partition("=")
        outputs[key] = value
    return rc, outputs


def test_main_staging_emits_dir_matching_workflow_and_names(
    tmp_path, monkeypatch
):
    runner_temp = tmp_path / "runner_temp"
    runner_temp.mkdir()
    rc, outputs = _run_release_asset_staging(
        tmp_path,
        monkeypatch,
        configured=["report.pdf", "plots/chart.png"],
        runner_temp=runner_temp,
        prestage={"report.pdf": b"r", "plots/chart.png": b"c"},
    )

    assert rc == 0
    # The emitted dir MUST equal ${RUNNER_TEMP}/classroom50-release-assets — the
    # exact path the workflow upload step reads from (release-assets-dir output).
    expected_dir = runner_temp / runner.RELEASE_ASSETS_DIRNAME
    assert outputs["release-assets-dir"] == str(expected_dir)
    assert outputs["release-assets"] == "report.pdf,chart.png"
    assert outputs["release-assets-skipped"] == "0"
    assert (expected_dir / "report.pdf").read_bytes() == b"r"
    assert (expected_dir / "chart.png").read_bytes() == b"c"


def test_main_staging_dir_output_is_where_files_land_when_runner_temp_unset(
    tmp_path, monkeypatch
):
    # With RUNNER_TEMP unset the dir is a random mkdtemp path, but the emitted
    # release-assets-dir output must point at exactly that same dir so the
    # workflow reads from where the runner wrote (no fallback divergence).
    rc, outputs = _run_release_asset_staging(
        tmp_path,
        monkeypatch,
        configured=["report.pdf"],
        runner_temp=None,
        prestage={"report.pdf": b"r"},
    )

    assert rc == 0
    staged_dir = pathlib.Path(outputs["release-assets-dir"])
    assert staged_dir.name == runner.RELEASE_ASSETS_DIRNAME
    assert (staged_dir / "report.pdf").read_bytes() == b"r"
    assert outputs["release-assets"] == "report.pdf"


def test_main_staging_emits_skipped_count_and_notice(tmp_path, monkeypatch, capsys):
    runner_temp = tmp_path / "runner_temp"
    runner_temp.mkdir()
    rc, outputs = _run_release_asset_staging(
        tmp_path,
        monkeypatch,
        configured=["present.pdf", "missing.pdf"],
        runner_temp=runner_temp,
        prestage={"present.pdf": b"p"},
    )

    assert rc == 0
    assert outputs["release-assets"] == "present.pdf"
    assert outputs["release-assets-skipped"] == "1"
    assert "::notice::release_assets: attached 1 of 2" in capsys.readouterr().out
