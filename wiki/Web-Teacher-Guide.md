# Web Teacher Guide

This guide walks you through Classroom 50's web app at
[classroom50.org](https://www.classroom50.org), in the order you'll use it to
run a course. Prefer the terminal? See the [CLI Teacher Guide](CLI-Teacher-Guide).

**The path:** set up a GitHub organization → sign in → run one-time setup →
create a classroom → create assignments → add students → share invite links →
collect submissions.

> [!TIP]
> Have feedback, a bug, or an idea? Raise it in the project's
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

At [classroom50.org](https://classroom50.org), click **Sign in with GitHub**.
This is the standard browser flow: GitHub asks you to authorize Classroom 50,
then returns you to the app.

**Other sign-in methods** expands three alternatives:

- **Use a device code instead**: copy the one-time code, open the GitHub
  verification page, paste the code, and authorize the app. Classroom 50
  detects the authorization within a few seconds. Use it on a machine without a
  browser, or when the browser flow can't return to this page.
- **Use a personal access token (classic)**: a classic token works across every
  organization you own. **Create a classic token** opens GitHub's token page
  with the scopes Classroom 50 needs already selected. Paste the token back and
  click **Sign in with token**.
- **Use a personal access token (fine-grained)**: enter the **Organization
  name** the token should manage, then click **Create a fine-grained token**. A
  fine-grained token works with one organization only, so template
  repositories in other organizations fail to copy. Set **Repository access**
  to **All repositories** on the token page.

Token sign-ins skip Classroom 50's sign-in service. Like the other methods,
they store the token in this browser's local storage. A token's permissions are
fixed when you create it, so an action that needs more (such as tearing down an
organization) means creating a new token and signing in again.

When authorizing, grant access to any organization you'll use with Classroom 50.
If the organization restricts third-party apps, request access and ask an
organization owner to approve it in the organization's OAuth settings. If an
organization you belong to is missing later, see
[My organization doesn't appear](Troubleshooting#my-organization-doesnt-appear).

## View your organizations

After signing in, the **Classroom 50 organizations** page lists the
organizations you can use:

- An organization that's set up shows an **Open** button. A token chip appears
  when the service token needs attention (for example **No service token**,
  **Token expiring soon**, or **Token expired**), because score collection
  needs a valid token. The card's menu offers **Manage token**, **Details**,
  and **Hide from home**.
- Pending invitations to organizations appear above the list. Click **Accept
  and open** to join one.
- To set up an organization you own that isn't set up yet, click **Set up new
  organization**. The dialog lists those organizations, each with a **Set up**
  button. An organization on the Free plan shows **Not supported** instead,
  because Classroom 50 needs the Team or Enterprise plan.

Don't see your organization? GitHub only reports organizations you've granted
Classroom 50 access to. See
[My organization doesn't appear](Troubleshooting#my-organization-doesnt-appear).

## Set up an organization (one-time)

Setup has three steps. The page derives the current step from what already
exists on GitHub, so a reload lands on the same step.

1. Click **Set up** on the organization, then click **Run setup**. This
   configures your organization's settings (member privileges, GitHub Actions,
   a $0 Actions spending cap, and rulesets), creates a private `classroom50`
   repository to hold Classroom 50's state, installs the workflow files in it,
   and turns on GitHub Pages for it. Each step reports its result. A step that
   couldn't be applied automatically says what to set by hand on GitHub.
2. Click **Next: service token** and add the token described below.
3. Click **Done** to open the organization.

The organization's **Settings** page (owners only) keeps every setting from
setup in one place:

- **Service token**: the token described above, with **Test token** and **Set
  a new token**.
- **GitHub Actions**: a switch that pauses autograding for every student
  repository in the organization, plus this month's Actions minutes.
- **Member team creation**: see [Member team creation](#member-team-creation).
- **Organization policy**: an audit of what setup configured, with **Fix it**
  for anything changed outside Classroom 50.
- **Re-run setup**: refresh the workflow files and settings after an upgrade.
- **Danger zone**: tear the organization down.

### Add a service token

The **service token** is a fine-grained personal access token (PAT) scoped to
your organization. The score-collection, regrade, and token-check workflows use
it to read student repositories (and push regrade tags) across the
organization. The form and the pre-filled GitHub page set up the required
permissions for you; the full permission table is in
[4. Fine-grained PAT for score collection](GitHub-Integration#4-fine-grained-pat-for-score-collection).
Classroom 50 stores it as the `CLASSROOM50_SERVICE_TOKEN` secret in your
`classroom50` repository, where the workflows read it.

In the **Service token** section, click **Set a token**. The dialog has two
steps:

1. Choose a **Token expiry** (120 days by default), then click **Generate new
   access token**. GitHub's token page opens with the name, expiry, and
   permissions pre-filled. Set **Repository access** to **All repositories**
   and generate the token.
2. Paste the token into **Paste token** and click **Save token**. Classroom 50
   validates it against the `classroom50` repository before saving.

To rotate a token later, click **Set a new token** in the same section. The
section shows the token's expiry, and the token chip on the organizations page
warns you as it approaches.

#### Test the token

Saving a token checks what it can prove from the `classroom50` repository
and one other repository. The permissions that only matter once collection
reads your classroom teams and re-runs workflows (organization **Members:
Read**, **Actions**, and whether the token can see each staff team) are checked
by a read-only workflow in your organization. In the **Service token** section,
the **Test token** button runs it and shows the verdict in place:

- A pass means the token has every permission Classroom 50 needs.
- A failure lists the permissions the check found missing, with a **View run**
  link to the full log. Create a new token with those permissions and use
  **Set a new token** to save it.

Run it after setting or rotating a token, or when a collect or regrade run
fails with a 401 or 403. The check only reads, so it's safe to run at any time.
If the result says the organization's workflow files don't include the check
yet, use **Re-run setup** on the same page to update them, then test again.

### Member team creation

Group assignments where students form their own groups work by letting the
founding student create the group's GitHub team when accepting, so setup turns
on the organization's "Allow members to create teams" member privilege. The
organization settings page has a **Member team creation** section with an
**Allow members to create teams** toggle that matches that GitHub setting.
While it's off, students can't create teams, so student-formed group
assignments can't work, and the new-assignment form disables the **Group**
type.

## Create a classroom

Open a set-up organization from its card, or visit
`https://classroom50.org/YOUR-ORGANIZATION`, to see its classrooms.

> [!NOTE]
> A **classroom** holds a group of students and their assignments. An
> organization can have many classrooms, for example one per class period or
> term.

On **My classrooms**, click **Create classroom**:

- **Classroom name**: the classroom's display name.
- **Classroom slug**: a unique identifier used in URLs and repository names,
  auto-filled from the name (letters with diacritics transliterate, so
  "Álgebra" becomes "algebra"). At most 40 characters: the slug prefixes every
  student repository name, and GitHub limits repository names to 100
  characters.
- **Classroom term** (optional): shown in various places to distinguish course
  offerings.
- **Use an unlisted link for this classroom** (optional): publishes this
  classroom's assignment data at an unguessable URL instead of a predictable
  one based on the slug. Turning it on reveals an **Access key**: accept the
  generated key or type your own (**Regenerate** picks another). The key
  becomes part of every published URL for this classroom and can't be changed
  later without students re-accepting their assignments.

> [!WARNING]
> Unlisted links are obscurity, not access control. The files are still public;
> anyone with the link can read them.

After creating, you'll get a URL of the form
`https://classroom50.org/YOUR-ORGANIZATION/YOUR-CLASSROOM` to view your new
classroom. Behind the scenes, this adds a subdirectory to your `classroom50`
repository holding the classroom's roster and assignment list.

## Add staff

If TAs or co-teachers help run the classroom, add them before students arrive:
open the classroom, click **Settings**, and use the **Staff and roles**
section. Enter a **GitHub username**, choose a **Role**, and click **Add**. For
the four roles, what each can see, and how to structure multi-teacher setups,
see [Staff, TAs, and Multiple Teachers](Staff-TAs-and-Multiple-Teachers).

## Create an assignment

On the classroom's **Assignments** page, click **Assignment**. (The arrow next
to it opens **Reuse assignment**, which copies an existing assignment from
another classroom in the organization: name, template, tests, runtime, and due
date come along; student repositories and scores don't.)

The form has four sections: **Details**, **Repository setup**, **Submission and
grading**, and **Schedule and access**. Most assignments only need the first
two. While creating, a section that differs from its defaults shows a **Reset**
link that restores only that section.

### Details

- **Assignment name**: the assignment's name.
- **Assignment slug**: the identifier used in student repository names,
  auto-filled from the name (diacritics transliterate, the same as classroom
  slugs). The classroom slug and the assignment slug together can spend at
  most 59 characters, so `CLASSROOM-ASSIGNMENT-USERNAME` stays within GitHub's
  100-character repository-name limit for any username. If you edit the slug,
  the form warns as you type when it is over that budget or collides with an
  existing assignment. The slug can't be changed after creation.
- **Description** (optional): details for students.
- **Assignment type**: **Individual** (one repository per student), **Group**
  (teammates share one repository, owned by a GitHub team Classroom 50
  manages; marked **Recommended**), or **Group (legacy)** (the older shared
  repository managed through repository collaborators). Both group types set a
  **Max group size** (2 by default), and **Group** adds a **Group formation**
  choice:
  - **Teacher assigns groups.** You create the groups and add students on the
    assignment's **Manage groups** page. Students who aren't in a group can't
    accept.
  - **Students form groups.** The first student creates the group when
    accepting, then adds teammates up to the max group size.

  Student-formed groups need organization members to be able to create teams,
  so the form disables the **Group** type, with an explanation, while the
  organization disallows it. Setup enables the setting by default; turn it
  back on under [Member team creation](#member-team-creation) in the
  organization settings.

### Repository setup

How each student's repository is created:

- **Start with a template**: **No template** (the default) or **Template
  repository**, a
  [template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository)
  used as each student's starting point. Search your organization's template
  repositories by name, or paste `OWNER/REPOSITORY` (or a full GitHub
  repository URL) for a template the search doesn't list. See
  [Assignment Templates](Assignment-Templates) for requirements.
- **Add a README** (no-template assignments, off by default): whether the
  repository starts with an initial commit. With it **off**, what students get
  depends on the built-in autograder choice under [Submission and
  grading](#submission-and-grading):
  - Autograder **off**: a truly bare repository, with no commit, no
    autograding, and no feedback pull request (permanently, not only until the
    student's first commit). Use it when students build everything from
    scratch, including their own GitHub Actions.
  - Autograder **on**: an initialized repository carrying only the control
    files (no README, no starter content) that grades normally.
- **Include all branches** (templated): copy every branch of the template into
  each student repository, not only the default branch. Useful for
  multi-branch template repositories.
- **Feedback pull request** (on by default): automatically opens a pull request
  per student so you can review changes and leave inline feedback. Unavailable
  for a bare repository, which has no starter commit to compare against.

The rest of the repository settings sit under **Advanced settings** in this
section. Most assignments never need them:

- **Copy About from template** and **Copy topics from template** (templated,
  both on by default): carry the template's About description and topics over
  to each student repository, because GitHub's template generation doesn't
  copy them on its own.
- **Use the template's pull request template as the Feedback PR body**
  (templated, with the feedback pull request on): use the template
  repository's own pull request template (`.github/pull_request_template.md`,
  `pull_request_template.md`, or `docs/pull_request_template.md`) as the body
  of each student's feedback pull request instead of the built-in text. The
  form checks this automatically when it finds such a file in the template;
  you can still toggle it. If the file is missing or can't be read, the
  built-in body is used, so nothing breaks. You are responsible for the
  template's contents.
- **Repository visibility**: the visibility each student repository is created
  with at accept time: **Private** (the default) or **Public**, for
  peer-review, portfolio, or showcase assignments. Students are warned before
  accepting a public assignment, since anyone on the internet can then see
  their work, including code, commits, and name. If the organization doesn't
  allow students to create public repositories, accept creates the repository
  private instead and tells the student. The setting applies to repositories
  created from then on; to change existing ones, use **Change repository
  visibility** on the submissions page.
- **Student repository access**: the role students get on their own
  repository. The default is **Write (push)** for individual assignments and
  **Admin** for group assignments (so the group owner can add teammates).
- **Repository features**: per-feature settings for **Issues**, **Wiki**,
  **Projects**, and **Pull requests** on student repositories. The default,
  **Inherit from template**, re-applies the template's current setting at
  accept time (again, GitHub's template generation doesn't copy these); you can
  force any feature **On** or **Off** instead. Template-less assignments show
  **GitHub default**, which keeps GitHub's own repository defaults. To update
  repositories that already exist, use the **Update repository features**
  action on the submissions page.

> [!NOTE]
> These settings can be changed after creation, but they only affect
> repositories accepted from then on. Repositories students already accepted
> aren't retrofitted, so they keep their original starter code and setup. When
> at least one student has already accepted, the edit form asks you to confirm
> and warns that you'll need to update the existing repositories yourself. The
> **Assignment type** (Individual, Group, or Group (legacy)) is the exception:
> it stays locked on edit, because switching it would invalidate every existing
> submission.

### Submission and grading

This section defines what counts as a submission, then how the assignment is
graded.

- **Submission type**: when the autograder runs, and what the submissions page
  counts. **Every push to the default branch** (the default) grades each push
  and counts each student commit on the branch (the tool's own accept and
  autograding-update commits are excluded), so a push of several commits is
  graded once but counted several times. **A tagged commit** grades and counts
  only when a student submits (`gh student submit`) or pushes a `submit/*`
  tag. Regular pushes then cost no Actions minutes, which matters at scale.
- **Submission tags** (optional, shown under **A tagged commit**): tag names
  such as `phase1`, `phase2`, and `complete`, one per line, that also trigger
  grading. A student pushes the tag with plain git (`git tag phase1 && git push
  origin phase1`) and that commit grades; the result appears as a normal
  `submit/*` release whose title ends with `(via phase1)`. Prefer exact names:
  a broad pattern like `v*` grades every matching tag. Changing them later
  requires the same trigger update as the submission type; see
  [Changing the submission type later](#changing-the-submission-type-later).
- **Grading**: **Not graded** (the default), **Manual (enter scores by hand)**,
  or **Autograded**. **Manual** adds a **Max points** field (100 by default),
  and you enter each student's score on the submissions page; see
  [Scores and overrides](#scores-and-overrides).
  **Autograded** reveals the autograder settings below. Grading can be changed
  after creation; scores recorded under the old mode may read differently.
- **Built-in autograder** (under **Autograded**): **Use the built-in
  autograder** (preselected when you switch to Autograded) or **Do not use the
  built-in autograder**. Opting out means accept installs no autograding
  workflow at all: on a templated assignment your template's own CI workflows
  run instead. The submissions page still shows who submitted (collection
  records submitters, but no scores), and the repository actions stay
  available. Your choice sticks: leaving Autograded and coming back won't
  reset it. It can be changed after creation (edits only affect repositories
  accepted from then on; turning autograding off later makes already-accepted
  repositories' autograde runs fail and drop out of the collected scores).

With the built-in autograder on, the section continues with the autograding
tests and, below them, a collapsed **Advanced settings** panel.

### Autograding tests

Autograding tests run whenever a submission grades (per the assignment's
submission type). The list collapses to keep the form scannable; click its
heading to expand it, or **Add test** to add one (saving a test expands the
list automatically).

Each test has:

- **Test name**: shown to students to indicate what passed or failed.
- **Test type**: **Input/Output**, **Run command**, or **Python (pytest)**.
- **Setup command**: an optional command run before the test.
- **Run command**: the command the runner executes, in the student's
  repository checkout. Uploaded test files are under
  `$CLASSROOM50_BUNDLE_DIR`.
- **Timeout (seconds)**: how long to wait before terminating the test (0 uses
  the 10-second default).
- **Points**: the test's weight.
- **Report options**: what the submission report shows for this test.
  **Failure details shown to students** (**Full: diff or expected and actual
  output**, **Student output only (never the expected output)**, or **Failure
  type only (no output)**) and **Output when passing** (**Include output** or
  **Discard output**). Both start at the assignment's report defaults; pick
  another value to override it for this test only. See
  [Report options](Autograding-Basics#report-options).

The three test types add their own fields:

- **Input/Output** provides input and checks the output:
  - **Input (stdin)**: text sent to standard input.
  - **Expected output**: text to check for in standard output.
  - **Comparison**: **Included** (expected appears anywhere in the output),
    **Exact** (output equals expected, surrounding whitespace ignored), or
    **Regex** (output matches a Python `re.search` pattern, multiline).
- **Run command** passes when a command returns a given exit code:
  - **Required exit code**: the exit code needed to pass (empty means 0).
- **Python (pytest)** runs a pytest command against test files in the
  template. Points are split across the test cases pytest discovers. No extra
  fields.

Below the tests table, a **Report defaults** panel sets the same two report
options for every test: **Default failure details** and **Include passing
test output**. A test's own report options override them.

Next to **Add test**, **Upload test files** explains where test scripts and
fixtures that students must not see belong: the assignment's folder in the
`classroom50` repository, reachable from test commands as
`$CLASSROOM50_BUNDLE_DIR`. On a saved assignment, its **Open upload page**
button opens the GitHub upload page for that folder, so you can drop files in
without cloning the repository. Students can't change these files, but they can
read them (they're published on the organization's public Pages site), so keep
full solutions out. For the full walkthrough, see
[Teacher-only test files](Autograding-Basics#teacher-only-test-files).

### Advanced settings

The collapsed **Advanced settings** panel below the autograding tests holds
optional settings for the autograding environment. Blank fields use their
documented defaults.

- **Runtime environment**: **GitHub-hosted runner** (the default) or **Docker
  container**, which grades inside a public Docker image that provides the OS
  and its packages.
- **GitHub runner**: the
  [runner](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)
  label autograding runs on. Blank uses `ubuntu-latest`. Combine
  comma-separated labels for a self-hosted runner; the form checks them
  against your organization's runners as you type.
- **Docker image** and **Container user** (container runtime only): the image
  to grade in (for example `gcc:13`) and the user it runs as. Set `root` if
  checkout fails with a permission error. The runner must be an Ubuntu
  variant, or Actions errors.
- **Language versions**: pick or type a version of Python, Node, Java, Go, or
  Rust to install that toolchain. A blank field skips it; Python defaults to
  3.14 on the hosted runner. Ignored on a self-hosted runner, which uses its own
  toolchains.
- **Extra apt packages** (hosted runner only): Ubuntu packages installed before
  grading, comma- or space-separated.
- **Setup command** and **Setup timeout (seconds)**: a shell command run once
  before the other tests, to compile code or install dependencies. A non-zero
  exit or timeout marks the autograde run as failed without changing the
  score; later tests still run. New setup commands start at 120 seconds;
  choose 0 for the runner's 10-second default or a whole number from 1
  through 600.
- **Allowed files**: a `.gitignore`-style list controlling which files remain
  for setup and grading. Include dependency manifests and project files used by
  setup.
- **Submission release files**: exact workspace-relative file paths (one per
  line) to attach to each submission's Release after grading. Paths are not
  globs; basenames must be unique and Release-safe. Missing or unsafe files are
  skipped with a warning. Existing organizations must update their workflow
  files (**Re-run setup**) before using this. See
  [Attaching files to submission Releases](Advanced-Autograding#attaching-files-to-submission-releases)
  for path rules and limits.
- **Set a passing threshold** (off by default): a percentage of the max score.
  When on, the submissions page marks each submission passing or failing
  against it (a **Passing** filter and score badges). This is a display
  threshold only and doesn't change scores.

Commands run in separate shell processes. See
[Setup commands, dependencies, and environment variables](Autograding-Basics#setup-commands-dependencies-and-environment-variables)
for dependency installation and environment-variable guidance.

### Schedule and access

- **Set a release date** (optional): assignments are hidden from the student
  assignments list by default, so students can only accept through the invite
  link. A release date lists the assignment for everyone once the date passes.
  Students who already accepted always see it. This controls listing only, not
  access.
- **Set a due date** (optional): a date and time in your local timezone. A due
  date marks later submissions **Late** in the collected scores; it does not
  block pushes or revoke access. To actually close an assignment, use the
  **Close submission** action (see [Bulk actions](#bulk-actions)).
- **Lock assignment**: students can't see or accept a locked assignment,
  including students who already accepted. For a private template in your
  organization, the classroom team loses read access to the template until you
  unlock. Use it to stage a timed assessment, then unlock when the session
  starts. See
  [Timed assessments](Course-Lifecycle-and-End-of-Term#timed-assessments).

When you're done, click **Create assignment**.

## Add students

Students must be on the classroom roster before they can accept assignments.

Open the classroom, then select **Roster** in the left sidebar. The page lists
everyone in the classroom and shows who has joined and who still has a pending
invitation. Adding a student sends them an invitation to join your GitHub
organization, and they must accept it before they can work on assignments.

The toolbar above the roster table has three controls (on an empty roster, the
same controls appear in the middle of the page):

- **Upload roster**, the primary button, adds students from a file.
- The arrow next to **Upload roster** opens a menu with **Add member**, which
  adds one person at a time.
- **Share** opens the links students use to accept the invitation and sign in.
- **Edit** (organization owners only) switches the table into batch editing.

Only organization owners see these controls; head TAs and TAs get a read-only
roster.

### Adding one student

Click the arrow next to **Upload roster**, then click **Add member**. In the
dialog, choose a **Role** (**Student** is preselected), then enter the student's
**GitHub username**. **First name**, **Last name**, **Email**, and **Section**
are optional. Click **Add member**.

To invite a student who hasn't given you a GitHub username yet, enter their
**Email** and leave **GitHub username** empty. The address goes onto the roster
as a pending row and is matched to the student's account when they accept. For
what happens next, see [Invitations by email](#invitations-by-email) below.

The same dialog adds staff: choose **Teacher**, **Head TA**, or **TA** as the
role and enter their GitHub username. For what each role can do, see
[Staff, TAs, and Multiple Teachers](Staff-TAs-and-Multiple-Teachers).

### Uploading a roster file

Click **Upload roster**, then drop a `.csv` or `.txt` file on the dialog or
click to choose one. The upload reads three shapes of file, and **Read the file
as** shows which one it detected:

- **Roster CSV**: a header row plus one student per line. This is the default
  and the format the app understands best; see the fields and examples below.
- **GitHub usernames (one per line)**: a plain list with no header. Choose it
  to read every line as a username, even one that looks like an email address.
- **Email addresses (one per line)**: a plain list with no header. Choose it to
  read every line as an email address.

A plain list without a header is read line by line, so a file that mixes
usernames and email addresses works under **Roster CSV**. The two list options
are overrides: a line that doesn't fit the one you chose is reported rather
than read the other way.

Not sure what the file should look like? **Download template** on the upload
dialog saves a five-row example CSV (rows with a username only, an email only,
and both) to fill in with your own students.

The upload checks every row before it changes anything:

- A row with a value the upload can't use (an address that isn't valid, a
  `github_id` matching no account, or a line that's neither a username nor an
  address) blocks the import. The dialog lists those rows with their line
  numbers and imports none of them. Fix the file and upload it again;
  re-uploading is safe, because students already in the classroom are left
  alone.
- Every identity column is checked independently, so a shifted column is caught
  even when the row's other cells look fine.
- A row with a name but no identifying column (usually a student who hasn't
  given you a GitHub account yet) is kept on the roster as an **Unlinked** row
  you can link or remove later.
- Only a row with nothing usable at all is skipped; everyone else is imported.

### Roster CSV fields

Each row needs at least one column that identifies a student: `github_id`,
`username`, or `email`. Every other column is optional. Headers are matched
case-insensitively, and any unrecognized column is ignored, so a CSV exported
from your SIS or gradebook usually works unchanged. Save the file as UTF-8
when you can (Excel's **CSV UTF-8** export). A file that isn't UTF-8 is read as
Windows-1252 (Excel's plain "CSV" export), and the upload shows a notice so
you can check that accented names survived.

When a row has more than one identifying column, they're used in this order:
`github_id` first, then `username`, then `email`.

| Column | Identifies a student | Description |
| --- | --- | --- |
| `github_id` | Yes, first choice | The account's immutable numeric id, as written by Classroom 50's own `roster.csv`. Used to look up the account's current username, so a student who renamed their account is still found. |
| `username` | Yes, if there's no `github_id` | The student's GitHub username, such as `octocat`. |
| `email` | Yes, if there's neither | Invites the student by email. Also stored as their contact email on every row. |
| `first_name` | No | Given name, for display and score exports. |
| `last_name` | No | Family name, for display and score exports. |
| `name` | No | Full name in one column, split into first/last. Use instead of `first_name`/`last_name`. |
| `section` | No | A section or group label you can filter by. |
| `role` | No | `student` (default), `ta`, `hta`, or `teacher`. Leave blank for students. |

> [!NOTE]
> If a row's `github_id` and `username` disagree, the upload uses the account
> the id belongs to and asks you to confirm before importing: the preview shows
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

So is a file that identifies some students by account and others only by email,
which is useful at the start of term, when not everyone has reported a GitHub
username:

```csv
github_id,username,email,first_name,section
583231,octocat,octocat@example.edu,Mona,A
,hubot,,Hu,A
,,octofez@example.edu,Octo,B
```

Here `octocat` is found by id (even after a rename), `hubot` by username, and
`octofez` is invited by email and appears as a pending row until they accept.

### Invitations by email

A row identified by account (`github_id` or `username`) is both invited and
added to the roster. A row identified only by an email address is invited by
email, and the address is recorded as a pending roster row:

- The row is matched to the student's GitHub account when they accept.
- The recorded address is the one you invited, not necessarily the email on the
  student's GitHub account.
- A name and section supplied with the row are kept on it, so they're already
  there when the student joins. You can correct them from the row while the
  invitation is pending. The address itself can't be changed there, because it
  identifies the invitation: to use a different one, cancel and invite the new
  address.
- If you cancel the invitation, the row is removed with it. An expired
  invitation's row is not removed: it stays on the roster as **Unlinked** for
  you to link or remove, and the next roster refresh only retires the
  invitation's bookkeeping.

A pending row is why the stored `roster.csv` can hold a row with no `username`
or `github_id`. Either tool reads that file back: **Upload roster** matches
those rows by email, and `gh teacher roster import` corrects a pending row's
name and section by address without touching the invitation. A row identified
only by `github_id` is the exception, since `import` resolves students by
username: it skips that row with a notice and leaves whatever is stored for it
alone. For more information, see
[Invitations by email](How-Classroom-50-Works#invitations-by-email).

### Enrolling existing organization members

Adding students who are already in your organization (for example, from a
previous course) is a different action. Inviting them again does nothing:
GitHub reports "Already a member," and it won't put them on this classroom's
roster. To enroll an existing member, open the organization's **Members** page
in Classroom 50, select their row (or several), click **Actions**, then click
**Add to classroom**. For more information, see
[Manage organization members](#manage-organization-members).

### Sharing the invitation links

Click **Share** to open the **Share classroom links** dialog. It holds two
links for students you've already invited:

- **Classroom onboarding link**: a student accepts the invitation and signs in
  to Classroom 50 in one step. This is the link most classrooms share.
- **GitHub organization invitation link**: a student accepts the invitation
  directly on github.com. Share it when a student can't use the onboarding
  link.

Neither link enrolls anyone on its own: invite the student from the roster
first, then share a link so they can accept and sign in.

### The roster view

The table lists everyone in this classroom, one row per member, with
**Member**, **Username**, **Role**, **Section**, and **Status** columns; click
a column header to sort by it, and click a row to open the member's detail.
**Section** appears only when at least one member carries a section label, and
**Status** only while a row has something to report: a pending invitation, a
member who needs a role, someone not in the organization, or an **unlinked**
row (one with no GitHub account attached: a name-only upload, or an address
that couldn't be invited). Click an unlinked row to link it to an organization
member or remove it.

The toolbar narrows and groups the table:

- **Search**: match members by name, username, or email.
- **Show**: one filter covering both status (**Enrolled**, **Pending**,
  **Needs a role**, **Not in organization**, **Unlinked** while such rows
  exist) and role (**Student**, **Teacher**, **Head TA**, **TA**).
- A **section filter**, shown when members have sections.
- **Group by**: group the rows by role or by section.

Selecting rows (with the row checkboxes, or the select-all in the header)
replaces the toolbar's left side with a selection bar carrying one
**Actions** menu:

- **Invite** re-sends the selected students' organization invitations.
- **Cancel** cancels their pending invitations.
- **Unenroll** removes them from the classroom.
- **Remove rows** (when the selection includes unlinked rows) deletes those
  rows from `roster.csv`.

Each action asks you to confirm, then reports its results. Bulk actions apply
to students only; staff are managed in the classroom's **Settings**.

**Edit** (owners only) switches the table into an editing surface:
names and sections become inputs, and unlinked rows offer a username picker
drawn from your classrooms' history. Stage as many changes as you like, then
**Save changes** applies them all in a single commit. A row that changed
underneath you (for example, a student accepted an invitation meanwhile) is
skipped and reported rather than overwritten.

**Refresh roster** checks the classroom's GitHub teams and invitations for
anything new (members who joined or left, accepted invitations, role changes)
and updates the roster to match; the same check runs when you open the page.
It runs in the background (the roster stays fully usable) with the button
reading **Refreshing roster…** while it works. The caption beside the button
shows when the roster last changed and what the last refresh found.

## Manage groups

For a group assignment, open the assignment and click **Manage groups** in the
sidebar (the submissions page has a **Manage groups** button too). The page
lists every group with its display name, its members (with full names from the
roster), its member count against the max group size, its repository status,
and its visibility. Two badges need explaining:

- **No repository yet.** The group's shared repository is created when a
  group member accepts the assignment (**Repository created** replaces it
  then).
- **Members changed since the last refresh.** The group's live membership on
  GitHub no longer matches the recorded group info; refresh to update the
  record.

Above the list:

- **Create group.** Create a group, optionally with a **Group name** (leave
  it blank to use a numbered name). On a teacher-formed assignment, create
  each group and add its students here; students who aren't in a group can't
  accept.
- **Copy groups.** Recreate another assignment's groups for this one, useful
  for a project sequence with stable groups. Pick the **Source assignment**;
  each group's name and members are copied into a plan you can edit, and
  nothing is created until you save. Groups stay per-assignment: the copy
  creates new group teams under this assignment's own numbering.
- **Refresh group info.** Re-read every group's live membership from GitHub
  and update the recorded group info (the `teams.json` snapshot in the
  `classroom50` repository). The page also refreshes automatically on load
  when live membership no longer matches the recorded group info.

An **Unassigned students** panel lists roster students who aren't in a group
yet: choose a group with room, then add them.

### Manage one group

Click **Manage** on a group to open its dialog:

- **Group name.** Rename the display name, then **Save name**. The name is
  shown to you and the group's members; the repository name doesn't change.
- **Visibility.** **Visible** groups can be browsed by classmates and receive
  join requests on GitHub; **Hidden** groups are visible only to their members
  and organization owners.
- **Members.** Stage additions and removals (marked **Will be added** and
  **Will be removed**), then **Save changes** applies them together.
- **Danger zone.** **Delete group** removes the group's GitHub team and the
  access it granted, after a confirmation. The group's repository is not
  deleted.

### Recover a deleted group team

If a group's GitHub team was deleted but its repository still exists, grading
can't credit the group's members until the team is recreated. The group's
submissions row shows a **Group team missing** error; click it to recreate the
team at the same group number. Members found in the repository's commit
history are pre-checked, you can add more from the roster, and you can
optionally pick a **Team maintainer** who can manage the group's members on
GitHub (like the student who founded the group).

## Manage organization members

The **Members** page lists everyone in your GitHub organization and the
classrooms they belong to. Open your organization in Classroom 50, then select
**Members** in the sidebar. The page is available to organization owners.

> [!WARNING]
> The page covers the whole organization, not only your students. If other
> teachers share the organization (even without using Classroom 50), their
> members appear here too, so take care when removing anyone.

The table shows **Name**, **Username**, **Classrooms**, **Roles**, and
**Status** columns; click a column header to sort by it. **Roles** is the
organization role (**Owner** or **Member**), and **Status** reports only
problems:

- **Not an org member.** On a classroom roster but not in the organization
  (for example, they left or were removed). Click **Invite** on the row to
  restore their access.
- **Invitation pending.** An email invitation hasn't been accepted yet.
- **Not enrolled.** On a roster but missing from the classroom team, so
  score collection would miss them.

The toolbar narrows the table: **Search** matches members by name, username,
or email; a **Show** filter covers both status and organization role
(**Owners**, **Members**); and a classroom filter shows one classroom's
members, or members on **No classroom**.

Click a row to open the member's details: their name, GitHub username and ID,
every email address the rosters record for them, and their classroom access
with a link to each classroom. From here you can also invite an on-roster
non-member back to the organization, or remove a member from the organization.

### Bulk member actions

Select rows with the checkboxes (or the select-all in the header), then open
the **Actions** menu:

- **Add to classroom** enrolls the selected members on a classroom you pick in
  the dialog. Members already on that classroom, and people who aren't
  organization members yet, are skipped.
- **Remove from classroom** unenrolls the selected members from a classroom
  you pick. Select the checkbox in the dialog to also remove them from the
  organization in the same run.
- **Remove from organization** removes the selected members from the
  organization. Each member is first unenrolled from every classroom they
  belong to, so no roster is left pointing at a non-member.

Each dialog previews what will happen (how many members are affected, and why
any are skipped) before you confirm. Removals also require typing `confirm`,
and the dialog warns when the selection includes organization owners or
members enrolled in other classrooms.

Neither unenrolling nor removing deletes repositories. For more information,
see
[Enroll, unenroll, and remove are separate](How-Classroom-50-Works#lifecycle-enroll-unenroll-and-remove-are-separate).

## Collect submissions

Once an assignment exists, share its invite link with students: on the
submissions page, click **Share** to open the **How students accept** dialog,
then click **Copy accept link** (or expand **Prefer the command line?** for the
`gh student accept` command). To grab the same link without opening the
assignment, use the link icon in the assignment's row on the **Assignments**
page. It copies the link straight to the clipboard, including the access key
when the classroom uses an unlisted URL.

Accepting creates a repository named `CLASSROOM-ASSIGNMENT-USERNAME`. Pushing
to it triggers autograding, which builds a Release containing a `result.json`
file. The score-collection workflow (run on demand) aggregates those results
into the classroom's collected scores.

### View submissions

Scores update when collection runs: click **Collect now** in the freshness
strip at the top of the submissions page (the **Actions** menu carries the same
**Collect now**). Both are scoped to the current assignment: they walk only this
assignment's repositories, so a collection is fast even in a large classroom
and doesn't rebuild other assignments' scores. The strip shows when this
assignment's data was last collected (a per-assignment `collected_at` stamp in
`scores.json`), and an **Out of date** badge appears beside it when students
have pushed since that collection. Collect to grade and score the newest work.
Click **View workflow** (or **View run** while a run is tracked) in the
**Actions** menu to see the Actions run. To refresh every assignment in one run
instead, see [Collect the whole classroom](#collect-the-whole-classroom).

Teachers and head TAs can collect. A TA has read-only access to the
`classroom50` repository, so their button reads **Refresh** and re-reads what a
teacher last collected.

The page header shows a submission progress bar (how many students, or groups,
have submitted; click it to filter to who hasn't), the due date, a **Late**
count, a **Closed** badge when the submission window is closed, the
submission type (**Submits on every push** or **Submits by tag**), and the
grading setup (**Autograded**, **Custom autograding**, or **No autograding**).

For larger classrooms, use the toolbar:

- **Search** by student, or by group or member on a group assignment.
- A section filter, when roster rows carry sections.
- A status filter: **Submitted**, **On time**, **Late**, **Not submitted**,
  **Accepted**, or **Not accepted**.
- A **Passing** / **Failing** filter, when the assignment sets a passing
  threshold.
- Sort by **Newest first**, **Oldest first**, **By first name**, or **By last
  name**.

Each row shows a student's (or group's) latest submission plus its full history
(newest first). For each submission you can view the score, the submission date,
and links to the repository, the commit, the feedback pull request
(**View feedback PR** on the row; its manage dialog carries the same link as
**Review**), and the Release (**View autograder details**). A row whose work
was pushed after the last collection shows **Pending** until you collect. For
where every result lives (per-test breakdowns, past attempts, grading a
specific commit, and who submitted), see
[Reading results](Autograding-Basics#reading-results).

On a group assignment, rows are titled by group name, and a **Members** column
shows each group's live member count; click it to open the group's manage
dialog. A group that hasn't accepted yet shows a **No repository yet** warning
(the repository is created when a member accepts), and **Group team missing**
flags a group whose GitHub team was deleted; click it to recreate the team
(see [Recover a deleted group team](#recover-a-deleted-group-team)).

### Collect the whole classroom

The classroom's assignments list refreshes all scores in one run. Above the
table, a freshness line shows when the classroom's submission data was last
collected, next to a **Collect all** button. The same **Out of date** badge
appears there when any assignment's repositories have pushes newer than that
assignment's last collection. Each assignment is judged against its own
stamp, so one freshly collected assignment can't mask a sibling that was
never collected. Clicking **Collect all** dispatches a single
`collect-scores.yaml` run scoped to the classroom, so one run walks every
assignment and rebuilds all of the classroom's collected scores; the table's
per-assignment counts refresh when the run finishes.

The **Submitted** count in that table is what the last collection found:
graded submissions, plus repositories with pushes (or submission tags) that the
autograder hasn't turned into a graded submission yet. Those repositories show
as **Pending** on the assignment's submissions page, so the two views agree. A
student who pushed but whose autograder run failed or never ran counts as
submitted here; their score arrives once the autograder publishes a result and
the assignment is collected again.

Because the run walks every assignment's repositories, it takes longer than a
single-assignment collection and uses more GitHub Actions minutes, so
**Collect all** asks you to confirm before dispatching. To refresh one
assignment while grading, prefer **Collect now** on that assignment's
submissions page.

Teachers and head TAs can collect, the same as the per-assignment collection.
The button is hidden on an archived classroom and while the classroom has no
assignments, and disabled while the roster is empty. Once dispatched, the run
appears in the banner at the top of the app as **Collecting scores for every
assignment in** the classroom, which keeps tracking the run if you navigate
away and links to the Actions run (**View run**).

### Scores and overrides

Each row's score cell has an edit button (pencil) that opens a score dialog.
It works for both grading modes:

- **Manual assignments**: enter a score out of the assignment's **Max
  points**.
- **Autograded assignments**: enter a score to override the autograded
  result. The autograded score is preserved and shown in the dialog; **Clear
  override** restores it. If the submission hasn't been autograded yet, the
  dialog also asks for the max points to grade out of.

An overridden score shows a **Manual** badge and won't be changed by
autograding until you clear the override. Entering a score writes the
`classroom50` repository's `scores.json`, so the editor appears only for
organization owners.

### Bulk actions

The **Actions** menu at the top of the submissions page operates on the whole
assignment. Teachers and head TAs see the collection and lifecycle actions;
the actions that write to every student repository need organization owner
permissions, and most of them apply to individual assignments only. In menu
order:

- **Metrics**: summary statistics of the collected scores (**Submitted**,
  **Classroom average**, **Passing**, **Accepted**). Shown only for
  empty-repository assignments; every other assignment shows live status in
  the table instead.
- **Open all feedback PRs** (owners): open a feedback pull request on every
  repository that doesn't have one yet, from your browser, one repository at
  a time.
- **Collect now**: trigger a score collection scoped to this assignment.
- **Regrade all**: re-run the autograder on every submitted repository's
  latest commit. Submission times don't change.
- **View workflow** / **View run**: open the collect or regrade workflow on
  GitHub.
- **Update student repo access** (owners): bulk-set every student's role on
  their repository (drop everyone to read-only for grading, then restore write
  afterwards).
- **Update repository features** (owners): re-apply the assignment's Issues,
  Wiki, Projects, and Pull requests settings to every existing student
  repository (repositories created before a settings change, or before
  features were inherited from the template).
- **Change repository visibility** (owners): make every accepted student
  repository in the assignment public or private in one pass. Repositories
  students accept later use the assignment's **Repository visibility** setting
  instead. A row whose repository is public shows a **Public** badge, and a
  single repository can be flipped from its row's manage dialog.
- **Update autograding triggers** (owners): retrofit existing repositories
  after a submission-type change (see
  [Changing the submission type later](#changing-the-submission-type-later)).
- **Pause autograding** / **Resume autograding** (owners): disable or
  re-enable the built-in `autograde.yaml` workflow in every student repository
  with GitHub's workflow-disable API. No files are changed, and you can resume
  anytime; other workflows in student repositories keep running. Use it to
  stop autograding for one assignment without touching the rest of the
  organization (the organization settings page has an organization-wide
  pause). Available on individual assignments that use the built-in
  autograder, once students have accepted; a single repository can also be
  paused from its row.
- **Close submission** / **Reopen submission** (owners): close the submission
  window: block new accepts and set every student's repository to read-only
  (work is preserved). This is the enforcement mechanism for due dates; the due
  date itself only marks submissions late. **Reopen submission** restores write
  access.
- **Lock assignment** / **Unlock assignment**: lock the assignment so students
  can't access or accept it (and, for a private template, remove the student
  team's read on it); unlock reopens it and restores template access. The same
  toggle is in the **Schedule and access** section of the assignment form, so
  you can create an assignment already locked. See
  [Timed assessments](Course-Lifecycle-and-End-of-Term#timed-assessments).
- **Download scores (CSV)**: export all submissions as a CSV.
- **Download all submissions**: download each repository's latest submission
  bundled into a single zip, built in the browser one repository at a time.
  For very large classrooms prefer `gh teacher download`, which clones every
  repository and writes a `scores.csv`; see
  [10. Download submissions](CLI-Teacher-Guide#10-download-submissions). The
  **Clone all submissions with the CLI** button next to the **Actions** menu,
  and the download icon in an assignment's row on the **Assignments** page,
  open a dialog with that CLI command filled in for the assignment, ready to
  copy.
- **Delete assignment**: remove the assignment from the classroom, with the
  same type-the-slug confirmation as the **Manage assignment** dialog. Student
  repositories are kept. After deleting, you land back on the assignments
  list.

### Download scores

Click **Download scores (CSV)** to export all submissions as a CSV for a
spreadsheet or external tool. The column-by-column reference is in
[Score exports](Autograding-Basics#score-exports).

## Edit assignments and classrooms

- **Manage an assignment from the list.** Each row on the **Assignments** page
  keeps four quick actions (copy invite link, clone submissions, edit, lock)
  plus **Manage assignment**, a dialog gathering every per-assignment action in
  one place: the quick four, **Template access** (review which teams can read
  the template, and re-grant the classroom teams' read), **Reuse in another
  classroom**, and **Delete assignment**.
- **Delete an assignment.** **Delete assignment** asks you to type the slug to
  confirm; student repositories are kept. The submissions page's **Actions**
  menu carries the same **Delete assignment**.
- **Edit an assignment.** Open the assignment, then click **Settings** in the
  sidebar (the page is titled **Assignment settings**; the pencil icon in the
  assignment's row goes there too). Same form as creating one, pre-filled.
  Provisioning settings (repository source, built-in autograder, grading mode)
  are editable; a change only affects repositories accepted from then on, so
  the form asks you to confirm when students have already accepted.
  **Assignment type** and **Assignment slug** stay locked, since switching
  them would invalidate existing submissions. **Discard changes** reverts
  unsaved edits.
- **Edit a classroom.** Open the classroom, then click **Settings**. Same form
  as creating one, pre-filled (the slug is fixed). Its **Advanced settings**
  section holds the **Custom Pages domain** field (see
  [Using a custom Pages domain](#using-a-custom-pages-domain)). The page also
  offers **Clean up invite data**, which clears the addresses held for email
  invitations that were never accepted (see
  [Invitations by email](How-Classroom-50-Works#invitations-by-email)),
  **Archive**, and a delete button that asks you to type
  `YOUR-ORGANIZATION/YOUR-CLASSROOM` to confirm.
- **Archive a classroom.** **Archive** on the classroom's **Settings** page
  drops the classroom out of the default **My classrooms** list (switch the
  filter to **Archived** or **All** to see it) and stops new assignments,
  accepts, and enrollments. Its roster and assignments are kept read-only, and
  **Unarchive** restores it. For end-of-term guidance, see
  [Course Lifecycle and End of Term](Course-Lifecycle-and-End-of-Term).

### Using a custom Pages domain

Classroom data that students' browsers read (the assignment list an invite
link resolves against) is published through GitHub Pages, normally at
`https://YOUR-ORGANIZATION.github.io/classroom50/`. If your organization's
Pages site uses a [custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site),
GitHub answers requests to `github.io` with a redirect that browsers reject,
so invite links stop loading assignment data for students.

To fix that, open the classroom's **Settings**, expand **Advanced settings**,
and fill in **Custom Pages domain**. Enter the domain itself (for example
`pages.example.edu`, read as `https://pages.example.edu/classroom50`), or a
full `https://` URL when your published site doesn't live under
`/classroom50`. Leave the field empty to use the default `github.io` address.
Students' browsers try the custom domain first and fall back to `github.io`,
so a mistyped domain can't lock students out of a working site.

> [!IMPORTANT]
> If your staff also uses the `gh teacher` CLI, upgrade it everywhere before
> setting a custom domain: releases older than 1.35.0 don't know the field
> and can strip it from student discovery on their next sync.

### Updating an over-budget assignment slug

An assignment whose slug can push student repository names past GitHub's
100-character limit shows a **Slug too long** badge in the assignments list.
This affects only assignments created before the limit was enforced, such as
ones imported from GitHub Classroom with long names.

1. Open the assignment's **Settings** page.
2. On the **Slug update needed** card above the form, click **Update slug**.
3. In the **New slug** field, keep the suggested slug or enter your own. A
   hint shows how many characters the classroom leaves room for.
4. Click **Update**. One configuration change renames the assignment, then
   every existing student repository is renamed to match, with per-repository
   progress.

GitHub redirects the old repository names, so existing clones keep working,
and collected scores follow the new slug. You can update a slug only once:
the old slug stays permanently reserved so the redirects survive. The
assignment stays locked while repositories are renamed; if any repository
fails, the card switches to **Slug update incomplete** and **Finish update**
re-runs the renames until everything lands. Students run `git pull` once
before their next submit. The CLI equivalent is
[`assignment rename`](gh-teacher#assignment-rename).

### Changing the submission type later

The trigger is baked into each student repository's autograding workflow when
the student accepts, so changing the **Submission type** on the assignment's
**Settings** page only affects repositories created from then on. To update
repositories students already accepted:

1. Change the submission type on the assignment's **Settings** page and save.
2. On the submissions page, click **Actions**, then click **Update autograding
   triggers**. It rewrites each repository's workflow to match (the commit is
   marked, so it neither triggers grading nor counts as a submission), reports
   repositories whose workflow was hand-edited (those are left untouched), and
   skips students who haven't accepted. A single repository can also be updated
   from its row's manage dialog.
3. Tell students to run `git pull`. Clones made before the update will
   conflict on their next push.

The bulk action is available to organization owners on individual assignments
that use the built-in autograder (a custom autograder's workflow is yours to
edit). It needs your GitHub authorization to include the `workflow` scope:
sign out and back in if the action reports a permissions problem.

## Organization pages

Beyond classrooms, the organization sidebar offers pages that cover the whole
organization:

- **Published** (all staff) lists every file Classroom 50 serves from the
  organization's GitHub Pages site (the classroom list, each classroom's
  assignment list, autograder files, and workflow files) with its public URL
  and status. These files are public; everything else in the `classroom50`
  repository stays private.
- **Members** (owners): see
  [Manage organization members](#manage-organization-members).
- **Activity** (owners) is a timeline of the organization's configuration
  changes, workflow runs, and this session's errors, newest first, with
  filters by source and type, a search box, **Export CSV**, and **Show
  diagnostics** to copy technical details into a bug report.
- **Settings** (owners): see
  [Set up an organization (one-time)](#set-up-an-organization-one-time).
