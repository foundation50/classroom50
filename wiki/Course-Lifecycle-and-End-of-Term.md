# Course lifecycle and end of term

The moments in a course that aren't covered by day-to-day assignment work:
staging an assignment before release, ending one at the due date, updating
starter code mid-flight, and cleaning up when the term is over.

## Staging an assignment before release

Assignments are hidden from the student assignments page by default; until an
assignment is listed, students can accept it only through its invite link.
Two controls build on that:

- **Release date** lists the assignment for everyone once the date passes.
  It controls listing only, not access: a student with the invite link can
  still accept early, and students who already accepted always see the
  assignment.
- **Lock assignment** (in the submissions page's **Actions** menu) blocks
  access entirely: students can't accept it, and for a private template the
  student team's read access is removed. **Unlock assignment** reopens it and
  restores template access. Use it to prepare an assignment (or its capstone
  solution review) without any chance of early accepts.

To try the assignment before students do, accept it yourself from a separate
student account, or add yourself to the roster; see
[Testing an assignment as a student](FAQ#as-a-teacher-can-i-test-an-assignment-as-a-student).

## Due dates mark late; closing enforces

A due date is a label: submissions after it are marked **late**, and nothing
is blocked. Autograding also keeps running after the due date, so a late
submission still gets a score (marked late). When you want an actual cutoff:

- **Close submission** (in the **Actions** menu) blocks new accepts and sets
  every student's repository to read-only. Work is preserved, and students
  keep read access. **Reopen submission** restores write access, useful when
  a project continues in a follow-up course.
- **Update student repo access** in the same menu gives finer control, such
  as dropping everyone to read-only while you grade and restoring write
  afterward.

Closing doesn't grade anything by itself; collect scores first if you want
the final state in your export (see
[Collect submissions](Web-Teacher-Guide#collect-submissions)).

## Updating starter code after students accept

A student repository is a copy of the template as it existed at accept time,
not a fork; there is no upstream link to pull new template commits through.
What that means in practice:

- **Template edits reach future accepts only.** Students who already
  accepted keep their original starter code. Late accepters get the newer
  content, so freeze the template if identical starting points matter.
- **Two files do propagate:** `.gitignore` and `.github/` are re-fetched
  from the template on every `gh student submit`. Fixing a broken ignore
  rule or a CI workflow there reaches every student's next submission. See
  [Why `.gitignore` and `.github/` re-sync](Assignment-Templates#why-gitignore-and-github-re-sync).
- **Grading changes propagate on their own.** Autograder logic and
  declarative tests live in your `classroom50` repository, not in student
  repositories, so you can fix tests any time and regrade.
- **For everything else, reach repositories directly.** Announce the change
  and let students apply it, or script it: clone each repository
  (`gh teacher download`) and push a fix or open a pull request per student.

## End of term

In rough order:

1. **Close or lock the assignments.** **Close submission** per assignment
   freezes student work (read-only, no new accepts).
2. **Collect and export.** Run a final collection, then **Download scores
   (CSV)**. For the work itself, **Download all submissions** bundles the
   latest submissions into a zip, or `gh teacher download` clones every
   repository and writes a `scores.csv`. See
   [Download submissions](CLI-Teacher-Guide#10-download-submissions).
3. **Archive the classroom.**

   ```sh
   gh teacher classroom archive cs50-fall-2026 cs-principles
   ```

   Archiving hides the classroom from the default list, blocks new accepts
   (after the next publish run), and refuses new assignments; student
   repositories are untouched, and `unarchive` reverses it. See
   [`gh teacher classroom archive`](gh-teacher#classroom-archive--unarchive).
4. **Optionally archive the student repositories on GitHub.** Archiving a
   repository makes it read-only for everyone while preserving it. Classroom
   50 has no bulk action for this yet, but the GitHub CLI handles it. List
   the candidates first:

   ```sh
   gh repo list YOUR-ORGANIZATION --visibility private --no-archived --limit 1000 \
     --json name,isTemplate \
     -q '.[] | select(.isTemplate == false) | .name' \
     | grep -vE '^(classroom50|KEEP-THIS-REPO)$'
   ```

   Replace `YOUR-ORGANIZATION` with your organization and extend the `grep`
   pattern with any repository to keep (it already excludes the `classroom50`
   repository; templates are excluded by the filter). When the list looks
   right, append the archiving step:

   ```sh
   ... | xargs -I {} gh repo archive YOUR-ORGANIZATION/{} --yes
   ```

5. **Tidy membership if you need to.** Unenrolling a student removes them
   from the roster and classroom team but not from the organization, and
   never deletes repositories; removing them from the organization revokes
   access but still deletes nothing. See
   [Enroll, unenroll, and remove are separate](How-Classroom-50-Works#lifecycle-enroll-unenroll-and-remove-are-separate).

## Reusing assignments next term

Create the new term's classroom, then copy assignments into it:

```sh
gh teacher assignment reuse cs50-fall-2026 hello --from cs-principles --to cs-principles-spring
```

Every field is copied (template, tests, runtime, due date included; update
the due date after copying). Student repositories and scores are not copied,
and the target classroom's team is re-granted read on a private in-org
template. The web app offers the same action on an assignment. See
[`gh teacher assignment reuse`](gh-teacher#assignment-reuse).

## Resetting an organization (destructive)

**Tear down organization** (web app: organization settings, Danger zone; CLI:
`gh teacher teardown`) deletes every repository Classroom 50 manages in the
organization, after you type an explicit confirmation. It exists for
development resets and complete decommissioning.

> [!WARNING]
> Teardown deletes student work permanently. Export scores and download
> submissions first. It requires the `delete_repo` scope, which the CLI only
> requests when you opt in (`gh teacher login -s delete_repo`).

## Further reading

- [Can I turn autograding off, or reduce Actions usage?](FAQ#can-i-turn-autograding-off-or-reduce-actions-usage)
  for pausing grading over a break.
- [Which commits grade](Autograders#which-commits-grade) for submission modes
  and milestone tags.
