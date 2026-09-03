# Web Student Guide

This guide walks you through using Classroom 50's web app at
[classroom50.org](https://www.classroom50.org) as a student. Prefer the
terminal? See the [CLI Student Guide](CLI-Student-Guide).

The path: join your classroom's organization, sign in, accept an assignment,
do the work and submit, then view your score.

> [!TIP]
> Have feedback, a bug, or an idea? Raise it in the project's
> [discussions](https://github.com/foundation50/classroom50/discussions).

## Before you start

You need a [GitHub account](https://docs.github.com/en/get-started/start-your-journey/creating-an-account-on-github).
Classroom 50 runs entirely on GitHub.

## Join your classroom

Your classroom belongs to a [GitHub organization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-organizations).
When your teacher invites you, GitHub emails you an invitation. Accept it in
any of these ways:

- Follow the link in the email.
- Sign in to Classroom 50. The home page lists your pending invitations. Expand
  the list and click **Accept and open**.
- Open the assignment link your teacher shared. The accept page accepts the
  invitation for you before it shows the assignment.

If you open an assignment link before you've been invited, the page says
**Not a member yet**. Ask your teacher to add you to the classroom roster and
send you an invitation. When it arrives, accept it, then click **Check again**.

## Sign in

At [classroom50.org](https://classroom50.org), click **Sign in with GitHub**
and authorize Classroom 50 in the window that opens.

If the browser sign-in doesn't work for you, expand **Other sign-in methods**
and click **Use a device code instead**. Copy the one-time code, open the
GitHub verification page, paste the code there, and come back. Classroom 50
detects the authorization within a few seconds.

## Find your assignments

After signing in, the home page lists your **Classroom 50 organizations**.

1. On the organization for your classroom, click **Open**.
2. On the **My classrooms** page, find your classroom and click
   **View assignments**.

The **Assignments** page lists every assignment your teacher has released, with
its type (**Individual**, **Group**, or **Group (legacy)**), due date, and
status (**Accepted** or **Not accepted**). Click **Accept assignment** to accept
one. Once you have, the button reads **View my submission** (or **View group
submission** on a group assignment).

Some assignments open only from the invite link your teacher shares. After you
accept one, it appears in the list too.

## Accept an assignment

Open the assignment link your teacher shared, or click **Accept assignment** on
the **Assignments** page. The accept page shows the assignment's type and due
date, its details, who you're signed in as, and the name of the repository
you'll get. Click **Accept assignment**.

Accepting creates a GitHub repository for you, named after the classroom, the
assignment, and your username, for example `cs50-fall-2026-hello-alice`. A
checklist tracks the setup. When it finishes, click **Open repository** to see
your repository on GitHub, or **Go to my classroom** to return to your
assignments.

If you open the link again later, the page says you've already accepted and
offers **Open repository**. If autograding isn't running or setup files are
missing, expand **Having trouble?** and click **Re-run setup** to repair your
repository.

> [!NOTE]
> Your repository is private unless your teacher configured the assignment to
> create public repositories. In that case the accept page warns you before you
> accept: **This repository will be public**, so anyone on the internet can see
> your work, including your code, commits, and name. If your organization
> doesn't let you create public repositories, a private one is created instead.

You can't accept when the page reports one of these:

- **This assignment is locked.** Your teacher has locked it. Check back later or
  ask your teacher to unlock it.
- **Submissions are closed.** Your teacher has closed it to new submissions. If
  you already accepted, your repository still opens as usual.
- **This assignment isn't available to you.** You aren't enrolled in this
  classroom. Ask your teacher if you think this is a mistake.
- **Assignment not found.** The link may be incorrect, or the assignment may
  not be published yet. Check the address with your teacher.

## Submit your work

You submit by [committing](https://github.com/git-guides/git-commit) and
[pushing](https://github.com/git-guides/git-push) to the repository you got when
you accepted. Your **My submission** page (see
[View your submissions](#view-your-submissions)) includes **Submit from the
command line**, a short guide with copyable commands: clone your repository
once, then run `gh student submit` from inside it. For the full command-line
walkthrough, see
[Submit in the CLI Student Guide](CLI-Student-Guide#4-submit).

### Submit-only assignments

Some assignments grade only on submit: pushing saves your work but doesn't
grade it, and the commit's check says so. To be graded, run
`gh student submit` from inside your repository, or push a tag under
`submit/`:

```sh
git tag submit/final && git push origin submit/final
```

Some assignments also name milestone tags (for example `phase1`; your teacher
tells you which). Push one to grade that commit:

```sh
git tag phase1 && git push origin phase1
```

If your teacher changes an assignment's grading setup, run `git pull` before
your next push.

## Group assignments

Some assignments are done in a group. The **Assignments** page shows the type
as **Group** or **Group (legacy)**; the accept page labels both
**Group assignment**.

For a **Group** assignment, your group shares one repository, named after the
classroom, the assignment, and a group number, for example
`cs50-fall-2026-project-group-3`. The repository is created when the first
member accepts, and every member gets push access through the group's GitHub
team. How you get into a group depends on the assignment:

- **Teacher-formed groups.** The accept page says **You're not in a group
  yet**. Ask your teacher to add you to a group, then open the link again.
- **Student-formed groups.** Under **Join a group**, the accept page lists the
  existing groups with their member counts. Click **Ask to join** to open a
  group's page on GitHub and select **Request to join** there (the group
  reviews requests on that page, where you can also cancel yours). Once you're
  in, come back and click **Check again**. Or start your own group: fill in
  **Group name (optional)** and click **Create group**. You become its first
  member and can add teammates after you accept.

After accepting, click **Manage my group** on the accept page (or
**Manage group** in the assignment's left menu) to see your group and its
members. In a teacher-formed group the list is read-only; ask your teacher for
changes. In a student-formed group:

- The student who created the group maintains it. Only they can add a teammate
  by GitHub username (click **Add**), remove members, and
  **Review join requests on GitHub**. They can't leave the group; the teacher
  can move them instead.
- Other members can click **Leave group**. You type the group's name to
  confirm, because you lose access to the group's repository (your work stays
  with the group), and rejoining takes another request and approval.

### Legacy group assignments

For an assignment shown as **Group (legacy)**, there is no group team:

1. One teammate accepts and creates the shared repository, named after them.
2. That teammate adds the others as collaborators.

To add collaborators, click **Edit collaborators** on the accept page, or open
**Manage group** in the assignment's left menu and click
**Manage collaborators**. In the **Group collaborators** dialog, add each
teammate by GitHub username, then click **Save collaborators**. Only the
teammate who created the repository can manage collaborators, and the dialog
enforces the assignment's maximum group size.

Collaborators must be members of the organization. Only collaborators who are
enrolled in the classroom receive the group's score.

## View your submissions

Open the assignment and click **My submission** in the left menu (on a group
assignment, **Group submission**). A callout at the top shows whether you've
submitted and when. If you haven't, click **Show me how to submit** to open
the command-line guide. Below it, a table shows your repository (on a group
assignment, the **Group repository**, with your teammates listed above it), how
many submissions you've made, and when you last submitted. The row's actions
open your repository on GitHub, list your submissions (**View submissions**),
and, once a submission has been graded, open the latest result
(**View autograder details**). In the submissions list, each graded submission
has a **View score** link. On a group assignment, the list also names the
teammate who made each commit.

The **Assignments** page offers the same views: **View my submission**, or on a
group assignment **View group submission** and **View group**.

> [!NOTE]
> Scores live on your repository's GitHub **Releases**: each graded submission
> publishes a Release with the score and a per-test breakdown. Classroom 50
> doesn't display the score inside the app, so **View autograder details** and
> **View score** take you to the Release. Your teacher may also leave comments
> on your feedback pull request.
