# CLI Student Guide

An end-to-end walkthrough of the `gh student` CLI. [Install the CLI](Installation)
first.

For every command and flag, see the [`gh student` reference](gh-student).

**The path:** [log in](#1-log-in) → [accept an assignment](#2-accept-an-assignment)
→ [clone and work](#3-clone-and-work) → [submit](#4-submit).

## Before you start

Your teacher must have already:

1. Set up a GitHub organization for the classroom.
2. Registered the assignment.
3. Invited you to the organization (you'll get an email).

You don't need to accept the organization invite in the GitHub UI —
`gh student accept` does it for you.

## 1. Log in

```sh
gh student login
```

![gh student login](images/gh_student_auth.gif)

This runs `gh auth login` with the scopes you need. If you skip it, the next
command logs you in automatically. `gh student logout` mirrors `gh auth logout`.

## 2. Accept an assignment

```sh
gh student accept <org> <classroom> <assignment>
```

![gh student accept](images/gh_student_accept.gif)

- `<org>` — your classroom's GitHub organization.
- `<classroom>` — the classroom your teacher set up (e.g., `cs-principles`).
- `<assignment>` — the assignment slug (e.g., `hello`).

This creates a repository at
`<org>/<classroom>-<assignment>-<username>` from the assignment's template (or
a new repository with a README and the autograding files if it's
template-less), then prints a `git clone` command. The repository is
**private** unless your teacher configured the assignment to create public
repositories; in that case accept warns you first that your work will be
visible to anyone on the internet.

<details>
<summary>What accept does, step by step</summary>

1. Auto-accepts any pending organization invitation.
2. Looks up the assignment in the classroom's published manifest.
3. Resolves the autograder workflow.
4. Creates your repository (a template copy, or a new
   README-initialized repository) — private unless the assignment opts into
   public repositories, in which case you're warned first.
5. Commits the setup files (`.classroom50.yaml` and the autograde workflow).
6. Opens the Feedback PR, when the assignment enables it.
7. Sets your repo role: `push` for an individual assignment, or `admin` for a
   legacy group assignment (so its founder can invite teammates). On a team
   assignment your access comes through the group's GitHub team instead.
8. Prints the `git clone` command.

</details>

Already accepted? The command reports `Assignment already accepted` and leaves
your existing repo (and your work) alone.

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

- **Your teacher assigns the groups.** If accept reports you're not in a group
  yet, ask your teacher to add you to one, then run accept again.
- **Students form groups.** The first member (the "founder") creates the group
  while accepting, optionally naming it:

  ```sh
  gh student accept <org> <classroom> <assignment> --new-team --team-name "The Sharks"
  ```

  The founder then adds each teammate:

  ```sh
  gh student team add <org> <classroom> <assignment> <teammate-username>
  ```

  Teammates must be enrolled in the classroom, and the group is capped at the
  size your teacher set. Once added, each teammate runs a plain
  `gh student accept` for the same assignment.

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
the founder can add collaborators. When run from inside the group repo,
`gh student invite` refuses to add past the size your teacher set, but this cap
is advisory: it can be bypassed (for example, via the GitHub UI), and the
authoritative crediting happens at grading time.

The whole group works in the one repository and submits from it. At grading
time, everyone on the roster who is a collaborator gets the same score.

## 4. Submit

From inside the cloned repository:

```sh
gh student submit
```

![gh student submit](images/gh_student_submit.gif)

This snapshots your current branch and pushes it as a new commit. The autograde
workflow runs automatically: it tags the commit `submit/<UTC-timestamp>-<short-sha>`,
grades it, and publishes a GitHub Release with your score a minute or two later.

> [!NOTE]
> On most assignments you can also `git push` directly — the result is the
> same. `gh student submit` exists mainly to pull any teacher-side updates to
> `.gitignore` and `.github/` from the template before pushing. (For a
> template-less assignment there's nothing to refresh, so it just commits and
> pushes.)
>
> Some assignments grade **only on submit** (your teacher will say so, and a
> plain push shows a passing check that says the push was not graded). There,
> `gh student submit` pushes the `submit/…` tag that triggers grading — or tag
> a commit yourself: `git tag submit/final && git push origin submit/final`.
> Any tag under `submit/` grades.
>
> Some assignments also name **milestone tags** (e.g. `phase1`, `phase2`,
> `complete` — your teacher will tell you). Push one to grade that commit:
> `git tag phase1 && git push origin phase1`. The graded result appears as a
> normal `submit/…` release.

When submit finishes, it prints two URLs:

- **Autograde** — the Actions tab, where the run appears in a few seconds.
- **Releases** — where the scored Release lands once grading finishes.

**Good to know:**

- **Every push grades (by default).** Each push to the default branch
  triggers one graded run, which tags and Releases the commit it ends on — so
  a push of several commits grades once, while the submissions page counts
  each of those commits. The first commit, from accepting, has nothing to
  grade and is skipped; the empty commit that opens your Feedback PR at accept
  time is likewise neither graded nor counted. The latest Release is always
  your most recent
  submission. On a **submit-only** assignment, only `gh student submit` (or a
  hand-pushed `submit/*` tag) grades; regular pushes save your work without
  grading it.
- **Pull after teacher-side workflow updates.** If your teacher changes the
  assignment's autograding trigger, a small commit lands in your repo. It is
  neither graded nor counted as a submission. Run `git pull` before your next
  push, or git will report a conflict.
- **History is preserved.** Submissions stack as commits; prior commits stay
  reachable for review.
- **No git config required.** Commits are authored with the `user.name` and
  `user.email` configured for your clone, so signed commits stay verified. In
  a shell with no git identity, submit falls back to your GitHub login and
  noreply email, so it still works.
- **Build artifacts are excluded.** Only tracked and untracked-not-ignored files
  are submitted.

## See also

- [`gh student` reference](gh-student) — every command and flag.
- [Troubleshooting](Troubleshooting) — debug flags and common errors.
