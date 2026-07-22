# Web Student Guide

This guide walks you through using Classroom 50's web app at
[classroom50.org](https://www.classroom50.org) as a student. Prefer the
terminal? See the [CLI Student Guide](CLI-Student-Guide).

**The path:** join your classroom's organization → sign in → accept an
assignment → do the work and submit → view your grade.

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
- **Use a device code** — a manual fallback. Paste a code into a GitHub page,
  and Classroom 50 detects when you've authorized it.

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

Afterward, your organization page lists the assignment repository you now own:

![One assignment](images/web_assignments_student.png)

## Submit your work

You submit by [committing](https://github.com/git-guides/git-commit) and
[pushing](https://github.com/git-guides/git-push) to the repository you got when
you accepted. Using the CLI instead? See
[Submit in the CLI Student Guide](https://github.com/foundation50/classroom50/wiki/CLI-Student-Guide#4-submit).

## Group assignments

Some assignments are done in a group. When accepting, you'll see the assignment
tagged **Individual** or **Group**.

For a group assignment:

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

Open the assignment and click **My submission** in the left menu:

![Assignment submission](images/web_assignment_submission_student.png)

If your teacher configured autograding, click **View grade** to see your results
on GitHub:

![Submission on GitHub](images/web_assignment_github_release_student.png)
