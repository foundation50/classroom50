# Web Teacher Guide

This guide walks you through Classroom 50's web app at
[classroom50.org](https://www.classroom50.org), in the order you'll use it to
run a course. Prefer the terminal? See the [CLI Teacher Guide](CLI-Teacher-Guide).

**The path:** set up a GitHub organization → sign in → run one-time setup →
create a classroom → create assignments → add students → share accept links →
collect submissions.

> [!TIP]
> Have feedback, a bug, or an idea? Reach out in our
> [discussions](https://github.com/foundation50/classroom50/discussions).

## Before you start: GitHub setup

Classroom 50 stores its state in GitHub; there are no Classroom 50 servers.
Your classroom data lives in a [GitHub organization](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-organizations),
and rosters and submissions live in a repository inside it.

You need:

1. A [GitHub account](https://docs.github.com/en/get-started/start-your-journey/creating-an-account-on-github).
2. A GitHub organization on the **Team** or **Enterprise** plan. Classroom 50
   relies on Team-plan features like GitHub Pages and branch protection.

> [!NOTE]
> Verified educators can get Team-tier organizations **free** through
> [GitHub Education](https://docs.github.com/en/education/about-github-education/github-education-for-teachers/apply-to-github-education-as-a-teacher).

## Sign in

![Classroom 50 login screen](images/web_login_screen.png)

At [classroom50.org](https://classroom50.org), sign in with GitHub using
[OAuth 2](https://oauth.net/2/). Two options:

- **Sign in with GitHub** — the standard browser flow.
- **Use a device code** — a manual fallback. Paste a code into a GitHub page,
  and Classroom 50 detects when you've authorized it.

When authorizing, grant access to any organization you'll use with Classroom 50.
If you don't own the organization, you may need to request access and have an
owner approve it in the organization's OAuth settings. If an organization you
belong to is missing later, see
[My organization doesn't appear](Troubleshooting#my-organization-doesnt-appear).

![Classroom 50 login flow](images/web_login_flow.png)

## View your organizations

![Organizations view](images/web_organizations.png)

After signing in, you'll see the organizations you can use. Each shows a status:

| Status | Meaning |
| --- | --- |
| **Ready** | Set up and ready. Use **Open**. |
| **Needs service token** | Set up, but a service token is still required before score collection works. |
| **Uninitialized** | Not set up yet. Appears under "Set up new organization". |

Don't see your organization? GitHub only reports organizations you've granted
Classroom 50 access to — see
[My organization doesn't appear](Troubleshooting#my-organization-doesnt-appear).

## Set up an organization (one-time)

![Setup steps](images/web_setup.png)

Click **Set up** on an uninitialized organization, then **Run setup**. This
configures your organization's settings and creates a `classroom50` config
repository to hold Classroom 50's state.

When step 1 is complete, continue to step 2 to add your service token.

### Add a service token

The **service token** is a fine-grained personal access token (PAT) scoped to
your organization, used by the score-collection and regrade workflows to read
student repositories (and push regrade tags) across the org. It needs
**Contents**, **Actions**, and **Administration** read/write plus
**Organization → Members** read — the form and the pre-filled GitHub page set
these up for you; the full permission table is in
[GitHub Integration](GitHub-Integration#4-fine-grained-pat-for-score-collection).
Classroom 50 stores it as the `CLASSROOM50_SERVICE_TOKEN` secret in your config
repo, where the daily score-collection workflow uses it.

![Service token setup](images/web_pat.png)

Classroom 50 sends you to GitHub to create the token, then you paste it back
into the form to finish setup.

## Create a classroom

![Classrooms in an organization](images/web_classes.png)

Open a set-up organization from its card, or visit
`https://classroom50.org/<ORG>`, to see its classrooms.

> [!NOTE]
> A **classroom** holds a group of students and their assignments. An
> organization can have many classrooms — for example, one per class period or
> term.

On **My classrooms**, click **Create classroom**:

![Create classroom form](images/web_create_classroom.png)

- **Name** — the classroom's display name.
- **Slug** — a unique identifier used in URLs and repository names.
- **Term** (optional) — shown in various places to distinguish course
  offerings.

![Unlisted links toggle](images/web_create_classroom_hash.png)

**Use an unlisted link for this classroom** (optional) publishes this
classroom's assignment data at an unguessable URL instead of a predictable one
based on the slug.

> [!WARNING]
> Unlisted links are obscurity, not access control. The files are still public;
> anyone with the link can read them.

After creating, you'll get a URL of the form
`https://classroom50.org/<ORG>/<CLASSROOM>` to view your new classroom.

![Create classroom success](images/web_create_classroom_success.png)

> [!NOTE]
> Behind the scenes, this adds a subdirectory to your `classroom50` repository
> holding the classroom's roster and assignment list.

## Create an assignment

![Assignment form](images/web_create_assignment.png)

On the classroom page, click **+ Assignment**. Fill in:

- **Name** — the assignment's name.
- **Description** (optional) — details for students.
- **Due date** (optional) — a date and time in your local timezone. A deadline
  marks later submissions **late** in the gradebook; it does not block pushes
  or revoke access. To actually close an assignment, use the **Close
  submission** action (see below).
- **Assignment type** — **Individual** (one repository per student) or **Group
  project** (students share a repository and submit together).

### Repository setup

How each student's repository is created:

- **Start with a template** — **No template** or **Template repository**: a
  [template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository)
  used as each student's starting point. Enter `<owner>/<repo>`, or just
  `<repo>` if it's in this organization. See
  [Assignment Templates](Assignment-Templates) for requirements.
- **Add a README** (no-template assignments) — whether the repository starts
  with an initial commit. With it **off**, what students get depends on the
  built-in autograder choice below:
  - autograder **off** → a **truly bare repository**: no commit, no
    autograding, and no feedback pull request (permanently — not just until the
    student's first commit). Use it when students build everything from
    scratch, including their own GitHub Actions.
  - autograder **on** → an initialized repository carrying only the control
    files (no README, no starter content) that grades normally.
- **Include all branches** (templated) — copy **all** of the template's
  branches into each student repository, not just the default branch. Useful
  for multi-branch starter repos.
- **Copy About from template** / **Copy topics from template** (templated, both
  on by default) — carry the template's About description and topics over to
  each student repository (GitHub's template-generate doesn't copy them on its
  own). Applies when students accept in the web app.
- **Repository features** — per-feature settings for **Issues**, **Wiki**,
  **Projects**, and **Pull requests** on student repositories. The default,
  **Inherit from template**, re-applies the template's current setting at
  accept time (again, GitHub's generate doesn't copy these); you can force any
  feature **On** or **Off** instead. Template-less assignments default to
  GitHub's own defaults. To reconcile repositories that already exist, use the
  **Update repository features** action on the submissions page.
- **Feedback pull request** — automatically opens a pull request per student so
  you can review changes and leave inline feedback.
- **Student repo access** — the role students get on their own repository.

> [!WARNING]
> **The empty-repository choice is permanent** — you can't change it after
> creating the assignment, because repositories students already accepted
> can't be retrofitted.

### Grading and submissions

- **Built-in autograder** — **Use the built-in autograder** (the default) or
  **Do not use the built-in autograder**. Opting out means accept installs no
  autograding workflow at all: on a templated assignment your template's own
  CI workflows run instead, and Classroom 50's score collection skips the
  assignment. Immutable after creation.
- **Grading** — **Not graded**, **Autograded**, or **Manual (enter scores by
  hand)**. Manual assignments get a **Max points** field, and you enter each
  student's score directly on the submissions page (see below). Immutable
  after creation.
- **Submission type** — when the autograder runs. **Every push to the default
  branch** (the default) grades each push. **A tagged commit** grades only
  when a student submits (`gh student submit`) or pushes a `submit/*` tag —
  regular pushes cost no Actions minutes, which matters at scale.
- **Submission tags** (optional) — tag names (e.g. `phase1`, `phase2`,
  `complete`) that also trigger grading. A student pushes the tag with plain
  git (`git tag phase1 && git push origin phase1`) and that commit grades; the
  result appears as a normal `submit/*` release titled "via phase1". Prefer
  exact names — a broad glob like `v*` grades every matching tag. Changing
  them later requires the same trigger update as the mode (see below).

### Advanced settings

Optional settings for customizing the autograding environment:

- **GitHub runner** — the [runner](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)
  autograding runs on. `ubuntu-latest` is a good default.
- **Docker image** — grade inside a custom Docker image. The runner must be an
  Ubuntu variant, or Actions errors.
- **Setup command and timeout** — a shell command run before the other tests. Use
  it to compile code or install dependencies. New setup commands start at 120
  seconds; choose 0 for the runner's 10-second default or a whole number from 1
  through 600.
- **Allowed files** — a `.gitignore`-style list controlling which files remain
  for setup and grading. Include dependency manifests and project files used by
  setup.
- **Submission release files** — exact workspace-relative file paths (one per
  line) to attach to each submission's Release after grading. Paths are not
  globs; basenames must be unique and Release-safe. Missing or unsafe files are
  skipped with a warning.

> [!NOTE]
> Existing organizations must refresh the shared skeleton before using
> submission release files. Submission publishing doesn't support GitHub
> Immutable Releases. See [Autograders](Autograders#attaching-files-to-submission-releases)
> for path rules and limits.

Commands run in separate shell processes. See
[Autograders](Autograders#setup-commands-dependencies-and-environment-variables)
for dependency installation and environment-variable guidance.

### Autograding tests

Autograding tests run whenever a submission grades (per the assignment's
submission type). Click **Add test** to add one.

![Autograding tests](images/web_create_assignment_tests.png)

Each test has:

- **Test name** — shown to students to indicate what passed or failed.
- **Test type** — Input/Output, Run command, or Python (pytest).
- **Setup command** — an optional command run before the test.
- **Run command** — the command the runner executes.
- **Timeout (seconds)** — how long to wait before terminating the test.
- **Points** — the test's weight.

The three test types add their own fields:

**Input/Output** — provide input and check the output.

![Input/Output test](images/web_create_assignment_tests.png)

- **Input (stdin)** — text sent to standard input.
- **Expected output** — text to check for in standard output.
- **Comparison** — **Included** (expected appears somewhere in the output),
  **Exact** (output equals expected), or **Regex** (output matches a pattern).

**Run command** — pass when a command returns a given exit code.

![Run command test](images/web_create_assignment_tests_run_command.png)

- **Required exit code** — the exit code needed to pass.

**Python (pytest)** — runs `pytest` against test files in the template. No extra
fields.

![Python pytest test](images/web_create_assignment_tests_python_pytest.png)

When you're done, click **Create assignment**.

![Classroom with one assignment](images/web_classroom_with_assignment.png)

## Add students

Students must be on the classroom roster before they can accept assignments.

![Students page, empty](images/web_students_none.png)

On a classroom's **Students** page, add students and see who has joined and who
has a pending invitation. Adding a student sends them an invitation to join your
GitHub organization.

> [!IMPORTANT]
> Students must accept the organization invitation before they can work on
> assignments.

**Add member** — add one student by GitHub username (name and email
optional). You can enter an email instead of a username; that student then
completes a separate onboarding process (see below).

**Upload roster** — bulk-add students from a CSV or text file of GitHub
usernames.

**Enrolled students** — the students already in this classroom. Classroom 50
gives you two shareable links: one to accept the organization invite, and one to
onboard students added by email. Below the links, each student's status shows
whether they've joined the organization.

## Collect submissions

![Assignment with no submissions](images/web_viewing_assignment.png)

Once an assignment exists, share its accept link with students: expand the
**How students accept** panel and copy the URL. When a student opens it, they're
taken to the accept page:

![Accepting an assignment](images/web_accept_assignment.png)

Accepting creates a repository named `<CLASSROOM>-<ASSIGNMENT>-<USERNAME>`.
Pushing to it triggers autograding, which builds a Release containing a
`result.json` file. The score-collection workflow (which runs daily, or on
demand) aggregates those results into the classroom's gradebook.

![Accept success](images/web_accept_assignment_success.png)

### View submissions

![Assignment with submissions](images/web_viewing_assignment_submissions.png)

Scores flow into the gradebook when collection runs: the nightly workflow
covers every classroom, or click **Sync now** in the freshness strip at the top
of the submissions page (also **Collect now** in the **Actions** menu). Both
are **scoped to the current assignment** — they walk only this assignment's
repositories, so a sync is fast even in a large classroom and doesn't rebuild
other assignments' gradebooks. The strip shows when this assignment's data was
last synced (a per-assignment `collected_at` stamp in `scores.json`). Click
**View workflow** to see the Actions run.

The top of the page shows:

- **Submitted** — submissions vs. students enrolled.
- **Classroom average** — average grade among students who submitted.
- **Passing** — how many students are passing vs. failing.
- **Accepted** — how many students accepted (one per student).

> [!TIP]
> For larger classes, use the search box, filters ("Submitted", "On time",
> passing/failing, "Accepted"), and sorting (by name or submission date).

Each row shows a student's (or group's) latest submission plus its full history
(newest first). For each submission you can view the score, the submission date,
and links to the repository, the commit, the feedback pull request
(**Review**), and the Release (**Details**).

### Manual grades

On an assignment created with **Grading → Manual (enter scores by hand)**, each
row gets an **Add grade** / **Edit grade** button for entering a score out of
the assignment's **Max points**. A hand-entered score is stored as an override
in the classroom's `scores.json` and shows a **Manual** badge — autograding
won't change it until the override is cleared.

The inline editor appears only on manual-mode assignments, and only for
organization owners (entering a score writes the config repo). To adjust a
score on an **autograded** assignment, edit `scores.json` directly — see the
[FAQ](FAQ#can-i-manually-override-or-adjust-a-grade).

### Bulk actions

The **Actions** menu at the top of the submissions page operates on the whole
assignment:

- **Metrics** — summary statistics for the assignment.
- **Open all Feedback PRs** — review each student's feedback pull request in
  turn.
- **Collect now** — trigger a score collection scoped to this assignment.
- **Regrade all** — re-run the autograder on every collected submission.
- **Update student repo access** — bulk-set every student's role on their
  repository (e.g. drop everyone to read-only for grading, restore write
  afterwards).
- **Update repository features** — re-apply the assignment's Issues / Wiki /
  Projects / Pull-requests settings to every existing student repository
  (repositories created before a settings change, or before features were
  inherited from the template).
- **Update autograding triggers** — retrofit existing repositories after a
  submission-type change (see below).
- **Pause autograding** / **Resume autograding** — disable or re-enable the
  built-in `autograde.yaml` workflow in every student repository via GitHub's
  workflow-disable API. No files are changed, and you can resume anytime;
  other workflows in student repositories keep running. Use it to stop
  autograding for one assignment without touching the rest of the org.
  (Available on individual assignments that use the built-in autograder, once
  students have accepted; a single repository can also be paused from its row.)
- **Close submission** / **Reopen submission** — close the submission window:
  block new accepts and set every student's repository to read-only (work is
  preserved). This is the enforcement mechanism for deadlines — the due date
  itself only marks submissions late. **Reopen submission** restores write
  access.
- **Lock assignment** / **Unlock assignment** — lock the assignment so
  students can't access or accept it (and, for a private template, remove the
  student team's read on it); unlock reopens it and restores template access.
  Useful for staging an assignment before release.
- **Download scores (CSV)** — export all submissions as a CSV.
- **Download all submissions** — download each repository's latest submission
  bundled into a single zip (built in the browser, one repository at a time;
  for very large classes prefer `gh teacher download`, which clones every repo
  and writes a `scores.csv` — see the
  [CLI Teacher Guide](CLI-Teacher-Guide#10-download-submissions)).

### Download scores

Click **Download scores (CSV)** to export all submissions as a CSV for a
spreadsheet or external tool.

## Edit assignments and classrooms

- **Edit an assignment** — open the assignment, then **Assignment settings**.
  Same form as creating one, pre-filled.
- **Edit a classroom** — open the classroom, then **Settings**. Same form as
  creating one, pre-filled.

### Changing the submission type later

The trigger is baked into each student repository's autograding workflow when
the student accepts, so changing the submission type in **Assignment settings**
only affects repositories created from then on. To update repositories students
already accepted:

1. Change the trigger in **Assignment settings** and save.
2. On the submissions page, open the actions menu and click **Update
   autograding triggers**. It rewrites each repository's workflow to match
   (the commit is marked so it doesn't trigger grading), reports repositories
   whose workflow was hand-edited (those are left untouched), and skips
   students who haven't accepted. A single repository can also be updated from
   its row's manage dialog.
3. Tell students to run `git pull` — clones made before the update will
   conflict on their next push.

The bulk action is available for assignments using the default autograder
(a custom autograder's workflow is yours to edit) and needs your GitHub
authorization to include the `workflow` scope — sign out and back in if the
action reports a permissions problem.
