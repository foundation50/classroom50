# Classroom 50

Classroom 50 is a free, open-source tool for distributing and auto-grading
programming assignments on GitHub. It's an alternative to GitHub Classroom,
supported by the [Fifty Foundation](https://fifty.foundation).

Use it as a web app at [classroom50.org](https://classroom50.org/) or as the
`gh teacher` and `gh student` command-line tools.

## How it works, in brief

Classroom 50 has no server or database of its own. The web app is a static site
hosted on GitHub Pages and the CLI runs on your machine; the app keeps only a
small amount of local state in your browser (your GitHub access token and
interface preferences). Your classrooms, roster, assignments, and grades are not
kept in a Classroom 50 account; they are stored in GitHub, as organization and
team membership, repositories, commit history, permissions, and a few config
files in your organization.

One consequence is worth noting early: because there is no always-on server,
some operations happen only when a teacher (an organization owner) is signed in
and acting. Actions such as creating a classroom, adding a student, or saving an
assignment run at the time you perform them and record the resulting state.
Teachers therefore stay more involved in administration than they would with a
hosted service.

For the full model, see [How Classroom 50 Works](How-Classroom-50-Works).

## What you can do

- Create individual and group assignments, with or without starter code.
- Auto-grade submissions with declarative tests or your own grading scripts.
- Leave inline feedback on student work.
- Manage rosters, track submissions, and collect scores.

Auto-grading and background tasks run in **GitHub Actions**; published data is
served from **GitHub Pages** — all inside your own organization.

## What you need

- A GitHub account.
- A GitHub organization on the **Team** or **Enterprise** plan (free for
  verified teachers through [GitHub Education](https://docs.github.com/en/education/about-github-education/github-education-for-teachers/apply-to-github-education-as-a-teacher)).

## Get started

**Web app** — no installation required:

1. Teachers: [Web Teacher Guide](Web-Teacher-Guide).
2. Students: [Web Student Guide](Web-Student-Guide).

**Command line** — needs the [GitHub CLI (`gh`)](https://cli.github.com/) and
[Go](https://go.dev/):

1. [Install the CLI](Installation).
2. Teachers: [CLI Teacher Guide](CLI-Teacher-Guide).
3. Students: [CLI Student Guide](CLI-Student-Guide).

New to the terminology? See the [Glossary](Glossary). Curious how it all fits
together? Read [How Classroom 50 Works](How-Classroom-50-Works). Have a question?
Check the [FAQ](FAQ).

## Training sessions

The Fifty Foundation hosts live online training sessions:

- [Friday, July 24, 1–2pm EDT](https://time.cs50.io/20260724T1300-0400/PT1H?title=Classroom+50+Training+Session)
- [Friday, August 14, 1–2pm EDT](https://time.cs50.io/20260814T1300-0400/PT1H?title=Classroom+50+Training+Session)

[Register here](https://docs.google.com/forms/d/e/1FAIpQLSdSZzOUOtSExmldFOsdlePWGZkJELHnZBpH3NPhXAJMDG9eXA/viewform?usp=dialog).
A recording will be made available afterward.

> [!NOTE]
> If you used the pre-release version of Classroom 50 before July 1, 2026,
> reset your organization before using the current version: delete the
> `classroom50` repository in your GitHub organization. This removes all
> existing classrooms and student data.

## Get help

- **Questions and ideas:** [Discussions](https://github.com/foundation50/classroom50/discussions).
- **Bug reports:** [Issues](https://github.com/foundation50/classroom50/issues).
- **Email updates:** subscribe at [fifty.foundation](https://fifty.foundation).
