# Assignment Templates

An assignment's starter code is a normal GitHub repository with the **Template
repository** flag turned on. `gh student accept` creates a fresh copy for
each student (private, unless the assignment's **Repository visibility** is
public); `gh student submit` re-fetches a couple of files from it on
every submission. This page describes the expected layout.

> [!NOTE]
> **Templates are optional.** An assignment without a template gives each
> student an initialized repository with a README and the autograding setup —
> good for write-from-scratch or short-answer work. See
> [Repository shapes](#repository-shapes) for every option. The rest of this
> page applies to assignments that ship a template.

A worked example lives at
[`templates/example-assignment/`](https://github.com/foundation50/classroom50/tree/main/templates/example-assignment).

## Repository shapes

What accept creates is a per-assignment choice. All five shapes:

| Shape | Set with | Students get | Autogrades? |
| --- | --- | --- | --- |
| **Template** | `--template` (or the web form's template field) | A copy of the template plus the control files | Yes |
| **Template, own CI** | `no_autograder: true` (web: **Do not use the built-in autograder**) | A copy of the template with no autograding workflow; the template's own CI runs instead | No scores, but collection still records who submitted |
| **Template-less with a README** | Omit `--template` (web: **No template**, **Add a README** on) | An initialized repository: README plus the control files | Yes |
| **Template-less, no README** | `init_shim: true` (web: **No template**, **Add a README** off, built-in autograder on) | An initialized repository carrying only the control files | Yes |
| **Empty repository** | `--empty-repo` (web: **No template**, **Add a README** off, **Do not use the built-in autograder**) | A completely bare repository: no commits, no control files, and no feedback pull request, ever | Never |

Two rules apply across all of them:

- **Shape changes affect future accepts only.** Every shape can be changed
  after creation, but repositories students already accepted keep their
  original setup; nothing is retrofitted. (**Assignment type** — individual
  or group — is the exception: it stays locked once set.)
- **A template brings only its default branch** unless the assignment turns
  on **Include all branches** (`include_all_branches: true`), which copies
  every branch into each generated repository. Template-only; it has no
  effect on the other shapes. A specific source branch can't be chosen:
  GitHub's create-from-template API has no branch parameter, so a `@branch`
  suffix on the CLI's `--template` is ignored with a warning. To start
  students from a different branch, change the template repository's default
  branch.

For the flag-level details (mutual exclusions and `assignments.json` fields),
see [`gh teacher assignment add`](gh-teacher#assignment-add).

## Structure

```
.
├── README.md              # student-facing assignment description
├── .gitignore             # optional, re-fetched on every gh student submit
├── .github/               # optional, re-fetched on every gh student submit
│   └── workflows/         # CI for student copies (NOT autograde — see below)
├── pull_request_template.md  # optional, can drive the Feedback PR body
└── <starter code>         # whatever files the assignment needs
```

- **`README.md`** — what the student sees on their copy. Describe the assignment,
  expected output, and evaluation criteria.
- **`.gitignore`** (optional) — re-fetched from the template on every submit, so
  updating it once propagates to every student's next submission.
- **`.github/`** (optional) — same re-fetch behavior. Put non-autograde
  workflows here (linters, formatters, dependabot).
- **`pull_request_template.md`** (optional) — GitHub's native pull request
  template (`.github/pull_request_template.md`, root, or `docs/`). If the
  assignment enables **Use the template's pull request template as the Feedback
  PR body**, Classroom 50 uses this file's contents as each student's Feedback
  PR body instead of the built-in text. See
  [Autograders](Autograding-Basics#feedback-pull-requests).
- **Starter code** — any files the student starts from, from a single file to a
  full project.

> [!WARNING]
> **Never put `.github/workflows/autograde.yaml` in the template.** The autograde
> shim is written by `gh student accept` (it's embedded in `gh-student`) and
> never changes after accept. A copy in the template would be clobbered by
> submit's `.github/` re-fetch and double-grade or break grading. Autograding
> logic lives in your `classroom50` repository, not the template — see [Autograding Basics](Autograding-Basics).

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

## Template visibility

A **public** template always works. A **private** template works only if it's
**inside your organization** — registering the assignment grants the
classroom's team read access to it. A private template **outside** your
organization is rejected (students can't be granted access, so accept would
404). Enterprise Cloud's "internal" visibility also works.

> [!NOTE]
> The team read grant happens when you **create** the assignment. If you
> create the assignment first and add a private template later by editing it,
> the grant isn't re-applied and students may get a 404 on accept.

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
    (the default for new assignments). This runs on the web accept path; a
    student who accepts with `gh student accept` gets the repository without
    them.
  - **Repository features** (Issues, Wiki, Projects, Pull requests) follow the
    assignment's Repository features settings — by default each **inherits the
    template's current setting**; you can force any of them on or off per
    assignment. This applies on both the web and CLI accept paths. Repos
    accepted before a change can be updated with the submissions page's
    **Update repository features** action.

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
