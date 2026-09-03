# FAQ

Common questions about Classroom 50, grouped by topic. For error messages and
fixes, see [Troubleshooting](Troubleshooting); for terms, see the
[Glossary](Glossary).

## Getting started

### Do I need a paid GitHub plan?

You need a GitHub organization on the **Team** or **Enterprise** plan.
Verified educators get GitHub Team **free** through
[GitHub Education](https://github.com/education/teachers), which unlocks
everything Classroom 50 relies on (notably GitHub Pages from a private
repository). Free/personal organizations can't host a classroom.

### How is Classroom 50 different from GitHub Classroom?

The teaching model is familiar: you create assignments (optionally with
starter code), students accept to get their own repository, and submissions are
autograded. But Classroom 50 has no server or database of its own. Your
classroom settings, roster, assignments, and scores are stored in a private
`classroom50` repository in your organization, and grading runs in GitHub
Actions. See [How Classroom 50 Works](How-Classroom-50-Works) for the full
model, or the [Glossary](Glossary) for the core concepts.

### Is there a web app, or is it CLI-only?

Both, and they're **alternatives**, not supplements. Teachers can do
everything from [classroom50.org](https://classroom50.org) or from the
`gh teacher` CLI; students can accept and submit from either. Use whichever you
prefer. See the [Web Teacher Guide](Web-Teacher-Guide) or
[CLI Teacher Guide](CLI-Teacher-Guide).

### Can I self-host Classroom 50?

There's no server to host. Classroom 50 runs entirely on GitHub's
infrastructure and public APIs. The web app is a static, open-source site, so
you're welcome to host your own copy. It only integrates with GitHub, not with
self-hosted Git platforms.

## Organizations and classrooms

### Can one organization hold multiple classrooms?

Yes. A **classroom** is a directory in your organization's `classroom50`
repository, and an organization can hold as many as you like, for example one per
course, section, or term. Add each with **Create classroom** in the web app or
`gh teacher classroom add`.

### Should I create one organization per course, like GitHub Classroom?

You don't have to: one organization can hold many classrooms, so a stable
teaching team usually keeps one organization with a classroom per term or
section. Separate organizations fit school-wide adoption or very large
courses. See
[One organization or several?](Staff-TAs-and-Multiple-Teachers#one-organization-or-several)
for how to choose.

### Can a classroom have multiple teachers or TAs?

Yes. Classroom 50 has four roles: **teacher** (organization owner, full
control), **head TA** (write access to the `classroom50` repository, not an
owner), **TA** (read-only access to the `classroom50` repository), and
**student**. Manage staff in the web app under a classroom's **Settings**, in
the **Staff and roles** section, or with `gh teacher staff add`. See the
[Glossary](Glossary#roles) for what each role can do.

### Can students join a classroom themselves with a link?

Not on their own: GitHub requires an organization owner to invite members. Add
students to the roster (by username, by email, or by bulk CSV upload), which
sends the organization invitation. **Once they've joined the organization**, the
assignment accept links work without any further action from you.

## Rosters and students

### Can I add students in bulk, or by email?

Yes. In the web app, use **Upload roster** with a roster CSV or a plain text
list. A row can identify a student by `github_id`, GitHub username, or **email
address**, so one file can mix students whose handle you know with ones you
only have an address for. Each address goes onto the roster right away as a
pending row, and is matched to the student's GitHub account when they accept.

From the CLI, invite one address with
`gh teacher roster invite cs50-fall-2026 cs-principles ada@example.edu`, or a
whole list with `--file`, a plaintext file holding one address per line. Only the
web app can invite **staff** by email; `gh teacher roster invite` always sends a
student invitation. `gh teacher roster import` adds and invites every student a
stored `roster.csv` identifies by username, but it never sends an email
invitation: on an email-only row it updates only the name and section, leaving the
invitation alone. See
[Invitations by email](How-Classroom-50-Works#invitations-by-email) and
[Roster CSV fields](Web-Teacher-Guide#roster-csv-fields).

### Can I see the whole roster, including students who haven't accepted?

Yes. The submissions view lists every rostered student, not only those who
accepted, with their status, so you can see at a glance who hasn't started.
Students you invited by email appear too, listed by address until they accept,
though only organization owners see them: GitHub keeps pending invitations
owner-only, so a TA's view leaves them out.

### What happens when I unenroll or remove a student?

They're separate actions, on purpose:

- **Unenroll** removes the student from the classroom roster and team. It does
  **not** remove them from the organization and does **not** delete their
  assignment repositories.
- **Remove from the organization** revokes their access to every repository
  (including their assignment repositories) but still doesn't delete anything.
- **Deleting a repository** is always a separate, manual step.

Both actions are available per member and in bulk on the organization's
**Members** page. For more information, see
[Manage organization members](Web-Teacher-Guide#manage-organization-members)
and
[Lifecycle: enroll, unenroll, and remove are separate](How-Classroom-50-Works#lifecycle-enroll-unenroll-and-remove-are-separate).

## Assignments

### Can I use a private repository as an assignment template?

Yes, if the template lives **inside your organization**: registering the
assignment grants the classroom's team read access to it. A private template
outside your organization can't be shared with students; a public one works
from anywhere. See
[Template visibility](Assignment-Templates#template-visibility), including
why a private template added to an existing assignment can 404 on accept.

### Can I customize the feedback pull request's first comment?

Yes, for a templated assignment. Turn on **Use the template's pull request
template as the Feedback PR body** and Classroom 50 uses your template
repository's own pull request template (`.github/pull_request_template.md`,
`pull_request_template.md`, or `docs/pull_request_template.md`) as each
student's feedback pull request body instead of the built-in text. The
assignment form auto-checks this when it detects such a file, and you can toggle
it off.

Note this is not GitHub's native behavior. GitHub only fills a
`pull_request_template.md` into pull requests opened through the web "compare
and pull request" flow, never for the API-created feedback pull request, so
dropping the file in alone does nothing until you enable this option. If the
file is missing or can't be read, the built-in body is used. It's set in the web
app; there is no `gh teacher` flag for it.

### Can I set a due date with a specific time of day?

Yes. Due dates support a date **and** time, in your timezone. Submissions after
the due date are **marked late**; nothing is blocked automatically.

### Does the due date cut off student access?

No. There is no cutoff date; the due date only marks later submissions late.
To actually end an assignment, use **Close submission**, which blocks new
accepts and sets every student's repository to read-only. See
[Due dates mark late; closing enforces](Course-Lifecycle-and-End-of-Term#due-dates-mark-late-closing-enforces).

### What's the difference between "template-less" and "empty repository"?

Both start from no template; the difference is what (if anything) is committed:

- **Template-less with a README** (**Add a README** on): students get a
  repository with an initial commit and the autograder setup. Good for
  write-from-scratch or short-answer work.
- **Empty repository** (**Add a README** off, built-in autograder off): a
  completely bare repository with no commit at all. No starter files **and** no
  autograding or feedback pull request, ever. Use it when students build
  everything themselves, including their own GitHub Actions.
- (**Add a README** off with the built-in autograder **on** is a third,
  in-between shape: an initialized repository carrying only the control files,
  no README, which grades normally.)

**These repository-shape choices can be changed after creation, but a change
only affects repositories accepted from then on.** Repositories students
already accepted aren't retrofitted, so they keep their original shape. The web
edit form asks you to confirm when students have already accepted.
(**Assignment type**, that is Individual, Group, or Group (legacy), is the
exception and stays locked, since switching it would invalidate existing
submissions.) For every shape in one table, see
[Repository shapes](Assignment-Templates#repository-shapes).

### How do group assignments work?

Choose **Group** when creating the assignment, set a maximum group size, and
pick who forms the groups:

- **Teacher assigns groups.** You create the groups and add students on the
  assignment's **Manage groups** page (or with `gh teacher team`). Students
  who aren't in a group can't accept.
- **Students form groups.** The first student creates the group when
  accepting, naming it if they like, then adds teammates. Classmates can also
  browse the existing groups on the accept page and ask to join on GitHub.

Each group is a GitHub team that owns one shared repository, named
`<classroom>-<assignment>-group-<n>`. Groups have display names, and renaming
one never changes the repository name. At grading time, the group team's
members who are on the roster all get the same score.

The older **Group (legacy)** mode still works: the first teammate to accept
creates the shared repository (named after their username) and invites the
others as collaborators, and everyone on the roster who is a collaborator gets
the same score. Legacy groups have no names, and renaming a legacy group
repository isn't recommended.

### Does the assignment description show to students?

Yes. The accept page shows it under **Assignment details**, rendered as
Markdown. Longer instructions still belong in the template's `README.md`, which
is what students see when they open their repository. See
[Assignment Templates](Assignment-Templates).

## Autograding and Actions

### Can I grade without writing test code?

Yes. Use **declarative tests** (input/output, run-command, or pytest checks)
defined right on the assignment. No grading script needed. For more control,
write an `autograder.py`. See [Autograding Basics](Autograding-Basics#declarative-tests)
and [Advanced Autograding](Advanced-Autograding).

### Can I keep my test script out of the student's repository?

Yes. Students receive every file in the template, so put grading files in the
`classroom50` repository under `CLASSROOM/autograders/ASSIGNMENT/` instead. In
the web app, **Upload test files** in the assignment's autograding section
opens the GitHub upload page for that folder. Reference the files from a test
command with `$CLASSROOM50_BUNDLE_DIR`, for example
`bash "$CLASSROOM50_BUNDLE_DIR/check.sh"`. The runner fetches the folder fresh
on every grading run, so a student can't edit the script to make it exit 0.
Your organization's public GitHub Pages site serves the folder, though, so a
determined student can still read it. See
[Teacher-only test files](Autograding-Basics#teacher-only-test-files).

### Can I turn autograding off, or reduce Actions usage?

Yes. Grade only on explicit submits (**Submission type: A tagged commit**),
skip the built-in autograder for assignments graded elsewhere, pause
autograding per assignment or organization-wide, or grade on self-hosted
runners. [Managing Actions Cost](Managing-Actions-Cost) covers every lever
and what each one trades away.

### Can I use my own (self-hosted) runners?

Yes. Set `runs-on` in the assignment's runtime to your self-hosted labels (for
example `["self-hosted", "gpu"]`). Self-hosted runners keep their own
toolchains, so Classroom 50 skips managed toolchain setup on them. Provision
what your assignments need in the runner image, plus the tools the grade job
itself calls: `curl`, `python3`, the GitHub CLI (`gh`), and `git`, which
GitHub-hosted runners preinstall but the runner agent doesn't install. See
[The `runtime` block](Advanced-Autograding#the-runtime-block).

### Can the autograder show students *why* a test failed?

Yes. Each submission's Release and the Actions run summary include a per-test
breakdown (expected against actual output for I/O tests, captured stderr),
unless you limit it with the assignment's failure-details setting. A custom
`autograder.py` can add its own diagnostic messages to `result.json`.

### Can students use GitHub Codespaces?

If Codespaces is enabled for your organization, students can open their
assignment repository in Codespaces like any other repository. Classroom 50
doesn't manage Codespaces itself; any education Codespaces benefit is handled on
GitHub's side.

## Scores and submissions

### A student submitted, but I don't see a score. Why?

A few common reasons:

- **Scores haven't been collected yet.** Click **Collect now** on the submissions
  page to pull this assignment's latest results (the collection is scoped to
  the assignment you're viewing, so it's fast even in a big classroom).
- **GitHub Pages is still deploying.** Right after a config change, published
  files can take a few minutes to go live.
- **The assignment grades only tagged submissions.** With **Submission type**
  set to **A tagged commit**, a plain push isn't graded; the student runs
  `gh student submit` or pushes a `submit/*` tag.
- **The assignment isn't autograded.** An assignment with **Grading** set to
  **Manual** or **Not graded**, or one whose template ships its own grading
  workflow, records no built-in score.

See [Troubleshooting](Troubleshooting) for specific error messages.

### Can students see their scores in the web app?

Not yet. Scores live in each student's repository: every graded submission
publishes a **Release** with the score and a per-test breakdown, which is what
the student-facing **View score** link opens. Showing scores inside the app is
blocked by a technical limitation (Classroom 50 has no server, and the browser
can't read Release assets cross-origin) but it's on the wish list (see
[#567](https://github.com/foundation50/classroom50/issues/567)). Point
students at their repository's Releases page (or the feedback pull request) for
results.

### Can I manually override or adjust a score?

Yes, right in the web app, for both **manual** and **autograded** assignments.
On the submissions page, each row's score cell has an **Add score**, **Edit
score**, or **Override score** control that opens a dialog:

- **Manual assignments.** Enter a score out of the assignment's **Max points**.
- **Autograded assignments.** Enter a score to override the autograded result.
  The original autograded score is preserved; clearing the override restores it.
  If the submission hasn't been autograded yet, the dialog also asks for the max
  points to grade out of.

Overridden scores show a **Manual** badge and aren't changed by autograding
until you clear the override. Use **Clear override** in the dialog to revert.

This editor appears only for organization owners (writing a score writes the
`classroom50` repository). Under the hood, an override is an entry in the
classroom's `scores.json` with `"override": true`, which collection leaves
untouched on future runs, so you can still edit it by hand if you prefer (see
[Collect scores](CLI-Teacher-Guide#9-collect-scores)).

### How do I export scores, or download student work in bulk?

Download scores as a CSV from the submissions page
(**Download scores (CSV)**). For the work itself, **Download all submissions**
in the same **Actions** menu bundles every repository's latest submission into
a single zip (built in your browser). For real clones, to run your own
tooling locally, `gh teacher download` clones every submission repository and
also writes a `scores.csv` summary at the destination root (the submissions
page's **Clone all submissions** button hands you that command ready to copy).
The raw score data also lives in `scores.json` in your `classroom50` repository,
so you can build your own automations against it. The column-by-column
reference for both CSVs is in
[Score exports](Autograding-Basics#score-exports) in Autograding Basics.

### As a teacher, can I test an assignment as a student?

You can: Classroom 50 doesn't currently disallow one account holding both a
staff and a student role. Add yourself to the roster with `gh teacher roster
add` (or the web app) while remaining on a staff team; you'll then show **both**
roles and be graded as a student. For how the app behaves with a dual-role
account, see
[Staff who are also students](Staff-TAs-and-Multiple-Teachers#staff-who-are-also-students-dual-roles).

To try an assignment without enrolling yourself, accept it as staff. Your
repository appears on the submissions page with your role badge, and the
assignments table counts it once you turn on **Include teaching staff** next
to **Collect all**.

One caveat: as an **organization owner** you keep `admin` on your own assignment
repository (GitHub won't let an owner reduce their own access to `write`), so it
won't match a real student's `write`-level setup. To test the exact student
experience, use a **separate** GitHub account added to the classroom as a
student.

## Coming from GitHub Classroom

### Will my existing scripts that manipulate student repositories still work?

Likely yes. As with GitHub Classroom, each student gets a normal GitHub
repository named `<classroom>-<assignment>-<username>`, so scripts that automate
git operations against those repositories generally carry over. For how GitHub
Classroom's vocabulary (cutoff date, Download grades, roster identifiers, teams)
maps onto Classroom 50's, see
[Coming from GitHub Classroom?](Glossary#coming-from-github-classroom).

## Access and permissions

### Why does signing in ask for access to all my repositories?

Classroom 50 authenticates the same way the GitHub CLI does, using GitHub's
`repo` scope. That scope is all-or-nothing (GitHub provides no way to limit it
to a single organization's repositories), so the grant covers your repositories
even though Classroom 50 only acts on classroom ones. This matches the CLI's
behavior. For what every scope grants and why, see
[Permissions and access](GitHub-Integration#permissions-and-access);
if you want to grant less, a fine-grained token scoped to one organization is
the tighter path (see
[Reducing what you grant](GitHub-Integration#reducing-what-you-grant)).

### Do teachers and students grant the same access?

Yes. Sign-in requests one scope set for everyone, on purpose: one person can be
both a teacher and a student (a teacher testing an assignment, a TA who also
takes the course), so Classroom 50 never asks you to declare a role at sign-in.
What you can *do* is decided afterward by your role in the organization and
classroom, not by your token. A student's grant is broader than what a student
actually uses (they never exercise the organization-administration or
repository-deletion powers). To grant less than the default, sign in with a
fine-grained token scoped to one organization. Why per-organization classic
sign-in and separate teacher/student profiles aren't offered is recorded in
[Known Limitations](Known-Limitations#requested-but-architecturally-hard).

### Why does tearing down an organization ask for an extra permission?

Signing in does not request permission to delete repositories. One feature needs
it: **Tear down organization**, which resets an organization by deleting every
repository in it, and only after you type an explicit confirmation. When you use
it, Classroom 50 asks you to request that permission and sign in again. Nothing
else ever deletes a repository. See
[the full explanation](GitHub-Integration#2-teacher-authentication) in GitHub
Integration.

### Can I edit the config files in the `classroom50` repository by hand?

It's not recommended. Some state is derived from both the config files and the
live state on GitHub.com, and the app updates the files automatically to keep
them in sync; a hand-edit can create a state the tools don't know how to handle
(and makes problems much harder to troubleshoot). Manage the classroom through
the web app or the `gh teacher` CLI instead; the one documented exception is a
`scores.json` score override (see above).

### What is the service token, and is it the same one the web app set up?

The **service token** is a fine-grained personal access token stored as a secret
in your `classroom50` repository; the score-collection, regrade, and token-probe
workflows use it. It's the **same** token whether you set it up through the web
app or the CLI: you only need one per organization. To check that the stored
token still has every permission it needs, use **Test token** under **Service
token** in the organization's **Settings**. See
[the service-token setup](CLI-Teacher-Guide#create-the-service-token).

### Is Classroom 50 FERPA compliant? Where does student data go?

Classroom 50 has no server or database, so it holds no student data to be
compliant about. Everything lives in your GitHub organization, and your
browser or machine talks to GitHub directly, with one exception: browser
sign-in and repository downloads pass through a small stateless proxy that
stores nothing. Compliance therefore depends on your institution's agreement
with GitHub and on how much identifying data you put on GitHub. For the full
picture, including practices that keep student data off GitHub, see
[Privacy and FERPA](GitHub-Integration#privacy-and-ferpa).

## Roadmap

Some capabilities from GitHub Classroom aren't available today, including
**LTI / LMS grade passback**, in-app **score visibility for students**, and
**roster self-selection**. See
[Requested, but architecturally hard](Known-Limitations#requested-but-architecturally-hard)
in Known limitations for why, and share your use case in
[Discussions](https://github.com/foundation50/classroom50/discussions).
