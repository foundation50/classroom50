# Assignment Templates

An assignment's starter code is a normal GitHub repository with the **Template
repository** flag turned on. `gh student accept` creates a fresh private copy
for each student; `gh student submit` re-fetches a couple of files from it on
every submission. This page describes the expected layout.

> [!NOTE]
> **Templates are optional.** Register an assignment without `--template` and
> students get an *empty* repo containing only the autograder shim — good for
> write-from-scratch or short-answer work. For repos with *nothing at all* (no
> shim, no autograding), use `--empty-repo` instead. The rest of this page
> applies only to assignments that ship a template.

A worked example lives at
[`templates/example-assignment/`](https://github.com/foundation50/classroom50/tree/main/templates/example-assignment).

## Structure

```
.
├── README.md              # student-facing assignment description
├── .gitignore             # optional, re-fetched on every gh student submit
├── .github/               # optional, re-fetched on every gh student submit
│   └── workflows/         # CI for student copies (NOT autograde — see below)
└── <starter code>         # whatever files the assignment needs
```

- **`README.md`** — what the student sees on their copy. Describe the assignment,
  expected output, and evaluation criteria.
- **`.gitignore`** (optional) — re-fetched from the template on every submit, so
  updating it once propagates to every student's next submission.
- **`.github/`** (optional) — same re-fetch behavior. Put non-autograde
  workflows here (linters, formatters, dependabot).
- **Starter code** — any files the student starts from, from a single file to a
  full project.

> [!WARNING]
> **Never put `.github/workflows/autograde.yaml` in the template.** The autograde
> shim is written by `gh student accept` (it's embedded in `gh-student`) and
> never changes after accept. A copy in the template would be clobbered by
> submit's `.github/` re-fetch and double-grade or break grading. Autograding
> logic lives in your config repo, not the template — see [Autograders](Autograders).

## Set it up

1. **Create a repository** with the structure above, then register it:

   ```sh
   gh teacher assignment add <org> <classroom> <slug> --name "…" --template <owner>/<repo>
   ```

   The assignment **slug** (e.g., `hello`) is what students pass to
   `gh student accept`; it needn't match the repository name.

2. **Set visibility** (see below).
3. **Mark it as a template** in **Settings → General → Template repository**.

Students can then run:

```sh
gh student accept <org> <classroom> <slug>
```

…which creates `<org>/<classroom>-<slug>-<username>` (lowercased) from your
template.

> [!NOTE]
> **Template visibility.** A **public** template always works. A **private**
> template works only if it's **inside your organization** — `gh teacher
> assignment add` grants the classroom team read access to it. A private
> template **outside** your organization is rejected (students can't be granted
> access, so accept would 404). Enterprise Cloud's "internal" visibility also
> works.

## Template requirements and gotchas

- **The template must have at least one commit.** A freshly created, commitless
  repository is rejected when you register the assignment — GitHub can't
  generate a copy of nothing. (A brand-new template with real commits can
  briefly be misreported by GitHub right after a push; if a just-pushed
  template is rejected, wait a minute and retry.)
- **Forked templates can trip other orgs' OAuth restrictions.** With a
  template that is a **fork of a repository in a different organization**,
  GitHub evaluates OAuth-app access restrictions against the fork's *parent*
  organization too — accept can fail with an HTTP 403 naming OAuth App access
  restrictions even though your own org has approved Classroom 50. Either have
  the upstream organization approve Classroom 50 as well, or (simpler) copy
  the content into a fresh, fork-free repository in your organization and flag
  that as the template.
- **Only the default branch is copied** unless the assignment enables
  **Include all branches** (`include_all_branches`), which passes every branch
  through to each generated student repo.
- **GitHub's template-generate copies files, not settings.** Classroom 50
  compensates at accept time:
  - The **About description and topics** are copied when the assignment's
    **Copy About from template** / **Copy topics from template** toggles are on
    (the default).
  - **Repository features** (Issues, Wiki, Projects, Pull requests) follow the
    assignment's Repository features settings — by default each **inherits the
    template's current setting**; you can force any of them on or off per
    assignment. Repos accepted before a change can be reconciled with the
    submissions page's **Update repository features** action.

## Reusing one template across assignments

The same repository can be the template for any number of assignments — each
accept generates an independent copy of the template **as it exists at that
moment**. That makes an evolving course repository workable: register
assignment A, keep committing, register assignment B later from the same repo.
Two things to keep in mind:

- Students who accept the *same* assignment at different times can start from
  different template states — late accepters get the newer content. Freeze the
  template (or cut a dedicated template repo per assignment) if identical
  starting points matter.
- `.gitignore` and `.github/` are re-fetched from the template on every
  submit (see below), so changes to those files propagate to **every**
  assignment that shares the template.

## Why `.gitignore` and `.github/` re-sync

On every submission, `gh student submit` re-fetches `.gitignore` and `.github/`
from the template (recorded in `.classroom50.yaml`). Starter code and the README
are **not** re-fetched — they belong to the student once accepted. Runtime,
dependency, and grading-logic changes propagate separately, through the runner
workflow and `assignments.json`, which the runner fetches fresh on every
submission.
