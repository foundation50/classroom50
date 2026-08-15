# Glossary

Terms used throughout Classroom 50, in the web app, the CLI, and this wiki.

## Core concepts

**Classroom** — The basic unit of Classroom 50: one course's students,
assignments, roster, and scores. A classroom belongs to a GitHub organization,
and an organization can hold several classrooms (for example, one per term or
section).

**Assignment** — A piece of coursework in a classroom. May be individual or
group, may include starter code, and may have a due date and autograding.

**Individual assignment** — Each student gets their own repository.

**Group assignment** — Teammates share one repository. The first student to
accept creates it and invites the others.

**Roster** — The list of students in a classroom. Backed by a `roster.csv`
file, but the classroom's GitHub team is the source of truth for who is
enrolled.

**Organization (org)** — The GitHub organization that hosts a Classroom 50
setup. Requires the Team or Enterprise plan.

**Config repository** — The private `classroom50` repository in your organization.
It holds every classroom's settings, roster, assignments, autograders, and
scores. Classroom 50 has no other backend.

## Roles

**Teacher** — Full control of a classroom. Granted organization owner and write
access to the config repository.

**Head TA** — Write access to the config repository, but not organization owner.

**TA** — Read-only access to the config repository.

**Student** — A member of the classroom who accepts and submits assignments.

**Founder** — For a group assignment, the student who accepts first: they create
the shared repository and invite the other teammates as collaborators.

## Assignments and grading

**Template repository** — A GitHub repository, flagged as a template, that
supplies an assignment's **starter code**. Each student who accepts gets a copy.
Assignments can also be template-less, in which case a student's repository
contains only the autograder setup.

**Due date** — An optional date and time for an assignment. Submissions after
it are marked *late*; nothing is blocked. To actually stop submissions, use
**Close submission** on the submissions page.

**Autograder** — The grading logic that runs on each submission. Can be
declarative tests (defined in the assignment) or a Python script you write.

**Declarative tests** — Input/output, run-command, and pytest checks defined
directly on an assignment, graded with no code to write.

**Runner** — The shared grading engine that runs in GitHub Actions on every
submission.

**Submission** — A push to a student's assignment repository. Each submission
is tagged, graded, and published as a GitHub Release.

**Feedback pull request** — An optional, long-lived pull request per student
repository for inline review of a student's work.

**Score / gradebook** — A **score** is the number a submission earned
(`score` out of `max-score`); the **gradebook** (`scores.json`) is the
collected record of every submission, built by the score-collection workflow.
Teachers can download it as CSV. See
[Reading results](Autograders#reading-results) in Autograders.

**Score override** — A teacher-set score entered on the submissions page,
stored in the gradebook and left untouched by autograding until cleared. Used
for manual grading and for overriding an autograded result (which is preserved
and restored when the override is cleared).

## Access and setup

**Service token** — A fine-grained personal access token (PAT) stored as a
secret in the config repository. The score-collection and regrade workflows use it to
read and update student repositories.

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
Where the words — or the behavior behind them — differ:

| GitHub Classroom | Classroom 50 |
| --- | --- |
| **Deadline / cutoff date** | **Due date**. It only marks later submissions *late* — nothing is blocked. The enforcement tools are **Close submission** (block new accepts, set repositories read-only) and **Lock assignment**. |
| **Download grades** (CSV) | **Download scores (CSV)** on an assignment's submissions page. The underlying gradebook is `scores.json` in your config repository. See [Reading results](Autograders#reading-results) in Autograders. |
| **Roster identifier** and student self-linking | Doesn't exist — there's nothing to link. The roster is keyed by **GitHub username** (the numeric `github_id` is resolved automatically); you invite students, and accept links work once they've joined the organization. |
| **Teams** (group assignments) | **Groups.** The first student to accept (the **founder**) creates the shared repository and invites teammates as collaborators — there is no separate team-creation step. |
| **Autograding presets** (`.github/classroom/autograding.json`) | **Declarative tests**, stored on the assignment itself (Input/Output, Run command, Python/pytest). An existing `autograding.json` workflow can be kept with a [custom runner workflow](Autograders#custom-runner-workflow-rare). |
| Hosted service stores your data | Everything lives in **your GitHub organization** (config repository, student repositories, Actions). |

To bring an existing classroom over, see
[`gh teacher classroom migrate`](gh-teacher#classroom-migrate) and the
[migration FAQ](FAQ#migrating-from-github-classroom).
