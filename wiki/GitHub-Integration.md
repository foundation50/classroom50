# GitHub Integration

Every place Classroom 50 touches GitHub: what you do manually, what the CLI
handles, and the complete list of REST API calls the tooling makes.

## Manual steps

### 1. Create the organization (one-time, on github.com)

The CLI never creates the organization. Before running any CLI command:

1. **Create the organization** at <https://github.com/account/organizations/new>.
   Free orgs work for public templates; Team or Enterprise Cloud is required for
   Pages from the private `classroom50` repository.
2. **Flag your template repositories** under **Settings → General → Template
   repository**.

> [!NOTE]
> A private template must live **inside your org**; see
> [Template visibility](Assignment-Templates#template-visibility).

`gh teacher init` locks organization member privileges to least-privilege
automatically. After it runs, a member can only create a **private** repository
(so `gh student accept` works) and publish a **public** Pages site (so the
`classroom50` repository's `assignments.json` stays reachable).

<details>
<summary>Why broad access to their own repository is safe for students</summary>

The lockdown denies the dangerous org-wide powers (private Pages, repo
delete/transfer, visibility change, issue deletion, team creation, dependency
insights, member-invited outside collaborators). Public-repo creation is the one
exception by plan: it's locked off only on Enterprise Cloud, because Team/Free
couples public and private creation and the student flow needs private creation.
So it's safe for `gh student accept` to grant broad access to a student's own
repository — individual students are downgraded to **write** after creation, a
group founder keeps **admin** to add teammates, and the org locks defang the
rest.

</details>

**Four member-privilege settings have no API**, so `init` can't set them and
`audit` can't read them. Apply them once by hand; the checklist is in
[Manual organization hardening](CLI-Teacher-Guide#manual-organization-hardening-one-time)
in the CLI Teacher Guide.

### 2. Teacher authentication

Run once per machine, or after a token rotation:

```sh
gh teacher login
```

This wraps `gh auth login -s admin:org -s read:org -s repo -s workflow` — the
unified Classroom 50 scope set, shared with `gh student login`, so
authenticating one CLI covers the other. (`delete_repo` is not included — opt
in with `gh teacher login -s delete_repo` for teardown.)

You often don't need to run it. Every other command checks your existing `gh`
credentials first: a sufficiently-scoped token is reused untouched, and an
under-scoped token that `gh` manages is widened in place with `gh auth refresh`
(your token is kept). `login` itself always re-runs `gh auth login`, which
**replaces** your stored github.com token — so when one already exists, the CLI
warns and asks for confirmation before proceeding. See
[Will `gh teacher login` disturb my existing `gh` setup?](Troubleshooting#will-gh-teacher-login-disturb-my-existing-gh-setup).

| Scope | Required for |
|---|---|
| `admin:org` | Org invitations, reading and removing memberships (implies `read:org`). |
| `read:org` | Checking org membership. |
| `repo` | Repo creation, contents writes, collaborators. |
| `workflow` | Committing the `classroom50` repository's workflow files during `init` (GitHub 404s the write without it). |

> [!NOTE]
> **Tearing down an organization needs an extra permission.** Signing in does
> not request `delete_repo`. Exactly one feature needs it: **Tear down
> organization**, in the organization's settings under **Danger zone**. It
> resets an organization by deleting **every** repository in it, not only the
> ones Classroom 50 created. When you use it, Classroom 50 asks you to request
> that permission and sign in again, and teardown still runs only after you type
> an explicit confirmation. Nothing else deletes repositories. Classroom 50 has
> no server: the token stays in your browser, so nobody but you can act on your
> organization with it. The CLIs work the same way: they never request
> `delete_repo` unless you opt in with `gh teacher login -s delete_repo`.
>
> **If you signed in with a personal access token**, Classroom 50 can't add the
> permission for you — a token's permissions are fixed when you create it on
> GitHub. Create one that allows deleting repositories (the `delete_repo` scope
> on a classic token, or **Administration: read and write** on a fine-grained
> one) and sign in again.

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
score-collection, regrade, and token-probe workflows (`collect-scores.yaml`,
`regrade.yaml`, `probe-token.yaml`) use it to read student repos across the org.

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

The `collect-scores.yaml` workflow runs nightly (`17 4 * * *` UTC) across every
classroom. Trigger it manually, optionally scoped to one classroom or a single
assignment (the same scoped run the web app's per-assignment **Sync now**
button dispatches):

```sh
gh workflow run collect-scores.yaml --repo <org>/classroom50
gh workflow run collect-scores.yaml --repo <org>/classroom50 -f classroom=<short-name>
gh workflow run collect-scores.yaml --repo <org>/classroom50 -f classroom=<short-name> -f assignment=<slug>
```

A scoped run walks only the matching assignment's repos (faster and cheaper on
API rate limits for a large classroom) and stamps that assignment's
`collected_at` in `scores.json`; sibling assignments' buckets are untouched.

### 7. Verify the service token

After `init`/`rotate`, or when collect/regrade returns 401/403, run the
read-only probe:

```sh
gh workflow run probe-token.yaml --repo <org>/classroom50
```

A green run confirms every scope; a red run's log names the missing scope(s).
Side-effect free.

---

## Permissions and blast radius

Classroom 50 has no server. Whatever you authorize is a GitHub token that lives
only in your browser (web app) or your local `gh` credential store (CLI) —
nobody but you can act on your account with it. Sign-in requests the **same
scope set for everyone**, because teachers and students share one flow and one
person can be both (an instructor testing an assignment as a student, a TA who
also takes the course). Capabilities are gated after sign-in by your role in the
organization and classroom, not by the scopes on your token.

The scopes below are GitHub's own. The table lists what each one grants across
your whole account (the blast radius), why Classroom 50 needs it, and who
actually exercises it.

| Scope | Blast radius (what it can touch) | Why Classroom 50 needs it | Who uses it |
|---|---|---|---|
| `read:user` | Reads your public profile. | Identifies who you are after sign-in. | Everyone. |
| `read:org` | Reads your organization and team memberships. | Confirms membership and resolves your classroom role; a student accepts their own org invitation. | Everyone. |
| `repo` | **Full control of all your repositories** — public and private, in every organization, not only the classroom one. GitHub offers no way to narrow it to a single org. | Creating student repositories, committing config and setup files, reading grades (private-repo Releases), and managing repo collaborators. | Everyone. |
| `workflow` | Commit files under `.github/workflows/` in repositories you can write. | Landing the autograder workflow — teachers during `init`, students when the browser commits the autograde shim on accept. | Everyone (students only for default-autograder accepts). |
| `admin:org` | Administer organizations you own — invite/remove members, manage teams, change org settings. | Inviting and removing students, managing classroom teams, and locking down org policy. Implies `read:org`. | Teachers only. |
| `delete_repo` | **Permanently delete repositories.** | Not requested at sign-in. One feature needs it — **Tear down organization** — and Classroom 50 asks for it on demand, then only after an explicit typed confirmation (see the [teacher-authentication note](#2-teacher-authentication) above). | Teachers only, on demand. |

### What a student actually uses versus a teacher

A student's session carries the same grant, but a student only ever exercises
`read:user`, `read:org`, and `repo` (plus `workflow` for default-autograder
accepts). The `admin:org` and `delete_repo` powers are never used by a student:
every organization-administration call the code makes is owner-only, and a plain
member's token can't perform them on an org they don't own even though the grant
nominally includes the scope. In other words, the grant is broader than the
footprint — the token *can* touch all your repos, but Classroom 50 only ever
acts on classroom ones. This matches the GitHub CLI's behavior.

### Reducing what you grant

The one lever that actually narrows the grant is a **fine-grained personal
access token**, which is scoped to a single organization instead of your whole
account. On the sign-in card, open **Other sign-in methods** and pick **Use a
personal access token (fine-grained)**; you name the org (it becomes the token's
resource owner) and set Repository access to **All repositories**. See
[If the proxy domain is blocked](#if-the-proxy-domain-is-blocked) for the full
walkthrough. A classic OAuth sign-in can't be scoped this way — the `repo` scope
is all-or-nothing — so the fine-grained token is the tighter-security path for
anyone who wants to grant less. Why classic OAuth can't be scoped per
organization, and why sign-in doesn't ask you to pick a teacher or student role,
are recorded in [Known Limitations](Known-Limitations#requested-but-architecturally-hard).

---

## Network and allowed domains

If your school or district filters web traffic, allow the domains below so
Classroom 50 works end to end. The web app runs entirely in the browser, so the
browser itself must reach these hosts.

| Domain | Used by | For |
|--------|---------|-----|
| `classroom50.org`, `preview.classroom50.org` | Web app | Loading the app. |
| `classroom50.fifty-foundation.workers.dev` | Web app | The GitHub proxy (OAuth sign-in and repo downloads). See [The GitHub proxy](#the-github-proxy) below. |
| `github.com` | Web app, CLI | OAuth sign-in and CLI authentication. |
| `api.github.com` | Web app, CLI, Actions | All GitHub REST API calls (classrooms, rosters, assignments, grading). |
| `*.github.io` | Web app, Actions | The org's Pages config (`<org>.github.io/classroom50/…`): the assignment manifest, autograders, and the runner. |
| `codeload.github.com` | Web app | Repo archive (zip) downloads, reached through the proxy. |
| `www.githubstatus.com` | Web app | GitHub status check for the outage banner (best-effort). |

### The GitHub proxy

A browser can't do everything GitHub requires directly, so the web app sends two
operations through a small proxy. It defaults to the Fifty Foundation Cloudflare
Worker at `classroom50.fifty-foundation.workers.dev`:

1. **OAuth sign-in.** Exchanging the login code for an access token needs the
   OAuth client secret, which can't be shipped in browser JavaScript. The proxy
   holds the secret and performs the exchange.
2. **Repo downloads.** GitHub's archive endpoint redirects to
   `codeload.github.com`, which doesn't send the CORS headers a browser needs to
   follow the redirect. The proxy follows it server-side and streams the zip
   back.

The proxy is configurable: set `VITE_GITHUB_PROXY_BASE` at build time to point
the app at your own proxy instead of the default worker. Everything else the web
app does talks to `api.github.com` directly and doesn't involve the proxy.

### If the proxy domain is blocked

Some networks can't allow `workers.dev`. When the proxy is unreachable:

- **What still works:** everything except the two operations above. All other
  GitHub calls go straight to `api.github.com`, so browsing classrooms, rosters,
  and assignments is unaffected.
- **What breaks:** the normal "Sign in with GitHub" button (its token exchange
  goes through the proxy) and in-app repo downloads.
- **Signing in anyway:** paste a personal access token instead. On the sign-in
  card, open **Other sign-in methods** and pick **Use a personal access token
  (classic)** or **Use a personal access token (fine-grained)**. Both validate
  the token directly against `api.github.com`, so they never touch the proxy,
  and both link to a token-creation page with the required scopes/permissions
  pre-filled. A fine-grained token works with **one organization only** — you
  name the org (it becomes the token's resource owner) and must set Repository
  access to **All repositories**.
  (This sign-in token is one you paste into the web app; it is separate from
  the fine-grained `CLASSROOM50_SERVICE_TOKEN` used for
  [score collection](#4-fine-grained-pat-for-score-collection).)
- **A fuller fix:** host the proxy yourself on a domain your network already
  allows and point `VITE_GITHUB_PROXY_BASE` at it. This restores both the normal
  sign-in and repo downloads.

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
| POST | `/orgs/{org}/repos` | Create the `classroom50` repository. |
| GET | `/repos/{owner}/{repo}` | Check the `classroom50` repository / validate a template. |
| POST / PUT | `/repos/{owner}/{repo}/pages` | Enable Pages and set it public. |
| PUT | `/repos/{owner}/{repo}/branches/{branch}/protection` | Protect the `classroom50` repository branch. |
| GET / PUT | `/repos/{owner}/{repo}/actions/permissions` | Read/re-enable Actions on the `classroom50` repository. |
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
| POST | `/orgs/{org}/repos` | Create the repo directly (template-less accept). |
| GET / PATCH | `/repos/{owner}/{repo}` | Recover from "already exists"; read the template's features and apply the assignment's repository-feature settings (inherit/on/off). |
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
| `regrade.yaml` | `workflow_dispatch` | Push regrade tags to student repos for an assignment. |
| `probe-token.yaml` | `workflow_dispatch` | Read-only service-token scope check. |
| `autograde-runner.yaml` (reusable) | Called by each student's `autograde.yaml` | Grade, publish, update the latest pointer. |

## Environment variables and secrets

| Variable / Secret | Set by | Used by | Purpose |
|-------------------|--------|---------|---------|
| `CLASSROOM50_SERVICE_TOKEN` | `gh teacher init` | `collect-scores.yaml`, `regrade.yaml`, `probe-token.yaml` | Read student repo releases; regrade; probe the token. |
| `GITHUB_TOKEN` | Actions | Runner jobs | Tags, status, Release, Feedback PR. |
| `GH_DEBUG=api` | Developer | `go-gh` | Log REST traffic. |
| `GITHUB_REPOSITORY_OWNER` / `GITHUB_API_URL` | Actions | `collect_scores.py` | Org name and API base (supports Enterprise Server). |

The teacher and student CLIs read credentials from the `gh` auth store (populated
by `gh teacher login` / `gh student login`), not from `GITHUB_TOKEN`.
