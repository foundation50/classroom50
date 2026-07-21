# GitHub Integration

This page documents every place where Classroom 50 touches GitHub's API or authentication infrastructure — what you have to do manually in a browser, what the CLI handles for you, and the complete list of REST API calls the tooling makes.

## Manual steps

### 1. Org setup (one-time, github.com web UI)

The CLI never creates the org for you. Do the following once before running any CLI commands:

1. **Create the organization** at <https://github.com/account/organizations/new>. Free orgs work for public template repos; Team or Enterprise Cloud is required for GitHub Pages from a private repo (the `classroom50` config repo is private).

2. **Flag your template repos as templates** under each repo's `Settings → General → Template repository`. A **public** template works on any plan. A **private** template works if it lives **inside your org**: `gh teacher assignment add` grants the classroom's GitHub team read on it, so rostered students can create from it under the "No permission" baseline. A private template **outside** your org is rejected by `gh teacher assignment add` (students can't be granted access). GitHub Enterprise Cloud's "internal" visibility also works — see [GitHub's docs on internal repositories](https://docs.github.com/en/enterprise-cloud@latest/repositories/creating-and-managing-repositories/about-repositories#about-internal-repositories).

Org-level member privileges are locked to least-privilege automatically — `gh teacher init` applies them via `PATCH /orgs/{org}` (see the REST table below), retrying each policy individually if the combined PATCH hits a plan-gated or enterprise-locked field. After init, the only things an org member can do are create a **private** repository (needed so `gh student accept` works) and publish a **public** Pages site (enforced so the `classroom50` config repo's site — the unauthenticated `assignments.json` source — keeps working); private Pages, repo delete/transfer, visibility changes, issue deletion, team creation, dependency insights, and member-invited outside collaborators are all denied. **Public-repo creation is the one exception by plan:** restricting members to *private repositories only* is a GitHub Enterprise Cloud capability, so init only locks public-repo creation off on Enterprise Cloud. On **Team/Free**, GitHub couples public and private into a single "all or none" choice (the legacy creation-type field has no Team-valid "private-only" value, and the UI auto-checks Public when you check Private) — and since the student flow needs private creation enabled, members can also create public repos there. init therefore skips that field on non-Enterprise plans rather than attempting an impossible lockdown that would also disable private creation. init *enforces* (not just allows) the Pages policy, so re-running `gh teacher init` resets a teacher who tightened it back to the working state. This is what makes it safe for `gh student accept` to leave the student as **admin** of their own repo (so a group founder can add teammates with `gh student invite`) — the dangerous repo-admin powers are defanged org-wide. The fields GitHub rejects on your plan are the one case where you'd still flip them yourself at `https://github.com/organizations/<org>/settings/member_privileges`; init warns per rejected field with that link.

**Four member-privilege settings have no REST API** and `gh teacher init` cannot set or even read them — apply them manually once at `https://github.com/organizations/<org>/settings/member_privileges` (init prints this reminder too):

- **Set "App access requests"** to "Members only" (or "Disable app access requests")
- **Uncheck "Allow repository admins to install GitHub Apps for their repositories"** (under "GitHub Apps")
- **Set "Projects base permissions"** to "No access"
- **Uncheck "Allow repository administrators to rename branches protected by organization rules"** (under "Branch renames"; enabled by default on new orgs; defense-in-depth — the `classroom50-protect-submission-history` org ruleset already protects each repo's default branch with org-admin-only bypass, so a student-admin can't rename out of that protection. Disable it as a tidy-up.)

### 2. Teacher authentication (`gh teacher login`)

Run once per machine or after a token rotation:

```sh
gh teacher login
```

This shells out to `gh auth login -s admin:org -s read:org -s repo -s workflow` and opens a browser to complete GitHub's OAuth device flow (a one-time code you enter at <https://github.com/login/device>). This is the **unified Classroom 50 scope set** — `gh teacher login` and `gh student login` request the same scopes, so authenticating for one CLI covers the other. None of these are granted by a plain `gh auth login`: `admin:org` is required for org-level invitations (and implies `read:org`), `repo` for repo creation/contents/collaborator management, and `workflow` lets `gh teacher init` commit the config repo's `.github/workflows/` files via the Git Data API (GitHub returns a misleading `404` on that write without it). If you skip this step and have no token at all, the CLI detects the missing token and runs the login flow automatically. If a token exists but lacks one of these scopes, the affected command fails with an error telling you to run `gh teacher login` to grant the missing scope. (`delete_repo` is **not** in this set — opt in with `gh teacher login -s delete_repo` for `gh teacher teardown`.)

OAuth scopes requested by the teacher CLI (identical to the student CLI):

| Scope | Required for |
|-------|--------------|
| `admin:org` | Sending org invitations, reading and removing org memberships (implies `read:org`) |
| `read:org` | Checking org membership (requested explicitly for parity with the student CLI and web GUI) |
| `repo` | Assignment-repo creation, contents writes, disabling repo features, adding collaborators |
| `workflow` | Committing the config repo's `.github/workflows/` files during `gh teacher init` (GitHub 404s the Git Data API write without it) |

### 3. Student authentication (`gh student login`)

Run once per student machine:

```sh
gh student login
```

Same device flow as above, and — as of the scope unification — the **same scope set** (`admin:org`, `read:org`, `repo`, `workflow`), so a student who has already authenticated a teacher CLI (or vice versa) needs no re-auth. The scopes a student actually exercises:

| Scope | Required for |
|-------|--------------|
| `read:org` | Checking and accepting org membership |
| `repo` | Generating private assignment repos from templates, disabling repo features, adding collaborators |
| `workflow` | Committing `.github/workflows/autograde.yaml` into the assignment repo at accept time |

### 4. Fine-grained PAT for score collection

`gh teacher init` uploads a PAT into the `CLASSROOM50_SERVICE_TOKEN` Actions secret of your `classroom50` config repo. That PAT is what the `collect-scores.yaml` workflow uses to read releases from student repos across the org.

**Create the PAT at <https://github.com/settings/personal-access-tokens/new>** (from your own GitHub account — GitHub's Terms of Service generally permit only one account per person, so there's no separate "service account" to create; scope the token tightly to the org you're provisioning instead):

| Setting | Value |
|---------|-------|
| Resource owner | your teaching org |
| Repository access | **All repositories** ("Only select repositories" misses student repos, which `gh student accept` creates on demand after the token is minted) |
| Repository → Contents | **Read and write** (Read: collect student repo releases; Write: regrade pushes `submit/*` tags — one shared token) |
| Repository → Actions | **Read and write** (regrade re-runs each student repo's autograde workflow run via the Actions rerun API) |
| Repository → **Administration** | **Read and write** (collect grants staff teams — e.g. TAs — read access to student repos and private templates via `PUT /orgs/{org}/teams/{slug}/repos/...`; **not** implied by Contents) |
| Repository → Metadata | **Read** (mandatory — GitHub auto-includes it on every fine-grained PAT; this is what lets `collect-scores` read group-repo collaborators, so group assignments need no extra scope) |
| Organization → **Members** | **Read** (collection is team-driven: it lists the classroom GitHub team's members to derive who is enrolled. This is a **separate section** from Repository permissions and only appears once the org is selected as Resource owner — it is **not** implied by any repository scope) |
| Expiry | 1–366 days (fine-grained PATs support up to 1 year); set a calendar reminder to rotate before it expires |

> **Where is "Members"?** It lives under **Organization permissions**, a
> collapsible section shown **only after you pick the org as Resource owner** —
> distinct from the **Repository permissions** section where Contents/Metadata
> live. It is not granted by, or implied by, any repository permission, so a
> Contents-only token passes `gh teacher rotate-service-token`'s Contents check
> yet fails the first API call `collect-scores` makes (listing the classroom
> team). `rotate-service-token` now probes `GET /orgs/{org}/members` too, so a
> Members-less token is rejected at rotation time rather than in a cron run.

> **Group assignments need no extra scope.** For a group assignment the
> autograder runs once in the first-accepter's repo and emits a single score;
> `collect_scores.py` then reads that repo's **collaborators** to fan the score
> out to every group member **on the classroom team** (the owner is always
> credited; a collaborator not on the team, added out-of-band, is excluded). Listing collaborators
> (`GET /repos/{owner}/{repo}/collaborators`) requires only `Metadata: read`,
> which is auto-included on every fine-grained PAT and already implied by the
> `Contents: read` grant above — so the same service token serves individual and
> group assignments. If the collaborator read fails for any reason, the group
> submission still scores for the repo owner and `collect-scores` logs a
> `::warning::` naming the repo.

Supply the PAT to `gh teacher init` via the environment variable (never a flag — command-line PATs leak via shell history):

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher init <org>
```

Or omit it and the CLI prompts for it with hidden TTY input. The token is encrypted with libsodium sealbox before being uploaded to GitHub and is never written to disk.

To rotate an expiring token, create a new one with the same settings and run:

```sh
CLASSROOM50_SERVICE_TOKEN=github_pat_... gh teacher rotate-service-token <org>
```

### 5. GitHub Pages (automatic, but requires Actions to run)

`gh teacher init` enables Pages programmatically via [`POST https://api.github.com/repos/{owner}/{repo}/pages`](https://docs.github.com/en/rest/pages/pages#create-a-github-pages-site) and sets visibility to public via [`PUT https://api.github.com/repos/{owner}/{repo}/pages`](https://docs.github.com/en/rest/pages/pages#update-information-about-a-github-pages-site). The Pages site is built by the `publish-pages.yaml` workflow that `init` commits into the config repo. **The first Pages deployment requires the workflow to run at least once** — either push a commit to the default branch or trigger it manually from the Actions tab. The CLI prints the expected Pages URL (`https://<org>.github.io/classroom50/`) after `init` finishes; it may take a minute to go live.

If `init` warns that the org-level workflow token policy is too restrictive (the endpoint is org-scoped and requires an org owner to change it), you can apply it yourself:

```sh
gh api -X PUT /orgs/<org>/actions/permissions/workflow \
  -f default_workflow_permissions=write \
  -f can_approve_pull_request_reviews=false
```

Similarly, if the reusable workflow access warning fires:

```sh
gh api -X PUT /repos/<org>/classroom50/actions/permissions/access \
  -f access_level=organization
```

### 6. Score collection

Scores are collected by the `collect-scores.yaml` Actions workflow in your `classroom50` config repo. It runs on a nightly cron (`17 4 * * *` UTC) automatically once `init` is done. To trigger it manually:

```sh
gh workflow run collect-scores.yaml --repo <org>/classroom50
gh workflow run collect-scores.yaml --repo <org>/classroom50 -f classroom=<short-name>   # single classroom
```

Or use the **Actions** tab on `<org>/classroom50` → `collect-scores.yaml` → **Run workflow**.

### 7. Verify the service token (`probe-token.yaml`)

After `gh teacher init` / `gh teacher rotate-service-token`, or whenever a collect/regrade run fails with a `401`/`403`, run the probe workflow to confirm the `CLASSROOM50_SERVICE_TOKEN` holds every scope the pipeline needs. It's read-only (no tags pushed, no runs re-run):

```sh
gh workflow run probe-token.yaml --repo <org>/classroom50
```

Or **Actions** tab → `probe-token.yaml` → **Run workflow**. A green run means the token has Contents Read+Write, Actions Read+Write, Administration Read+Write, org Members: Read (including the per-classroom team read), and Metadata. A red run's log lists exactly which scope is missing and how to fix it — re-scope and `gh teacher rotate-service-token <org>`.

---

## GitHub REST API reference

The CLIs call the GitHub REST API through [`go-gh`](https://github.com/cli/go-gh) (`RESTClient`), which resolves paths relative to `https://api.github.com` on github.com or `https://<host>/api/v3` on GitHub Enterprise Server. The `collect_scores.py` script uses Python's `urllib` with a `Bearer` token. No Octokit, no axios, no raw `fetch()`.

### `gh teacher` CLI

| Method | URL | Purpose |
|--------|-----|---------|
| GET | [`https://api.github.com/user`](https://docs.github.com/en/rest/users/users#get-the-authenticated-user) | Verify authenticated identity (whoami) |
| GET | [`https://api.github.com/orgs/{org}`](https://docs.github.com/en/rest/orgs/orgs#get-an-organization) | Check org plan (warn if Pages from a private repo requires Team or Enterprise Cloud) |
| PATCH | [`https://api.github.com/orgs/{org}`](https://docs.github.com/en/rest/orgs/orgs#update-an-organization) | Lock down org member privileges to least-privilege at `init` time. The only enabled member capabilities are private repo creation (`members_can_create_private_repositories: true`) and public Pages creation (`members_can_create_pages: true` + `members_can_create_public_pages: true`, **enforced** so the config repo's public Pages site can publish — re-running init resets it). Everything else is denied: `default_repository_permission: "none"`, and `false` for private Pages, repo delete/transfer, repo visibility change, issue deletion, team creation, dependency-insights viewing, member-invited outside collaborators, and read-access discussion creation. **Public/internal repo creation** is only locked off on GitHub Enterprise Cloud (where "private repos only" exists); on Team/Free that field is skipped because public+private are coupled and the student flow needs private creation. Combined PATCH with a per-field retry on 403/422 so a plan-gated field only warns. |
| GET | [`https://api.github.com/orgs/{org}/actions/permissions`](https://docs.github.com/en/rest/actions/permissions#get-github-actions-permissions-for-an-organization) | Read whether GitHub Actions is enabled for the org |
| PUT | [`https://api.github.com/orgs/{org}/actions/permissions`](https://docs.github.com/en/rest/actions/permissions#set-github-actions-permissions-for-an-organization) | Enable GitHub Actions for the org when it's disabled org-wide |
| POST | [`https://api.github.com/orgs/{org}/repos`](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository) | Create the `classroom50` config repo |
| GET | [`https://api.github.com/repos/{owner}/{repo}`](https://docs.github.com/en/rest/repos/repos#get-a-repository) | Check whether the config repo already exists |
| POST | [`https://api.github.com/repos/{owner}/{repo}/pages`](https://docs.github.com/en/rest/pages/pages#create-a-github-pages-site) | Enable GitHub Pages (workflow build source) |
| PUT | [`https://api.github.com/repos/{owner}/{repo}/pages`](https://docs.github.com/en/rest/pages/pages#update-information-about-a-github-pages-site) | Set Pages visibility to public |
| PUT | [`https://api.github.com/repos/{owner}/{repo}/branches/{branch}/protection`](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection) | Branch protection on the config repo (no force-push, no delete) |
| GET | [`https://api.github.com/repos/{owner}/{repo}/actions/permissions`](https://docs.github.com/en/rest/actions/permissions#get-github-actions-permissions-for-a-repository) | Read whether Actions is enabled for the config repo |
| PUT | [`https://api.github.com/repos/{owner}/{repo}/actions/permissions`](https://docs.github.com/en/rest/actions/permissions#set-github-actions-permissions-for-a-repository) | Re-enable Actions on the config repo when it's off |
| GET | [`https://api.github.com/repos/{owner}/{repo}/actions/permissions/workflow`](https://docs.github.com/en/rest/actions/permissions#get-default-workflow-permissions-for-a-repository) | Read current workflow token policy (detect org-enforced override) |
| PUT | [`https://api.github.com/repos/{owner}/{repo}/actions/permissions/workflow`](https://docs.github.com/en/rest/actions/permissions#set-default-workflow-permissions-for-a-repository) | Set default `GITHUB_TOKEN` to write permissions |
| PUT | [`https://api.github.com/repos/{owner}/{repo}/actions/permissions/access`](https://docs.github.com/en/rest/actions/permissions#set-the-level-of-access-for-workflows-outside-of-the-repository) | Allow reusable workflows from the same org |
| GET | [`https://api.github.com/repos/{owner}/{repo}/actions/secrets/public-key`](https://docs.github.com/en/rest/actions/secrets#get-a-repository-public-key) | Retrieve sealbox public key for encrypting the collect PAT |
| PUT | [`https://api.github.com/repos/{owner}/{repo}/actions/secrets/CLASSROOM50_SERVICE_TOKEN`](https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret) | Upload the encrypted service PAT as an Actions secret |
| GET | [`https://api.github.com/repos/{owner}/{repo}/contents/{path}`](https://docs.github.com/en/rest/repos/contents#get-repository-content) | Read existing files in the config repo (idempotency checks, skeleton probing) |
| GET | [`https://api.github.com/repos/{owner}/{repo}/git/refs/heads/{branch}`](https://docs.github.com/en/rest/git/refs#get-a-reference) | Resolve branch tip SHA before a tree commit |
| GET | [`https://api.github.com/repos/{owner}/{repo}/git/commits/{commit_sha}`](https://docs.github.com/en/rest/git/commits#get-a-commit-object) | Read parent commit metadata |
| POST | [`https://api.github.com/repos/{owner}/{repo}/git/blobs`](https://docs.github.com/en/rest/git/blobs#create-a-blob) | Upload file content as a blob (for tree commits) |
| POST | [`https://api.github.com/repos/{owner}/{repo}/git/trees`](https://docs.github.com/en/rest/git/trees#create-a-tree) | Create a new git tree |
| POST | [`https://api.github.com/repos/{owner}/{repo}/git/commits`](https://docs.github.com/en/rest/git/commits#create-a-commit) | Create a commit object |
| PATCH | [`https://api.github.com/repos/{owner}/{repo}/git/refs/heads/{branch}`](https://docs.github.com/en/rest/git/refs#update-a-reference) | Fast-forward the branch to the new commit (with rebase retry on conflict) |
| GET | [`https://api.github.com/repos/{owner}/{repo}`](https://docs.github.com/en/rest/repos/repos#get-a-repository) | Validate a template repo and read its default branch |
| GET | [`https://api.github.com/users/{username}`](https://docs.github.com/en/rest/users/users#get-a-user) | Resolve a GitHub login to its numeric account ID |
| POST | [`https://api.github.com/orgs/{org}/invitations`](https://docs.github.com/en/rest/orgs/members#create-an-organization-invitation) | Send an org membership invitation |
| GET | [`https://api.github.com/orgs/{org}/memberships/{username}`](https://docs.github.com/en/rest/orgs/members#get-an-organization-membership-for-a-user) | Check a user's org membership state |
| DELETE | [`https://api.github.com/orgs/{org}/memberships/{username}`](https://docs.github.com/en/rest/orgs/members#remove-an-organization-membership-for-a-user) | Remove a user from the org |
| PUT | [`https://api.github.com/repos/{owner}/{repo}/collaborators/{username}`](https://docs.github.com/en/rest/collaborators/collaborators#add-a-repository-collaborator) | Add a repo collaborator (direct invite) |
| DELETE | [`https://api.github.com/repos/{owner}/{repo}/collaborators/{username}`](https://docs.github.com/en/rest/collaborators/collaborators#remove-a-repository-collaborator) | Remove a repo collaborator |
| DELETE | [`https://api.github.com/repos/{owner}/{repo}`](https://docs.github.com/en/rest/repos/repos#delete-a-repository) | Delete a repository (`gh teacher teardown`; requires the `delete_repo` OAuth scope, not granted by default — opt in with `gh teacher login -s delete_repo`) |
| GET | [`https://api.github.com/repos/{owner}/{repo}/releases`](https://docs.github.com/en/rest/releases/releases#list-releases) | Page through all releases to collect every `submit/*` submission (score collection / download) |
| GET | [`https://api.github.com/orgs/{org}/repos`](https://docs.github.com/en/rest/repos/repos#list-organization-repositories) | Page through org repos for `--by-pattern` download mode |
| GET | [`https://api.github.com/repos/{owner}/{repo}/releases/assets/{asset_id}`](https://docs.github.com/en/rest/releases/assets#get-a-release-asset) | Download a `result.json` release asset (`Accept: application/octet-stream`) |
| GET | [`https://api.github.com/classrooms`](https://docs.github.com/en/rest/classroom/classroom#list-classrooms) | List GitHub Classroom classrooms the user administers (org-name `--source` resolution for `migrate`) |
| GET | [`https://api.github.com/classrooms/{classroom_id}`](https://docs.github.com/en/rest/classroom/classroom#get-a-classroom) | Get a single GitHub Classroom by ID (numeric `--source` for `migrate`) |
| GET | [`https://api.github.com/classrooms/{classroom_id}/assignments`](https://docs.github.com/en/rest/classroom/classroom#list-assignments-for-a-classroom) | List a source classroom's assignments (`migrate` discovery) |
| GET | [`https://api.github.com/assignments/{assignment_id}`](https://docs.github.com/en/rest/classroom/classroom#get-an-assignment) | Fetch a source assignment's `starter_code_repository` + deadline (`migrate` discovery) |
| POST | [`https://api.github.com/repos/{template_owner}/{template_repo}/generate`](https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template) | Copy each source starter repo into the target org as a fresh template (`migrate` template copy) |
| PATCH | [`https://api.github.com/repos/{owner}/{repo}`](https://docs.github.com/en/rest/repos/repos#update-a-repository) | Set `is_template: true` on the newly-generated target repo (`migrate` template copy) |
| GET | [`https://api.github.com/repos/{owner}/{repo}/branches/{branch}`](https://docs.github.com/en/rest/branches/branches#get-a-branch) | Wait for the freshly-generated target repo's branch ref to stabilize (`migrate` template copy) |

### `gh student` CLI

| Method | URL | Purpose |
|--------|-----|---------|
| GET | [`https://api.github.com/user`](https://docs.github.com/en/rest/users/users#get-the-authenticated-user) | Verify authenticated identity (whoami, git identity) |
| GET | [`https://api.github.com/user/memberships/orgs/{org}`](https://docs.github.com/en/rest/orgs/members#get-an-organization-membership-for-the-authenticated-user) | Check whether the student is already an org member |
| PATCH | [`https://api.github.com/user/memberships/orgs/{org}`](https://docs.github.com/en/rest/orgs/members#update-an-organization-membership-for-the-authenticated-user) | Accept a pending org invitation |
| POST | [`https://api.github.com/repos/{template_owner}/{template_repo}/generate`](https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template) | Generate the student's assignment repo from the template (templated assignments) |
| POST | [`https://api.github.com/orgs/{org}/repos`](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository) | Create an empty `auto_init` assignment repo (template-less assignments) |
| GET | [`https://api.github.com/repos/{owner}/{repo}`](https://docs.github.com/en/rest/repos/repos#get-a-repository) | Recover from a 422 "repository already exists" during generate |
| PATCH | [`https://api.github.com/repos/{owner}/{repo}`](https://docs.github.com/en/rest/repos/repos#update-a-repository) | Disable issues, projects, and wiki on the new repo (visibility is set to private at generation time) |
| PUT | [`https://api.github.com/repos/{owner}/{repo}/collaborators/{username}`](https://docs.github.com/en/rest/collaborators/collaborators#add-a-repository-collaborator) | Keep the student as an `admin` collaborator on their assignment repo (org-level member-privilege lockdown defangs the org-wide danger of repo-admin) |
| GET | [`https://api.github.com/repos/{owner}/{repo}/branches/{branch}`](https://docs.github.com/en/rest/branches/branches#get-a-branch) | Wait for the template's default branch to stabilize after generate |
| GET | [`https://api.github.com/repos/{owner}/{repo}/git/refs/heads/{branch}`](https://docs.github.com/en/rest/git/refs#get-a-reference) | Resolve branch tip SHA before a tree commit |
| GET | [`https://api.github.com/repos/{owner}/{repo}/git/commits/{commit_sha}`](https://docs.github.com/en/rest/git/commits#get-a-commit-object) | Read parent commit metadata |
| POST | [`https://api.github.com/repos/{owner}/{repo}/git/blobs`](https://docs.github.com/en/rest/git/blobs#create-a-blob) | Upload file content as blobs (used by both `accept` and `submit`) |
| POST | [`https://api.github.com/repos/{owner}/{repo}/git/trees`](https://docs.github.com/en/rest/git/trees#create-a-tree) | Create a new git tree |
| POST | [`https://api.github.com/repos/{owner}/{repo}/git/commits`](https://docs.github.com/en/rest/git/commits#create-a-commit) | Create a commit object |
| PATCH | [`https://api.github.com/repos/{owner}/{repo}/git/refs/heads/{branch}`](https://docs.github.com/en/rest/git/refs#update-a-reference) | Fast-forward the branch to the new commit |
| GET | [`https://api.github.com/repos/{owner}/{repo}/contents/{path}`](https://docs.github.com/en/rest/repos/contents#get-repository-content) | Fetch `.gitignore` and `.github/` from the template repo (`gh student submit` only) |

### `collect_scores.py` (runs inside GitHub Actions, uses `CLASSROOM50_SERVICE_TOKEN`)

| Method | URL | Purpose | Required FG-PAT permission |
|--------|-----|---------|----------------------------|
| GET | [`https://api.github.com/orgs/{org}/teams/{team_slug}/members`](https://docs.github.com/en/rest/teams/members#list-team-members) | List the classroom team's members (team-driven enrollment; the source of the (student, assignment) pairs) | **Organization → Members: Read** |
| GET | [`https://api.github.com/repos/{owner}/{repo}/releases`](https://docs.github.com/en/rest/releases/releases#list-releases) | Page through a student's assignment-repo releases to collect every `submit/*` submission | **Repository → Contents: Read** |
| GET | [`https://api.github.com/repos/{owner}/{repo}/releases/assets/{asset_id}`](https://docs.github.com/en/rest/releases/assets#get-a-release-asset) | Download the `result.json` asset from a release | **Repository → Contents: Read** |
| GET | [`https://api.github.com/repos/{owner}/{repo}/collaborators`](https://docs.github.com/en/rest/collaborators/collaborators#list-repository-collaborators) | List a group repo's collaborators to fan the score out to teammates on the classroom team | **Repository → Metadata: Read** (auto-included) |
| GET / PUT | [`https://api.github.com/orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}`](https://docs.github.com/en/rest/teams/teams#add-or-update-team-repository-permissions) | Grant a classroom staff team (e.g. TAs) its mapped permission on each existing student repo and private in-org template (idempotent GET pre-check, then PUT when missing) | **Repository → Administration: Read and write** |

### `probe_token.py` (runs inside GitHub Actions, uses `CLASSROOM50_SERVICE_TOKEN`)

Read-only. Exercises every scope the token needs so a teacher gets one green/red signal after provisioning or rotating. No writes — write scopes are proven with read-only proxies GitHub gates behind the write permission.

| Method | URL | Purpose | Scope proven |
|--------|-----|---------|--------------|
| GET | [`https://api.github.com/orgs/{org}/members`](https://docs.github.com/en/rest/orgs/members#list-organization-members) | Org-members proxy for the team read | **Organization → Members: Read** |
| GET | [`https://api.github.com/orgs/{org}/teams/{team_slug}/members`](https://docs.github.com/en/rest/teams/members#list-team-members) | The exact per-classroom team read collect makes (also tests team visibility) | **Organization → Members: Read** |
| GET | [`https://api.github.com/repos/{org}/classroom50`](https://docs.github.com/en/rest/repos/repos#get-a-repository) | Config repo readable + `permissions.push` + `permissions.admin` | **Contents: Read**, **Contents: Write** (via `permissions.push`), and **Administration: Write** (via `permissions.admin`) |
| GET | [`https://api.github.com/repos/{org}/classroom50/actions/permissions`](https://docs.github.com/en/rest/actions/permissions#get-github-actions-permissions-for-a-repository) | Reachable only with the Actions permission | **Actions: Read and write** (regrade rerun) |
| GET | [`https://api.github.com/repos/{org}/classroom50/collaborators`](https://docs.github.com/en/rest/collaborators/collaborators#list-repository-collaborators) | Metadata endpoint (group attribution) | **Metadata: Read** (auto-included) |

### `autograde-runner.yaml` (reusable workflow, runs in student repos)

The workflow has `setup`, `grade`, and `set-latest` jobs. `setup` creates the submit tag without executing submission code, validates assignment configuration, and passes the ordered release-file paths to `grade`. `grade` uses `persist-credentials: false`, runs `runner.py` and the autograder, then posts status, publishes the Release, and maintains the Feedback PR on the same runner. `set-latest` serializes updates to the latest pointer. Grading and publishing in the same job is not a credential or hostile-workflow isolation boundary.

| Method | URL | Purpose |
|--------|-----|---------|
| POST | [`https://api.github.com/repos/{owner}/{repo}/statuses/{sha}`](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status) | Post `classroom50/autograde`: `setup` posts acceptance `success`; `grade` posts final `success`, `failure`, or `error` |

The workflow also uses `git tag` + `git push` against the student's repo to create the `submit/<UTC-timestamp>-<short-sha>` tag for branch-triggered runs, and `gh release` subcommands (`view`, `edit`, `upload`, `create`) to publish `result.json` and configured extras on the submission tag release. The latest-pointer flip lives in a separate `set-latest` job with a per-repo concurrency group so concurrent submissions can't race on the read-modify-write.

The runner setup also fetches from GitHub Pages without authentication (public by design):

| Method | URL | Purpose |
|--------|-----|---------|
| GET | `https://{org}.github.io/classroom50/{classroom}/assignments.json` | Load the classroom's assignment manifest (and the per-assignment runtime block for the grade job) |
| GET | `https://{org}.github.io/classroom50/runner.py` | Fetch the runner-side bootstrap (org-level; one per config repo, shared across all classrooms) |
| GET | `https://{org}.github.io/classroom50/{classroom}/autograder.py` | Fetch the classroom default autograder (only when set via `gh teacher autograder set-default` and the assignment has no per-assignment override). 404 → runner publishes a vacuous-pass result. |
| GET | `https://{org}.github.io/classroom50/{classroom}/autograders/{slug}.tar.gz` | Download the per-assignment bundle (entrypoint `autograder.py` plus any sibling fixtures; fetched by `runner.py` at runtime) |

After grading, `runner.py` copies accepted extras into a fresh directory under runner temp and emits only their Release-safe basenames. The existing Release step uploads core output first, then the staged extras. Collection and extra-upload failures warn and continue without changing the grade or suppressing core publication. GitHub Releases remain the durable teacher and student surface.

---

## GitHub Actions workflows

### Scaffolded by `gh teacher init` into each `<org>/classroom50` config repo

| File | Triggers | Purpose |
|------|----------|---------|
| `publish-pages.yaml` | Push to default branch, `workflow_dispatch` | Deploy `assignments.json`, classroom-default `autograder.py` files, autograder workflow shims, the runner-side bootstrap, and per-assignment bundles to GitHub Pages |
| `collect-scores.yaml` | `workflow_dispatch`, cron `17 4 * * *` UTC | Run `collect_scores.py`, aggregate `result.json` assets into `*/scores.json` |
| `probe-token.yaml` | `workflow_dispatch` | Run `probe_token.py` — a read-only check that `CLASSROOM50_SERVICE_TOKEN` holds every scope collect and regrade need. Run it after provisioning/rotating, or when a collect/regrade run 401/403s. |
| `autograde-runner.yaml` (reusable) | Called from each student's `autograde.yaml` | Validated setup, grading and Release publication, then a serialized latest-pointer update |

---

## Environment variables and secrets summary

| Variable / Secret | Where set | Used by | Purpose |
|-------------------|-----------|---------|---------|
| `CLASSROOM50_SERVICE_TOKEN` | `gh teacher init` (Actions secret on `classroom50`) | `collect-scores.yaml`, `collect_scores.py` | Fine-grained PAT for reading student repo releases |
| `GITHUB_TOKEN` / `github.token` | Automatically injected by Actions | `setup`, `grade`, and `set-latest` jobs | Student-repo token used for tag, status, Release, Feedback PR, and latest-pointer operations |
| `GH_TOKEN` | Set from `github.token` only on GitHub-calling shell steps | Tag/status, Release, Feedback PR, and latest-pointer commands | `gh` CLI authentication; not set on the autograder step, though grading and publishing remain in the same job |
| `GH_DEBUG=api` | Developer shell | `go-gh` (teacher & student CLIs) | Log all REST request/response traffic |
| `GITHUB_REPOSITORY_OWNER` | Actions context | `collect_scores.py` | Org name inside the collect workflow |
| `GITHUB_API_URL` | Actions context | `collect_scores.py` | API base URL (supports GitHub Enterprise Server) |
| `GH_API_URL` | Test override | `collect_scores.py` tests | Override API base in unit tests |

The teacher and student CLIs do not use `GITHUB_TOKEN` or `GH_TOKEN`. They read credentials from the `gh` auth store (typically `~/.config/gh/hosts.yml`), populated by `gh teacher login` / `gh student login`.
