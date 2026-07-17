# Classroom 50 CLI - Student Guide

End-to-end walkthrough for students. Install the CLI first — see [Installation](Installation).

## Before you start

Your teacher must have already:

1. Set up a GitHub organization for the classroom.
2. Registered the assignment (optionally with a template repo).
3. Invited you to the org (you'll get an email invitation).

You don't need to accept the org invitation in the GitHub UI — `gh student accept` does it for you on first use.

## 1. Log in

```sh
gh student login
```

![Demo: gh student login](images/gh_student_auth.gif)

This runs `gh auth login` with the unified Classroom 50 scope set — `admin:org`, `read:org`, `repo`, and `workflow` — the same scopes `gh teacher login` requests, so a single sign-in works across both CLIs. (A student only exercises `read:org`, `repo`, and `workflow`; `admin:org` is included for parity and is harmless on a student account.) If you skip this step, the next command you run will trigger the login flow automatically.

`gh student logout` mirrors `gh auth logout`.

## 2. Accept an assignment

```sh
gh student accept <org> <classroom> <assignment>
```

![Demo: gh student accept](images/gh_student_accept.gif)

- `<org>` — the GitHub org your classroom uses.
- `<classroom>` — the classroom your teacher set up (e.g. `cs-principles`). Has to match a real classroom directory in your org's `classroom50` config repo.
- `<assignment>` — the slug your teacher registered with `gh teacher assignment add` (e.g. `hello`).

What this command does:

1. Auto-accepts any pending org invitation for your account.
2. Looks up the assignment in the classroom's published manifest (`https://<org>.github.io/classroom50/<classroom>/assignments.json`). If the assignment has a template repo, that's used as the starter; the template may live in another org — your teacher's `gh teacher assignment add --template <owner>/<repo>` chose it. Some assignments are **template-less** (your teacher omitted `--template`) — those start from an empty repo.
3. Resolves the autograder workflow shim. For the default autograder (the common case), the universal shim embedded in `gh-student` is used directly. For a non-default `--autograder <name>` your teacher registered, the shim is fetched from Pages (`https://<org>.github.io/classroom50/<classroom>/autograders/<name>.yaml`) — if that fetch fails, no half-baked repo is left behind.
4. Creates a **private** repo at `<org>/<classroom>-<assignment>-<username>` (lowercased), with issues, projects, and wiki disabled. With a template it's a copy of that template; for a template-less assignment it's an empty repo (just the autograder shim — write your solution from scratch).
5. Keeps you as an `admin` collaborator on the new repo (so a group founder can add teammates with `gh student invite`).
6. Writes `.classroom50.yaml` and `.github/workflows/autograde.yaml` (the resolved shim) in a single commit. The metadata records the classroom and assignment (plus the template-repo identity when there is one); the runner derives everything else at workflow time.
7. Prints the `git clone` command for your new repo.

If you've already accepted this assignment, the command short-circuits with `Assignment already accepted: <org>/<repo>` and leaves your existing repo (and any work in it) alone — re-running is safe.

**Errors you might see:**

- _"the classroom may not exist yet, or `publish-pages.yaml` may not have run"_ — your teacher hasn't completed the classroom setup yet, or the Pages site hasn't deployed. Wait a few minutes and try again, or ask your teacher to confirm.
- _"assignment X is not registered in ..."_ — typo, or your teacher hasn't run `gh teacher assignment add` yet for this assignment.
- _"autograder `<name>` not published yet"_ — the assignment references an autograder workflow whose YAML isn't on the Pages site. Ask your teacher to confirm `<classroom>/autograders/<name>.yaml` exists in the config repo and that `publish-pages.yaml` has run.
- _"autograder `<name>` is malformed YAML"_ — the teacher's autograder workflow has a YAML syntax error. Ask them to fix the file in the config repo before retrying.
- _"template `<owner>/<repo>` is not accessible to you"_ — the template repo is private and not shared with you; ask your teacher to make it public or grant your account access.
- _"assignment `<X>` has unsupported mode `<mode>`"_ — the assignment's `mode` in the manifest is neither `individual` nor `group` (likely a hand-edited `assignments.json`). Ask your teacher to fix it. (Both `individual` and `group` assignments accept normally — see the group-assignment note below.)

## 3. Clone and work

Run the `git clone` command that `gh student accept` printed. Edit the code in your usual editor, commit and push to your repo's `main` branch as you normally would.

If you'd like to collaborate with a classmate or invite a TA to your repo:

```sh
gh student invite <org>/<repo> <username>
```

That adds them with `push` permission.

### Group assignments

If your teacher registered the assignment with `--mode group`, teammates share **one** repo instead of each getting their own:

1. **One teammate accepts first.** Whoever runs `gh student accept <org> <classroom> <assignment>` first creates the shared repo, named after them (`<classroom>-<assignment>-<their-username>`). They become the repo's **admin**.
2. **That same teammate adds the others** — the founder (not the joiners) runs, once per teammate:

```sh
gh student invite <org>/<repo> <teammate-username>
```

`<repo>` is the shared repo (`<classroom>-<assignment>-<founder-username>`). Each teammate is added with `push` permission and receives a GitHub invitation to accept. Only the repo's admin (the founder) can add collaborators, which is why joins are founder-driven — a plain org member can't see or modify a teammate's private repo. Keep the group within the size your teacher set (the CLI doesn't hard-enforce the cap on `invite`, so coordinate within your group).

The whole group works in the one repo and submits from it like any other assignment (below). At grading time everyone on the roster who is a collaborator on the repo is credited with the same score.

## 4. Submit

From inside the cloned repo:

```sh
gh student submit
```

![Demo: gh student submit](images/gh_student_submit.gif)

`gh student submit` snapshots your current branch and pushes it as a new commit on top of `main`. The autograde workflow runs automatically on the push: it tags the commit with `submit/<UTC-timestamp>-<short-sha>`, runs the autograder, and publishes a GitHub Release with your score a minute or two later.

You can also `git push` directly — the result is identical. `gh student submit` exists mainly to refresh the teacher's `.gitignore` and `.github/` from the assignment template before pushing, so any teacher-side updates flow through. (For a template-less assignment there's no template to refresh from, so submit just commits and pushes.)

When submit finishes, two URLs are printed:

- **Autograde** — the repo's Actions tab. The autograde run for this submission shows up there within a few seconds and creates the submit tag.
- **Releases** — the releases page. The scored release lands once the workflow finishes; per-test results appear in the release body.

A few useful properties:

- **Every push grades.** Whether through `gh student submit` or `git push`, every commit on `main` triggers a graded run with its own tag and release — except the very first commit from accepting the assignment, which has nothing to grade and is skipped automatically. The latest release on the page is always the most recent submission.
- **History is preserved.** Submissions overlay as commits on top of the existing `main`; prior commits stay reachable for review.
- **No git config required.** The commit is authored with your GitHub login and noreply email, passed via `git -c user.name=... -c user.email=...`, so a fresh shell with no global git identity still submits cleanly. `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment variables override these defaults if you want a custom identity.
- **Build artifacts are excluded.** Only tracked files plus untracked-not-ignored files are submitted, so build outputs and unrelated local files don't end up in the snapshot.

Submit tags follow the shape `submit/2026-06-01T14-32-05Z-a1b2c3d` (UTC timestamp, hyphens between time components, then a short SHA suffix). Tags are immutable, so each submission's snapshot stays linkable forever.

## See also

- [`gh student` command reference](gh-student) — every command and flag.
- [Troubleshooting](Troubleshooting) — debug flags, common errors.
