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
- **Use a device code instead** — a manual fallback. Paste a code into a
  GitHub page, and Classroom 50 detects when you've authorized it.

When authorizing, grant access to any organization you'll use with Classroom 50.
If you don't own the organization, you may need to request access and have an
owner approve it in the organization's OAuth settings. If an organization you
belong to is missing later, see
[My organization doesn't appear](Troubleshooting#my-organization-doesnt-appear).

![Classroom 50 login flow](images/web_login_flow.png)

## View your organizations

![Organizations view](images/web_organizations.png)

After signing in, you'll see the organizations you can use:

- An organization that's set up shows an **Open** button. A token chip appears
  when the service token needs attention (for example **No service token** or
  **Token expired**) because score collection needs a valid token.
- Organizations that aren't set up yet appear under **Set up new
  organization**, each with a **Set up** button.

Don't see your organization? GitHub only reports organizations you've granted
Classroom 50 access to — see
[My organization doesn't appear](Troubleshooting#my-organization-doesnt-appear).

## Set up an organization (one-time)

![Setup steps](images/web_setup.png)

Click **Set up** on an uninitialized organization, then **Run setup**. This
configures your organization's settings and creates a `classroom50` repository
to hold Classroom 50's state.

When step 1 is complete, continue to step 2 to add your service token.

### Add a service token

The **service token** is a fine-grained personal access token (PAT) scoped to
your organization, used by the score-collection, regrade, and token-probe
workflows to read student repositories (and push regrade tags) across the org.
The form and the
pre-filled GitHub page set up the required permissions for you; the full
permission table is in
[GitHub Integration](GitHub-Integration#4-fine-grained-pat-for-score-collection).
Classroom 50 stores it as the `CLASSROOM50_SERVICE_TOKEN` secret in your
`classroom50` repository, where the daily score-collection workflow uses it.

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

## Add staff

If TAs or co-teachers help run the classroom, add them before students arrive:
open the classroom, click **Settings**, and use the **Staff and roles**
section. For the four roles, what each can see, and how to structure
multi-teacher setups, see
[Staff, TAs, and multiple teachers](Staff-TAs-and-Multiple-Teachers).

## Create an assignment

![Assignment form](images/web_create_assignment.png)

On the classroom page, click **+ Assignment**. Fill in:

- **Name** — the assignment's name.
- **Description** (optional) — details for students.
- **Due date** (optional) — a date and time in your local timezone. A due date
  marks later submissions **late** in the collected scores; it does not block pushes
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
  built-in autograder choice under [Submission and
  grading](#submission-and-grading):
  - autograder **off** → a **truly bare repository**: no commit,
    no autograding, and no feedback pull request (permanently — not just until
    the student's first commit). Use it when students build everything from
    scratch, including their own GitHub Actions.
  - autograder **on** → an initialized repository carrying only the control
    files (no README, no starter content) that grades normally.
- **Include all branches** (templated) — copy **all** of the template's
  branches into each student repository, not just the default branch. Useful
  for multi-branch starter repos.
- **Feedback pull request** — automatically opens a pull request per student so
  you can review changes and leave inline feedback.

The rest of the repository settings sit under **Advanced settings** in this
section — most assignments never need them:

- **Copy About from template** / **Copy topics from template** (templated, both
  on by default) — carry the template's About description and topics over to
  each student repository (GitHub's template-generate doesn't copy them on its
  own). Applies when students accept in the web app.
- **Use the template's pull request template as the Feedback PR body**
  (templated, with the Feedback pull request on) — use the template repository's
  own pull request template (`.github/pull_request_template.md`,
  `pull_request_template.md`, or `docs/pull_request_template.md`) as the body of
  each student's Feedback PR instead of the built-in text. The form auto-checks
  this when it finds such a file in the template; you can still toggle it. If the
  file is missing or can't be read, the built-in body is used, so nothing breaks.
  It is your responsibility to keep the template's contents correct.
- **Student repo access** — the role students get on their own repository.
- **Repository features** — per-feature settings for **Issues**, **Wiki**,
  **Projects**, and **Pull requests** on student repositories. The default,
  **Inherit from template**, re-applies the template's current setting at
  accept time (again, GitHub's generate doesn't copy these); you can force any
  feature **On** or **Off** instead. Template-less assignments default to
  GitHub's own defaults. To update repositories that already exist, use the
  **Update repository features** action on the submissions page.

> [!NOTE]
> **These settings can be changed after creation, but only affect repositories
> accepted from now on** — repositories students already accepted aren't
> retrofitted, so they keep their original starter code and setup. When at least
> one student has already accepted, the edit form asks you to confirm and warns
> that you'll need to update the existing repositories yourself. (**Assignment
> type** — Individual vs. Group — is the exception: it stays locked on edit,
> because switching it would invalidate every existing submission.)

### Submission and grading

- **Grading** — **Not graded** (the default), **Autograded**, or **Manual
  (enter scores by hand)**. The autograding options below appear only under
  **Autograded**; **Manual** assignments get a **Max points** field and
  you enter each student's score on the submissions page (see below). Can be
  changed after creation (edits only affect repositories accepted from now on).
- **Built-in autograder** — under **Autograded**, choose **Use the built-in
  autograder** (preselected when you switch to Autograded) or **Do not use the
  built-in autograder**. Opting out means accept installs no autograding
  workflow at all: on a templated assignment your template's own CI workflows
  run instead, and Classroom 50's score collection skips the assignment. Your
  choice sticks — leaving Autograded and coming back won't reset it. Can be
  changed after creation (edits only affect repositories accepted from now on;
  turning autograding off later makes already-accepted repositories' autograde
  runs fail and drop out of the collected scores).
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

A collapsed **Advanced settings** section, below the autograding tests in the
form, holds optional settings for customizing the autograding environment:

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
> Existing organizations must refresh the shared workflow files (re-run
> setup) before using submission release files. Submission publishing doesn't
> support GitHub Immutable Releases. See
> [Autograders](Advanced-Autograding#attaching-files-to-submission-releases)
> for path rules and limits.

Commands run in separate shell processes. See
[Autograders](Autograding-Basics#setup-commands-dependencies-and-environment-variables)
for dependency installation and environment-variable guidance.

### Autograding tests

Autograding tests run whenever a submission grades (per the assignment's
submission type). The list collapses to keep the form scannable; click its
heading to expand it, or **Add test** to add one (saving a test expands the
list automatically).

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

![Roster page, empty](images/web_students_none.png)

On a classroom's **Roster** page, add students and see who has joined and who
has a pending invitation. Adding a student sends them an invitation to join your
GitHub organization.

> [!IMPORTANT]
> Students must accept the organization invitation before they can work on
> assignments.

**Add member** — add one student by GitHub username (name and email
optional). You can enter an email instead of a username; that student then
completes a separate onboarding process (see below).

**Upload** — bulk-add students from a file. Roster CSV is how every upload is
read, and it handles all three shapes; the other two entries in **Read the file
as** are overrides that force one interpretation:

- **A roster CSV**: a header row plus one student per line. See the fields and
  example below.
- **A plain list**: one GitHub username or one email address per line, no
  header. Each line is read for what it is, so a mixed list works.
- **The overrides**: choose **GitHub usernames** to read every line as a handle
  even if it looks like an address, or **Email addresses** to read every line as
  an address and no columns at all. Either one is you telling the app what every
  line is, so a line that doesn't fit is reported rather than read the other way.

If any row carries a value the upload can't use — an address that isn't valid, a
`github_id` matching no account, a line that's neither a handle nor an address —
it lists those rows with their line numbers and imports none of them. Fix the
file and upload it again; re-uploading is safe, because students already in the
classroom are left alone. That check covers every identity column independently, so
a shifted column is caught even when the row's other cells look fine. The one
exception is a row with no identifying column at all, usually a student who hasn't
given you a GitHub account yet: that row is reported and skipped, and everyone else
is imported.

### Roster CSV fields

Each row needs at least one column that identifies a student: `github_id`,
`username`, or `email`. Every other column is optional. Headers are matched
case-insensitively, and any unrecognized column is ignored, so a CSV exported
from your SIS or gradebook usually works unchanged.

When a row has more than one, they're used in that order — `github_id` first,
then `username`, then `email`:

| Column | Identifies a student | Description |
| --- | --- | --- |
| `github_id` | Yes, first choice | The account's immutable numeric id, as written by Classroom 50's own `roster.csv`. Used to look up the account's current username, so a student who renamed their account is still found. |
| `username` | Yes, if there's no `github_id` | The student's GitHub username, e.g. `octocat`. |
| `email` | Yes, if there's neither | Invites the student by email. Also stored as their contact email on every row. |
| `first_name` | No | Given name, for display and score exports. |
| `last_name` | No | Family name, for display and score exports. |
| `name` | No | Full name in one column, split into first/last. Use instead of `first_name`/`last_name`. |
| `section` | No | A section or group label you can filter by. |
| `role` | No | `student` (default), `ta`, `hta`, or `teacher`. Leave blank for students. |

> [!NOTE]
> If a row's `github_id` and `username` disagree, the upload uses the account
> the id belongs to and asks you to confirm before importing — the preview shows
> both, and the roster's stored username is corrected to match. An id that
> doesn't match any GitHub account stops the import rather than falling back to
> the username, since the username could belong to someone else entirely.

A complete roster CSV looks like this:

| username | first_name | last_name | email | section |
| --- | --- | --- | --- | --- |
| octocat | Mona | Octocat | octocat@example.edu | A |
| hubot | Hu | Bot | hubot@example.com | A |
| octofez | Octo | Fez | | B |

As a plain text file:

```csv
username,first_name,last_name,email,section
octocat,Mona,Octocat,octocat@example.edu,A
hubot,Hu,Bot,hubot@example.com,A
octofez,Octo,Fez,,B
```

A single `username` column is also valid:

```csv
username
octocat
hubot
octofez
```

So is a file that identifies some students by account and others only by email —
useful at the start of term, when not everyone has reported a GitHub username:

```csv
github_id,username,email,first_name,section
583231,octocat,octocat@example.edu,Mona,A
,hubot,,Hu,A
,,octofez@example.edu,Octo,B
```

Here `octocat` is found by id (even after a rename), `hubot` by username, and
`octofez` is invited by email and appears as a pending row until they accept.

> [!NOTE]
> A row identified by account (`github_id` or `username`) is both invited **and**
> added to the roster. A row identified only by an email address is invited by
> email, and the address is recorded as a pending roster row. That row is matched
> to the student's GitHub account when they accept; if the invitation is
> cancelled or expires, the row is removed again on the next roster sync. Keep in
> mind the recorded address is the one **you invited** — not necessarily the email
> on the student's GitHub account. A name and section supplied in the CSV are kept
> on the pending row, so they're already there when the student joins — and you
> can correct them from the row while the invitation is still pending. The address
> itself can't be changed there, because it identifies the invitation: to use a
> different one, cancel and invite the new address.

A pending row is why the stored `roster.csv` can hold a row with no `username`
or `github_id`. Re-uploading such a file to **Upload** is fine — it reads those
rows by email — but `gh teacher roster import` rejects them, since the CLI still
requires a username. For more information, see
[Invitations by email](How-Classroom-50-Works#invitations-by-email).

> [!TIP]
> Adding students who are **already in your organization** (for example, from a
> previous course) is a different action. Inviting them again does nothing:
> GitHub reports "Already a member," and it won't put them on this classroom's
> roster. To enroll an existing member, open the organization's **Members** page
> in Classroom 50 and use **Add to classroom** (per member, or select several
> for the bulk action). See
> [Already an org member, but not on the roster](Troubleshooting#already-an-org-member-but-not-on-the-roster).

**The roster list** — everyone already in this classroom. Classroom 50
gives you two shareable links: one to accept the organization invite, and one to
onboard students added by email. Neither link enrolls anyone on its own: invite
the student from the roster first, then share a link so they can accept and sign
in. Below the links, each student's status shows whether they've joined the
organization.

## Collect submissions

![Assignment with no submissions](images/web_viewing_assignment.png)

Once an assignment exists, share its accept link with students: expand the
**How students accept** panel and copy the URL. When a student opens it, they're
taken to the accept page:

![Accepting an assignment](images/web_accept_assignment.png)

Accepting creates a repository named `<CLASSROOM>-<ASSIGNMENT>-<USERNAME>`.
Pushing to it triggers autograding, which builds a Release containing a
`result.json` file. The score-collection workflow (which runs daily, or on
demand) aggregates those results into the classroom's scores.

![Accept success](images/web_accept_assignment_success.png)

### View submissions

![Assignment with submissions](images/web_viewing_assignment_submissions.png)

Scores update when collection runs: the nightly workflow
covers every classroom, or click **Sync now** in the freshness strip at the top
of the submissions page (also **Collect now** in the **Actions** menu). Both
are **scoped to the current assignment** — they walk only this assignment's
repositories, so a sync is fast even in a large classroom and doesn't rebuild
other assignments' scores. The strip shows when this assignment's data was
last synced (a per-assignment `collected_at` stamp in `scores.json`). Click
**View workflow** to see the Actions run.

The top of the page shows:

- **Submitted** — submissions vs. students enrolled.
- **Classroom average** — average score among students who submitted.
- **Passing** — how many students are passing vs. failing.
- **Accepted** — how many students accepted (one per student).

> [!TIP]
> For larger classrooms, use the search box, filters ("Submitted", "On time",
> passing/failing, "Accepted"), and sorting (by name or submission date).

Each row shows a student's (or group's) latest submission plus its full history
(newest first). For each submission you can view the score, the submission date,
and links to the repository, the commit, the feedback pull request
(**Review**), and the Release (**View autograder details**). For where every
result lives — per-test breakdowns, past attempts, grading a specific commit,
and who submitted — see
[Reading results](Autograding-Basics#reading-results) in Autograding Basics.

### Scores and overrides

Each row's score cell has an edit button (pencil) that opens a score dialog.
It works for both grading modes:

- **Manual assignments** — enter a score out of the assignment's **Max
  points**.
- **Autograded assignments** — enter a score to override the autograded
  result. The autograded score is preserved and shown in the dialog; **Clear
  override** restores it. If the submission hasn't been autograded yet, the
  dialog also asks for the max points to grade out of.

An overridden score shows a **Manual** badge and won't be changed by
autograding until you clear the override. Entering a score writes the
`classroom50` repository's `scores.json`, so the editor appears only for
organization owners.

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
  preserved). This is the enforcement mechanism for due dates — the due date
  itself only marks submissions late. **Reopen submission** restores write
  access.
- **Lock assignment** / **Unlock assignment** — lock the assignment so
  students can't access or accept it (and, for a private template, remove the
  student team's read on it); unlock reopens it and restores template access.
  Useful for staging an assignment before release.
- **Download scores (CSV)** — export all submissions as a CSV.
- **Download all submissions** — download each repository's latest submission
  bundled into a single zip (built in the browser, one repository at a time;
  for very large classrooms prefer `gh teacher download`, which clones every repository
  and writes a `scores.csv` — see the
  [CLI Teacher Guide](CLI-Teacher-Guide#10-download-submissions)).

### Download scores

Click **Download scores (CSV)** to export all submissions as a CSV for a
spreadsheet or external tool. The column-by-column reference is in
[Score exports](Autograding-Basics#score-exports) in Autograding Basics.

## Edit assignments and classrooms

- **Edit an assignment** — open the assignment, then **Assignment settings**.
  Same form as creating one, pre-filled. Provisioning settings (repository
  source, built-in autograder, grading mode) are editable; a change only affects
  repositories accepted from then on, so the form asks you to confirm when
  students have already accepted. **Assignment type** (Individual vs. Group)
  stays locked, since switching it would invalidate existing submissions.
- **Edit a classroom** — open the classroom, then **Settings**. Same form as
  creating one, pre-filled. The page also offers **Clean up invite data**, which
  clears the addresses held for email invitations that were never accepted. See
  [Invitations by email](How-Classroom-50-Works#invitations-by-email).

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
