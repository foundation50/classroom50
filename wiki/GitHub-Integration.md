# GitHub Integration

Every place Classroom 50 touches GitHub: what you do manually, what the CLI
handles, and the REST API calls the tooling makes.

## Manual steps

### 1. Create the organization (one-time, on github.com)

The CLI never creates the organization. Before running any CLI command:

1. **Create the organization** at <https://github.com/account/organizations/new>.
   Free organizations work for public templates; Team or Enterprise Cloud is
   required for Pages from the private `classroom50` repository.
2. **Flag your template repositories.** On each template repository's
   **Settings** page, under **General**, select **Template repository**.

> [!NOTE]
> A private template must live **inside your organization**; see
> [Template visibility](Assignment-Templates#template-visibility).

`gh teacher init` locks organization member privileges to least-privilege
automatically. After it runs, a member can only create a **private** repository
(so `gh student accept` works) and publish a **public** Pages site (so the
`classroom50` repository's `assignments.json` stays reachable).

<details>
<summary>Why broad access to their own repository is safe for students</summary>

The lockdown denies the dangerous organization-wide powers (private Pages,
repository deletion and transfer, visibility changes, issue deletion,
dependency insights, member-invited outside collaborators). Two member
privileges stay deliberately on: public-repository creation is locked off only
on Enterprise Cloud, because Team and Free couple public and private creation
and the student flow needs private creation; and team creation stays on
because a student-formed group assignment has its founding student create the
group's team. So it's safe for `gh student accept` to grant broad access to a
student's own repository: individual students are downgraded to **write**
after creation, a legacy group founder keeps **admin** to add teammates (the
current group mode grants push through the group's GitHub Team instead), and
the organization locks defang the rest.

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

This wraps `gh auth login -s admin:org -s read:org -s repo -s workflow`, the
unified Classroom 50 scope set, shared with `gh student login`, so
authenticating one CLI covers the other. (`delete_repo` is not included; opt
in with `gh teacher login -s delete_repo` for teardown.)

You often don't need to run it. Every other command checks your existing `gh`
credentials first: a sufficiently-scoped token is reused untouched, and an
under-scoped token that `gh` manages is widened in place with `gh auth refresh`
(your token is kept). `login` itself always re-runs `gh auth login`, which
**replaces** your stored github.com token, so when one already exists, the CLI
warns and asks for confirmation before proceeding. See
[Will `gh teacher login` disturb my existing `gh` setup?](Troubleshooting#will-gh-teacher-login-disturb-my-existing-gh-setup).

| Scope | Required for |
|---|---|
| `admin:org` | Organization invitations, reading and removing memberships, managing teams (implies `read:org`). |
| `read:org` | Checking organization membership. |
| `repo` | Repository creation, contents writes, collaborators. |
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
> permission for you: a token's permissions are fixed when you create it on
> GitHub. Create one that allows deleting repositories (the `delete_repo` scope
> on a classic token, or **Administration: read and write** on a fine-grained
> one) and sign in again.

### 3. Student authentication

```sh
gh student login
```

Same device flow and the **same scope set**, so a student who authenticated a
teacher CLI (or the other way around) needs no re-auth. A student exercises
`read:org` (accept organization membership), `repo` (generate repositories,
collaborators), and `workflow` (commit the autograde workflow at accept).

### 4. Fine-grained PAT for score collection

`gh teacher init` uploads a PAT into the `CLASSROOM50_SERVICE_TOKEN` secret; the
score-collection, regrade, and token-probe workflows (`collect-scores.yaml`,
`regrade.yaml`, `probe-token.yaml`) use it to read student repositories across
the organization.

Create it at <https://github.com/settings/personal-access-tokens/new> from your
own account (scope it tightly to the organization):

| Setting | Value |
|---|---|
| Resource owner | Your teaching organization. |
| Repository access | **All repositories** ("Only select repositories" misses on-demand student repositories). |
| Contents | **Read and write** (read: collect; write: regrade pushes `submit/*` tags). |
| Actions | **Read and write** (regrade re-runs autograde). |
| Administration | **Read and write** (grant staff teams read on student repositories and templates). |
| Metadata | **Read** (auto-included; lets collection read legacy group repository collaborators). |
| Organization permissions, **Members** | **Read** (list the classroom team; a separate section, shown only once the organization is the resource owner). |
| Expiry | Up to 1 year; set a rotation reminder. |

> [!IMPORTANT]
> **Members: Read** is under **Organization permissions**, not Repository
> permissions, and isn't implied by any repository scope. A Contents-only token
> passes a Contents check but fails the first call collection makes.

Group assignments need no extra permission. Collection reads a group team's
members with the same **Members: Read** the classroom team uses, and reads a
legacy group repository's collaborators with **Metadata: Read** (auto-included),
crediting members on the classroom team either way. A failed legacy read
still scores the owner with a warning; a failed group-team read skips the
repository and preserves its previous credit.

Supply the token in the environment variable, never as a flag (command-line
PATs leak into shell history):

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init YOUR-ORGANIZATION
```

Replace `YOUR-ORGANIZATION` with your organization's name. The token is
validated, encrypted with libsodium before upload, and never written to disk.
Rotate with `gh teacher rotate-service-token YOUR-ORGANIZATION`. In the web
app, the **Service token** section of the organization settings page builds
the same token with these permissions pre-filled.

### 5. GitHub Pages

`init` enables Pages and sets visibility to public. **The first deployment needs
the `publish-pages.yaml` workflow to run once**: push to the default branch or
trigger it from the **Actions** tab. The CLI prints the Pages URL
(`https://YOUR-ORGANIZATION.github.io/classroom50/`) after `init`.

If the organization's Pages site uses a custom domain, GitHub answers
`github.io` requests with a redirect that students' browsers reject. Set the
classroom's **Custom Pages domain** in the web app so browsers fetch from the
custom domain directly; server-side readers (the CLIs and Actions workflows)
follow the redirect and are unaffected. See
[Using a custom Pages domain](Web-Teacher-Guide#using-a-custom-pages-domain).

`init` also turns on the organization's **Allow GitHub Actions to create and
approve pull requests** setting (the feedback pull request is opened by each
student repository's workflow) and opens the `classroom50` repository's
reusable workflows to the organization. If `init` warns that an enterprise
policy blocked either, apply them yourself or ask your enterprise
administrator:

```sh
gh api -X PUT /orgs/YOUR-ORGANIZATION/actions/permissions/workflow \
  -F default_workflow_permissions=write -F can_approve_pull_request_reviews=true
gh api -X PUT /repos/YOUR-ORGANIZATION/classroom50/actions/permissions/access \
  -f access_level=organization
```

### 6. Score collection

Trigger the `collect-scores.yaml` workflow from the **Actions** tab, optionally
scoped to one classroom or a single assignment (the same scoped runs the web
app dispatches: **Collect all** on a classroom's assignments list sends the
classroom-only scope, and the per-assignment **Collect now** sends both inputs):

```sh
gh workflow run collect-scores.yaml --repo YOUR-ORGANIZATION/classroom50
gh workflow run collect-scores.yaml --repo YOUR-ORGANIZATION/classroom50 -f classroom=CLASSROOM-SHORT-NAME
gh workflow run collect-scores.yaml --repo YOUR-ORGANIZATION/classroom50 -f classroom=CLASSROOM-SHORT-NAME -f assignment=ASSIGNMENT-SLUG
```

Replace `CLASSROOM-SHORT-NAME` with the classroom's short name and
`ASSIGNMENT-SLUG` with the assignment's slug. A scoped run walks only the
matching repositories (one classroom's, or a single assignment's, which is
faster and cheaper on API rate limits for a large classroom) and stamps each
walked assignment's `collected_at` in `scores.json`; buckets outside the scope
are untouched. The staff-team read grant that rides along with collection is
scoped the same way, so a per-assignment run touches only that assignment's
repositories and template.

### 7. Verify the service token

After `init` or `rotate-service-token`, or when collect or regrade returns 401
or 403, run the read-only probe. In the web app, open the organization settings
page and click **Test token** in the **Service token** section; the result
shows in place. From the CLI:

```sh
gh workflow run probe-token.yaml --repo YOUR-ORGANIZATION/classroom50
```

A green run confirms every permission; a red run's log names the missing one.
The probe is side-effect free.

---

## Permissions and access

Classroom 50 has no server. Whatever you authorize is a GitHub token that lives
only in your browser (web app) or your local `gh` credential store (CLI), so
nobody but you can act on your account with it. Sign-in requests **one scope set
for everyone**, a deliberate simplicity choice, not a technical requirement.
Teachers and students share a single flow because one person can be both (a
teacher testing an assignment as a student, a TA who also takes the course), so
the app asks for the union of what any role might need rather than making you
declare a role up front. A student's grant is therefore broader than what a
student actually uses. Capabilities are gated after sign-in by your role in the
organization and classroom, not by the scopes on your token.

The scopes below are GitHub's own. The table lists what each one grants across
your whole account, why Classroom 50 needs it, and who actually exercises it.

| Scope | Access it grants | Why Classroom 50 needs it | Who uses it |
|---|---|---|---|
| `read:user` | Reads your public profile. | Identifies who you are after sign-in. | Everyone. |
| `read:org` | Reads your organization and team memberships. | Confirms membership and resolves your classroom role; a student accepts their own organization invitation. | Everyone. |
| `repo` | **Full control of all your repositories**: public and private, in every organization, not only the classroom one. GitHub offers no way to narrow it to a single organization. | Creating student repositories, committing configuration and setup files, reading scores (private-repository Releases), and managing repository collaborators. | Everyone. |
| `workflow` | Commit files under `.github/workflows/` in repositories you can write. | Landing the autograder workflow: teachers during `init`, students when the browser commits the autograde workflow on accept. | Everyone (students only for default-autograder accepts). |
| `admin:org` | Administer organizations you own: invite and remove members, manage teams, change organization settings. | Inviting and removing students, managing classroom teams, and locking down organization policy. Implies `read:org`. | Teachers only. |
| `delete_repo` | **Permanently delete repositories.** | Not requested at sign-in. One feature needs it, **Tear down organization**, and Classroom 50 asks for it on demand, then only after an explicit typed confirmation (see the [teacher-authentication note](#2-teacher-authentication) above). | Teachers only, on demand. |

### What a student actually needs versus a teacher

A student's flow only ever exercises three scopes: `read:user` (identify
themselves), `read:org` (accept their own organization invitation and read
their own memberships), and `repo` (generate their assignment repository, commit
their work, add a teammate as a collaborator on a legacy group repository, and
read their own scores). Default-autograder assignments also need `workflow`,
because the browser commits the autograde workflow file on accept; empty
repository and no-autograder assignments don't. That's the whole student
footprint.

A student never uses `admin:org` or `delete_repo`. Those are organization-owner
powers: a plain member's token can't perform them on an organization they don't
own, even though the shared grant nominally includes `admin:org`. The app
requests them because the sign-in flow is shared with teachers, not because a
student needs them. So the grant is broader than the footprint: the token *can*
touch all your repositories, but Classroom 50 only ever acts on classroom ones.
This matches the GitHub CLI's behavior, where `gh teacher login` and `gh student
login` share one scope set for the same reason.

### Reducing what you grant

The one lever that actually narrows the grant is a **fine-grained personal
access token**, which is scoped to a single organization instead of your whole
account. On the sign-in card, click **Other sign-in methods**, then click **Use a
personal access token (fine-grained)**; you name the organization (it becomes
the token's resource owner) and set Repository access to **All repositories**.
See [If the proxy domain is blocked](#if-the-proxy-domain-is-blocked) for the
full walkthrough. A classic OAuth sign-in can't be scoped this way (the `repo`
scope is all-or-nothing), so the fine-grained token is the tighter-security path
for anyone who wants to grant less. Why classic OAuth can't be scoped per
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
| `classroom50.fifty-foundation.workers.dev` | Web app | The GitHub proxy (OAuth sign-in and repository downloads). See [The GitHub proxy](#the-github-proxy) below. |
| `github.com` | Web app, CLI | OAuth sign-in and CLI authentication. |
| `api.github.com` | Web app, CLI, Actions | All GitHub REST API calls (classrooms, rosters, assignments, grading). |
| `*.github.io` | Web app, Actions | The organization's Pages site (`YOUR-ORGANIZATION.github.io/classroom50/…`): the assignment manifest, autograders, and the runner. If the organization's Pages site uses a custom domain, allow that domain too. See [Using a custom Pages domain](Web-Teacher-Guide#using-a-custom-pages-domain). |
| `codeload.github.com` | Web app | Repository archive (zip) downloads, reached through the proxy. |
| `www.githubstatus.com` | Web app | GitHub status check for the outage banner (best-effort). |

### The GitHub proxy

A browser can't do everything GitHub requires directly, so the web app sends two
operations through a small proxy. It defaults to the Fifty Foundation Cloudflare
Worker at `classroom50.fifty-foundation.workers.dev`:

1. **OAuth sign-in**, both the browser redirect flow and the device-code flow.
   Exchanging the login code for an access token needs the OAuth client secret,
   which can't be shipped in browser JavaScript. The proxy holds the secret and
   performs the exchange.
2. **Repository downloads.** GitHub's archive endpoint redirects to
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
- **What breaks:** the normal **Sign in with GitHub** button and **Use a device
  code instead** (their token exchange goes through the proxy) and in-app
  repository downloads.
- **Signing in anyway:** paste a personal access token instead. On the sign-in
  card, click **Other sign-in methods**, then click **Use a personal access
  token (classic)** or **Use a personal access token (fine-grained)**. Both
  validate the token directly against `api.github.com`, so they never touch the
  proxy, and both link to a token-creation page with the required scopes or
  permissions pre-filled. A fine-grained token works with **one organization
  only**: you name the organization (it becomes the token's resource owner) and
  must set Repository access to **All repositories**. This sign-in token is one
  you paste into the web app; it is separate from the fine-grained
  `CLASSROOM50_SERVICE_TOKEN` used for
  [score collection](#4-fine-grained-pat-for-score-collection).
- **A fuller fix:** host the proxy yourself on a domain your network already
  allows and point `VITE_GITHUB_PROXY_BASE` at it. This restores both the normal
  sign-in and repository downloads.

---

## REST API reference

The CLIs call GitHub through [`go-gh`](https://github.com/cli/go-gh); the
workflow scripts (`collect_scores.py`, `regrade_repos.py`, `probe_token.py`) use
`urllib` with a bearer token. The tables list the main endpoint families, not
every call.

### `gh teacher` CLI

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/user` | Whoami. |
| GET | `/orgs/{org}` | Check organization plan. |
| PATCH | `/orgs/{org}` | Lock down member privileges at `init`. |
| GET / PUT | `/orgs/{org}/actions/permissions` | Read and enable organization Actions. |
| GET / PUT | `/orgs/{org}/actions/permissions/workflow` | Allow Actions to create pull requests (feedback pull requests). |
| GET / POST | `/organizations/{org}/settings/billing/budgets` | Read and create the $0 Actions spending cap. |
| GET / POST / PUT | `/orgs/{org}/rulesets` | Install the submission-history and feedback-base rulesets. |
| POST | `/orgs/{org}/repos` | Create the `classroom50` repository. |
| GET | `/repos/{owner}/{repo}` | Check the `classroom50` repository; validate a template. |
| POST / PUT | `/repos/{owner}/{repo}/pages` | Enable Pages and set it public. |
| PUT | `/repos/{owner}/{repo}/branches/{branch}/protection` | Protect the `classroom50` repository's default branch. |
| GET / PUT | `/repos/{owner}/{repo}/actions/permissions` | Read and re-enable Actions on the `classroom50` repository. |
| GET / PUT | `/repos/{owner}/{repo}/actions/permissions/workflow` | Read and set `GITHUB_TOKEN` permissions. |
| PUT | `/repos/{owner}/{repo}/actions/permissions/access` | Allow same-organization reusable workflows. |
| GET / PUT | `/repos/{owner}/{repo}/actions/secrets/...` | Upload the encrypted service PAT. |
| GET / POST / PATCH | `/repos/{owner}/{repo}/git/{refs,commits,blobs,trees}` | Tree-commit configuration files (with rebase retry). |
| GET / POST / PATCH / DELETE | `/orgs/{org}/teams`, `/orgs/{org}/teams/{slug}` | Create, read, update, and delete classroom, staff, invite, and group teams. |
| GET / PUT / DELETE | `/orgs/{org}/teams/{slug}/members`, `/orgs/{org}/teams/{slug}/memberships/{username}` | Team membership (enrollment, staff roles, groups). |
| PUT / DELETE | `/orgs/{org}/teams/{slug}/repos/{owner}/{repo}` | Grant staff teams the `classroom50` repository and grant the classroom team a private template. |
| GET | `/users/{username}` | Resolve a login to its numeric ID. |
| GET / POST / DELETE | `/orgs/{org}/invitations`, `/orgs/{org}/invitations/{id}` | Send, list, and cancel organization invitations (email invitations carry teams). |
| GET / DELETE | `/orgs/{org}/memberships/{username}` | Check and remove organization membership. |
| PUT / DELETE | `/repos/{owner}/{repo}/collaborators/{username}` | Add and remove a repository collaborator. |
| GET / POST | `/repos/{owner}/{repo}/pulls`, `/repos/{owner}/{repo}/labels` | Open or repair a feedback pull request (`assignment feedback-pr`). |
| DELETE | `/repos/{owner}/{repo}` | Delete a repository (`teardown`; needs `delete_repo`). |
| GET | `/repos/{owner}/{repo}/releases` + `/releases/assets/{id}` | Collect `submit/*` releases and `result.json`. |
| GET | `/orgs/{org}/repos` | Page organization repositories for `--by-pattern` download and `teardown`. |

### `gh student` CLI

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/user` | Whoami and git identity. |
| GET / PATCH | `/user/memberships/orgs/{org}` | Check and accept a pending organization invitation. |
| POST | `/repos/{template_owner}/{template_repo}/generate` | Generate the repository from a template (with `include_all_branches` when the assignment sets it). |
| POST | `/orgs/{org}/repos` | Create the repository directly (template-less accept). |
| GET / PATCH | `/repos/{owner}/{repo}` | Recover from "already exists"; read the template's features and apply the assignment's repository-feature settings (inherit, on, or off). |
| PUT | `/repos/{owner}/{repo}/collaborators/{username}` | Set the founder role: `push` (individual) or `admin` (legacy group); also backs `gh student invite`. |
| GET / POST / PUT | `/user/teams`, `/orgs/{org}/teams`, `/orgs/{org}/teams/{slug}/memberships/{username}`, `/orgs/{org}/teams/{slug}/repos/{owner}/{repo}` | Group assignments: find your group, found one (`--new-team`), add teammates, and attach the team to the shared repository. |
| GET / POST / PATCH | `/repos/{owner}/{repo}/git/{refs,commits,blobs,trees}` + `/branches/{branch}` | Commit the setup files and freeze the `feedback` base branch. |
| GET / POST | `/repos/{owner}/{repo}/pulls`, `/repos/{owner}/{repo}/labels` | Open the feedback pull request at accept. |
| GET | `/repos/{owner}/{repo}/contents/{path}` | Fetch `.gitignore` and `.github/` from the template (`submit`), and the template's pull request template. |

### `collect_scores.py` (Actions, uses `CLASSROOM50_SERVICE_TOKEN`)

| Method | Endpoint | Purpose | FG-PAT permission |
|--------|----------|---------|-------------------|
| GET | `/orgs/{org}/teams/{slug}/members` | List the classroom and staff teams (team-driven enrollment) and a group assignment's group teams. | **Members: Read** |
| GET | `/orgs/{org}/repos` | List the organization's repositories once, to find accepted repositories and pushes without a release. | **Metadata: Read** |
| GET | `/repos/{owner}/{repo}/releases` + `/releases/assets/{id}` | Collect submissions and `result.json`. | **Contents: Read** |
| GET | `/repos/{owner}/{repo}/collaborators` | Fan a legacy group score to teammates. | **Metadata: Read** |
| GET / PUT | `/orgs/{org}/teams/{slug}/repos/{owner}/{repo}` | Grant staff teams read on student repositories and templates. | **Administration: Read and write** |

### `probe_token.py` (Actions, read-only)

Exercises every permission with read-only calls GitHub gates behind the write
permission: `/orgs/{org}/members`, `/orgs/{org}/teams/{slug}/members`,
`/repos/{org}/classroom50` (its `permissions.push` and `permissions.admin`),
`/repos/{org}/classroom50/actions/permissions`, and
`/repos/{org}/classroom50/collaborators`.

### `autograde-runner.yaml` (reusable, runs in student repositories)

Jobs: `setup` (create the submit tag, validate configuration), `grade` (run
`runner.py` and the autograder, post status, publish the Release, maintain the
feedback pull request), and `set-latest` (serialized latest-pointer update). It
posts `/repos/{owner}/{repo}/statuses/{sha}`, uses `git tag`, `git push`, and
`gh release` for tags and Releases, and fetches unauthenticated from Pages:

| Endpoint | Purpose |
|----------|---------|
| `https://{org}.github.io/classroom50/{classroom}/assignments.json` | The assignment manifest and runtime block. |
| `https://{org}.github.io/classroom50/runner.py` | The runner bootstrap (organization-level). |
| `https://{org}.github.io/classroom50/ensure_feedback_pr.py` | The feedback pull request script (organization-level). |
| `https://{org}.github.io/classroom50/{classroom}/autograder.py` | The classroom default (a 404 means a vacuous pass). |
| `https://{org}.github.io/classroom50/{classroom}/autograders/{slug}.tar.gz` | The per-assignment bundle. |

For an unlisted classroom, `{classroom}` becomes `{classroom}/{key}`.

---

## Workflows installed into `classroom50`

| File | Triggers | Purpose |
|------|----------|---------|
| `publish-pages.yaml` | Push to the default branch (roster-only commits skipped), `workflow_dispatch` | Deploy `classrooms-index.json`, each classroom's `classroom.json` and `assignments.json`, autograders and bundles, `runner.py`, and `ensure_feedback_pr.py` to Pages. |
| `collect-scores.yaml` | `workflow_dispatch` | Aggregate `result.json` into `*/scores.json`. |
| `regrade.yaml` | `workflow_dispatch` | Push regrade tags to student repositories for an assignment. |
| `probe-token.yaml` | `workflow_dispatch` | Read-only service-token permission check. |
| `autograde-runner.yaml` (reusable) | Called by each student's `autograde.yaml` | Grade, publish, update the latest pointer. |

## Environment variables and secrets

| Variable / Secret | Set by | Used by | Purpose |
|-------------------|--------|---------|---------|
| `CLASSROOM50_SERVICE_TOKEN` | `gh teacher init` or the web app | `collect-scores.yaml`, `regrade.yaml`, `probe-token.yaml` | Read student repository releases; regrade; probe the token. |
| `CLASSROOM50_SERVICE_TOKEN_EXPIRES_AT`, `CLASSROOM50_SERVICE_TOKEN_NAME` | The web app (Actions variables) | The web app | Show the token's expiry countdown and display name. The CLI doesn't write them, so a CLI-provisioned token shows no tracked expiry. |
| `GITHUB_TOKEN` | Actions | Runner jobs | Tags, status, Release, feedback pull request. |
| `GH_DEBUG=api` | Developer | `go-gh` | Log REST traffic. |
| `GITHUB_REPOSITORY_OWNER` / `GITHUB_API_URL` | Actions | `collect_scores.py` | Organization name and API base (supports Enterprise Server). |

The teacher and student CLIs read credentials from the `gh` auth store (populated
by `gh teacher login` and `gh student login`), not from `GITHUB_TOKEN`.
