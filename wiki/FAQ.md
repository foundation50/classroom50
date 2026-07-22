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

You don't have to. Because one organization holds many classrooms, most teachers
use a single organization and add a classroom per course or term. You can still
use separate organizations if you prefer — each just needs its own one-time
setup.

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

### Can I set a deadline with a specific time, not just a date?

Yes. Deadlines support a date **and** time (down to the second, in your
timezone). Submissions after the deadline are **marked late**; nothing is
blocked automatically.

### What's the difference between "template-less" and "empty repository"?

- **Template-less** (no template chosen): students get a repo containing only
  the autograder setup — good for write-from-scratch or short-answer work.
- **Empty repository**: a completely bare repo — no starter files **and** no
  autograding or feedback pull request. Use it when students build everything
  themselves, including their own GitHub Actions.

**Empty repository is permanent** for an assignment — you can't switch it on or
off after creating the assignment.

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

Yes. Create an assignment with **no autograding tests**, and no grading runs
(Classroom 50 still uses a lightweight workflow to tag submissions and support
written feedback, which uses far fewer Actions minutes). You can also **pause
autograding org-wide** from the organization's Actions settings in the web app,
and setup applies a **$0 Actions spending cap** by default so a runaway workflow
can't run up a bill.

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

## Grades and submissions

### A student submitted, but I don't see a grade. Why?

A few common reasons:

- **Scores haven't been collected yet.** Collection runs nightly; click
  **Collect now** on the submissions page to pull the latest immediately.
- **GitHub Pages is still deploying.** Right after a config change, published
  files can take a few minutes to go live.
- **The student's repo predates a workflow update.** If you updated Classroom 50
  after they accepted, have them re-accept (or re-create the repo) to pick up the
  current setup.

See [Troubleshooting](Troubleshooting) for specific error messages.

### Can I manually override or adjust a grade?

Yes. Edit the classroom's `scores.json` in the config repo: change the
submission's `score` and add `"override": true` to that entry, then commit.
Collection leaves overridden entries untouched on future runs. See
[Collect scores](CLI-Teacher-Guide#9-collect-scores).

### How do I export grades?

Download scores as a CSV from the submissions page
(**Download scores (CSV)**). The `gh teacher download` command clones every
submission repo and also writes a `scores.csv` summary at the destination root.
The raw score data also lives in `scores.json` in your config repo, so you can
build your own automations against it.

### As a teacher, can I test an assignment as a student?

You can accept your own assignment, but as an organization owner you'll keep
`admin` on the repository (GitHub won't let an owner reduce their own access to
`write`), so it won't match a real student's setup. To test the exact student
experience, use a separate GitHub account that you add to the classroom as a
student.

## Migrating from GitHub Classroom

### Can I import my existing GitHub Classroom?

Yes. `gh teacher classroom migrate` imports a GitHub Classroom into your
`classroom50` config repo — it copies each starter repo into your organization
as a fresh template and recreates the assignments. Rosters, scores, and past
student repositories are **not** migrated; you re-onboard students for the new
term. See [`gh teacher classroom migrate`](gh-teacher#classroom-migrate).

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

### What is the service token, and is it the same one the web app set up?

The **service token** is a fine-grained personal access token stored as a secret
in your config repo; the score-collection and regrade workflows use it. It's the
**same** token whether you set it up through the web app or the CLI — you only
need one per organization. See
[the service-token setup](CLI-Teacher-Guide#create-the-service-token).

## Roadmap

Some capabilities from GitHub Classroom aren't available today, including
**LTI / LMS grade passback** and a built-in **manual-grading UI**. Classroom 50
is open source and actively developed — share ideas or track direction in
[Discussions](https://github.com/foundation50/classroom50/discussions).
