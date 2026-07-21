"""Behavioral tests for the inline Python validator embedded in
autograde-runner.yaml's setup job.

The validator runs in production on every submission against a
teacher-controlled assignments.json + a student-controlled .classroom50.yaml,
and it's the last gate before runtime values flow into the grade job's
`runs-on:`/`container:` mapping. Drift between it and `runtime.go` (CLI
write-time) would let injection past one or the other untested.

These tests extract the YAML-embedded `shell: python3 {0}` block, write it to a
tempfile, and exec it as a subprocess with hand-crafted .classroom50.yaml +
assignments.json fixtures so the validator's allow-lists, regexes, and emit
shape can be exercised independently of the rest of the workflow.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml


_REPO_ROOT = Path(__file__).resolve().parents[3]
_RUNNER_YAML = (
    _REPO_ROOT / "cli" / "gh-teacher" / "skeleton"
    / "dotgithub" / "workflows" / "autograde-runner.yaml"
)


def _extract_inline_python() -> str:
    """Pull the inline Python validator body out of the setup-job's `read`
    step, identified by its `id: read` + `shell: python3 {0}` pair."""
    doc = yaml.safe_load(_RUNNER_YAML.read_text())
    setup_steps = doc["jobs"]["setup"]["steps"]
    for step in setup_steps:
        if step.get("id") == "read" and step.get("shell") == "python3 {0}":
            return step["run"]
    raise RuntimeError("setup.read step with shell: python3 {0} not found")


@pytest.fixture(scope="module")
def inline_script() -> str:
    """The validator body, captured once per module."""
    return _extract_inline_python()


def _run_validator(
    inline_script: str,
    tmp_path: Path,
    *,
    classroom50_yaml: str,
    manifest: dict | None,
    submission_tag: str = "submit/2026-06-01T14-32-05Z-a1b2c3d",
    extra_env: dict | None = None,
) -> tuple[int, str, str, dict]:
    """Run the inline validator with hand-crafted env + fixtures.

    Stubs network: the validator's `get(manifest_url)` hits a file:// URL
    pointing at the local manifest fixture instead of GitHub Pages.
    Manifest=None → no file written, simulating a 404 (validator should fail
    gracefully).

    Returns (exit_code, stdout, stderr, parsed-GITHUB_OUTPUT-as-dict).
    """
    workdir = tmp_path / "workspace"
    workdir.mkdir()
    (workdir / ".classroom50.yaml").write_text(classroom50_yaml)

    pages_root = tmp_path / "pages"
    pages_root.mkdir()
    classroom_dir = pages_root / "cs-test"
    classroom_dir.mkdir()
    if manifest is not None:
        (classroom_dir / "assignments.json").write_text(json.dumps(manifest))

    script_path = tmp_path / "validator.py"
    script_path.write_text(inline_script)

    gh_output = tmp_path / "github-output"
    gh_output.write_text("")

    # Serve the validator's Pages fetch from a local file:// URL. The script
    # composes `https://{REPO_OWNER}.github.io/classroom50` from env itself, so
    # rather than intercept that, a tiny wrapper monkey-patches urlopen before
    # exec'ing the validator to serve the URL from the pages_root fixture.

    wrapper = textwrap.dedent(f"""
    import urllib.request
    import urllib.error
    import os
    from pathlib import Path

    _PAGES_ROOT = Path({str(pages_root)!r})

    _real_urlopen = urllib.request.urlopen

    def _file_urlopen(req, *args, **kwargs):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if url.startswith("https://test-org.github.io/classroom50/"):
            rel = url.removeprefix("https://test-org.github.io/classroom50/")
            target = _PAGES_ROOT / rel
            if not target.is_file():
                raise urllib.error.HTTPError(url, 404, "Not Found", {{}}, None)
            return open(target, "rb")
        return _real_urlopen(req, *args, **kwargs)

    urllib.request.urlopen = _file_urlopen

    with open({str(script_path)!r}) as fh:
        exec(compile(fh.read(), {str(script_path)!r}, "exec"), {{"__name__": "__main__"}})
    """)
    wrapper_path = tmp_path / "wrapper.py"
    wrapper_path.write_text(wrapper)

    env = dict(os.environ)
    env.update({
        "SUBMISSION_TAG": submission_tag,
        "REPO_OWNER": "test-org",
        "GITHUB_REPOSITORY": "test-org/cs-test-hello-student",
        "GITHUB_OUTPUT": str(gh_output),
        "GITHUB_REF_NAME": submission_tag,
    })
    if extra_env:
        env.update(extra_env)

    proc = subprocess.run(
        [sys.executable, str(wrapper_path)],
        cwd=str(workdir),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    outputs = {}
    if gh_output.exists():
        for line in gh_output.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                outputs[k] = v

    return proc.returncode, proc.stdout, proc.stderr, outputs


def _classroom_yaml(classroom: str = "cs-test", assignment: str = "hello") -> str:
    """Minimum .classroom50.yaml the validator accepts."""
    return f"classroom: {classroom}\nassignment: {assignment}\n"


_MISSING = object()


def _manifest(*, slug: str = "hello", runtime: dict | None = None,
              tests: list | None = None,
              release_assets: object = _MISSING) -> dict:
    """Minimum assignments.json with one entry, optional runtime/tests."""
    entry = {
        "slug": slug,
        "name": "Hello",
        "template": {"owner": "x", "repo": "y", "branch": "main"},
        "mode": "individual",
        "autograder": "default",
    }
    if runtime is not None:
        entry["runtime"] = runtime
    if tests is not None:
        entry["tests"] = tests
    if release_assets is not _MISSING:
        entry["release_assets"] = release_assets
    return {
        "schema": "classroom50/assignments/v1",
        "assignments": [entry],
    }


# ---------------------------------------------------------------------------
# Happy paths — runtime block is omitted, host-only, or container
# ---------------------------------------------------------------------------


class TestValidatorHappyPaths:
    def test_no_runtime_defaults_to_ubuntu_latest_python_312(self, inline_script, tmp_path):
        rc, _stdout, _stderr, outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(),
        )
        assert rc == 0
        # runs-on is emitted as a JSON array (consumed via fromJSON) so
        # multi-label custom runners share one code path with hosted labels.
        assert outputs.get("runs-on") == '["ubuntu-latest"]'
        assert outputs.get("python") == "3.12"
        assert outputs.get("container") == "null"

    def test_host_runtime_with_python_apt(self, inline_script, tmp_path):
        rc, _stdout, _stderr, outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={
                "runs-on": "ubuntu-22.04",
                "python": "3.11",
                "apt": ["build-essential", "valgrind"],
            }),
        )
        assert rc == 0
        assert outputs["runs-on"] == '["ubuntu-22.04"]'
        assert outputs["python"] == "3.11"
        assert outputs["apt"] == "build-essential valgrind"
        assert outputs["container"] == "null"

    def test_host_runtime_with_rust_emitted(self, inline_script, tmp_path):
        # Rust has no first-party setup action (provisioned via
        # dtolnay/rust-toolchain), but the validator treats it like any
        # other language field: shape-checked and emitted verbatim.
        rc, _stdout, _stderr, outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"rust": "1.79"}),
        )
        assert rc == 0
        assert outputs["rust"] == "1.79"
        assert outputs["container"] == "null"

    def test_container_with_user_translates_to_options(self, inline_script, tmp_path):
        rc, _stdout, _stderr, outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={
                "container": {"image": "cs50/cli:latest", "user": "root"},
            }),
        )
        assert rc == 0
        container = json.loads(outputs["container"])
        assert container["image"] == "cs50/cli:latest"
        assert container["options"] == "--user root"
        # `user` is NOT emitted — Actions doesn't accept container.user.
        assert "user" not in container

    def test_custom_runner_array_emitted_as_array(self, inline_script, tmp_path):
        # Custom / self-hosted runner: a runs-on
        # array bypasses any hosted-label assumption and is emitted
        # verbatim as the runs-on JSON array.
        rc, _stdout, _stderr, outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={
                "runs-on": ["self-hosted", "gpu"],
                "python": "3.12",
            }),
        )
        assert rc == 0
        assert json.loads(outputs["runs-on"]) == ["self-hosted", "gpu"]
        assert outputs["python"] == "3.12"
        assert outputs["container"] == "null"

    def test_custom_single_label_emitted_as_array(self, inline_script, tmp_path):
        # A single arbitrary (non-hosted) label string is accepted with
        # no allow-list and normalized into the one-element runs-on array.
        rc, _stdout, _stderr, outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"runs-on": "self-hosted"}),
        )
        assert rc == 0
        assert json.loads(outputs["runs-on"]) == ["self-hosted"]


# ---------------------------------------------------------------------------
# runs-on rejection paths (mirror runtime.go ValidateRunsOn)
# ---------------------------------------------------------------------------


class TestRunsOnRejection:
    def test_runs_on_label_with_metacharacters_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"runs-on": "self-hosted; rm -rf /"}),
        )
        assert rc != 0
        assert "runtime.runs-on" in stderr

    def test_runs_on_array_element_with_whitespace_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"runs-on": ["self hosted"]}),
        )
        assert rc != 0
        assert "runtime.runs-on" in stderr

    def test_too_many_runs_on_labels_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"runs-on": [f"l{i}" for i in range(11)]}),
        )
        assert rc != 0
        assert "max 10" in stderr

    def test_runs_on_wrong_type_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"runs-on": 123}),
        )
        assert rc != 0
        assert "Traceback" not in stderr
        assert "runtime.runs-on" in stderr

    def test_empty_string_runs_on_rejected(self, inline_script, tmp_path):
        # Degenerate present-but-empty form: rejected so the inline
        # validator agrees with Go's UnmarshalJSON and the schema.
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"runs-on": ""}),
        )
        assert rc != 0
        assert "empty string" in stderr

    def test_empty_array_runs_on_rejected(self, inline_script, tmp_path):
        # Degenerate present-but-empty form: rejected (omit runs-on to
        # use the default). Mirrors Go + the schema's minItems:1.
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"runs-on": []}),
        )
        assert rc != 0
        assert "empty array" in stderr

    def test_array_with_non_string_element_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"runs-on": ["self-hosted", 1]}),
        )
        assert rc != 0
        assert "Traceback" not in stderr
        assert "runtime.runs-on" in stderr

    def test_multi_label_array_with_windows_and_container_rejected(self, inline_script, tmp_path):
        # The macos-/windows- container rejection must fire on any
        # element of a multi-label array, not just a single label.
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={
                "runs-on": ["self-hosted", "windows-2022"],
                "container": {"image": "ubuntu:24.04"},
            }),
        )
        assert rc != 0
        assert "Ubuntu hosts only" in stderr


# ---------------------------------------------------------------------------
# Allow-by-omission protection (#1 from the audit)
# ---------------------------------------------------------------------------


class TestUnknownKeyRejection:
    """Hand-edited assignments.json with extra keys must be rejected by the
    runtime validator, mirroring Go's DisallowUnknownFields. Without this,
    `container.options: --privileged` would flow through to the grade job."""

    def test_unknown_runtime_key_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={
                "python": "3.12",
                "options": "--privileged",  # would be smuggled through
            }),
        )
        assert rc != 0
        assert "runtime has unsupported keys" in stderr or "unsupported" in stderr

    def test_unknown_container_key_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={
                "container": {
                    "image": "ubuntu:latest",
                    "options": "--privileged",  # the headline P1 attack
                },
            }),
        )
        assert rc != 0
        assert "runtime.container has unsupported keys" in stderr or "unsupported" in stderr


# ---------------------------------------------------------------------------
# Field validation — regex + isinstance guards
# ---------------------------------------------------------------------------


class TestFieldValidation:
    def test_empty_image_rejected_with_clear_message(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"container": {"image": ""}}),
        )
        assert rc != 0
        # Empty image now produces a specific message, not the generic
        # "characters other than ..." regex error.
        assert "must not be empty" in stderr

    def test_image_with_shell_metacharacters_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"container": {"image": "ubuntu:24.04;rm -rf /"}}),
        )
        assert rc != 0
        assert "image" in stderr

    def test_python_non_string_rejected(self, inline_script, tmp_path):
        # JSON-numeric python field. Without the isinstance guard, the
        # regex match call would raise TypeError (uncaught → traceback,
        # not a clean fail()).
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"python": 312}),
        )
        assert rc != 0
        # Either caught by isinstance guard → clean fail message,
        # or by the regex check. Either way, no Python traceback.
        assert "Traceback" not in stderr
        assert "python" in stderr

    def test_rust_with_shell_metacharacters_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={"rust": "1.79; rm -rf /"}),
        )
        assert rc != 0
        assert "rust" in stderr

    def test_user_with_shell_metacharacters_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(runtime={
                "container": {"image": "cs50/cli:latest", "user": "root; rm -rf /"},
            }),
        )
        assert rc != 0
        assert "runtime.container.user" in stderr


# ---------------------------------------------------------------------------
# Declarative tests block — re-validation mirroring tests.go
# ---------------------------------------------------------------------------


class TestDeclarativeTestsValidation:
    """The setup job re-validates the `tests` block (mirroring
    cli/gh-teacher/tests.go, like the runtime block's dual validation): a
    hand-edited assignments.json must fail at setup with a clear message, and
    nothing from `tests` may reach the job outputs."""

    def test_valid_tests_pass_and_never_reach_outputs(self, inline_script, tmp_path):
        rc, _stdout, _stderr, outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "compiles", "type": "run",
                 "run": "gcc -o hello hello.c", "timeout": 30, "points": 1},
                {"name": "prints", "type": "io", "run": "./hello",
                 "expected": "Hello, world!", "comparison": "included", "points": 2},
                {"name": "pytest suite", "type": "python",
                 "run": "python -m pytest -q", "timeout": 120, "points": 10},
            ]),
        )
        assert rc == 0
        assert outputs.get("runs-on") == '["ubuntu-latest"]'
        # Test specs are bundle data, never workflow outputs.
        joined = "\n".join(f"{k}={v}" for k, v in outputs.items())
        assert "gcc" not in joined
        assert "tests" not in outputs

    def test_tests_must_be_an_array(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests={"name": "not-a-list"}),
        )
        assert rc != 0
        assert "tests must be an array" in stderr

    def test_unknown_test_key_rejected(self, inline_script, tmp_path):
        # Mirrors Go's DisallowUnknownFields: a typo'd `compare` (it's
        # `comparison`) fails loudly instead of being silently ignored.
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "t", "type": "io", "run": "x",
                 "expected": "y", "compare": "exact", "points": 1},
            ]),
        )
        assert rc != 0
        assert "unsupported keys" in stderr and "compare" in stderr

    def test_invalid_type_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "t", "type": "nope", "run": "x", "points": 1},
            ]),
        )
        assert rc != 0
        assert "type" in stderr and "nope" in stderr

    def test_duplicate_names_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "same", "type": "run", "run": "true", "points": 1},
                {"name": "same", "type": "run", "run": "false", "points": 1},
            ]),
        )
        assert rc != 0
        assert "duplicate test name" in stderr

    def test_io_missing_expected_rejected(self, inline_script, tmp_path):
        # included/regex against an empty expected matches everything —
        # the always-pass footgun tests.go also rejects.
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "t", "type": "io", "run": "./hello",
                 "comparison": "included", "points": 1},
            ]),
        )
        assert rc != 0
        assert "expected" in stderr

    def test_io_only_field_on_run_test_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "t", "type": "run", "run": "true",
                 "expected": "oops", "points": 1},
            ]),
        )
        assert rc != 0
        assert "only valid for an io test" in stderr

    def test_out_of_bounds_timeout_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "t", "type": "run", "run": "true",
                 "timeout": 9999, "points": 1},
            ]),
        )
        assert rc != 0
        assert "timeout" in stderr

    def test_non_integer_points_rejected_cleanly(self, inline_script, tmp_path):
        # No traceback: the isinstance guard catches it, like the
        # runtime block's python-version check.
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "t", "type": "run", "run": "true", "points": "many"},
            ]),
        )
        assert rc != 0
        assert "Traceback" not in stderr
        assert "points" in stderr

    def test_count_cap_rejected(self, inline_script, tmp_path):
        too_many = [{"name": f"t{i}", "type": "run", "run": "true", "points": 1}
                    for i in range(101)]
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=too_many),
        )
        assert rc != 0
        assert "too many tests" in stderr

    def test_name_length_is_byte_based(self, inline_script, tmp_path):
        # Mirrors Go's len() on the UTF-8 string: 40 three-byte chars is
        # 40 characters but 120 bytes, so it must be rejected.
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "\u4e16" * 40, "type": "run", "run": "true", "points": 1},
            ]),
        )
        assert rc != 0
        assert "100 bytes" in stderr

    def test_exit_code_on_io_test_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(tests=[
                {"name": "t", "type": "io", "run": "./hello", "expected": "hi",
                 "comparison": "included", "exit-code": 0, "points": 1},
            ]),
        )
        assert rc != 0
        assert "exit-code" in stderr


# ---------------------------------------------------------------------------
# Auth/identity invariants
# ---------------------------------------------------------------------------


class TestIdentityInvariants:
    def test_classroom50_yaml_missing_classroom_field_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml="assignment: hello\n",  # no classroom
            manifest=_manifest(),
        )
        assert rc != 0
        assert "classroom" in stderr

    def test_assignment_not_in_manifest_rejected(self, inline_script, tmp_path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml=_classroom_yaml(assignment="missing-slug"),
            manifest=_manifest(),  # only "hello" registered
        )
        assert rc != 0
        assert "missing-slug" in stderr

    def test_classroom_with_path_traversal_rejected(self, inline_script, tmp_path):
        # The slug regex blocks anything but [a-z0-9-]; a hand-edited
        # .classroom50.yaml with `classroom: ../../etc` should fail.
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script, tmp_path,
            classroom50_yaml="classroom: ../../etc\nassignment: hello\n",
            manifest=_manifest(),
        )
        assert rc != 0
        assert "classroom" in stderr


class TestReleaseAssetsValidation:
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
            ["a" * 4094 + "/x", "é" * 2047 + "/y"],
        ],
    )
    def test_emits_compact_ordered_json(self, inline_script, tmp_path, paths):
        rc, _stdout, _stderr, outputs = _run_validator(
            inline_script,
            tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(release_assets=paths),
        )
        assert rc == 0
        assert outputs["release-assets"] == json.dumps(
            paths, separators=(",", ":"), ensure_ascii=False
        )

    @pytest.mark.parametrize(
        "value",
        [
            None, "report.pdf", [1], [f"f{i}.pdf" for i in range(51)],
            [""], ["  "],
            ["report.pdf", "report.pdf"],
            ["a/report.pdf", "b/report.pdf"],
            ["/tmp/report.pdf"], ["C:/report.pdf"], [r"plots\\chart.png"],
            ["plots//chart.png"], ["./report.pdf"], ["../report.pdf"],
            ["plots/../report.pdf"], ["plots/"], ["a\nreport.pdf"],
            ["a\x7freport.pdf"], ["a\u0085report.pdf"],
            [".GiT/report.pdf"], [".report.pdf"], ["report.pdf."],
            ["*.pdf"], ["résumé.pdf"], ["a" * 252 + ".pdf"],
            ["result.json"], ["nested/Release-Body.MD"],
            ["report..pdf"],
            ["a" * 4094 + "/x", "é" * 2047 + "z/y"],
        ],
    )
    def test_rejects_invalid_configuration(self, inline_script, tmp_path, value):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script,
            tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(release_assets=value),
        )
        assert rc != 0
        assert "release_assets" in stderr

    @pytest.mark.parametrize("path", ["\ud800/report.pdf", "\udc00/report.pdf"])
    def test_rejects_unpaired_surrogates(self, inline_script, tmp_path, path):
        rc, _stdout, stderr, _outputs = _run_validator(
            inline_script,
            tmp_path,
            classroom50_yaml=_classroom_yaml(),
            manifest=_manifest(release_assets=[path]),
        )
        assert rc != 0
        assert "must not contain Unicode surrogates" in stderr
