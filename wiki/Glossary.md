# Glossary

Terms used throughout Classroom 50, in the web app, the CLI, and this wiki.

One concept, one term: when writing about Classroom 50, use the terms
defined here and avoid mixing in synonyms, so readers never have to wonder
whether two words mean two different things. Occasional slips are
understandable, but this page is the reference. If you find copy that
disagrees with it,
[file an issue](https://github.com/foundation50/classroom50/issues).

## Core concepts

#### Classroom

The basic unit of Classroom 50: one course's students,
assignments, roster, and scores. A classroom belongs to a GitHub organization,
and an organization can hold several classrooms (for example, one per term or
section).

#### Assignment

A piece of coursework in a classroom. May be individual or
group, may include starter code, and may have a due date and autograding.

#### Slug

The short lowercase identifier of a classroom or an assignment, used in URLs
and repository names. The web app derives it from the name (letters with
diacritics transliterate to their base letters); the CLI calls a classroom's
slug its **short-name**.

#### Individual assignment

Each student gets their own repository.

#### Group assignment

Teammates share one repository. The first student to
accept creates it and invites the others. Groups replace GitHub Classroom's
teams: there is no separate team-creation step and no group names.

#### Roster

The list of students in a classroom. Backed by a `roster.csv`
file, but the classroom's GitHub team is the source of truth for who is
enrolled. A row identifies a student by `github_id` or GitHub username; a student
invited by email has a **pending row**, identified by their address, until they
accept. There is no equivalent of GitHub Classroom's roster identifier or student
self-linking.

#### Pending row

A `roster.csv` row for someone invited by email who hasn't
accepted yet. It holds the invited address and role, with no username or
`github_id`, because GitHub offers no way to look up an account from an email
address. A sync fills in the account once they accept; cancelling the
invitation removes the row immediately, and an expired one is cleared by the next
sync, from either tool.

#### Invite team

A `secret` GitHub team, named `invite-<hash>`, that holds one
invited address until that person joins. It is how an email invitation is
matched to the GitHub account that accepts it. Classroom 50 creates one per
email invitation and removes it once the invitation has been accepted, cancelled,
or expired. Both the web app and the teacher CLI create and read them, so an
invitation sent from one can be completed or revoked from the other. For more
information, see
[Invitations by email](How-Classroom-50-Works#invitations-by-email).

#### Sync

A pass that catches `roster.csv` up with the classroom's GitHub state:
it records the students who accepted an email invitation, fills in a missing
`github_id`, drops the pending rows nothing backs, and retires the invite teams
that are done. Nothing runs on its own: the web app runs a sync when a teacher
opens a classroom or its roster, and `gh teacher roster sync` runs one on demand.
This is not **Collect now**, which collects scores. See
[What triggers a sync](How-Classroom-50-Works#what-triggers-a-sync).

#### Organization (org)

The GitHub organization that hosts a Classroom 50
setup. Requires the Team or Enterprise plan.

#### The `classroom50` repository

The private repository named `classroom50`
in your organization. It holds every classroom's settings, roster,
assignments, autograders, and scores. Classroom 50 has no other backend.

## Roles

#### Teacher

Full control of a classroom. Granted organization owner and write
access to the `classroom50` repository.

#### Head TA

Write access to the `classroom50` repository, but not
organization owner.

#### TA

Read-only access to the `classroom50` repository.

#### Student

A member of the classroom who accepts and submits assignments.

#### Founder

For a group assignment, the student who accepts first: they create
the shared repository and invite the other teammates as collaborators.

## Assignments and grading

#### Template repository

A GitHub repository, flagged as a template, that
supplies an assignment's **starter code**. Each student who accepts gets a copy.
Assignments can also be template-less, in which case a student's repository
starts with a README and the autograding setup instead of starter code (see
[Repository shapes](Assignment-Templates#repository-shapes) for variations).

#### Due date

An optional date and time for an assignment. Submissions after
it are marked *late*; nothing is blocked, unlike GitHub Classroom's cutoff
date. To actually stop submissions, use **Close submission** on the
submissions page.

#### Autograder

The grading logic that runs on each submission. Can be
declarative tests (defined in the assignment) or a Python script you write.

#### Declarative tests

Input/output, run-command, and pytest checks defined
directly on an assignment, graded with no code to write. They fill the role
of GitHub Classroom's `autograding.json` presets; an existing
`autograding.json` workflow can be kept with a
[custom runner workflow](Advanced-Autograding#custom-runner-workflow-rare).

#### Runner

The shared grading engine that runs in GitHub Actions on every
submission.

#### Submission

A push to a student's assignment repository triggers one graded run, which
tags and publishes a GitHub Release — so grading is per push. The submissions
page, however, counts per commit: each student commit past the starter commit
on the default branch (excluding the tool's own bookkeeping commits), so a push
of several commits is graded once but counted several times.

#### Feedback pull request

An optional, long-lived pull request per student
repository for inline review of a student's work.

#### Score / collected scores

A **score** is the number a submission earned
(`score` out of `max-score`). The **collected scores** (`scores.json` in the
`classroom50` repository) are the record of every submission, built by the
score-collection workflow. Teachers can download them as CSV. See
[Reading results](Autograding-Basics#reading-results) in Autograding Basics.

#### Score override

A teacher-set score entered on the submissions page,
stored with the collected scores and left untouched by autograding until
cleared. Used for manual grading and for overriding an autograded result
(which is preserved and restored when the override is cleared).

## Access and setup

#### Service token

A fine-grained personal access token (PAT) stored as a
secret in the `classroom50` repository. The score-collection, regrade, and
token-probe workflows use it to read and update student repositories.

#### Workflow files

The GitHub Actions files Classroom 50 places in the
`classroom50` repository and in each assignment repository (such as
`autograde.yaml`) to run grading, collection, and publishing.

#### Accept

The student action that creates their assignment repository from
the template.

#### Submit

The student action that pushes work for grading.

#### Unlisted classroom

A classroom whose published files live at an
unguessable URL instead of a predictable one. This is obscurity, not access
control: anyone with the link can read the files.

## Repository naming

Assignment repositories are named:

```
<classroom>-<assignment>-<username>
```

For a group assignment, `<username>` is the founder who created the shared
repository.

GitHub caps a repository name at 100 characters, so the classroom and
assignment slugs share a budget that leaves room for any username. An
assignment slug that predates the budget can be renamed once to fit; the old
slug is recorded as `renamed_from` and stays permanently reserved, so
GitHub's redirects from the old repository names keep working. See
[`assignment rename`](gh-teacher#assignment-rename).

## Coming from GitHub Classroom?

Most vocabulary carries over unchanged: classroom, roster, assignment,
individual and group assignments, template repository, starter code, accept.
Where the behavior behind a term differs, the entry above says so. See also
[Coming from GitHub Classroom](FAQ#coming-from-github-classroom) in the FAQ.
