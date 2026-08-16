# Known limitations

Classroom 50 has no server: state lives in GitHub, work runs as you or as
GitHub Actions in your organization. That design keeps your data yours, but
it also rules some features out and makes others behave unexpectedly. This
page lists those limits candidly, each with the reason and the workaround
where one exists, so you don't have to rediscover them as bugs.

## Roster and enrollment

**You can't add students by email alone.** GitHub's API provides no way to
look up an account from an email address, so a roster is keyed by GitHub
username. Workarounds: collect usernames up front (a signup form works
well), or use the email-invitation path, where each student completes a
short onboarding step that links their account. See
[Add students](Web-Teacher-Guide#add-students).

**Students can't join through a link alone.** GitHub requires an
organization owner to invite members, so there's no self-service join link.
Adding a student to the roster sends the invitation; once they've accepted
it, assignment accept links work with no further action from you.

**There's no roster self-identification at accept time.** GitHub Classroom
lets a student claim "I am this roster entry" when accepting. That step
requires a server to mediate identities, so Classroom 50 identifies students
by their GitHub account instead. Rows in the roster are usernames, not
names to be claimed.

## Visibility and feedback

**Students can't see scores inside the app.** Grading results are published
as a Release on each student's repository, and the browser can't read
Release assets across origins (GitHub redirects them to storage that lacks
CORS headers). Point students at their repository's Releases page or the
feedback pull request; the student view's **View grade** link opens the
right Release. In-app scores are on the wish list; see
[#567](https://github.com/foundation50/classroom50/issues/567).

**There are no notifications or webhooks.** Nothing runs while no one is
signed in, so Classroom 50 can't email you when a student accepts or a
grading run fails. GitHub's own notifications still work (for example,
watching activity on the `classroom50` repository or on feedback pull
requests).

**What you see refreshes when a page loads.** With no server polling in the
background, the app reads GitHub's current state when you open or reload a
page, and scores update only when collection runs (nightly, or **Sync now**).
If a view looks stale, reload it. See
[When state refreshes](How-Classroom-50-Works#when-state-refreshes).

## Templates and student repositories

**Students can read private in-org templates.** Accept works by giving the
classroom's team read access to the template, so a curious student can
browse it, including its history. Never commit solutions (or their history)
to a template: develop privately and copy or squash the clean state into the
template repository you register.

**Student repositories are not forks.** Accept generates a copy of the
template; there is no upstream link, so template updates can't be pushed or
pulled into accepted repositories. `.gitignore` and `.github/` are the
exception, re-fetched on every submit. See
[Updating starter code after students accept](Course-Lifecycle-and-End-of-Term#updating-starter-code-after-students-accept).

**Renaming a repository breaks tracking.** Classroom 50 finds student work
by the repository name (`<classroom>-<assignment>-<username>`). A renamed
repository disappears from the submissions view. Tell students not to rename
their repositories; if one already did, rename it back.

**Students can re-enable paused workflows.** Students have write access to
their repositories, which includes the Actions tab, so **Pause autograding**
(and any Actions policy) is housekeeping, not enforcement: a student can
re-enable the workflow. Treat grading controls as cost management, and use
**Close submission** when you need actual enforcement.

**Group repositories have no names.** A group repository is named after the
founder (the first student to accept); there's no group-name concept and no
pre-assigned teams. See
[How group assignments work](FAQ#how-do-group-assignments-work).

## Timing

**Published changes take a moment to go live.** Classroom data that students
read (the assignment list an accept link resolves against) is published
through GitHub Pages, and a deploy takes from about 20 seconds to a few
minutes. Right after you create or change an assignment, an accept link can
briefly fail or show stale data; wait a minute and retry before debugging
anything else.

## Requested, but architecturally hard

- **LTI / LMS grade passback** needs a server-to-server integration, which
  the serverless design doesn't currently accommodate. Exports (score CSVs
  and `scores.json`) are the supported path into an LMS today.
- **Live in-app grades for students** are blocked by the cross-origin limit
  above ([#567](https://github.com/foundation50/classroom50/issues/567)).
- **Roster self-selection** would need a server to arbitrate identity
  claims.

Classroom 50 is open source and actively developed; if one of these matters
to your course, weigh in on
[Discussions](https://github.com/foundation50/classroom50/discussions).

## Further reading

- [How Classroom 50 Works](How-Classroom-50-Works) for the design these
  limits fall out of.
- [Troubleshooting](Troubleshooting) for error messages with fixes.
