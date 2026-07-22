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
owner approve it in the organization's OAuth settings.

![Classroom 50 login flow](images/web_login_flow.png)

## View your organizations

![Organizations view](images/web_organizations.png)

After signing in, you'll see the organizations you can use. Each shows a status:

| Status | Meaning |
| --- | --- |
| **Ready** | Set up and ready. Use **Open**. |
| **Needs service token** | Set up, but a service token is still required before score collection works. |
| **Uninitialized** | Not set up yet. Appears under "Set up new organization". |

Don't see your organization? Grant it access in Classroom 50's
[OAuth settings](https://github.com/settings/connections/applications).

## Set up an organization (one-time)

![Setup steps](images/web_setup.png)

Click **Set up** on an uninitialized organization, then **Run setup**. This
configures your organization's settings and creates a `classroom50` config
repository to hold Classroom 50's state.

When step 1 is complete, continue to step 2 to add your service token.

### Add a service token

The **service token** is a fine-grained personal access token (PAT) with read
access to your organization's repositories. Classroom 50 stores it as the
`CLASSROOM50_SERVICE_TOKEN` secret in your config repo, where the daily
score-collection workflow uses it.

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
- **Template repository** (optional) — a [template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository)
  used as each student's starting point. Enter `<owner>/<repo>`, or just
  `<repo>` if it's in this organization. Leave blank for an empty starter repo.
- **Due date** (optional) — a date and time in your local timezone.
- **Assignment type** — **Individual** (one repository per student) or **Group
  project** (students share a repository and submit together).
- **Feedback pull request** — automatically opens a pull request per student so
  you can review changes and leave inline feedback.
- **Empty repository** — creates each student's repository completely empty: no
  starter files, no autograding, no feedback pull request. Use it when students
  build everything from scratch, including their own GitHub Actions.

> [!WARNING]
> **Empty repository is permanent** — you can't change it after creating the
> assignment, because repositories students already accepted can't be
> retrofitted. Enabling it hides the template and grading fields.

### Advanced settings

Optional settings for customizing the autograding environment:

- **GitHub runner** — the [runner](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)
  autograding runs on. `ubuntu-latest` is a good default.
- **Docker image** — grade inside a custom Docker image. The runner must be an
  Ubuntu variant, or Actions errors.
- **Setup command** — a shell command run before grading (for example, to
  compile C code with `gcc`).
- **Allowed files** — a `.gitignore`-style list controlling which files are
  considered during grading.
- **Submission release files** — exact workspace-relative file paths (one per
  line) to attach to each submission's Release after grading. Paths are not
  globs; basenames must be unique and Release-safe. Missing or unsafe files are
  skipped with a warning.

> [!NOTE]
> Existing organizations must refresh the shared skeleton before using
> submission release files. Submission publishing doesn't support GitHub
> Immutable Releases. See [Autograders](Autograders#attaching-files-to-submission-releases)
> for path rules and limits.

### Autograding tests

Autograding tests run every time a student pushes. Click **Add test** to add
one.

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

Collect scores by letting the nightly workflow run, or click **Collect now** at
the top of the submissions page. Click **View workflow** to see the Actions run.

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

### Download scores

Click **Download Scores (CSV)** at the top right to export all submissions as a
CSV for a spreadsheet or external tool.

## Edit assignments and classrooms

- **Edit an assignment** — open the assignment, then **Assignment settings**.
  Same form as creating one, pre-filled.
- **Edit a classroom** — open the classroom, then **Settings**. Same form as
  creating one, pre-filled.
