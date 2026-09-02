# Known limitations

Classroom 50 has no server: state lives in GitHub, and work runs as you or
as GitHub Actions in your organization. That design keeps your data in your
organization, but it also rules some features out and makes others behave
unexpectedly. This page lists those limits, each with the reason and the
workaround where one exists.

## Roster and enrollment

**Students can't be looked up by email.** GitHub's API provides no way to
find an account from an email address, so an emailed invitation can't be
matched to a student until they accept it. Classroom 50 records the address
on the roster as a pending row and fills in the account at the next sync,
from either tool. To have usernames from the start, collect them up front; a
signup form works well. See [Add students](Web-Teacher-Guide#add-students)
and [What triggers a sync](How-Classroom-50-Works#what-triggers-a-sync).

**A retained address is the one you invited.** When you invite by email, the
address stored on the roster is what you typed, which is not necessarily the
email on the student's GitHub account. Treat it as your contact address for
that student rather than a verified account detail. To record a different
address, edit the roster row or upload a roster CSV once they've joined.

**Students can't join through a link alone.** GitHub requires an
organization owner to invite members, so there's no self-service join link.
Adding a student to the roster sends the invitation; once they've accepted
it, assignment accept links work with no further action from you.

**There's no roster self-identification at accept time.** GitHub Classroom
lets a student claim "I am this roster entry" when accepting. That step
requires a server to mediate identities, so Classroom 50 identifies students
by their GitHub account instead. A roster row names an account, not a person
waiting to be claimed.

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

**State refreshes only when a page loads.** With no server polling in the
background, the app reads GitHub's current state when you open or reload a
page, and scores update only when collection runs (**Collect now**, or a manual
`collect-scores` run).
If a view looks stale, reload it. See
[When state refreshes](How-Classroom-50-Works#when-state-refreshes).

## Templates and student repositories

**Students can read private templates in your organization.** Accept works
by giving the classroom's team read access to the template, so a curious
student can browse it, including its history. Never commit solutions (or
their history) to a template: develop privately and copy or squash the clean
state into the template repository you register.

**Grading files are tamper-proof, not secret.** Test scripts and fixtures
kept in `CLASSROOM/autograders/ASSIGNMENT/` never enter a student's
repository, and the runner fetches them fresh on every grading run, so a
student can't alter them. But your organization's GitHub Pages site serves the
bundle publicly (an unlisted classroom only makes the URL hard to guess), so a
student who finds the URL can read it. Keep full solutions and private data
out of the bundle, and use `failure-details` to limit what a failing run
reveals. See
[Teacher-only test files](Autograding-Basics#teacher-only-test-files).

**Student repositories are not forks.** Accept generates a copy of the
template; there is no upstream link, so template updates can't be pushed or
pulled into accepted repositories. `.gitignore` and `.github/` are the
exception, re-fetched on every submit. See
[Updating starter code after students accept](Course-Lifecycle-and-End-of-Term#updating-starter-code-after-students-accept).

**Renaming a repository breaks tracking.** Classroom 50 finds student work
by the repository name (`<classroom>-<assignment>-<username>`). A renamed
repository disappears from the submissions view. Tell students not to rename
their repositories; if one already did, rename it back. The one supported
rename is the slug update for an assignment whose repository names can exceed
GitHub's 100-character limit — it renames every student repository
consistently, and only once per assignment. See
[Updating an over-budget assignment slug](Web-Teacher-Guide#updating-an-over-budget-assignment-slug).

**Students can re-enable paused workflows.** Students have write access to
their repositories, which includes the Actions tab, so **Pause autograding**
(and any Actions policy) is housekeeping, not enforcement: a student can
re-enable the workflow. Treat grading controls as cost management, and use
**Close submission** when you need actual enforcement.

**Legacy group repositories have no names.** A **Group (legacy)** assignment's
repository is named after the founder (the first student to accept); that mode
has no group-name concept and no pre-assigned groups. The current **Group**
mode has both: each group is a GitHub team with a display name, and its
repository is numbered. See
[How group assignments work](FAQ#how-do-group-assignments-work).

## Group assignments

**Join requests happen on GitHub, not in the app.** GitHub's API exposes no
endpoints for team join requests, so a student who wants to join an existing
group requests it on the group team's GitHub page (the accept page's **Ask to
join** opens it), and the group reviews and cancels requests there too.
Classroom 50 can't list or approve join requests itself.

**A group founder can change membership on GitHub.** In student formation the
founding student maintains the group's team, and GitHub can't stop a
maintainer from adding or removing members directly on GitHub. Classroom 50
contains this instead of preventing it:

- The teacher's group views flag the change as **Members changed since the
  last refresh**, against the recorded group info.
- Grading credits only team members who are on the classroom roster, so an
  outside account is never credited.
- The maximum group size is re-checked whenever a Classroom 50 client adds a
  member.

## Timing

**Published changes take a moment to go live.** Classroom data that students
read (the assignment list an accept link resolves against) is published
through GitHub Pages, and a deploy takes from about 20 seconds to a few
minutes. Right after you create or change an assignment, an accept link can
briefly fail or show stale data; wait a minute and retry.

## Requested, but architecturally hard

- **LTI / LMS grade passback** needs a server-to-server integration, which
  the serverless design doesn't currently accommodate. Exports (score CSVs
  and `scores.json`) are the supported path into an LMS today.
- **Live in-app scores for students** are blocked by the cross-origin limit
  above ([#567](https://github.com/foundation50/classroom50/issues/567)).
- **Roster self-selection** would need a server to arbitrate identity
  claims.
- **Per-organization sign-in access** isn't possible with a classic OAuth
  sign-in: GitHub's `repo` scope is all-or-nothing, so the grant covers all
  your repositories, not just the classroom org's. The tighter path is a
  fine-grained personal access token scoped to one organization; see
  [Reducing what you grant](GitHub-Integration#reducing-what-you-grant).
- **Separate teacher and student sign-in profiles** would require choosing a
  role at sign-in, which the design avoids — one person can be both a teacher
  and a student in the same organization. What you can do is gated by your
  org and classroom role after sign-in, not by your token's scopes; see
  [Permissions and access](GitHub-Integration#permissions-and-access).

Classroom 50 is open source and actively developed; if one of these matters
to your course, share your use case in
[Discussions](https://github.com/foundation50/classroom50/discussions).

## Further reading

- [How Classroom 50 Works](How-Classroom-50-Works) for the design behind
  these limits.
- [Troubleshooting](Troubleshooting) for error messages with fixes.
