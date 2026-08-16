# Migrating from GitHub Classroom

How to bring an existing GitHub Classroom into Classroom 50: what the import
carries over, what you rebuild, what behaves differently, and how to avoid
conflicts while both tools touch the same organization.

## The migration path

The import copies each assignment's starter repository into your organization
as a fresh template repository and recreates the assignments in a new
classroom. GitHub Classroom ties one classroom to one organization; you can
migrate several legacy classrooms into a single Classroom 50 organization by
importing each one.

**Prerequisite:** the target organization is set up for Classroom 50 (the
one-time setup in the [Web Teacher Guide](Web-Teacher-Guide#set-up-an-organization-one-time)
or [CLI Teacher Guide](CLI-Teacher-Guide#3-set-up-the-organization)).

**Web app:** open your organization at
`https://classroom50.org/YOUR-ORGANIZATION` and click
**Import from GitHub Classroom**. Pick the classroom from the list of GitHub
Classrooms your account administers, review the import summary, and confirm;
nothing is created until you do.

**CLI:**

```sh
gh teacher classroom migrate --source cs50-legacy --target cs50-fall-2026
```

`--dry-run` previews without changes. See
[`gh teacher classroom migrate`](gh-teacher#classroom-migrate) for source
resolution, naming flags, and the failure model.

## What carries over, and what doesn't

**Imported:** the classroom (as a new Classroom 50 classroom), its
assignments (individual and group, with group sizes), and a copy of each
starter repository as a template in your organization.

**Not imported:**

- **Rosters.** You re-onboard students for the new term; see
  [Add students](Web-Teacher-Guide#add-students).
- **Scores and past student repositories.** They stay where they are, in the
  old organization, and remain yours to keep.
- **Autograding configuration.** GitHub Classroom's autograding setup doesn't
  translate 1:1; the next section covers your options.

## Reusing your autograders

Classroom 50's [declarative tests](Autograding-Basics#declarative-tests) fill the
role of GitHub Classroom's autograding presets: input/output, run-command,
and pytest checks defined on the assignment, with no grading script to
write. For most assignments, migrating the autograder means re-entering
those tests on the imported assignment.

If you've invested in a working `autograding.json` workflow, you can keep it
and skip Classroom 50's grading pipeline for that assignment; see
[Bringing a GitHub Classroom autograder along](Advanced-Autograding#bringing-a-github-classroom-autograder-along).

## What behaves differently

Most concepts carry over unchanged. The differences, roughly in the order
you'll meet them:

- **Students don't self-select from a roster.** GitHub Classroom lets a
  student pick their roster entry from an invite link. In Classroom 50 you
  add students by GitHub username (individually or by CSV), which sends the
  organization invitation; the accept link works once they've joined. There
  are no roster identifiers. See
  [Add students](Web-Teacher-Guide#add-students).
- **Due dates don't cut anything off.** A due date only marks later
  submissions late; there is no cutoff date. To end an assignment, use
  **Close submission**, which blocks new accepts and sets student
  repositories to read-only. See
  [Course lifecycle and end of term](Course-Lifecycle-and-End-of-Term).
- **Groups replace teams.** There's no team-creation step and no group
  names: the first student to accept (the founder) creates the shared
  repository and invites teammates, and the repository is named after the
  founder. See [How group assignments work](FAQ#how-do-group-assignments-work).
- **Scores live in your organization, not a dashboard.** Every graded
  submission publishes a Release on the student's repository, and collection
  gathers results into `scores.json` in your `classroom50` repository. You
  download scores as CSV from the submissions page; students read their
  results from their repository's Releases, not inside the app.

For features GitHub Classroom has and Classroom 50 doesn't, see
[Known limitations](Known-Limitations).

## Running both in the same organization

Don't leave active GitHub Classroom classrooms in an organization you use
with Classroom 50. The two tools disagree about the private-repository
forking policy, and each keeps flipping the setting back, which shows up as
recurring settings warnings. Archive the old GitHub Classroom classrooms
once you've migrated. See
[Why organization settings sometimes change back](How-Classroom-50-Works#why-organization-settings-sometimes-change-back).

## Your existing scripts still work

Each student gets a normal GitHub repository named
`<classroom>-<assignment>-<username>`, as with GitHub Classroom, so scripts
that automate git operations against student repositories generally carry
over unchanged.

## Further reading

- [Coming from GitHub Classroom?](Glossary#coming-from-github-classroom) in
  the Glossary, for vocabulary.
- [How Classroom 50 Works](How-Classroom-50-Works#how-this-differs-from-github-classroom)
  for the architectural comparison.
