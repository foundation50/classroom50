# How Classroom 50 Works

This page describes the model behind Classroom 50 — what it is, where its data
is stored, and why teachers remain involved in administration. It also explains
behavior that is otherwise surprising, such as why a student is an admin of
their repository, or why unenrolling a student does not delete their repository.

## The mental model: GitHub is the backend

Many web tools have a server and a database: you sign in to their account, and
their systems store your data. Classroom 50 does not work this way.

- The **web app** ([classroom50.org](https://classroom50.org)) is a static site
  hosted on GitHub Pages. It runs in your browser.
- The **CLI** (`gh teacher` / `gh student`) runs on your own machine.

Neither keeps a database of classroom data. The web app stores only a small
amount of local state in your browser — your GitHub access token and interface
preferences such as theme and language — and the CLI reuses the GitHub CLI's
stored credentials. Everything else is stored in GitHub, and your classroom's
state is represented by ordinary GitHub data:

| What you think of as… | Is stored as… |
| --- | --- |
| Your classrooms, assignments, scores | Config files in a private `classroom50` repo in your org |
| Who's enrolled | GitHub organization and team membership |
| Who's staff (teacher/TA) | Membership in `secret` GitHub teams |
| A student's submissions | Commit history and Releases in their repo |
| Who can do what | GitHub permissions |

Classroom 50 reads and writes this GitHub data on your behalf, then reads it
back to show the current state. Most of the behavior described below follows
from this.

## Why teachers stay involved

Because there is no always-on server, the app does not change state on its own
while you are signed out. It cannot reconcile state in the background the way a
hosted service can. As a result:

- **Interactive work runs as you.** Creating a classroom, adding a student,
  saving an assignment, or inviting a TA runs at the moment you do it, using
  your signed-in GitHub token. These changes happen only when you make them.
- **Signing in can trigger reconciliation.** Opening a classroom lets the app
  correct things that have drifted — for example, migrating an old team name or
  re-checking organization settings. Some upkeep occurs only after an owner
  signs in and loads the page.
- **Background jobs require setup.** Score collection and regrading run as
  GitHub Actions on a schedule, but only after you provision the
  [service token](#the-service-token) that lets them act while you are offline.

For teachers, this means administering Classroom 50 is closer to administering
your own GitHub organization than to using a hosted service. If a view looks out
of date, signing in and reopening the page often updates it.

## Interactive vs. background work

Work happens in one of two ways. Knowing which applies explains most questions
about why a change did or did not take effect:

1. **Interactive actions** run as you, with your signed-in GitHub token, at the
   time you take them (create a classroom, add a student, accept an assignment).
   They are limited by your GitHub permissions and require you to be present.
2. **Asynchronous actions** run in **GitHub Actions workflows** in your config
   repo (publishing to Pages, collecting scores, regrading). They run in the
   background, can take a minute or more, and depend on the
   [service token](#the-service-token) rather than on you being online.

So when a change "hasn't shown up yet," it's usually a background workflow still
running (or GitHub Pages still deploying), not a lost action.

## The web app and CLI are equivalent

The web app and the `gh teacher` / `gh student` CLIs are two front ends over the
same GitHub operations; neither is primary. A classroom created in the web app
is fully manageable from the CLI and vice versa, because both read and write the
same files and teams in your organization. Use whichever you prefer, or mix
them.

## Roles are GitHub organization roles and teams

Classroom 50 has four roles, and each maps directly onto a GitHub construct:

| Role | On GitHub | Can |
| --- | --- | --- |
| **Teacher** | Organization **owner**, on the `-teacher` team | Everything, including org + classroom settings |
| **Head TA** | Org **member**, on the `-hta` team | Write the config repo; manage the classroom; not an owner |
| **TA** | Org **member**, on the `-ta` team | Read the config repo; view submissions |
| **Student** | Org **member**, on the classroom team | Accept and submit assignments |

Every classroom has a set of `secret` GitHub teams
(`classroom50-<classroom>-{teacher,hta,ta}` plus the student team
`classroom50-<classroom>`). Membership in these teams *is* the role — there's no
separate role database. That's why staff you invite show up as GitHub team
invitations, and why the classroom's **team is the source of truth for who's
enrolled** (not the `roster.csv`, which only carries display details like name
and section).

## The permission model: why students are admins

The organization is locked down to **least privilege**. During setup, Classroom
50 sets the org's base permission to **"No permission"** and disables risky
member capabilities (repo deletion, transfer, visibility changes, and more).
This org-wide lockdown is the safety boundary.

Against that backdrop, each student's access to *their own* assignment
repository is deliberately broad:

- **Individual assignments:** the student is created as an admin of their repo,
  then downgraded to **write**, enough to push work but not enough to do damage.
- **Group assignments:** the first student to accept (the **founder**) keeps
  **admin** on the shared repo, because they need it to invite teammates as
  collaborators. Classroom 50 has no separate "create a team" step — students
  form their own groups.

This is safe **because of** the org lockdown: even an admin on their own repo
can't delete it, change its visibility, transfer it, or reach another student's
private repo (the "No permission" base blocks cross-repo access). The generous
per-repo access and the strict org policy work together.

> [!NOTE]
> TAs and head TAs get read access to student repositories through the
> score-collection workflow, not at accept time. A newly accepted repo
> therefore has no staff team attached to it, which is expected.

## Why org policies sometimes "drift"

If you run both Classroom 50 and GitHub Classroom in the same organization, they
can disagree on a setting and flip it back and forth, most notably private-repo
forking. That tug-of-war shows up as "policy drift" in the setup/audit check.
Classroom 50 no longer enforces the forking setting for this reason; private
templates work either way. If you see a setting you fixed revert later, another
tool (or an org/enterprise policy) is changing it back.

## How grading flows

1. A student pushes to their repository (via `gh student submit` or a plain
   `git push`).
2. A small workflow in their repo calls the shared **autograde runner** in your
   config repo, which fetches the grading logic from Pages and runs it.
3. The result is published as a **GitHub Release** on the student's repo.
4. The **score-collection** workflow gathers those results into `scores.json`.

Autograding is optional — an assignment with no tests still tags submissions and
supports feedback. See [Autograders](Autograders) for the full pipeline.

### The Feedback PR opens on the first submission, not at accept

If you enable the Feedback pull request, it appears on the student's **first
submission that adds work**, not when they accept. This is by design: GitHub
can't open a pull request with no changes, and opening it later keeps the setup
files (the accept marker and autograde workflow) out of the diff you review. See
[Autograders](Autograders#feedback-pull-requests).

## Lifecycle: enroll, unenroll, and remove are separate

Classroom 50 keeps three actions deliberately distinct, so a small mistake can't
cascade into deleting a student's work:

- **Unenrolling** a student removes them from the classroom's roster and team.
  It does **not** remove them from the organization, and it does **not** delete
  their assignment repositories.
- **Removing** a student from the organization revokes their access to every
  repo in it (and, as a side effect, to their assignment repos) — but still
  doesn't delete the repositories.
- **Deleting** a repository is always a separate, manual action.

## Assignment repositories

Each accepted assignment produces a repository named:

```
<classroom>-<assignment>-<username>
```

For a group assignment, `<username>` is the founder who created the shared repo.
These are normal GitHub repositories — scripts that automate git operations
against them generally work the same as they did with GitHub Classroom.

> [!NOTE]
> **Adding a template after the fact is a gotcha.** Classroom 50 grants the
> classroom team read access to a private in-org template when you *create* the
> assignment with that template. If you create an assignment first and add the
> template later by editing it, that grant isn't re-applied — students may then
> 404 on accept. Set the template when creating the assignment, or re-grant team
> access to it.

## The service token

The **service token** is a fine-grained personal access token stored as a secret
in your config repo. The background workflows (score collection, regrade) use it
to read and update student repositories across the org — work that can't run as
"you" because it happens on a schedule when you're not online. It's the same
token whether you set it up in the web app or the CLI, and you need only one per
organization. See [the service-token setup](CLI-Teacher-Guide#create-the-service-token).

## How this differs from GitHub Classroom

| | GitHub Classroom | Classroom 50 |
| --- | --- | --- |
| Backend | Hosted service | None (GitHub repos + Actions) |
| Classroom ↔ org | One classroom per org | Many classrooms per org |
| Grading | Hosted autograder | GitHub Actions in each repo |
| Feedback PR | Opened at accept | Opened on first submission |
| Group naming | Team names | Founder's username |
| Data | In the service | In your `classroom50` config repo (yours to keep) |

For a term-by-term reference, see the [Glossary](Glossary); for common questions,
see the [FAQ](FAQ).
