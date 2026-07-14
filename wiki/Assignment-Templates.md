# Assignment Templates

An assignment's starter code in classroom50 is a normal GitHub repo with the "Template repository" flag turned on. `gh student accept` creates a fresh private copy of the template for each student; `gh student submit` fetches a couple of files back from it on every submit. This page describes the expected layout.

> **Templates are optional.** An instructor can register an assignment without a template (`gh teacher assignment add` with no `--template`). Students then get an *empty* private repo containing only the autograder workflow shim — useful for write-from-scratch or short-answer work. For repos with *nothing at all* in them — no shim, no metadata, no autograding — pass `--empty-repo` instead (see the [teacher CLI guide](gh-teacher)). The rest of this page applies only to assignments that *do* ship a template.

A worked example lives at [`templates/example-assignment/`](https://github.com/foundation50/classroom50/tree/main/templates/example-assignment).

## Required structure

```
.
├── README.md              # student-facing description of the assignment
├── .gitignore             # optional, re-fetched on every gh student submit
├── .github/               # optional, re-fetched on every gh student submit
│   └── workflows/         # CI for student copies (NOT autograde — see below)
└── <starter code>         # whatever files the assignment needs
```

Notes on each piece:

- **`README.md`** — what the student sees when they land on their copy of the repo. Describe the assignment, expected output, evaluation criteria, etc.
- **`.gitignore`** (optional) — if present, `gh student submit` re-fetches this from the template at submit time. Update it once on the template and every student's next submission picks it up.
- **`.github/`** (optional) — same re-fetch behavior. **The autograde workflow does not live in the template.** `gh student accept` writes a universal shim at `.github/workflows/autograde.yaml` (embedded in `gh-student`, with the org substituted in); the shim never changes after accept. The shim's only job is to `uses:` the reusable autograde-runner workflow in your `classroom50` config repo. That workflow fetches `runner.py` (the runner-side bootstrap) which resolves and execs the per-assignment or classroom-default `autograder.py` entrypoint. Put non-autograde workflows in this template directory (linters, formatters, dependabot, etc.); leave autograding to your config repo (`<classroom>/autograder.py` for the classroom default — set via `gh teacher autograder set-default`, optional per-assignment `autograder.py` overrides under `<classroom>/autograders/<slug>/`, and the `runtime:` block on each `assignments.json` entry). **Never include `.github/workflows/autograde.yaml` in the template** — submit's `.github/` re-fetch would clobber the accept-time shim and double-grade or break grading entirely.
- **Starter code** — any files the student should start from. The template can be a single file or a full project skeleton.

## Setting it up

1. Create a normal repo in your classroom org with the structure above. Register it with `gh teacher assignment add ... --template <owner>/<repo>` — the **assignment slug** you choose there (e.g. `hello`, `dna`) is what students pass as `<assignment>` to `gh student accept`, and it does not have to match the template repo's name.
2. **Set the template's visibility.** A **public** template always works. A **private** template works if it lives **in your teaching org** — `gh teacher assignment add` grants the classroom's team read access to it, so students can create from it under the "No permission" org baseline. A private template **outside** your org is rejected by `gh teacher assignment add` (students can't be granted access, so `gh student accept` would 404). The GitHub Enterprise Cloud "internal" visibility also works, on plans that have it.
3. **Mark it as a template** in `Settings → General → Template repository`.

That's it. Students can now run:

```sh
gh student accept <org> <classroom> <assignment-slug>
```

…which will create `<org>/<classroom>-<assignment-slug>-<username>` from your template, lowercased.

## Why these specific files re-sync

`gh student submit` re-fetches `.gitignore` and `.github/` from the template (recorded in `.classroom50.yaml`) on every submission. Starter code and the README are **not** re-fetched — they belong to the student once accepted. The autograde workflow shim is set once at accept time and never refreshed; runtime, dependency, and grading-logic changes propagate via the runner workflow and `assignments.json` on the teacher's side, both fetched fresh by the runner on every submission.
