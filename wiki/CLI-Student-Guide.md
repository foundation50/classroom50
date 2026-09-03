# CLI Student Guide

An end-to-end walkthrough of the `gh student` CLI. [Install the CLI](Installation)
first.

For every command and flag, see the [`gh student` reference](gh-student).

The path: [log in](#1-log-in), [accept an assignment](#2-accept-an-assignment),
[clone and work](#3-clone-and-work), then [submit](#4-submit).

## Before you start

Your teacher must have already:

1. Set up a GitHub organization for the classroom.
2. Registered the assignment.
3. Invited you to the organization (you get an email).

You don't need to accept the organization invitation on GitHub first:
`gh student accept` does it for you.

## 1. Log in

```sh
gh student login
```

This runs `gh auth login` with the scopes you need. If you skip it, the next
command logs you in automatically. `gh student logout` mirrors `gh auth logout`.

## 2. Accept an assignment

```sh
gh student accept <org> <classroom> <assignment>
```

- `<org>`: your classroom's GitHub organization.
- `<classroom>`: the classroom your teacher set up (for example, `cs-principles`).
- `<assignment>`: the assignment slug (for example, `hello`).

If your classroom uses an unlisted URL, your teacher gives you an access key.
Pass it with `--key`; normal classrooms need no key.

This creates a repository at
`<org>/<classroom>-<assignment>-<username>` from the assignment's starter code
(or, with no starter code, a new repository with a README and the autograding
setup), then prints a `git clone` command. The repository is **private** unless
your teacher configured the assignment to create public repositories; in that
case accept warns you first that your work will be visible to anyone on the
internet. If the organization doesn't let you create public repositories,
accept creates a private one instead and says your teacher can make it public
later.

<details>
<summary>What accept does, step by step</summary>

1. Accepts any pending organization invitation.
2. Looks up the assignment in the classroom's published assignment list.
3. Resolves the autograding workflow.
4. Creates your repository (a copy of the starter code, or a new
   README-initialized repository), private unless the assignment opts into
   public repositories, in which case you're warned first.
5. Commits the setup files (`.classroom50.yaml` and the autograding workflow)
   and verifies they're in place.
6. Opens the feedback pull request, when the assignment enables it.
7. Sets your repository role: `push` for an individual assignment, or `admin`
   for a legacy group assignment (so its founder can invite teammates). On a
   team assignment your access comes through the group's GitHub team instead.
8. Prints the `git clone` command.

</details>

Already accepted? The command reports `Assignment already accepted` and leaves
your existing repository (and your work) alone. Running accept again is safe:
it also repairs a repository whose setup was interrupted partway.

If accept fails, see
[Common `gh student accept` errors](Troubleshooting#common-gh-student-accept-errors)
in Troubleshooting.

## 3. Clone and work

Run the `git clone` command that `gh student accept` printed. Edit, commit, and
push to your repository's default branch as usual.

To collaborate with a classmate or invite a TA:

```sh
gh student invite <org>/<repo> <username>
```

That adds them with `push` permission. On a team assignment (see below) invite
refuses: teammates join through the group's GitHub team, with
`gh student team add`.

### Group assignments

If your teacher registered the assignment with `--mode team`, your group
shares **one** repository, owned by a GitHub team. How you get a group depends
on the assignment:

- **Teacher-formed groups.** If accept reports you're not in a group yet, ask
  your teacher to add you to one, then run accept again.
- **Student-formed groups.** The first member (the "founder") creates the group
  while accepting, optionally naming it:

  ```sh
  gh student accept <org> <classroom> <assignment> --new-team --team-name "The Sharks"
  ```

  The founder then adds each teammate:

  ```sh
  gh student team add <org> <classroom> <assignment> <teammate-username>
  ```

  Teammates must be enrolled in the classroom and not already in another
  group, and the group is capped at the size your teacher set. Once added,
  each teammate runs a plain `gh student accept` for the same assignment.

The shared repository is named `<classroom>-<assignment>-group-<n>` and is
created by the first accept; every group member gets push access through the
team. Check your group and its members anytime:

```sh
gh student team list <org> <classroom> <assignment>
```

At grading time, the group team's members who are on the roster all get the
same score.

### Legacy group assignments

If your teacher registered the assignment with `--mode group` (the legacy
shared-repository mode), there is no group team:

1. **One teammate accepts first.** They create the shared repository (named after
   them) and become its **admin** (the "founder").
2. **The founder adds each teammate:**

   ```sh
   gh student invite <org>/<classroom>-<assignment>-<founder-username> <teammate-username>
   ```

Each teammate is added with `push` permission and gets a GitHub invitation. Only
the founder can add collaborators. When run from inside the group repository,
`gh student invite` refuses to add past the size your teacher set, but this cap
is advisory: it can be bypassed (for example, in the GitHub UI), and the
authoritative crediting happens at grading time.

The whole group works in the one repository and submits from it. At grading
time, everyone on the roster who is a collaborator gets the same score.

## 4. Submit

From inside the cloned repository:

```sh
gh student submit
```

This snapshots your work and pushes it as a new commit on your repository's
default branch. The autograding workflow runs automatically: it tags the commit
`submit/<UTC-timestamp>-<short-sha>`, grades it, and publishes a GitHub Release
with your score a minute or two later.

On most assignments you can also `git push` directly; the result is the same.
`gh student submit` exists mainly to pull any teacher-side updates to
`.gitignore` and `.github/` from the starter code before pushing. (With no
starter code there's nothing to refresh, so it only commits and pushes.)

Some assignments grade **only on submit** (your teacher says so, and a plain
push shows a passing check that says the push was not graded). There,
`gh student submit` also pushes the `submit/…` tag that triggers grading. You
can tag a commit yourself instead:

```sh
git tag submit/final && git push origin submit/final
```

Any tag under `submit/` grades. Some assignments also name **milestone tags**
(for example `phase1`, `phase2`, `complete`; your teacher tells you which).
Push one to grade that commit:

```sh
git tag phase1 && git push origin phase1
```

The graded result appears as a normal `submit/…` release.

When submit finishes, it prints the assignment's name, the submission time, and
a link to the submitted commit on GitHub. Open your repository's **Actions** tab
to watch the run, and its **Releases** page for the scored Release once grading
finishes.

**Good to know:**

- **Every push grades (by default).** Each push to the default branch triggers
  one graded run, which tags and releases the commit it ends on. A push of
  several commits grades once, while the submissions page counts each of those
  commits. The first commit, from accepting, has nothing to grade and is
  skipped; the empty commit that opens your feedback pull request at accept
  time is likewise neither graded nor counted. The latest Release is always
  your most recent submission. On a **submit-only** assignment, only
  `gh student submit` (or a hand-pushed `submit/*` tag) grades; regular pushes
  save your work without grading it.
- **Pull after teacher-side workflow updates.** If your teacher changes the
  assignment's autograding trigger, a small commit lands in your repository. It
  is neither graded nor counted as a submission. Run `git pull` before your
  next push, or git reports a conflict.
- **History is preserved.** Submissions stack as commits; prior commits stay
  reachable for review.
- **No git config required.** Commits are authored with the `user.name` and
  `user.email` configured for your clone, so signed commits stay verified. In
  a shell with no git identity, submit falls back to your GitHub login and
  noreply email, so it still works.
- **Build artifacts are excluded.** Only tracked files and untracked files
  that aren't ignored are submitted.

## See also

- [`gh student` reference](gh-student): every command and flag.
- [Troubleshooting](Troubleshooting): debug flags and common errors.
