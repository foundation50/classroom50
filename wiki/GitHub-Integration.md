# GitHub Integration

Every place Classroom 50 touches GitHub: what you do manually, what the CLI
handles, and the complete list of REST API calls the tooling makes.

## Manual steps

### 1. Create the organization (one-time, on github.com)

The CLI never creates the organization. Before running any CLI command:

1. **Create the organization** at <https://github.com/account/organizations/new>.
   Free orgs work for public templates; Team or Enterprise Cloud is required for
   Pages from the private `classroom50` config repo.
2. **Flag your template repositories** under **Settings → General → Template
   repository**.

> [!NOTE]
> **Template visibility.** Public works on any plan. A private template works
> only if it's **inside your org** (`gh teacher assignment add` grants the
> classroom team read). A private template **outside** your org is rejected.
> Enterprise Cloud's "internal" visibility also works.

`gh teacher init` locks organization member privileges to least-privilege
automatically. After it runs, a member can only create a **private** repository
(so `gh student accept` works) and publish a **public** Pages site (so the config
repo's `assignments.json` stays reachable).

<details>
<summary>Why student repos can safely leave the student as admin</summary>

The lockdown denies the dangerous org-wide powers (private Pages, repo
delete/transfer, visibility change, issue deletion, team creation, dependency
insights, member-invited outside collaborators). Public-repo creation is the one
exception by plan: it's locked off only on Enterprise Cloud, because Team/Free
couples public and private creation and the student flow needs private creation.
So it's safe for `gh student accept` to leave a student as **admin** of their own
repo — a group founder needs admin to add teammates, and the org locks defang the
rest.

</details>

**Four member-privilege settings have no API** — apply them once at
`https://github.com/organizations/<org>/settings/member_privileges` (`init`
prints this reminder):

- [ ] **App access requests** → "Members only" (or disable).
- [ ] **Uncheck** "Allow repository admins to install GitHub Apps for their
      repositories".
- [ ] **Projects base permissions** → "No access".
- [ ] **Uncheck** "Allow repository administrators to rename branches protected
      by organization rules".

### 2. Teacher authentication

Run once per machine, or after a token rotation:

```sh
gh teacher login
```

This runs `gh auth login -s admin:org -s read:org -s repo -s workflow` and opens
a browser. It's the unified Classroom 50 scope set — `gh teacher login` and
`gh student login` request the same scopes, so authenticating one CLI covers the
other. (`delete_repo` is not included — opt in with `gh teacher login -s
delete_repo` for teardown.)

| Scope | Required for |
|---|---|
| `admin:org` | Org invitations, reading and removing memberships (implies `read:org`). |
| `read:org` | Checking org membership. |
| `repo` | Repo creation, contents writes, collaborators. |
| `workflow` | Committing the config repo's workflow files during `init` (GitHub 404s the write without it). |

### 3. Student authentication

```sh
gh student login
```

Same device flow and the **same scope set**, so a student who authenticated a
teacher CLI (or vice versa) needs no re-auth. A student exercises `read:org`
(accept org membership), `repo` (generate repos, collaborators), and `workflow`
(commit the autograde shim at accept).

### 4. Fine-grained PAT for score collection

`gh teacher init` uploads a PAT into the `CLASSROOM50_SERVICE_TOKEN` secret; the
`collect-scores.yaml` workflow uses it to read student repos across the org.

Create it at <https://github.com/settings/personal-access-tokens/new> from your
own account (scope it tightly to the org):

| Setting | Value |
|---|---|
| Resource owner | Your teaching org. |
| Repository access | **All repositories** ("Only select repositories" misses on-demand student repos). |
| Contents | **Read and write** (read: collect; write: regrade pushes `submit/*` tags). |
| Actions | **Read and write** (regrade re-runs autograde). |
| Administration | **Read and write** (grant staff teams read on student repos/templates). |
| Metadata | **Read** (auto-included; lets collection read group-repo collaborators). |
| Organization → **Members** | **Read** (list the classroom team; separate section, shown only once the org is the resource owner). |
| Expiry | Up to 1 year; set a rotation reminder. |

> [!IMPORTANT]
> **Members: Read** is under **Organization permissions**, not Repository
> permissions, and isn't implied by any repository scope. A Contents-only token
> passes a Contents check but fails the first call collection makes.

> [!NOTE]
> **Group assignments need no extra scope.** Collection reads a group repo's
> collaborators via `Metadata: read` (auto-included) and credits members on the
> classroom team. If the read fails, the owner is still scored and a warning is
> logged.

Supply the token via the environment variable (never a flag — command-line PATs
leak via shell history):

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init <org>
```

It's encrypted with libsodium before upload and never written to disk. Rotate
with `gh teacher rotate-service-token <org>`.

### 5. GitHub Pages

`init` enables Pages and sets visibility to public. **The first deployment needs
the `publish-pages.yaml` workflow to run once** — push to the default branch or
trigger it from the Actions tab. The CLI prints the Pages URL
(`https://<org>.github.io/classroom50/`) after `init`.

If `init` warns that the org workflow-token policy or reusable-workflow access is
too restrictive, apply them yourself:

```sh
gh api -X PUT /orgs/<org>/actions/permissions/workflow \
  -f default_workflow_permissions=write -f can_approve_pull_request_reviews=false
gh api -X PUT /repos/<org>/classroom50/actions/permissions/access \
  -f access_level=organization
```

### 6. Score collection

The `collect-scores.yaml` workflow runs nightly (`17 4 * * *` UTC). Trigger it
manually:

```sh
gh workflow run collect-scores.yaml --repo <org>/classroom50
gh workflow run collect-scores.yaml --repo <org>/classroom50 -f classroom=<short-name>
```

### 7. Verify the service token

After `init`/`rotate`, or when collect/regrade returns 401/403, run the
read-only probe:

```sh
gh workflow run probe-token.yaml --repo <org>/classroom50
```

A green run confirms every scope; a red run's log names the missing scope(s).
Side-effect free.

---

## REST API reference

The CLIs call GitHub through [`go-gh`](https://github.com/cli/go-gh);
`collect_scores.py` uses `urllib` with a bearer token.

### `gh teacher` CLI

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/user` | Whoami. |
| GET | `/orgs/{org}` | Check org plan. |
| PATCH | `/orgs/{org}` | Lock down member privileges at `init`. |
| GET / PUT | `/orgs/{org}/actions/permissions` | Read/enable org Actions. |
| POST | `/orgs/{org}/repos` | Create the `classroom50` config repo. |
| GET | `/repos/{owner}/{repo}` | Check the config repo / validate a template. |
| POST / PUT | `/repos/{owner}/{repo}/pages` | Enable Pages and set it public. |
| PUT | `/repos/{owner}/{repo}/branches/{branch}/protection` | Protect the config repo branch. |
| GET / PUT | `/repos/{owner}/{repo}/actions/permissions` | Read/re-enable Actions on the config repo. |
| GET / PUT | `/repos/{owner}/{repo}/actions/permissions/workflow` | Read/set `GITHUB_TOKEN` permissions. |
| PUT | `/repos/{owner}/{repo}/actions/permissions/access` | Allow same-org reusable workflows. |
| GET / PUT | `/repos/{owner}/{repo}/actions/secrets/...` | Upload the encrypted service PAT. |
| GET / POST / PATCH | `/repos/{owner}/{repo}/git/{refs,commits,blobs,trees}` | Tree-commit config files (with rebase retry). |
| GET | `/users/{username}` | Resolve a login to its numeric ID. |
| POST | `/orgs/{org}/invitations` | Send an org invitation. |
| GET / DELETE | `/orgs/{org}/memberships/{username}` | Check / remove org membership. |
| PUT / DELETE | `/repos/{owner}/{repo}/collaborators/{username}` | Add / remove a repo collaborator. |
| DELETE | `/repos/{owner}/{repo}` | Delete a repo (`teardown`; needs `delete_repo`). |
| GET | `/repos/{owner}/{repo}/releases` + `/releases/assets/{id}` | Collect `submit/*` releases and `result.json`. |
| GET | `/orgs/{org}/repos` | Page org repos for `--by-pattern` download. |
| GET | `/classrooms`, `/classrooms/{id}`, `/classrooms/{id}/assignments`, `/assignments/{id}` | GitHub Classroom discovery (`migrate`). |
| POST / PATCH | `/repos/{owner}/{repo}/generate`, `/repos/{owner}/{repo}` | Copy source starter repos as templates (`migrate`). |

### `gh student` CLI

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/user` | Whoami / git identity. |
| GET / PATCH | `/user/memberships/orgs/{org}` | Check / accept a pending org invite. |
| POST | `/repos/{template_owner}/{template_repo}/generate` | Generate the repo from a template. |
| POST | `/orgs/{org}/repos` | Create an empty repo (template-less). |
| GET / PATCH | `/repos/{owner}/{repo}` | Recover from "already exists"; disable issues/projects/wiki. |
| PUT | `/repos/{owner}/{repo}/collaborators/{username}` | Set the founder role: `push` (individual) or `admin` (group); also backs `gh student invite`. |
| GET / POST / PATCH | `/repos/{owner}/{repo}/git/{refs,commits,blobs,trees}` + `/branches/{branch}` | Commit the setup files. |
| GET | `/repos/{owner}/{repo}/contents/{path}` | Fetch `.gitignore`/`.github/` from the template (`submit`). |

### `collect_scores.py` (Actions, uses `CLASSROOM50_SERVICE_TOKEN`)

| Method | Endpoint | Purpose | FG-PAT permission |
|--------|----------|---------|-------------------|
| GET | `/orgs/{org}/teams/{slug}/members` | List the classroom team (team-driven enrollment). | **Members: Read** |
| GET | `/repos/{owner}/{repo}/releases` + `/releases/assets/{id}` | Collect submissions and `result.json`. | **Contents: Read** |
| GET | `/repos/{owner}/{repo}/collaborators` | Fan a group score to teammates. | **Metadata: Read** |
| GET / PUT | `/orgs/{org}/teams/{slug}/repos/{owner}/{repo}` | Grant staff teams read on student repos/templates. | **Administration: R/W** |

### `probe_token.py` (Actions, read-only)

Exercises every scope with read-only proxies GitHub gates behind the write
permission: `/orgs/{org}/members`, `/orgs/{org}/teams/{slug}/members`,
`/repos/{org}/classroom50` (its `permissions.push`/`admin`),
`/repos/{org}/classroom50/actions/permissions`, and
`/repos/{org}/classroom50/collaborators`.

### `autograde-runner.yaml` (reusable, runs in student repos)

Jobs: `setup` (create the submit tag, validate config), `grade` (run
`runner.py` + the autograder, post status, publish the Release, maintain the
Feedback PR), and `set-latest` (serialized latest-pointer update). It posts
`/repos/{owner}/{repo}/statuses/{sha}`, uses `git tag`/`git push` and `gh
release` for tags and Releases, and fetches unauthenticated from Pages:

| Endpoint | Purpose |
|----------|---------|
| `https://{org}.github.io/classroom50/{classroom}/assignments.json` | The assignment manifest + runtime block. |
| `https://{org}.github.io/classroom50/runner.py` | The runner bootstrap (org-level). |
| `https://{org}.github.io/classroom50/{classroom}/autograder.py` | The classroom default (404 → vacuous pass). |
| `https://{org}.github.io/classroom50/{classroom}/autograders/{slug}.tar.gz` | The per-assignment bundle. |

---

## Workflows scaffolded into `classroom50`

| File | Triggers | Purpose |
|------|----------|---------|
| `publish-pages.yaml` | Push to default branch, `workflow_dispatch` | Deploy `assignments.json`, autograders, shims, `runner.py`, and bundles to Pages. |
| `collect-scores.yaml` | `workflow_dispatch`, nightly cron | Aggregate `result.json` into `*/scores.json`. |
| `probe-token.yaml` | `workflow_dispatch` | Read-only service-token scope check. |
| `autograde-runner.yaml` (reusable) | Called by each student's `autograde.yaml` | Grade, publish, update the latest pointer. |

## Environment variables and secrets

| Variable / Secret | Set by | Used by | Purpose |
|-------------------|--------|---------|---------|
| `CLASSROOM50_SERVICE_TOKEN` | `gh teacher init` | `collect-scores.yaml` | Read student repo releases; regrade. |
| `GITHUB_TOKEN` | Actions | Runner jobs | Tags, status, Release, Feedback PR. |
| `GH_DEBUG=api` | Developer | `go-gh` | Log REST traffic. |
| `GITHUB_REPOSITORY_OWNER` / `GITHUB_API_URL` | Actions | `collect_scores.py` | Org name and API base (supports Enterprise Server). |

The teacher and student CLIs read credentials from the `gh` auth store (populated
by `gh teacher login` / `gh student login`), not from `GITHUB_TOKEN`.
