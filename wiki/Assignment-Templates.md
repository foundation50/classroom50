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

   The assignment **slug** (e.g. `hello`) is what students pass to
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

## Why `.gitignore` and `.github/` re-sync

On every submission, `gh student submit` re-fetches `.gitignore` and `.github/`
from the template (recorded in `.classroom50.yaml`). Starter code and the README
are **not** re-fetched — they belong to the student once accepted. Runtime,
dependency, and grading-logic changes propagate separately, through the runner
workflow and `assignments.json`, which the runner fetches fresh on every
submission.
