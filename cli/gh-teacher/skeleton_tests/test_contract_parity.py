"""Parity of the cross-tool contract literals the embedded scripts hand-mirror.

The scripts are standalone (each is copied into a classroom repo and run by a
workflow), so they cannot import cli/shared or the web. Every constant they
share with Go and TypeScript is spelled by hand, and this module reads the
other sides' source to pin each spelling. The Go legs live in
init_skeleton_test.go (TestStaffRolesParity_GoVsPythonVsWeb and
TestStaffTeamSlugParity_GoVsPython); this is the Python leg plus the guidance
text the three surfaces each phrase themselves.
"""

from __future__ import annotations

import math
import pathlib
import re

from conftest import _load_module, _SCRIPTS_DIR
from conftest import collect_scores as cs
from conftest import materialize_tests as mt
from conftest import probe_token as pt
from conftest import regrade_repos as rr

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
_WEB_RELEASE_READS_TS = (
    _REPO_ROOT / "web" / "src" / "github-core" / "queries" / "releaseRunReads.ts"
)
_DOWNLOAD_GO = (
    _REPO_ROOT / "cli" / "gh-teacher" / "internal" / "download" / "download.go"
)


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


class TestAcceptMarkerPath:
    def test_scripts_match_contract_metadata_path(self):
        # The acceptance commit is "the one that added the accept marker" in
        # three scripts; each spells the path by hand, so pin all of them to the
        # Go source of truth.
        src = _CONTRACT_GO.read_text()
        go = re.search(r'MetadataPath\s*=\s*"([^"]+)"', src)
        assert go, "contract.MetadataPath not found in contract.go"
        for module in (runner, cs, rr):
            assert module.ACCEPT_MARKER_PATH == go.group(1), module.__name__


class TestAutogradeReleaseAuthor:
    def test_collector_matches_go_and_web(self):
        # Three hand spellings; a drift makes one reader disagree with the others.
        go = re.search(r'AutogradeReleaseAuthor\s*=\s*"([^"]+)"', _CONTRACT_GO.read_text())
        assert go, "contract.AutogradeReleaseAuthor not found in contract.go"
        web = re.search(
            r'export const AUTOGRADE_RELEASE_AUTHOR\s*=\s*"([^"]+)"',
            _WEB_RELEASE_READS_TS.read_text(),
        )
        assert web, "web AUTOGRADE_RELEASE_AUTHOR not found in releaseRunReads.ts"
        assert cs.AUTOGRADE_RELEASE_AUTHOR == go.group(1) == web.group(1)


class TestResultSniff:
    def test_sniff_ceiling_covers_every_reader(self):
        # The runner refuses a release_assets file shaped like a result only up
        # to RESULT_SNIFF_MAX_BYTES. A reader that accepted a larger result.json
        # would reopen the rename route for files between the two sizes.
        go = re.search(r"maxResultBytes\s*=\s*([\d\s*]+)", _DOWNLOAD_GO.read_text())
        assert go, "maxResultBytes not found in download.go"
        go_bytes = math.prod(int(factor) for factor in go.group(1).split("*"))
        assert runner.RESULT_SNIFF_MAX_BYTES >= cs.MAX_RESULT_BYTES
        assert runner.RESULT_SNIFF_MAX_BYTES >= go_bytes

    def test_sniff_prefix_matches_the_schema_the_readers_accept(self):
        assert cs.RESULT_SCHEMA_V1.startswith(runner.RESULT_SCHEMA_PREFIX)
        go = re.search(r'resultSchemaV1\s*=\s*"([^"]+)"', _DOWNLOAD_GO.read_text())
        assert go, "resultSchemaV1 not found in download.go"
        assert go.group(1) == cs.RESULT_SCHEMA_V1 == runner.RESULT_SCHEMA_V1


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


# The settings a service token needs. The Go constant and the rotate help must
# name all of them; the collect grant hint names only the two a grant 401/403
# can mean (see the tests below).
TOKEN_PERMISSION_PHRASES = (
    "All repositories",
    "Contents: Read and write",
    "Actions: Read and write",
    "Workflows: Read and write",
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

    def test_probe_and_init_remediation_name_every_permission(self):
        # probe-token's failure remediation and `gh teacher init`'s help are the
        # two other places a teacher is told what to grant when creating the
        # token; a permission added to the Go constant must reach both. Each is
        # narrowed to the one literal a teacher reads, so a phrase living
        # elsewhere in the file (a docstring, an unrelated message) can't
        # satisfy the check for it.
        probe_src = pathlib.Path(pt.__file__).read_text()
        init_src = (_REPO_ROOT / "cli" / "gh-teacher" / "init.go").read_text()
        probe_block = re.search(
            r'emit_error\(\n((?:\s*f?"[^"]*"\n)+)\s*\)\n\s*return 1',
            probe_src[probe_src.index("service token probe FAILED") - 200 :],
        )
        assert probe_block, "probe_token.py FAILED remediation literal not found"
        probe_text = " ".join(re.findall(r'f?"([^"]*)"', probe_block.group(1)))
        assert "service token probe FAILED" in probe_text
        start = init_src.rfind("\n", 0, init_src.index("Create a fine-grained personal access token"))
        end = init_src.index("\n", init_src.index("init validates the token", start))
        init_text = " ".join(re.findall(r'"([^"]*)"', init_src[start:end])).replace("\\n", " ")
        for phrase in TOKEN_PERMISSION_PHRASES[1:]:  # "All repositories" is phrased differently
            assert phrase in " ".join(probe_text.split()), phrase
            assert phrase in " ".join(init_text.split()), phrase

    def test_web_prefill_url_requests_every_permission(self):
        # The web app prefills the PAT creation form from buildServiceTokenUrl;
        # a permission added to the Go constant must be requested there too, or
        # a teacher following the link creates a token the pipeline rejects.
        src = (_REPO_ROOT / "web" / "src" / "pages" / "OrgSettingsPage.tsx").read_text()
        fn = re.search(
            r"function buildServiceTokenUrl\(.*?new URLSearchParams\(\{(.*?)\}\)", src, re.S
        )
        assert fn, "buildServiceTokenUrl URLSearchParams literal not found"
        params = dict(re.findall(r'^\s*(\w+):\s*"(\w+)",', fn.group(1), re.M))
        expected = {}
        for phrase in TOKEN_PERMISSION_PHRASES[1:]:
            name, _, access = phrase.partition(": ")
            expected[name.lower()] = "write" if access == "Read and write" else "read"
        assert {k: params.get(k) for k in expected} == expected

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
