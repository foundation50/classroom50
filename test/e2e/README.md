# Live end-to-end suite (`test/e2e`)

A real, no-mocks harness: it builds the actual `gh-teacher` / `gh-student` binaries from the current
branch and drives the teacher↔student happy path against a **dedicated throwaway GitHub org**,
asserting the result via the GitHub REST API. It mirrors the manual E2E plan **§0–6 + §8** (single-
student happy path) and **§7** (the group round trip), the latter gated on a second student account
(`E2E_STUDENT2_PAT`) and skipped otherwise.

> ⚠️ **Destructive.** Every run **teardown-firsts and teardown-lasts** — it deletes *every repo* in
> the target org. Point it only at a throwaway org you own.

## Gating

The suite is doubly gated and is a **clean no-op** when either gate is unmet:

- Build tag: files are `//go:build e2e`, so a plain `go test ./...` builds nothing here.
- Credentials: `TestMain` exits 0 (skip) unless `E2E_ORG`, `E2E_TEACHER_PAT`, `E2E_STUDENT_PAT`,
  and `E2E_COLLECT_TOKEN` are all set.

## Environment

| Var | Required | What |
| --- | --- | --- |
| `E2E_ORG` | ✅ | Throwaway org the **teacher PAT owns** (the suite asserts owner role and aborts otherwise). |
| `E2E_TEACHER_PAT` | ✅ | Classic PAT: `admin:org`, `workflow`, `repo`, `delete_repo`. |
| `E2E_STUDENT_PAT` | ✅ | Classic PAT for a **separate** bot: `read:org`, `repo`, `workflow`. |
| `E2E_COLLECT_TOKEN` | ✅ | Fine-grained PAT: `Contents: Read and write` on all org repos **and** Organization `Members: Read`. The suite passes this to `init` / `rotate-service-token` as `CLASSROOM50_SERVICE_TOKEN` (it *is* the service token that powers collect-scores — not a separate credential). Validation now probes org members, so a `Members`-less token fails `init`. |
| `E2E_TEMPLATE` | optional | A **public** `is_template` repo `owner/name`. Unset → template-less assignments (empty repo + autograder shim; no external dependency). Set it to also exercise the template-generate path — it must be visible to the teacher account, so public (the CLI rejects out-of-org private templates). |
| `E2E_STUDENT2_PAT` | optional | Classic PAT for a **third, distinct** bot (`read:org`, `repo`, `workflow`) — the group teammate; enables the §7 group flow (`TestGroupAssignment`). |
| `E2E_CLASSROOM` / `E2E_ASSIGNMENT` | optional | Defaults `cs-principles` / `hello`. |
| `E2E_ALLOW_DIRTY_ORG` | optional | Set to `1` to bypass the disposability guard. By default the suite refuses to run if `E2E_ORG` already contains repos other than a leftover `classroom50` marker (the teardown-first deletes *every* repo, so a populated org is treated as a possible misconfiguration). Set this only for a known-dirty throwaway org. |

## Run locally

```sh
cd test/e2e
export E2E_ORG=classroom50-e2e-test-org
export E2E_TEACHER_PAT=...   # owner of E2E_ORG
export E2E_STUDENT_PAT=...   # a separate bot (e.g. bot50)
export E2E_COLLECT_TOKEN=... # fine-grained: Contents R/W + Members: Read
export E2E_STUDENT2_PAT=...  # optional: a 3rd bot → enables the §7 group flow
GOWORK=off go test -tags e2e -timeout 60m -v ./...
```

The happy path alone fits comfortably in ~15 min; enabling `E2E_STUDENT2_PAT` runs the group flow as
a second self-contained init→teardown, so budget ~60 min (hence `-timeout 60m`). To run just one:
`-run TestHappyPath` or `-run TestGroupAssignment`.

`GOWORK=off` is required: this is a standalone module (stdlib only), not part of the repo's dev
`go.work`. The CLI modules it builds resolve their `../shared` dep via their own `replace` directives.

## In CI

`.github/workflows/e2e.yaml` runs it on `workflow_dispatch` (nightly is currently disabled until the
secrets are provisioned). Provision the secrets/vars above on this repo; runs are serialized per-org and never cancel in
flight (a cancelled run would leave the org dirty). A hard-killed run is self-healed by the next
run's teardown-first plus the workflow's `if: always()` safety-net wipe.

## Notes / known rough edges

- Assertions target **current** branch behavior — notably the founder is repo `admin` after `accept`.
  If the group permission model moves to teacher-managed/`maintain`, flip that one assertion
  in `happy_path_test.go` (step 4.2).
- Enterprise test orgs grant more than a real **Team-plan** teacher, so this validates the happy path
  but won't catch Team-plan-only permission failures.
- First real run in a **new** environment may still need small tweaks (e.g. git push auth in §5.1,
  exact workflow filenames). Both flows have been run green against a live org, but a fresh org /
  credential set can surface environment-specific rough edges.
