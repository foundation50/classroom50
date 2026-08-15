# Glossary

Terms used throughout Classroom 50, in the web app, the CLI, and this wiki.

Classroom 50 uses one term for each concept, matching GitHub Classroom and
GitHub documentation where they have a word for the same thing. Each entry
below defines the canonical term; where an older or alternative word is
still in circulation, the entry says so. If you find copy that disagrees
with this page,
[file an issue](https://github.com/foundation50/classroom50/issues).

## Core concepts

**Classroom** — The basic unit of Classroom 50: one course's students,
assignments, roster, and scores. A classroom belongs to a GitHub organization,
and an organization can hold several classrooms (for example, one per term or
section). Always "classroom", not "class" or "course".

**Assignment** — A piece of coursework in a classroom. May be individual or
group, may include starter code, and may have a due date and autograding.

**Individual assignment** — Each student gets their own repository.

**Group assignment** — Teammates share one repository. The first student to
accept creates it and invites the others. Groups replace GitHub Classroom's
teams: there is no separate team-creation step and no group names.

**Roster** — The list of students in a classroom. Backed by a `roster.csv`
file, but the classroom's GitHub team is the source of truth for who is
enrolled. The roster is keyed by GitHub username; there is no equivalent of
GitHub Classroom's roster identifier or student self-linking.

**Organization (org)** — The GitHub organization that hosts a Classroom 50
setup. Requires the Team or Enterprise plan.

**The `classroom50` repository** — The private repository named `classroom50`
in your organization. It holds every classroom's settings, roster,
assignments, autograders, and scores. Classroom 50 has no other backend.
Earlier copy called this the "config repository".

## Roles

**Teacher** — Full control of a classroom. Granted organization owner and write
access to the `classroom50` repository. Always "teacher", not "instructor".

**Head TA** — Write access to the `classroom50` repository, but not
organization owner.

**TA** — Read-only access to the `classroom50` repository.

**Student** — A member of the classroom who accepts and submits assignments.

**Founder** — For a group assignment, the student who accepts first: they create
the shared repository and invite the other teammates as collaborators.

## Assignments and grading

**Template repository** — A GitHub repository, flagged as a template, that
supplies an assignment's **starter code**. Each student who accepts gets a copy.
Assignments can also be template-less, in which case a student's repository
contains only the autograder setup. "Template repository", not "starter
repository".

**Due date** — An optional date and time for an assignment. Submissions after
it are marked *late*; nothing is blocked, unlike GitHub Classroom's cutoff
date. To actually stop submissions, use **Close submission** on the
submissions page. Always "due date", not "deadline".

**Autograder** — The grading logic that runs on each submission. Can be
declarative tests (defined in the assignment) or a Python script you write.

**Declarative tests** — Input/output, run-command, and pytest checks defined
directly on an assignment, graded with no code to write. They fill the role
of GitHub Classroom's `autograding.json` presets; an existing
`autograding.json` workflow can be kept with a
[custom runner workflow](Autograders#custom-runner-workflow-rare).

**Runner** — The shared grading engine that runs in GitHub Actions on every
submission.

**Submission** — A push to a student's assignment repository. Each submission
is tagged, graded, and published as a GitHub Release.

**Feedback pull request** — An optional, long-lived pull request per student
repository for inline review of a student's work.

**Score / collected scores** — A **score** is the number a submission earned
(`score` out of `max-score`); Classroom 50 says "score", not "grade". The
**collected scores** (`scores.json` in the `classroom50` repository) are the
record of every submission, built by the score-collection workflow. Teachers
can download them as CSV. See
[Reading results](Autograders#reading-results) in Autograders.

**Score override** — A teacher-set score entered on the submissions page,
stored with the collected scores and left untouched by autograding until
cleared. Used for manual grading and for overriding an autograded result
(which is preserved and restored when the override is cleared).

## Access and setup

**Service token** — A fine-grained personal access token (PAT) stored as a
secret in the `classroom50` repository. The score-collection and regrade
workflows use it to read and update student repositories.

**Workflow files** — The GitHub Actions files Classroom 50 places in the
`classroom50` repository and in each assignment repository (such as
`autograde.yaml`) to run grading, collection, and publishing. Some CLI
output still calls these the "skeleton".

**Accept** — The student action that creates their assignment repository from
the template.

**Submit** — The student action that pushes work for grading.

**Unlisted classroom** — A classroom whose published files live at an
unguessable URL instead of a predictable one. This is obscurity, not access
control: anyone with the link can read the files.

## Repository naming

Assignment repositories are named:

```
<classroom>-<assignment>-<username>
```

For a group assignment, `<username>` is the founder who created the shared
repository.

## Coming from GitHub Classroom?

Most vocabulary carries over unchanged: classroom, roster, assignment,
individual and group assignments, template repository, starter code, accept.
Where a term or the behavior behind it differs, the entry above says so. To
bring an existing classroom over, see
[`gh teacher classroom migrate`](gh-teacher#classroom-migrate) and the
[migration FAQ](FAQ#migrating-from-github-classroom).
