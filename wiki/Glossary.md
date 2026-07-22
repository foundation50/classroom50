# Glossary

Terms used throughout Classroom 50, in the web app, the CLI, and this wiki.

## Core concepts

**Classroom** — The basic unit of Classroom 50: one course's students,
assignments, roster, and scores. A classroom belongs to a GitHub organization,
and an organization can hold several classrooms (for example, one per term or
section).

**Assignment** — A piece of coursework in a classroom. May be individual or
group, may include starter code, and may have a deadline and autograding.

**Individual assignment** — Each student gets their own repository.

**Group assignment** — Teammates share one repository. The first student to
accept creates it and invites the others.

**Roster** — The list of students in a classroom. Backed by a `roster.csv`
file, but the classroom's GitHub team is the source of truth for who is
enrolled.

**Organization (org)** — The GitHub organization that hosts a Classroom 50
setup. Requires the Team or Enterprise plan.

**Config repo** — The private `classroom50` repository in your organization.
It holds every classroom's settings, roster, assignments, autograders, and
scores. Classroom 50 has no other backend.

## Roles

**Teacher** — Full control of a classroom. Granted organization owner and write
access to the config repo.

**Head TA** — Write access to the config repo, but not organization owner.

**TA** — Read-only access to the config repo.

**Student** — A member of the classroom who accepts and submits assignments.

**Founder** — For a group assignment, the student who accepts first: they create
the shared repository and invite the other teammates as collaborators.

## Assignments and grading

**Template repository** — A GitHub repository, flagged as a template, that
supplies an assignment's **starter code**. Each student who accepts gets a copy.
Assignments can also be template-less, in which case a student's repository
contains only the autograder setup.

**Deadline (due date)** — An optional date and time for an assignment.
Submissions after it are marked *late*; nothing is blocked.

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

**Score / gradebook** — Collected results. The gradebook (`scores.json`) is
built by the score-collection workflow; teachers can download it as CSV.

## Access and setup

**Service token** — A fine-grained personal access token (PAT) stored as a
secret in the config repo. The score-collection and regrade workflows use it to
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
