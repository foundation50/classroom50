# Staff, TAs, and multiple teachers

How to run a classroom with more than one person on staff: the four roles,
how to grant them, what each role can see, and how to structure organizations
when several teachers are involved.

## The four roles

| Role | On GitHub | Can |
| --- | --- | --- |
| **Teacher** | Organization **owner**, on the classroom's teacher team | Everything, including organization and classroom settings |
| **Head TA** | Organization member, on the head-TA team | Write the `classroom50` repository; manage the classroom; not an owner |
| **TA** | Organization member, on the TA team | Read the `classroom50` repository; view submissions and scores |
| **Student** | Organization member, on the classroom team | Accept and submit assignments |

A role is membership in one of the classroom's `secret` GitHub teams; there is
no separate role database, so staff you add show up as GitHub team
invitations. For the underlying model, see
[Roles are GitHub organization roles and teams](How-Classroom-50-Works#roles-are-github-organization-roles-and-teams).

The head TA role covers a trusted grader who manages the classroom (edits
assignments, runs collection) without holding organization-owner power. TAs
who only grade need the read-only TA role.

## Adding staff

Adding a staff member sends them a GitHub invitation, which they must accept
before the role takes effect. The web app and the CLI manage the same teams,
so staff added in one show up in the other.

**Web app:** open the classroom, click **Settings**, and use the
**Staff and roles** section. Enter a GitHub username, pick a role, and click
**Add**. The section also links each role's GitHub team and shows pending
invitations.

**CLI:**

```sh
gh teacher staff add cs50-fall-2026 cs-principles octocat --role ta
```

`--role` accepts `teacher`, `hta`, or `ta` and defaults to `teacher`. See
[`gh teacher staff`](gh-teacher#staff) for details. Removing a staff member
(`gh teacher staff remove`, or the web app's staff list) takes away the role
but doesn't touch their organization membership.

Staff can also be invited by email, from the web app only. On the classroom's
**Roster** page, use **Upload** with a file of addresses (one per line, or a
roster CSV with an `email` column), then set each person's role in the preview's
**Role** column, or supply a `role` column in the CSV. Choosing **Teacher**
requires a separate confirmation, because the teacher role makes that person an
organization owner. As with a student, the address goes onto the roster as a
pending row and is matched to their GitHub account when they accept. See
[Invitations by email](How-Classroom-50-Works#invitations-by-email).

`gh teacher roster invite` has no `--role` flag: it sends student invitations
only, so a mistyped address can never be handed organization ownership. From the
CLI, grant a role with `gh teacher staff add` once you know the person's
username. If you only have their address, invite them by email as a student
first, then grant the role once they've joined; they stay enrolled as a student
until you unenroll them.

> [!NOTE]
> Granting the **teacher** role makes that person an organization owner, with
> full control over the whole organization, not only the classroom. Grant it
> to co-teachers you'd trust with the organization itself; give everyone else
> head TA or TA.

## What TAs can and can't see

TAs and head TAs see the same classroom content as teachers: the roster,
assignments, submissions, and scores. The differences:

- **Organization and classroom settings are teacher-only.** Only organization
  owners can run setup, change organization policy, or write scores from the
  web app.
- **Pending invitations are owner-only.** GitHub lets only organization
  owners read pending invitations, so a TA's roster view can't show who has
  been invited but hasn't joined yet; the app notes this instead of showing
  an incomplete list.
- **The student list comes from the roster file.** The classroom's GitHub
  teams are secret, so a TA or head TA who isn't on the student team can't
  read its membership. Their roster, submissions, and student counts use
  `roster.csv` as of its last sync instead, and the page says so. A student
  enrolled since then appears after a teacher opens the roster (which syncs
  the file). Organization owners always see live membership.
- **Collecting and regrading are for teachers and head TAs.** Both run
  workflows in the classroom's config repository, which needs write access.
  Head TAs have it and can use **Collect now** to refresh submission data
  themselves. TAs have read-only access, so they see a **Refresh** button
  that re-reads the latest collected data and live repository status, plus a
  note on who to ask for a new collection.
- **Access to student repositories arrives with collection.** The
  score-collection workflow grants the staff teams read access to student
  repositories as it runs. A freshly accepted repository has no staff access
  yet, which is expected; it appears after the next collection run. Until
  then that student shows as **Not visible** for staff (they may or
  may not have accepted), while the teacher sees the repository.

With read access, TAs can open each student's work and leave reviews on the
[feedback pull request](Autograding-Basics#feedback-pull-requests). There is no
automatic reviewer assignment yet; TAs pick up repositories from the
submissions page (**Open all Feedback PRs** steps through them).

Because TAs and head TAs are ordinary organization members, graders don't
need owner rights to do their work. If your institution's privacy rules (such
as FERPA) require limiting who holds administrative access to student data,
keep the teacher role small and use head TA and TA for everyone else.

## Staff who are also students (dual roles)

Classroom 50 doesn't stop one account from holding a staff role and a student
enrollment in the same classroom. The common case is a teacher or TA who adds
themselves to the roster to preview the student experience. The classroom's
GitHub teams are the authority for enrollment and role; the `role` column in
`roster.csv` is only a display snapshot. With that in mind:

- **Roster view** shows all of the account's role badges, and the account
  appears under each role's filter.
- **In-app access** follows the highest role (`teacher > hta > ta >
  student`), so a teacher-who-is-also-a-student keeps teacher-level access.
  "View as" only changes the preview locally; it never grants access.
- **`roster list` and the `role` column** record the single highest role. The web
  app's automatic sync can rewrite the column shortly after `roster add`; that's
  the snapshot updating, not a change to enrollment.
- **Submissions** list any account with a student enrollment as a student. A
  pure-staff account appears in submissions only once it has accepted an
  assignment repository.
- **Unenroll** drops only the student side (the roster row and student-team
  membership); the staff role stays.

One caveat when testing as yourself: an organization owner keeps `admin` on
their own assignment repository (GitHub won't let an owner reduce their own
access), so it won't match a real student's `write`-level setup. For the
exact student experience, use a separate GitHub account enrolled as a
student. See
[Testing an assignment as a student](FAQ#as-a-teacher-can-i-test-an-assignment-as-a-student).

## One organization or several?

A single organization can hold many classrooms, so the question is about
people, not courses:

- **One organization** works well for a stable teaching team running one
  course across terms or sections: create a classroom per term or section and
  keep the same staff.
- **Separate organizations per teacher** fit school-wide adoption, where many
  teachers run unrelated classes; each teacher manages their own organization
  and its staff.
- **One organization per academic year** keeps a very large course tidy:
  hundreds of assignment repositories per year stay grouped, and old years
  can be archived wholesale.

Each organization needs its own one-time setup (plan upgrade, setup run, and
service token).

## Further reading

- [How Classroom 50 Works](How-Classroom-50-Works) for the permission model
  behind roles.
- [`gh teacher staff`](gh-teacher#staff) for command syntax.
- [Course lifecycle and end of term](Course-Lifecycle-and-End-of-Term) for
  end-of-term staff housekeeping.
