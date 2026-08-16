# Managing Actions cost

Autograding runs in GitHub Actions in your organization, and GitHub bills the
organization for those minutes, never the students. This page is the cost
playbook: what grading spends, the levers that reduce it, and what happens
when minutes run out.

## What grading costs

- **The organization pays.** GitHub Actions minutes are budgeted per
  organization. Student repositories are private, so their workflow runs
  count against the organization's included minutes.
- **The Team plan includes 3,000 minutes per month.** Usage past that is
  billed, up to the organization's Actions spending limit.
- **Each run bills at least a minute.** GitHub rounds every job up to the
  next minute, so even a near-empty grading run (a vacuous pass with no
  tests) bills about a minute.
- **In the default submission type, every push grades.** An assignment in
  `every-push` mode grades each push to the default branch: five pushes in
  ten minutes are five graded runs. Multiply by class size to estimate an
  assignment's cost.

## The levers, by impact

1. **Grade on submit only.** Set the assignment's **Submission type** to
   **A tagged commit** (`--submission-mode tag`). Regular pushes then run
   nothing at all; grading happens only when a student submits. This is the
   biggest saver for large classrooms. See
   [Which commits grade](Autograding-Basics#which-commits-grade).
2. **Skip the built-in autograder where you don't need it.** For assignments
   graded by hand or by your own CI, pick **Do not use the built-in
   autograder**; accept then installs no grading workflow at all. An
   assignment with **no tests** still runs a lightweight workflow to tag
   submissions, which uses far fewer minutes than grading.
3. **Pause autograding over a break.** Per assignment, or organization-wide;
   the next section covers both and how **Regrade all** behaves afterward.
4. **Use self-hosted runners.** Grading on your own hardware costs no GitHub
   Actions minutes. Set the assignment's `runs-on` to your runner labels;
   see [The `runtime` block](Advanced-Autograding#the-runtime-block).
5. **Ask GitHub Education.** Verified educators who need more minutes can
   contact the GitHub Education team, which can often help with additional
   credits.

## Turning autograding off or pausing it

Beyond choosing [when commits grade](Autograding-Basics#which-commits-grade),
you can turn the pipeline off entirely:

- **Per assignment, at creation** — pick **Do not use the built-in
  autograder** (`no_autograder` in assignments.json). Accept installs no
  autograding workflow at all; a templated assignment's own CI workflows run
  instead, and score collection skips the assignment. Changeable later, but
  only affects repositories accepted from then on (existing ones keep their
  setup). See [`gh teacher` reference](gh-teacher#assignment-add).
- **Per assignment, temporarily** — **Pause autograding** in the submissions
  page's **Actions** menu disables the `autograde.yaml` workflow in every
  student repository through GitHub's workflow-disable API. No files change, students'
  other workflows keep running, and **Resume autograding** re-enables it.
  Available on individual assignments using the built-in autograder (a single
  repository can also be paused from its row). A student with admin on their own
  repository can technically re-enable the workflow — a known limitation.
- **Org-wide** — the organization settings' **Pause autograding for all
  student repositories** toggle narrows the organization's GitHub Actions policy to the config
  repository. **This stops all workflows in student repositories**, including any
  course CI — prefer the per-assignment pause unless that's what you want.

**Catching up after a pause.** Work pushed while autograding was off is not
graded retroactively. After resuming, run **Regrade all** from the
submissions page's **Actions** menu: it triggers one grading run per
repository instead of one per missed push. Each repository's latest
submission is re-run, and a never-graded repository is graded at its current
state. See
[Grading a specific commit](Autograding-Basics#grading-a-specific-commit)
for the details of what a regrade re-runs.

## The spending cap

Setup creates a **$0 GitHub Actions spending cap**, but only when the
organization has none yet, so a runaway workflow can't run up a bill. A cap
you set yourself is never modified. When the included minutes are exhausted,
workflow runs are blocked until the next billing month or until you raise
the limit in the organization's billing settings.

On enterprise-managed organizations, the cap often isn't readable and setup
shows an advisory warning; see
[Couldn't verify the Actions spending cap](Troubleshooting#couldnt-verify-the-actions-spending-cap).

## Further reading

- [Which commits grade](Autograding-Basics#which-commits-grade) for the full
  submission-type semantics.
- [Students can re-enable paused workflows](Known-Limitations#templates-and-student-repositories)
  in Known limitations.
