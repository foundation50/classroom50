# Web Student Guide

This guide walks you through using Classroom 50's web app at
[classroom50.org](https://www.classroom50.org) as a student. Prefer the
terminal? See the [CLI Student Guide](CLI-Student-Guide).

**The path:** join your classroom's organization → sign in → accept an
assignment → do the work and submit → view your score.

> [!TIP]
> Have feedback, a bug, or an idea? Reach out in our
> [discussions](https://github.com/foundation50/classroom50/discussions).

## Before you start

You need a [GitHub account](https://docs.github.com/en/get-started/start-your-journey/creating-an-account-on-github).
Classroom 50 runs entirely on GitHub.

## Join your classroom

Your classroom belongs to a [GitHub organization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-organizations).
When your teacher invites you, GitHub emails you a link to join.

**Accept that invitation before signing in to Classroom 50.**

## Sign in

![Classroom 50 login screen](images/web_login_screen.png)

At [classroom50.org](https://classroom50.org), sign in with GitHub using
[OAuth 2](https://oauth.net/2/). Two options:

- **Sign in with GitHub** — the standard browser flow.
- **Use a device code instead** — a manual fallback. Paste a code into a
  GitHub page, and Classroom 50 detects when you've authorized it.

![Classroom 50 login flow](images/web_login_flow_student.png)

## View your organizations

![Organizations view](images/web_organizations_student.png)

After signing in, find the organization for your classroom — it has a
**Student** label. Open it to see the assignments you have access to.

![No assignments yet](images/web_assignments_none_student.png)

## Accept an assignment

When your teacher shares an assignment link, open it and accept on a page like
this:

![Accepting an assignment](images/web_accept_assignment_student.png)

Accepting creates a GitHub repository for you, named after the classroom, the
assignment, and your username — for example,
`introduction-to-computer-science-hello-assignment-username`.

> [!NOTE]
> Your repository is private unless your teacher configured the assignment to
> create public repositories. In that case the accept page tells you before
> you accept: anyone on the internet will be able to see your work, including
> your code, commits, and name.

Afterward, your organization page lists the assignment repository you now own:

![One assignment](images/web_assignments_student.png)

## Submit your work

You submit by [committing](https://github.com/git-guides/git-commit) and
[pushing](https://github.com/git-guides/git-push) to the repository you got when
you accepted. Using the CLI instead? See
[Submit in the CLI Student Guide](https://github.com/foundation50/classroom50/wiki/CLI-Student-Guide#4-submit).

> [!NOTE]
> Some assignments grade **only on submit**: pushing saves your work but
> doesn't grade it (the commit's check says so). Run `gh student submit`, or
> push a tag under `submit/` (for example `git tag submit/final && git push
> origin submit/final`) to be graded. Some assignments also name **milestone
> tags** (e.g. `phase1` — your teacher will tell you); push one to grade that
> commit: `git tag phase1 && git push origin phase1`. And if your teacher
> changes an assignment's grading setup, run `git pull` before your next push.

## Group assignments

Some assignments are done in a group. When accepting, you'll see the assignment
tagged **Individual**, **Group**, or **Group (legacy)**.

For a **Group** assignment, your group shares one repository, and the accept
page walks you through getting a group. How you get one depends on the
assignment:

- **Your teacher assigns the groups.** The accept page says so. If you aren't
  in a group yet, ask your teacher to add you to one, then open the link
  again.
- **Students form groups.** The accept page lists the existing groups with
  their member counts. **Ask to join** opens a group's page on GitHub: select
  **Request to join** there (the group reviews requests on that page, where
  you can also cancel yours), then come back and click **I've been added,
  check again**. Or click **Create group** to start your own: you become its
  first member and can add teammates after you accept.

The group's shared repository is created when the first member accepts, and
every member gets push access through the group's GitHub team.

After accepting, **Manage my group** on the accept page (or **Manage group**
in the assignment's left menu) shows your group and its members. In a
student-formed group you can also add teammates there, or leave the group:
leaving asks you to type the group's name to confirm, because you lose access
to the group's repository (your work stays with the group). The student who
created the group maintains it and can't leave; the teacher can move them
instead.

### Legacy group assignments

For an assignment tagged **Group (legacy)**, there is no group team:

1. **One teammate accepts** and creates the shared repository.
2. **That teammate adds the others** as collaborators.

To add collaborators, click the edit pencil at the top-right of a group
assignment:

![Group assignment page](images/web_assignment_edit_student.png)

Then click **Manage collaborators**:

![Manage collaborators](images/web_assignment_manage_collaborators_student.png)

> [!NOTE]
> Collaborators must be members of the organization and enrolled in the
> classroom.

## View your submissions

Open the assignment and click **My submission** in the left menu. A callout at
the top shows whether you've submitted and when; if you haven't, **Show me how
to submit** walks you through your first submission. On a group assignment the
menu item is **Group submission** instead, and the page shows your group and
teammates alongside the shared **Group repository**; the assignments list
offers the same views as **View group submission** and **View group**.

![Assignment submission](images/web_assignment_submission_student.png)

If your teacher configured autograding, click **View grade** to see your results
on GitHub:

![Submission on GitHub](images/web_assignment_github_release_student.png)

> [!NOTE]
> Scores live on your repository's GitHub **Releases** — each graded submission
> publishes a Release with the score and a per-test breakdown. Classroom 50
> can't yet display the score inside the app itself, so **View grade** takes
> you to the Release. Your teacher may also leave comments on your feedback
> pull request.
