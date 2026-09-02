"""Parity of the cross-tool contract literals the embedded scripts hand-mirror.

The scripts are standalone (each is copied into a classroom repo and run by a
workflow), so they cannot import cli/shared or the web. Every constant they
share with Go and TypeScript is spelled by hand, and this module reads the
other sides' source to pin each spelling. The Go leg lives in
init_skeleton_test.go (TestStaffRolesParity_GoVsPythonVsWeb); this is the
Python leg plus the guidance text the three surfaces each phrase themselves.
"""

from __future__ import annotations

import pathlib
import re

from conftest import _load_module, _SCRIPTS_DIR
from conftest import collect_scores as cs
from conftest import materialize_tests as mt
from conftest import probe_token as pt

runner = _load_module("runner", _SCRIPTS_DIR / "runner.py")

_REPO_ROOT = _SCRIPTS_DIR.parents[4]
_CONTRACT_GO = _REPO_ROOT / "cli" / "shared" / "contract" / "contract.go"
_SERVICETOKEN_GO = (
    _REPO_ROOT / "cli" / "gh-teacher" / "internal" / "servicetoken" / "servicetoken.go"
)
_TEST_CMD_GO = (
    _REPO_ROOT / "cli" / "gh-teacher" / "internal" / "assignmentcmd" / "test_cmd.go"
)
_WEB_CLASSROOM_TS = _REPO_ROOT / "web" / "src" / "types" / "classroom.ts"


def _go_staff_roles() -> list[str]:
    """contract.StaffRoles in declaration order, resolved through the Role*
    constants so the test reads wire strings, not Go identifiers."""
    src = _CONTRACT_GO.read_text()
    values = dict(re.findall(r'(Role\w+)\s+StaffRole\s*=\s*"([a-z]+)"', src))
    block = re.search(r"var StaffRoles = \[\]StaffRole\{([^}]*)\}", src)
    assert block, "contract.StaffRoles literal not found in contract.go"
    return [values[name] for name in re.findall(r"Role\w+", block.group(1))]


def _web_staff_roles() -> list[str]:
    src = _WEB_CLASSROOM_TS.read_text()
    block = re.search(
        r"export const STAFF_ROLES: readonly StaffRole\[\] = \[([^\]]*)\]", src
    )
    assert block, "web STAFF_ROLES literal not found in classroom.ts"
    return re.findall(r'"([a-z]+)"', block.group(1))


class TestStaffRoles:
    def test_scripts_match_go_in_value_and_order(self):
        go = _go_staff_roles()
        assert list(cs.STAFF_ROLES) == go
        assert list(pt.STAFF_ROLES) == go

    def test_web_matches_go_in_value_and_order(self):
        assert _web_staff_roles() == _go_staff_roles()


class TestStaffTeamSlug:
    def test_both_scripts_derive_the_contract_shape(self):
        # contract.StaffTeamSlug: ConfigRepoName + "-" + short + "-" + role.
        src = _CONTRACT_GO.read_text()
        body = re.search(
            r"func StaffTeamSlug\(shortName string, role StaffRole\) string \{\n\s*return ([^\n]+)\n\}",
            src,
        )
        assert body and body.group(1).replace(" ", "") == (
            'ConfigRepoName+"-"+shortName+"-"+string(role)'
        ), "contract.StaffTeamSlug shape changed; update both scripts and this test"
        for role in cs.STAFF_ROLES:
            expected = f"classroom50-cs-{role}"
            assert cs.staff_team_slug("cs", role) == expected
            assert pt.resolve_staff_team_slugs({}, "cs")[role] == expected


# The four settings a service token needs. Each surface below phrases them in
# its own voice; every phrase must appear in each, or a permission added to one
# goes missing from another.
TOKEN_PERMISSION_PHRASES = (
    "All repositories",
    "Contents: Read and write",
    "Actions: Read and write",
    "Administration: Read and write",
    "Members: Read",
)


class TestTokenPermissionGuidance:
    def _go_constant(self) -> str:
        src = _SERVICETOKEN_GO.read_text()
        block = re.search(
            r"const RequiredTokenPermissions = ((?:\s*\"[^\"]*\"\s*\+?)+)", src
        )
        assert block, "RequiredTokenPermissions not found in servicetoken.go"
        return "".join(re.findall(r'"([^"]*)"', block.group(1)))

    def test_go_constant_names_every_setting(self):
        text = self._go_constant()
        for phrase in TOKEN_PERMISSION_PHRASES:
            assert phrase in text

    def test_collect_grant_hint_names_the_settings_it_can_fix(self, monkeypatch, capsys):
        # The grant-failure hint names what a 401/403 on the staff grant means:
        # the token cannot reach the student repos, or cannot administer them.
        # Reuses the Go constant's spellings so the two never disagree.
        src = pathlib.Path(cs.__file__).read_text()
        hint = re.search(r"grant_hint = \(\n((?:\s*f?\"[^\"]*\"\n)+)", src)
        assert hint, "grant_hint literal not found in collect_scores.py"
        text = "".join(re.findall(r'"([^"]*)"', hint.group(1)))
        for phrase in ("All repositories", "Administration: Read and write"):
            assert phrase in text
            assert phrase in self._go_constant()


class TestHandWrittenTestsGuidance:
    """runner.py, materialize_tests.py and `gh teacher assignment test` each
    tell a teacher not to commit tests.json by hand and where tests belong.
    Pin the shared facts so one surface cannot start pointing elsewhere."""

    def _texts(self) -> dict[str, str]:
        mt_src = pathlib.Path(mt.__file__).read_text()
        mt_warning = re.search(
            r'print\(f"::warning::\{target\}: replaced by the tests((?:[^)]|\n)*?)\)', mt_src
        )
        assert mt_warning, "materialize_tests.py hand-committed tests.json warning not found"
        return {
            "runner": runner.HAND_WRITTEN_TESTS_HINT,
            "materialize_tests": mt_warning.group(0),
            "test_cmd.go": _TEST_CMD_GO.read_text(),
        }

    def test_every_surface_says_tests_json_is_generated_and_where_tests_live(self):
        for name, text in self._texts().items():
            flat = " ".join(text.split())
            assert "tests.json" in flat, name
            assert "generate" in flat, name
            assert "gh teacher assignment test" in flat or "assignment test" in flat, name
