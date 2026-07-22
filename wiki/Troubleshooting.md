# Troubleshooting

## See what the CLI is doing

Both CLIs accept `--verbose` / `-v` on any command. It shows each REST call,
response status, raw `git` output, and metadata writes — try it first when
something misbehaves.

```sh
gh student submit -v
gh teacher download -v <org> <classroom> <assignment>
```

For raw REST request/response logging (headers + bodies), set `GH_DEBUG=api`:

```sh
GH_DEBUG=api gh teacher invite <org> <username>
```

Commands with informational output also accept `--quiet` / `-q`.

## "Missing scope" / 403 on `gh teacher invite`

Org invitations need the `admin:org` scope, which a plain `gh auth login`
doesn't grant. Run:

```sh
gh teacher login
```

The CLI also detects this and logs you in automatically if you skip it.

## `git/trees: HTTP 404` on `gh teacher init`

`init` commits workflow files via the Git Data API, which GitHub gates behind
the `workflow` scope. A token without it is rejected with a misleading 404,
leaving `classroom50` with only a README. Re-authenticate:

```sh
gh teacher login
# or add the scope in place:
gh auth refresh -s admin:org,workflow
```

Whether a plain `gh auth login` already granted `workflow` depends on unrelated
prompt choices, which is why this appears on some machines and not others.

## "Not an admin" on `gh teacher invite`

You must be an organization owner for `POST /orgs/{org}/invitations` to succeed.
Check under `https://github.com/orgs/<org>/people` — you should show **Owner**.
(Team-based admin isn't enough for the invitation API.)

## "Already a member" / "Pending invite"

Not errors — the desired state already exists. The CLI reports them clearly and
exits 0, so invite commands are safe to re-run in scripts.

## "Assignment already accepted" on `gh student accept`

You've already accepted; the repo is at
`<org>/<classroom>-<assignment>-<username>`. The CLI short-circuits to protect
your work. Clone it with the URL from `gh repo view <org>/<repo>` if you don't
have it locally.

## "Template not found" / 404 on `gh student accept`

Only applies to assignments with a template. Check, in order:

1. **The template is readable by the student.** Public always works. A private
   template works only if it's inside your org (the classroom team is granted
   read). A private template outside your org can't be shared — re-add the
   assignment with an in-org copy or a public template. If a student still 404s,
   confirm they're on the roster (so they're in the team).
2. **The repo is flagged as a template** in Settings → Template repository.
3. **The `<assignment>` argument matches the registered slug** (case is
   normalized; spelling must be exact).

## "Could not find `.classroom50.yaml`" on `gh student submit`

`submit` reads that file at the repo root. If it's missing, you're likely running
submit from outside the cloned assignment repo, or from a clone not created by
`gh student accept`. `cd` into the directory the `git clone` command created.

## "autograder `<name>` not published yet" on `gh student accept`

The assignment references an autograder workflow whose YAML isn't on Pages. Two
causes:

1. **The file doesn't exist.** This fires only for non-default `--autograder
   <name>` values; `<classroom>/autograders/<name>.yaml` must exist in the config
   repo. Ask your teacher to confirm.
2. **`publish-pages.yaml` hasn't run.** A fresh classroom needs one Pages
   deployment. Wait a minute and retry.

("autograder `<name>` is malformed YAML" means the workflow has a syntax error —
`gh student` validates before writing, so a broken file never lands. Ask the
teacher to fix it.)

## Submit pushed a commit but the teacher sees no new work

`submit` pushes to the repo's actual default branch (`main`, `master`, or
`develop`), and autograding triggers on that branch. If a submission still isn't
graded, confirm the push landed on the default branch and that the autograde
workflow ran under the repo's Actions tab.

## `gh teacher download` clones nothing

By default `download` is team-driven. If you get zero clones:

- Confirm `<org>/classroom50` exists and the classroom team has members (add them
  with `gh teacher roster add` / `import`).
- Confirm `<assignment>` is registered (`gh teacher assignment list`).
- Verify a few student repos exist under
  `https://github.com/orgs/<org>/repositories?q=<classroom>-<assignment>`.
- Re-run with `-v` to see which members were probed.

If the config repo isn't bootstrapped, or you want every matching repo regardless
of the roster, pass `--by-pattern`.

## `collect-scores` warns "collected 0 submissions"

Almost always means the `CLASSROOM50_SERVICE_TOKEN` can't read the student repos
— not that the class submitted nothing. (A fine-grained PAT returns 404 for
out-of-scope repos, indistinguishable from "no release yet".)

- Confirm the token has **Contents: Read and write on all org repos** (not "Only
  select repositories" — student repos are created on demand) **and Organization
  Members: Read**.
- Re-scope and rotate with `gh teacher rotate-service-token <org>`.
- A `401`/`403` (rather than the `0 submissions` warning) means a bad/expired
  token or a missing `Members: Read` scope.

See the [service-token setup](GitHub-Integration#4-fine-grained-pat-for-score-collection).

## Build fails after a `git pull`

`gh extension install .` registers the binary only the first time. After pulling
new commits, rebuild:

```sh
(cd cli/gh-teacher && go build .)
(cd cli/gh-student && go build .)
```

If `go build` itself fails, run `go mod tidy` first.

## Filing an issue

If none of the above helps, open an issue at
<https://github.com/foundation50/classroom50/issues>. Include:

- The exact command you ran.
- The full output, ideally with `-v` and/or `GH_DEBUG=api`.
- Your `gh --version` and `go version`.
- Your OS and shell.
