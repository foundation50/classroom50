# `gh student` reference

Every command and flag for the student CLI. For a walkthrough, see the
[CLI Student Guide](CLI-Student-Guide).

Run `gh student <command> --help` for the live flag list. Errors go to stderr
with a non-zero exit code. Pass `--verbose` / `-v` for per-step detail.

## Commands at a glance

| Command | Description |
| --- | --- |
| `whoami` | Print the authenticated GitHub user. |
| `login` | Log in to GitHub with the scopes gh-student needs (`admin:org`, `read:org`, `repo`, `workflow`). `gh teacher login` requests the same set, so one sign-in covers both. |
| `logout` | Log out of GitHub with `gh auth logout`. |
| `accept <org> <classroom> <assignment>` | Accept an assignment from an organization's classroom: accept the organization invitation, create your assignment repository, and set up autograding. `--key` for an unlisted classroom; `--new-team` / `--team-name` create your group on a team assignment with student-formed groups. |
| `invite <org>/<repo> <username>` | Invite a classmate or TA to push to your assignment repo. Not for team assignments; use `team add` there. |
| `team list <org> <classroom> <assignment>` | Show your group for a team assignment and who is on it. |
| `team add <org> <classroom> <assignment> <username>` | Add a classmate to your group (founders only). |
| `submit` | Submit your work on the current assignment. |

## `accept`

```sh
gh student accept <org> <classroom> <assignment>
gh student accept <org> <classroom> <assignment> --key <key>
gh student accept <org> <classroom> <assignment> --new-team --team-name "The Sharks"
```

Creates a repository at `<org>/<classroom>-<assignment>-<username>` (all
lowercase), then prints a `git clone` command. If the assignment has starter
code, your repository starts as a copy of it; with no starter code, it starts
with a README and the autograding setup (only the autograding setup when your
teacher turned the README off). On a team assignment the repository is
instead the group's shared `<classroom>-<assignment>-group-<n>`, created by
whichever group member accepts first.

The repository is **private** unless the assignment opts into public
repositories; then accept warns you before creating it that your work (code,
commits, and name) will be visible to anyone on the internet. If the
organization doesn't let you create public repositories, accept creates a
private repository instead and notes that your teacher can make it public
later.

Flags:

- `--key <key>`: access key from your teacher for a classroom that uses an
  unlisted URL; omit for normal classrooms. The key is part of the published
  URL, and without it the classroom's assignments can't be found.
- `--new-team`: team assignments with student-formed groups only. Creates a
  new group for this assignment and makes you its founder (the group team's
  maintainer); add teammates afterward with `gh student team add`. If you're
  already in a group, accept uses it and ignores the flag with a warning, so
  a re-run never creates a second group. On a teacher-formed assignment,
  accept refuses students who aren't in one of the teacher's groups.
- `--team-name <name>`: display name for the group created by `--new-team`,
  for example `"The Sharks"`.

<details>
<summary>What accept does, step by step</summary>

1. Accepts any pending invitation to the organization.
2. Looks up the assignment in the classroom's published assignment list,
   which is public, so the lookup needs no special access.
3. Resolves the autograding workflow. This CLI carries the standard one; if
   your teacher registered a custom autograder for the assignment, that one
   is downloaded from the classroom's published site instead (before the
   repository is created, so a download failure leaves no half-made
   repository).
4. Creates the repository: a copy of the starter code, a new
   README-initialized repository, or (when the teacher chose an empty
   repository) a bare one with steps 3, 6, and 7 skipped. Private by default;
   public when the assignment opts in, with the warning printed before
   creation and a fallback to private when the organization denies the public
   create.
5. Applies the assignment's repository features (Issues, Wiki, Projects, Pull
   requests). By default each feature inherits the starter code's setting
   (GitHub's template copy doesn't carry them over, so accept reads the
   starter repository and re-applies them); the teacher can force any feature
   on or off per assignment. With no starter code, GitHub's own defaults apply
   unless the teacher forced a feature. Best-effort: a rejected feature update
   never fails accept.
6. Writes the classroom marker file (`.classroom50.yaml`) and the autograding
   workflow (`.github/workflows/autograde.yaml`) in a single commit, then
   verifies both are in place before reporting success. The workflow only
   points at the grading logic your teacher manages, so grading updates apply
   on your next submission without changing your repository. When the teacher
   turned the README off for an assignment with no starter code, this commit
   also removes the seeded README.
7. Opens the feedback pull request when the assignment enables it.
   Best-effort: if this fails, the autograding run creates the pull request on
   your first submission instead.
8. Sets your repository role, last so a failed role change never leaves a
   half-set-up repository: `push` for an individual assignment, or `admin`
   for a legacy group assignment (so its founder can invite teammates). On a
   team assignment access flows through the group's GitHub team, so no
   special role is kept. The teacher can override the role per assignment.
9. Prints the `git clone` command.

</details>

Running accept again is safe. A repository that is fully set up is left in
place (your access level is refreshed when possible), and the command reports
`Assignment already accepted: <org>/<repo>`. A repository whose setup was
interrupted partway is repaired.

If accept fails, see
[Common `gh student accept` errors](Troubleshooting#common-gh-student-accept-errors)
in Troubleshooting.

## `invite`

```sh
gh student invite <org>/<repo> <username>
gh student invite cs50/cs50-fall-2026-hello-alice cs50-duck
```

Adds `<username>` as a collaborator with push access on `<org>/<repo>`. They
receive a GitHub invitation and can push once they accept it.

- Inviting someone who is already a collaborator is safe and changes nothing.
- Run from inside a legacy group-assignment repository, invite checks the
  assignment's maximum group size and refuses to add a new teammate once the
  group is full. The limit is advisory: it can be bypassed, for example in the
  GitHub UI, and the group size that counts is checked again when your
  teacher collects the work.
- Run anywhere else (or for an individual assignment or a TA invite), it adds
  the collaborator.
- On a team assignment it refuses: teammates join through your GitHub team,
  with `gh student team add`.

## `team`

Team assignments use one shared repository per group, owned by a GitHub team.
These commands work on **your** group for an assignment. Create a group in the
first place with `gh student accept --new-team` (student-formed groups only;
otherwise your teacher assigns them). Both subcommands accept `--key <key>` for
a classroom that uses an unlisted URL.

### `team list`

```sh
gh student team list <org> <classroom> <assignment>
gh student team list cs50 cs50-fall-2026 project
```

Shows the group you are in for a team assignment, who is on it, and the
group's shared repository. Your group is resolved from your own GitHub team
memberships, so no special access is needed. Not in a group yet? The error
explains how to get one for this assignment.

### `team add`

```sh
gh student team add <org> <classroom> <assignment> <username>
gh student team add cs50 cs50-fall-2026 project cs50-duck
```

Adds `<username>` to your group. They get push access to the group's shared
repository through the GitHub team, and the command tells them to run
`gh student accept` for the assignment next.

- Only the group's founder (its team maintainer) can add members on a
  student-formed assignment.
- The classmate must be enrolled in the classroom, and can be in only one
  group for the assignment.
- The group size is capped by the assignment's maximum group size. The limit
  is advisory and is checked again when your teacher collects the work.
- Adding someone who is already in the group changes nothing.

## `submit`

Run from inside a cloned assignment repository:

```sh
gh student submit
```

Snapshots your work (tracked files, plus untracked files that aren't ignored)
and pushes it as a new commit on top of the repository's default branch.

How grading is triggered:

- Most assignments grade every push: the autograding workflow creates its own
  `submit/<UTC-timestamp>-<short-sha>` tag at the pushed commit and publishes
  a scored release at that tag a minute or two later.
- Some assignments grade only on submission tags (your teacher configures
  this). Plain pushes aren't graded there, so this command also pushes the
  `submit/...` tag itself, which is what triggers grading. Pushing your own
  `submit/*` tag by hand works too.

Functionally equivalent to `git commit -am 'Submit' && git push`, plus a
refresh of the teacher's files: the latest `.gitignore` and `.github/` are
fetched from the starter code recorded in `.classroom50.yaml`, so teacher-side
updates flow through (skipped when the assignment has no starter code). The
autograding workflow itself is set once at accept time and never refreshed:
changes to the grading logic reach you through the teacher-side setup, fetched
fresh on every submission.

<details>
<summary>What submit does, step by step</summary>

1. Reads `.classroom50.yaml` for the assignment and its starter code.
2. Copies your submittable files (tracked, plus untracked files that aren't
   ignored) into a temporary work tree, so build artifacts don't pollute the
   submission.
3. Fetches the teacher's `.gitignore` and `.github/` from the starter code.
4. Commits with your git `user.name` and `user.email` (unset fields fall back
   to your GitHub login and noreply email) and pushes to the default branch as
   a fast-forward. No force-push, so prior commits stay reachable.
5. On a submit-only assignment, pushes the `submit/…` tag at the new commit
   (reusing an existing tag if the commit already has one, so a retry never
   grades twice).
6. Prints the assignment's name, the submission time, and a link to the
   submitted commit.

On an every-push assignment tagging is the autograding run's job. The
acceptance commit is skipped (nothing to grade); your first real submit always
grades. `GIT_AUTHOR_*` / `GIT_COMMITTER_*` override the default identity.

</details>

> [!NOTE]
> If your teacher enabled feedback, one long-lived feedback pull request is
> opened when you accept, and the same pull request is reused for every later
> submission. If it couldn't be opened then, run `accept` again to retry (or it
> appears on your first submission when autograding is enabled).

## `whoami` / `login` / `logout`

- `whoami`: prints the authenticated GitHub user.
- `login`: wraps `gh auth login` and requests the unified Classroom 50 scope
  set on top of the gh defaults (`admin:org`, `read:org`, `repo`, `workflow`,
  shared with `gh teacher login`); add scopes with `-s` (repeatable, or
  comma-separated). It replaces your stored github.com token, so when one
  already exists it warns and asks for confirmation. `accept` and `submit`
  don't need it: they reuse a sufficiently-scoped token untouched and widen
  an under-scoped gh-managed one in place. See
  [Will `gh teacher login` disturb my existing `gh` setup?](Troubleshooting#will-gh-teacher-login-disturb-my-existing-gh-setup).
- `logout`: runs `gh auth logout`, removing the local gh authentication, so
  later commands need a fresh `gh student login`.

## Contributing

Building, testing, and linting the extension are documented in the
[`cli/gh-student/` README](https://github.com/foundation50/classroom50/blob/main/cli/gh-student/README.md).
