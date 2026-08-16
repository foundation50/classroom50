# `gh student` reference

Every command and flag for the student CLI. For a walkthrough, see the
[CLI Student Guide](CLI-Student-Guide).

Run `gh student <command> --help` for the live flag list. Errors go to stderr
with a non-zero exit code. Pass `--verbose` / `-v` for per-step detail.

## Commands at a glance

| Command | Description |
| --- | --- |
| `whoami` | Print the authenticated GitHub user. |
| `login` | Log in with the unified Classroom 50 scopes (`admin:org`, `read:org`, `repo`, `workflow`) — the same set `gh teacher login` requests, so one sign-in covers both. A student only exercises `read:org`, `repo`, and `workflow`. |
| `logout` | Log out via `gh auth logout`. |
| `accept <org> <classroom> <assignment>` | Accept an assignment: auto-accept the org invite, create your private repo, and set up autograding. |
| `invite <org>/<repo> <username>` | Invite a classmate or TA to your repo with `push` permission. |
| `submit` | Snapshot the current branch and push it for grading. |

## `accept`

```sh
gh student accept <org> <classroom> <assignment>
gh student accept <org> <classroom> <assignment> --key <access-key>
```

Creates a private repo at `<org>/<classroom>-<assignment>-<username>` (a copy of
the assignment's template, or a README-initialized repo if it's template-less),
then prints a `git clone` command.

**`--key <access-key>`** — access key for a classroom that uses an unlisted
URL (provided by your teacher); omit for normal classrooms.

<details>
<summary>What accept does, step by step</summary>

1. Auto-accepts any pending org invitation.
2. Looks up the assignment in the classroom's published `assignments.json` on
   Pages. A `template` block resolves the starter; its absence means a
   template-less, README-initialized repo.
3. Resolves the autograder workflow shim. The `default` autograder uses the shim
   embedded in `gh-student`; a non-default one is fetched from Pages (resolved
   *before* creating the repo, so a fetch failure leaves no half-baked repo).
4. Creates the repo — from the template, a README-initialized (`auto_init`)
   repo, or (for an `empty_repo` assignment) a truly bare repo with steps 3
   and 7 skipped.
5. Applies the assignment's repository features (Issues, Wiki, Projects, Pull
   requests). By default each feature **inherits the template's setting**
   (GitHub's template-generate doesn't copy them, so accept reads the template
   and re-applies them); the teacher can force any feature on or off per
   assignment. A template-less assignment keeps GitHub's own defaults unless
   the teacher forced a feature. Best-effort — a rejected feature update never
   fails accept.
6. Sets your repo role: `push` for an individual assignment, or `admin` for a
   group assignment (so a group founder can invite teammates). The teacher can
   override this per assignment (`student_permission`).
7. Commits `.classroom50.yaml` and `.github/workflows/autograde.yaml` in one
   commit. The metadata records the classroom, assignment, and (when present)
   the template repo. `gh student submit` re-fetches `.gitignore` and `.github/`
   from that template.
8. Prints the `git clone` command.

</details>

Already accepted? The command reports `Assignment already accepted: <org>/<repo>`
and leaves your repo alone.

If accept fails, see
[Common `gh student accept` errors](Troubleshooting#common-gh-student-accept-errors)
in Troubleshooting.

## `invite`

```sh
gh student invite <org>/<repo> <username>
```

Adds a classmate or TA to your repo with `push` permission. For a group
assignment, the founder uses this to add each teammate.

## `submit`

Run from inside a cloned assignment repo:

```sh
gh student submit
```

Snapshots your submittable files (tracked, plus untracked files that aren't
ignored) and pushes them as a new commit on the repo's
default branch. The autograde workflow then tags the commit
`submit/<UTC-timestamp>-<short-sha>`, grades it, and publishes a scored Release a
minute or two later.

Functionally equivalent to `git commit -am "Submit" && git push`, with one extra
step: it refreshes the teacher's `.gitignore` and `.github/` from the template
(skipped for a template-less assignment).

On a **submit-only assignment** (`submission_mode: tag` — your teacher will
say so) plain pushes aren't graded; `submit` additionally pushes the
`submit/<UTC-timestamp>-<short-sha>` tag itself, which is what triggers
grading. Hand-pushing any `submit/*` tag works the same.

<details>
<summary>What submit does, step by step</summary>

1. Reads `.classroom50.yaml` for the template coordinates and identity.
2. Copies submittable files (tracked + untracked-not-ignored) into a temp
   worktree, so build artifacts don't pollute the submission.
3. Fetches the teacher's `.gitignore` and `.github/` from the template.
4. Commits (with your GitHub login + noreply email) and pushes to the default
   branch as a fast-forward — no force-push; prior commits stay reachable.
5. On a submit-only assignment, pushes the `submit/…` tag at the new commit
   (reusing an existing tag if the commit already has one, so a retry never
   grades twice).
6. Prints the Actions and Releases URLs.

On an every-push assignment tagging is the runner's job. The **acceptance
commit** is skipped (nothing to grade); your first real submit always grades.
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` override the default identity.

</details>

> [!NOTE]
> **Feedback PR timing.** If your teacher enabled feedback, one long-lived
> Feedback pull request is opened when you accept, and the same PR is reused for
> every later submission. If it couldn't be opened then, run `accept` again to
> retry (or it appears on your first submission when autograding is enabled).

## `whoami` / `login` / `logout`

- `whoami` — prints the authenticated GitHub user.
- `login` — wraps `gh auth login` with the unified scope set (`admin:org`,
  `read:org`, `repo`, `workflow`, shared with `gh teacher login`); add scopes
  with `-s`. It replaces your stored github.com token, so when one already
  exists it warns and asks for confirmation. `accept` and `submit` don't need
  it: they reuse a sufficiently-scoped token untouched and widen an
  under-scoped gh-managed one in place. See
  [Will `gh teacher login` disturb my existing `gh` setup?](Troubleshooting#will-gh-teacher-login-disturb-my-existing-gh-setup).
- `logout` — runs `gh auth logout`.

## Contributing

Building, testing, and linting the extension are documented in the
[`cli/gh-student/` README](https://github.com/foundation50/classroom50/blob/main/cli/gh-student/README.md).
