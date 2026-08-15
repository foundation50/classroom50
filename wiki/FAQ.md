# FAQ

Common questions about Classroom 50, grouped by topic. For error messages and
fixes, see [Troubleshooting](Troubleshooting); for terms, see the
[Glossary](Glossary).

## Getting started

### Do I need a paid GitHub plan?

You need a GitHub organization on the **Team** or **Enterprise** plan.
Verified educators get GitHub Team **free** through
[GitHub Education](https://github.com/education/teachers), which unlocks
everything Classroom 50 relies on (notably GitHub Pages from a private repo).
Free/personal organizations can't host a classroom.

### How is Classroom 50 different from GitHub Classroom?

The teaching model is familiar — you create assignments (optionally with
starter code), students accept to get their own repository, and submissions are
auto-graded — but Classroom 50 has no server or database of its own. Your
classroom settings, roster, assignments, and scores are stored in a private
`classroom50` config repo in your organization, and grading runs in GitHub
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

Yes. A **classroom** is a directory in your organization's `classroom50` config
repo, and an organization can hold as many as you like, for example one per
course, section, or term. Add each with **Create classroom** in the web app or
`gh teacher classroom add`.

### Should I create one organization per course, like GitHub Classroom?

You don't have to. Because one organization holds many classrooms, a single,
stable teaching team running one course (across terms or sections) works well
with **one organization** and a classroom per term or section. Prefer
**separate organizations** when many teachers run very different classes (e.g.
school-wide adoption) — each teacher then manages their own org — or when a
large course would otherwise accumulate hundreds of assignment repositories
per year; in that case, one org per academic year keeps things tidy. Each
organization needs its own one-time setup.

### Can a classroom have multiple teachers or TAs?

Yes. Classroom 50 has four roles: **teacher** (organization owner, full
control), **head TA** (config-repo write, not an owner), **TA** (config-repo
read-only), and **student**. Manage staff in the web app under a classroom's
**Settings → Staff and roles**, or with `gh teacher staff add`. See the
[Glossary](Glossary#roles) for what each role can do.

### Can students join a classroom themselves with a link?

Not on their own — GitHub requires an organization owner to invite members. Add
students to the roster (by username, by email, or by bulk CSV upload), which
sends the organization invitation. **Once they've joined the organization**, the
assignment accept links work without any further action from you.

## Rosters and students

### Can I add students in bulk, or by email?

Yes. Upload a CSV or a text file of GitHub usernames (web app: **Upload**; CLI:
`gh teacher roster import`). You can also invite students by **email address**
when you don't know their GitHub username — they complete a short onboarding
step to link their account.

### Can I see the whole roster, including students who haven't accepted?

Yes. The submissions view lists every rostered student, not just those who
accepted, with their status — so you can see at a glance who hasn't started.

### What happens when I unenroll or remove a student?

They're separate actions, on purpose:

- **Unenroll** removes the student from the classroom roster and team. It does
  **not** remove them from the organization and does **not** delete their
  assignment repositories.
- **Remove from the organization** revokes their access to every repo (including
  their assignment repos) but still doesn't delete anything.
- **Deleting a repository** is always a separate, manual step.

See [How Classroom 50 Works](How-Classroom-50-Works#lifecycle-enroll-unenroll-and-remove-are-separate).

## Assignments

### Can I use a private repository as an assignment template?

Yes, if the template lives **inside your organization**. When you register the
assignment, Classroom 50 automatically grants the classroom's team read access
so students can copy it. A **public** template works from anywhere. A private
template **outside** your organization can't be shared with students — copy it
into your organization or make it public. See
[Assignment Templates](Assignment-Templates).

> [!NOTE]
> Grant the template when you **create** the assignment. If you create the
> assignment first and add a private template later by editing it, the team
> read grant isn't re-applied and students may get a 404 on accept.

### Can I customize the Feedback PR's first comment?

Yes, for a templated assignment. Turn on **Use the template's pull request
template as the Feedback PR body** and Classroom 50 uses your template
repository's own pull request template (`.github/pull_request_template.md`,
`pull_request_template.md`, or `docs/pull_request_template.md`) as each
student's Feedback PR body instead of the built-in text. The assignment form
auto-checks this when it detects such a file, and you can toggle it off.

Note this is not GitHub's native behavior. GitHub only fills a
`pull_request_template.md` into pull requests opened through the web "compare
and pull request" flow, never for the API-created Feedback PR, so dropping the
file in alone does nothing until you enable this option. If the file is missing
or can't be read, the built-in body is used. It's set in the web app; there is
no `gh teacher` flag for it.

### Can I set a due date with a specific time, not just a date?

Yes. Due dates support a date **and** time (down to the second, in your
timezone). Submissions after the due date are **marked late**; nothing is
blocked automatically.

### Does the due date cut off student access?

No — there is no cutoff date; the due date only marks later submissions late.
To actually end an assignment, use **Close submission** in the submissions
page's **Actions** menu: it blocks new accepts and sets every student's
repository to read-only (work is preserved). **Reopen submission** restores
write access — useful when a project continues in a follow-up course. **Update
student repo access** in the same menu gives finer control over the role
students hold on their repos.

### What's the difference between "template-less" and "empty repository"?

Both start from no template; the difference is what (if anything) is committed:

- **Template-less with a README** (**Add a README** on): students get a repo
  with an initial commit and the autograder setup — good for write-from-scratch
  or short-answer work.
- **Empty repository** (**Add a README** off, built-in autograder off): a
  completely bare repo with no commit at all — no starter files **and** no
  autograding or feedback pull request, ever. Use it when students build
  everything themselves, including their own GitHub Actions.
- (**Add a README** off with the built-in autograder **on** is a third,
  in-between shape: an initialized repo carrying only the control files, no
  README, which grades normally.)

**These repository-shape choices can be changed after creation, but a change
only affects repositories accepted from then on** — repositories students
already accepted aren't retrofitted, so they keep their original shape. The web
edit form asks you to confirm when students have already accepted. (**Assignment
type** — Individual vs. Group — is the exception and stays locked, since
switching it would invalidate existing submissions.)

### How do group assignments work?

Choose **Group** when creating the assignment and set a maximum group size. The
first teammate to accept creates the shared repository and becomes its owner
(the "founder"); they then invite the other teammates as collaborators. Everyone
on the roster who is a collaborator gets the same score. Group repositories are
named after the founder's username; custom group names aren't supported, and
renaming a group repository isn't recommended.

### Does the assignment description show to students?

The description is stored with the assignment, but student-facing instructions
are best placed in the template's `README.md` — that's what students see when
they open their repository. See [Assignment Templates](Assignment-Templates).

## Autograding and Actions

### Can I grade without writing test code?

Yes. Use **declarative tests** (input/output, run-command, or pytest checks)
defined right on the assignment. No grading script needed. For more control,
write an `autograder.py`. See [Autograders](Autograders).

### Can I turn autograding off, or reduce Actions usage?

Yes, several levers:

- **Grade on submit only** — set the assignment's **Submission type** to **A
  tagged commit** (`--submission-mode tag` in the CLI). Students' regular
  pushes then run nothing at all; grading happens only when they submit
  (`gh student submit` or a hand-pushed `submit/*` tag). This is the biggest
  saver for large classrooms, where every work-in-progress push would otherwise
  grade. You can also name **milestone tags** (`--submission-tag phase1`) so
  students grade specific checkpoints with plain git. See
  [Autograders → Which commits grade](Autograders#which-commits-grade).
- **Pause autograding for one assignment** (reversible) — **Pause autograding**
  in the submissions page's **Actions** menu disables the built-in
  `autograde.yaml` workflow in every student repository (via GitHub's
  workflow-disable API — no files change). Students' other workflows keep
  running, and **Resume autograding** re-enables it. Offered on individual
  assignments that use the built-in autograder, once students have accepted.
- Create an assignment with **no autograding tests**, and no grading runs
  (Classroom 50 still uses a lightweight workflow to tag submissions and
  support written feedback, which uses far fewer Actions minutes).
- **Don't use the built-in autograder at all** — when creating an
  assignment, pick **Do not use the built-in autograder**. Accept then installs
  no autograding workflow: a templated assignment runs only your template's own
  CI (if any), and score collection skips the assignment. The right choice for
  project-shaped assignments graded by hand or by your own CI. Can be changed
  after creation, but only affects repositories accepted from then on (existing
  ones keep their original setup).
- **Pause autograding org-wide** — the organization's Actions settings in the
  web app. **Caution:** this stops **all** workflows in student repositories,
  not just autograding — any CI your students run stops too. Setup also creates
  a **$0 Actions spending cap** (only when the organization has none) so a
  runaway workflow can't run up a bill.

### Can I use my own (self-hosted) runners?

Yes. Set `runs-on` in the assignment's runtime to your self-hosted labels (for
example `["self-hosted", "gpu"]`). Self-hosted runners keep their own
toolchains, so Classroom 50 skips managed toolchain setup on them — provision
what your assignments need in the runner image. See
[Autograders](Autograders#the-runtime-block).

### Can the autograder show students *why* a test failed?

Yes. Each submission's Release and the Actions run summary include a per-test
breakdown (expected vs. actual output for I/O tests, captured stderr). A custom
`autograder.py` can add its own diagnostic messages to `result.json`.

### Can students use GitHub Codespaces?

If Codespaces is enabled for your organization, students can open their
assignment repository in Codespaces like any other repo. Classroom 50 doesn't
manage Codespaces itself — any education Codespaces benefit is handled on
GitHub's side.

## Scores and submissions

### A student submitted, but I don't see a score. Why?

A few common reasons:

- **Scores haven't been collected yet.** Collection runs nightly; click
  **Sync now** on the submissions page to pull this assignment's latest
  results immediately (the sync is scoped to the assignment you're viewing, so
  it's fast even in a big classroom).
- **GitHub Pages is still deploying.** Right after a config change, published
  files can take a few minutes to go live.
- **The student's repo predates a workflow update.** If you updated Classroom 50
  after they accepted, have them re-accept (or re-create the repo) to pick up the
  current setup.

See [Troubleshooting](Troubleshooting) for specific error messages.

### Can students see their scores in the web app?

Not yet. Scores live in each student's repository: every graded submission
publishes a **Release** with the score and a per-test breakdown, which is what
the student-facing **View grade** link opens. Showing scores inside the app is
blocked by a technical limitation — Classroom 50 has no server, and the
browser can't read Release assets cross-origin — but it's on the wish list
(see [#567](https://github.com/foundation50/classroom50/issues/567)). Point
students at their repository's Releases page (or the Feedback PR) for
results.

### Can I manually override or adjust a score?

Yes, right in the web app — for both **manual** and **autograded** assignments.
On the submissions page, each row's score cell has an edit button that opens a
score-override dialog:

- **Manual assignments** — enter a score out of the assignment's **Max points**.
- **Autograded assignments** — enter a score to override the autograded result.
  The original autograded score is preserved; clearing the override restores it.
  If the submission hasn't been autograded yet, the dialog also asks for the max
  points to grade out of.

Overridden scores show a **Manual** badge and aren't changed by autograding
until you clear the override. Use **Clear override** in the dialog to revert.

This editor appears only for organization owners (writing a score writes the
config repo). Under the hood, an override is just an entry in the classroom's
`scores.json` with `"override": true`, which collection leaves untouched on
future runs — so you can still edit it by hand if you prefer (see
[Collect scores](CLI-Teacher-Guide#9-collect-scores)).

### How do I export scores, or download student work in bulk?

Download scores as a CSV from the submissions page
(**Download scores (CSV)**). For the work itself, **Download all submissions**
in the same **Actions** menu bundles every repository's latest submission into
a single zip (built in your browser). For real clones — e.g. to run your own
tooling locally — `gh teacher download` clones every submission repo and also
writes a `scores.csv` summary at the destination root. The raw score data also
lives in `scores.json` in your config repo, so you can build your own
automations against it. The column-by-column reference for both CSVs is in
[Autograders → Score exports](Autograders#score-exports).

### As a teacher, can I test an assignment as a student?

You can — Classroom 50 doesn't currently disallow one account holding both a
staff and a student role. Add yourself to the roster with `gh teacher roster
add` (or the web app) while remaining on a staff team; you'll then show **both**
roles and be graded as a student. (Your in-app access stays at your highest
role, and the `roster.csv` `role` column records that highest role — an
automatic sync may rewrite it, which doesn't affect your student enrollment. See
[Dual roles](gh-teacher#dual-roles-staff-who-are-also-students).)

One caveat: as an **organization owner** you keep `admin` on your own assignment
repo (GitHub won't let an owner reduce their own access to `write`), so it won't
match a real student's `write`-level setup. To test the exact student
experience, use a **separate** GitHub account added to the classroom as a
student.

## Migrating from GitHub Classroom

### Can I import my existing GitHub Classroom?

Yes. `gh teacher classroom migrate` imports a GitHub Classroom into your
`classroom50` config repo — it copies each starter repo into your organization
as a fresh template and recreates the assignments. Rosters, scores, and past
student repositories are **not** migrated; you re-onboard students for the new
term. See [`gh teacher classroom migrate`](gh-teacher#classroom-migrate), and
[Coming from GitHub Classroom?](Glossary#coming-from-github-classroom) for how
GitHub Classroom's vocabulary (cutoff date, Download grades, roster
identifiers, teams) maps onto Classroom 50's.

### Will my existing scripts that manipulate student repos still work?

Likely yes. As with GitHub Classroom, each student gets a normal GitHub
repository named `<classroom>-<assignment>-<username>`, so scripts that automate
git operations against those repos generally carry over.

## Access and permissions

### Why does signing in ask for access to all my repositories?

Classroom 50 authenticates the same way the GitHub CLI does, using GitHub's
`repo` scope. That scope is all-or-nothing — GitHub provides no way to limit it
to a single organization's repositories — so the grant covers your repos even
though Classroom 50 only acts on classroom ones. This matches the CLI's behavior.

### Why does signing in ask for permission to "Delete repositories"?

One feature uses it: **Tear down organization** (org settings → Danger zone),
which resets an organization by deleting the repositories Classroom 50 manages
— and only after you type an explicit confirmation. Nothing else ever deletes a
repository, and because there's no Classroom 50 server, the token stays in your
browser. The CLIs don't request it at all unless you opt in
(`gh teacher login -s delete_repo`). Details:
[GitHub Integration](GitHub-Integration#2-teacher-authentication).

### Can I edit the config files in the `classroom50` repo by hand?

It's not recommended. Some state is derived from both the config files and the
live state on GitHub.com, and the app's reconciliation process updates the
files automatically to keep them in sync — a hand-edit can create a state the
tools don't know how to handle (and makes problems much harder to
troubleshoot). Manage the classroom through the web app or the `gh teacher`
CLI instead; the one documented exception is a `scores.json` score override
(see above).

### What is the service token, and is it the same one the web app set up?

The **service token** is a fine-grained personal access token stored as a secret
in your config repo; the score-collection and regrade workflows use it. It's the
**same** token whether you set it up through the web app or the CLI — you only
need one per organization. See
[the service-token setup](CLI-Teacher-Guide#create-the-service-token).

## Roadmap

Some capabilities from GitHub Classroom aren't available today, including
**LTI / LMS grade passback**, in-app **grade visibility for students**, and
**roster self-selection** (students picking their own roster entry when
accepting). Classroom 50 is open source and actively developed — share ideas
or track direction in
[Discussions](https://github.com/foundation50/classroom50/discussions).
