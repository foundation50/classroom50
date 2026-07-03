# Classroom 50

Classroom 50 is a free and open-source tool for managing and grading programming assignments via GitHub. Supported by the [Fifty Foundation](https://fifty.foundation) as an open-source alternative to GitHub Classroom, Classroom 50 supports creating assignments, defining auto-graded correctness tests, and managing submissions.

Classroom 50 exists both as a web application (available at [https://classroom50.org](https://classroom50.org/)) and as a command-line tool.

## Training Sessions

The Fifty Foundation will host two online training sessions to teach you how to use Classroom 50 and to answer your questions live. The sessions will take place at the following times:

- [Friday, July 24, 1pm-2pm EDT](https://time.cs50.io/20260724T1300-0400/PT1H?title=Classroom+50+Training+Session)
- [Friday, August 14, 1pm-2pm EDT](https://time.cs50.io/20260814T1300-0400/PT1H?title=Classroom+50+Training+Session)

To sign up to attend one of the training sessions, [complete the registration form here](https://docs.google.com/forms/d/e/1FAIpQLSdSZzOUOtSExmldFOsdlePWGZkJELHnZBpH3NPhXAJMDG9eXA/viewform?usp=dialog).

A recorded training session will also be made available for those who cannot attend live.

## Features

Classroom 50 supports:

- Creating assignments with starter code
- Defining correctness tests
- Distributing individual and group assignments
- Collecting and auto-grading submissions
- Providing inline qualitative feedback on submissions
- Managing course rosters and scores

Classroom 50 is entirely GitHub-based and does not have any servers of its own: all data lives in GitHub repositories and all auto-grading runs in GitHub Actions.

Teachers and students can use Classroom 50 through the web interface at https://classroom50.org or via the command-line interface (CLI), which is available as `gh teacher` and `gh student` GitHub CLI extensions.

To use Classroom 50, you'll need:

- A GitHub account
- A GitHub organization with at least the Team plan (free via GitHub Education for verified teachers).

## Try Classroom 50

> Note: If you used the pre-release version of Classroom 50 before July 1, 2026, you will likely need to reset your Classroom 50 organization before using the current version. To reset your organization, delete the `classroom50` repository in your GitHub organization. Note that this will remove all existing classrooms and student data.

### Web Interface

1. Follow the [Web Teacher Guide](Web-Teacher-Guide) to set up your classroom with Classroom 50.
2. Students can follow the steps in the [Web Student Guide](Web-Student-Guide) to accept and submit assignments.

### CLI

1. Follow the [Installation](Installation) guide. Go and the [GitHub CLI (`gh`)](https://cli.github.com/) are the only prerequisites.
2. Walk through the [CLI Teacher Guide](CLI-Teacher-Guide) to set up your classroom with Classroom 50.
3. Students can follow the steps in the [CLI Student Guide](CLI-Student-Guide) to accept and submit assignments.

## Get Help

- **Questions, ideas, feature requests:** open a thread on our [Discussions page](https://github.com/foundation50/classroom50/discussions).
- **Bug reports:** file an [issue](https://github.com/foundation50/classroom50/issues).
- **Email updates:** subscribe at [fifty.foundation](https://fifty.foundation).
