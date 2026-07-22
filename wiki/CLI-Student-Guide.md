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
- `<classroom>` — the classroom your teacher set up (e.g. `cs-principles`).
- `<assignment>` — the assignment slug (e.g. `hello`).

This creates a **private** repository at
`<org>/<classroom>-<assignment>-<username>` from the assignment's template (or
an empty repo if it's template-less), then prints a `git clone` command.

<details>
<summary>What accept does, step by step</summary>

1. Auto-accepts any pending organization invitation.
2. Looks up the assignment in the classroom's published manifest.
3. Resolves the autograder workflow.
4. Creates your private repository (a template copy, or an empty repo).
5. Sets your repo role: `push` for an individual assignment, or `admin` for a
   group assignment (so a group founder can invite teammates).
6. Commits the setup files (`.classroom50.yaml` and the autograde workflow).
7. Prints the `git clone` command.

</details>

Already accepted? The command reports `Assignment already accepted` and leaves
your existing repo (and your work) alone.

**Common errors:**

| Message | What it means |
| --- | --- |
| "the classroom may not exist yet, or `publish-pages.yaml` may not have run" | Setup isn't finished or Pages hasn't deployed. Wait a few minutes, or ask your teacher. |
| "assignment X is not registered" | A typo, or your teacher hasn't added the assignment yet. |
| "autograder `<name>` not published yet" | The autograder's YAML isn't on the Pages site. Ask your teacher to confirm it exists and that Pages has deployed. |
| "template `<owner>/<repo>` is not accessible to you" | The template is private and not shared with you. Ask your teacher to make it public or grant access. |

## 3. Clone and work

Run the `git clone` command that `gh student accept` printed. Edit, commit, and
push to your repository's default branch as usual.

To collaborate with a classmate or invite a TA:

```sh
gh student invite <org>/<repo> <username>
```

That adds them with `push` permission.

### Group assignments

If your teacher registered the assignment with `--mode group`, teammates share
**one** repository:

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
> You can also `git push` directly — the result is the same. `gh student submit`
> exists mainly to pull any teacher-side updates to `.gitignore` and `.github/`
> from the template before pushing. (For a template-less assignment there's
> nothing to refresh, so it just commits and pushes.)

When submit finishes, it prints two URLs:

- **Autograde** — the Actions tab, where the run appears in a few seconds.
- **Releases** — where the scored Release lands once grading finishes.

**Good to know:**

- **Every push grades.** Each commit on the default branch triggers a graded run
  with its own tag and Release — except the first commit from accepting, which
  has nothing to grade and is skipped. The latest Release is always your most
  recent submission.
- **History is preserved.** Submissions stack as commits; prior commits stay
  reachable for review.
- **No git config required.** Commits are authored with your GitHub login and
  noreply email, so a fresh shell submits cleanly.
- **Build artifacts are excluded.** Only tracked and untracked-not-ignored files
  are submitted.

## See also

- [`gh student` reference](gh-student) — every command and flag.
- [Troubleshooting](Troubleshooting) — debug flags and common errors.
