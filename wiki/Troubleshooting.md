# Troubleshooting

This page collects known errors and their fixes, grouped by task and titled
with the message you see, so searching the page for the error text usually
lands on the answer. If nothing here matches, see
[Filing an issue](#filing-an-issue).

## See what the CLI is doing

Both CLIs accept `--verbose` / `-v` on any command. It shows each REST call,
response status, raw `git` output, and metadata writes — try it first when
something misbehaves.

```sh
gh student submit -v
gh teacher download -v <org> <classroom> <assignment>
```

For raw REST request/response logging (headers + bodies), set `GH_DEBUG=api`:

```sh
GH_DEBUG=api gh teacher invite <org> <username>
```

Commands with informational output also accept `--quiet` / `-q`.

## Reaching classroom50.org and signing in

### classroom50.org won't load, or is flagged as unsafe

A few ISPs and school web filters have blocked `classroom50.org` (a relatively
new domain) as a suspected phishing site — the symptom is a timeout, a
DNS failure, or an ISP warning page (Safari may just time out without showing
the warning). Classroom 50 is not compromised; we file unblock requests with
ISPs and security vendors as reports come in.

Workarounds:

- **Add an exception.** On a home connection, add `classroom50.org` to the
  ISP's security-feature exception list (e.g. AT&T ActiveArmor) or switch the
  device's DNS resolver (e.g. `1.1.1.1` or `8.8.8.8`).
- **School/district filters:** ask IT to allow the domains in
  [Network and allowed domains](GitHub-Integration#network-and-allowed-domains).
- Please still [report it](https://github.com/foundation50/classroom50/issues)
  with the ISP's name so we can request an unblock.

### "Network error reaching the Cloudflare Worker proxy"

Browser sign-in routes the OAuth exchange through a small Cloudflare Worker,
and this message ("Network error reaching the Cloudflare Worker proxy; it may
be down or unreachable.") means your browser couldn't reach it. Two causes:

- **You're offline.** Check your connection; the app shows a separate
  "You appear to be offline" notice when it can tell.
- **A school or corporate filter blocks the proxy.** Ask IT to allow the
  domains in
  [Network and allowed domains](GitHub-Integration#network-and-allowed-domains),
  or select **Sign in with token** to sign in with a personal access token,
  which skips the proxy entirely.

### `redirect_uri is not associated with this application`

GitHub sometimes shows this during sign-in when a stale authorization is
replayed, often after switching GitHub accounts. Sign out of classroom50.org
and sign in again, or use a private browsing window.

### Is GitHub down?

Everything Classroom 50 does runs on GitHub, so a GitHub incident surfaces as
Classroom 50 failures: assignments stuck publishing, accepts erroring,
collection runs failing. Before debugging, check
[githubstatus.com](https://www.githubstatus.com) (the API, Actions, and Pages
components matter most). It is effectively Classroom 50's status page too.

## Setting up an organization

### My organization doesn't appear

GitHub only reports organizations you've granted Classroom 50 access to. A
GitHub Education account doesn't change this — an organization you own can stay
invisible until that grant exists. Work through these in order:

1. **Grant the organization.** Open
   [Classroom 50's OAuth settings](https://github.com/settings/connections/applications/Ov23liDFFyDtm0pO5NN5)
   and select **Grant** next to the organization. Classroom 50 also links this
   from the "Not seeing your organization?" notice on its home page.
2. **Have an owner approve it.** If the organization restricts third-party
   applications, the same page offers **Request access** instead of **Grant**;
   an owner then approves it under
   `https://github.com/organizations/<org>/settings/oauth_application_policy`.
3. **Authorize SAML SSO.** On that same page, use **Configure SSO** to authorize
   the organization.
4. **Accept the invitation.** An unaccepted invitation shows under pending
   invitations, not in the organization list. Check
   [your organizations](https://github.com/settings/organizations).
5. **Sign out and back in.** A token issued before the membership existed
   authenticates fine but can't see the organization.

Then return to Classroom 50 and use **Refresh** — the organization list is
cached for ten minutes.

To check independently from a terminal:

```sh
gh auth refresh -s read:org,admin:org
gh api user/memberships/orgs --paginate \
  --jq '.[] | [.organization.login, .state, .role] | @tsv'
```

The organization should be listed `active` (and `admin` if you're setting it
up). The CLI token and the web app's token are separate, so a passing check here
still leaves the browser grant to do.

### "Couldn't verify the Actions spending cap"

Setup creates a **$0 GitHub Actions spending cap** so a runaway workflow can't
run up a bill — but only when your organization has no Actions cap yet; a cap
you set yourself is never modified. It then verifies the cap, and that
verification can fail with an advisory warning (e.g. `read failed (400)`) when
billing isn't readable by your token — typically **enterprise-managed
billing**, a plan that doesn't expose organization budgets, or a token without
Organization Administration read.

This is expected and **doesn't block anything** — Classroom 50 keeps working.
Confirm your Actions spending limits in the organization's billing settings, or
with your Enterprise/billing administrator.

### Branch protection "Fix it" does nothing

The setup checks protect student work through two organization rulesets. For
what they do, see
[How student repositories are protected](How-Classroom-50-Works#how-student-repositories-are-protected).

On an enterprise-managed organization, an enterprise-level policy can pin these
settings, so the organization-level change Classroom 50 requests is ignored:
**Fix it** appears to succeed but the check stays red, and only an enterprise
owner can change the setting. Like the spending-cap check, this one is
advisory. Classroom 50 keeps working without it.

### Setup loops between steps 1 and 2

After you add the service token, the setup wizard returns to step 1 and never
reaches step 3. This is stale cached state in the browser: sign out, clear the
browser cache, and sign in again.

### "You have been removed from the team" emails during setup

Creating a classroom sends you two of these emails, for the `-hta` and `-ta`
teams. They're expected: Classroom 50 creates the staff teams using your GitHub
token, which makes you a member of each, then removes you from all but the
`-teacher` team so you hold a single role.

### `git/trees: HTTP 404` on `gh teacher init`

`init` commits workflow files via the Git Data API, which GitHub gates behind
the `workflow` scope. A token without it is rejected with a misleading 404,
leaving `classroom50` with only a README. Re-authenticate:

```sh
gh teacher login
# or add the scope in place:
gh auth refresh -s admin:org,workflow
```

Whether a plain `gh auth login` already granted `workflow` depends on unrelated
prompt choices, which is why this appears on some machines and not others.

### Will `gh teacher login` disturb my existing `gh` setup?

The Classroom 50 CLIs share the GitHub CLI's credential store, so this is worth
knowing if you already use `gh` for other work.

**Running any teacher/student command** (not `login`) never disturbs a working
setup unnecessarily:

- A stored token that already carries the required scopes (`admin:org`,
  `read:org`, `repo`, `workflow`) is **reused untouched**.
- An under-scoped token that `gh` manages (its config file or OS keyring) is
  widened in place with `gh auth refresh` — your existing token is kept, not
  replaced, and no other `gh` settings change.
- An under-scoped token from **`GH_TOKEN` / `GITHUB_TOKEN`** can't be widened by
  `gh`, so you get an error naming the missing scopes: re-issue that token with
  them, or unset the variable and sign in.
- With no stored token at all, the command starts a sign-in for you.

**Running `login` explicitly is the one clobbering path.** `gh teacher login`
wraps `gh auth login`, which mints a **new** token and replaces your stored
github.com auth. When a token already exists, the CLI warns and asks
`Proceed and let gh auth login replace it? [y/N]` — the default is **No**, and
declining leaves your auth untouched and prints the alternatives:

```sh
gh auth refresh -h github.com -s admin:org,read:org,repo,workflow   # widen in place
export GH_TOKEN=<a PAT with those scopes>                           # or bring your own
```

So if `gh` is already set up, you usually don't need `login` at all — just run
the command you want and let it add any missing scope in place.

With **multiple `gh` accounts**, the CLIs use whichever account is active for
github.com (`gh auth status`); switch with `gh auth switch` first. Not sure
whether anything needs fixing? `gh teacher audit <org>` is read-only and a good
first probe.

## Inviting students and managing the roster

### "Missing scope" / 403 on `gh teacher invite`

Org invitations need the `admin:org` scope, which a plain `gh auth login`
doesn't grant. Run:

```sh
gh teacher login
```

The CLI also detects this and logs you in automatically if you skip it.

### "Not an admin" on `gh teacher invite`

You must be an organization owner for `POST /orgs/{org}/invitations` to succeed.
Check under `https://github.com/orgs/<org>/people` — you should show **Owner**.
(Team-based admin isn't enough for the invitation API.)

### "Already a member" / "Pending invite"

The desired state already exists, but the commands react differently:

- `gh teacher roster add` and `roster import` report it and exit 0, so they're
  safe to re-run in scripts.
- Repository invitations (`gh teacher invite <org>/<repo> <username>`) are
  idempotent: re-running updates the collaborator's permission in place.
- Organization invitations (`gh teacher invite <org> <username>`) fail with a
  non-zero exit: GitHub rejects re-invites to a pending or existing member.
  Use `roster add` when you need a re-runnable enrollment path.

### Already an org member, but not on the roster

Adding a student who is **already in your organization** (commonly someone from
a previous course) doesn't put them on the classroom roster, and re-inviting
them does nothing. GitHub won't send a fresh invitation to an existing member,
so the web app reports **"Already a member or already invited — no new
invitation sent"** (and the CLI prints "Already a member" and exits 0). This is
expected: **organization membership and classroom enrollment are separate.** An
invite only covers membership; enrolling an existing member is a different
action.

To enroll students who are already org members:

1. In Classroom 50, open the organization's **Members** page (the People view,
   not a classroom's **Roster** page).
2. Find each student. They show as a member with no classroom, or you can filter
   by "no classroom".
3. Use **Add to classroom** to place them on a classroom's roster and team. To
   do several at once, select the rows and use the bulk **Add to {classroom}**
   action.

Uploading a **roster CSV** or a plain list of usernames on the **Roster** page
also enrolls existing members: the invite is skipped, but they're still added to
the roster and team. A row identified only by an **email address** can't, because
GitHub won't invite an existing member, and Classroom 50 has no way to tell which
account owns that address: the email is skipped instead. From the CLI,
`gh teacher roster add <org> <classroom> <username>` (or `roster import`)
enrolls an existing member the same way.

### Invitations or accepts fail on an organization with SAML SSO

When an organization requires SAML single sign-on, GitHub rejects API calls
made without an authorized SSO session; the underlying error is
`Resource protected by organization SAML enforcement`. Common symptoms:

- Inviting students fails with a 403 even though you're an organization owner.
- A student's accept fails with **"Couldn't confirm your membership. If your
  organization uses single sign-on (SSO), authorize it for this org (or open
  this link from your LMS), then accept again."**

The fix is to establish the SSO session first: sign in to your identity
provider, then to github.com, and authorize SSO for the organization (for the
web app, use **Configure SSO** on
[Classroom 50's OAuth settings](https://github.com/settings/connections/applications/Ov23liDFFyDtm0pO5NN5)).
Then retry the invitation or the accept link.

### `line N: username column is empty` when importing a roster CSV

Every row in a CSV you import with `gh teacher roster import` must carry a
`username`. The line number points at the row in your file whose username cell
is blank, commonly a student who hasn't created or reported a GitHub account
yet, or a leftover row from another export. Fill in the username or remove the
row, then re-run. For the accepted columns, see
[Roster CSV fields](Web-Teacher-Guide#roster-csv-fields).

Importing a copy of the stored `roster.csv` needs two things trimmed. Import
accepts the `username` through `github_id` columns, so a stored roster's trailing
`role` column is rejected first, with an `unexpected header` error naming the
columns to drop. And a student invited by email sits on the roster as a pending
row with no username until they accept, which is valid in the stored file but not
on import. Remove those rows, or wait until the students have joined. The web
app's **Upload** reads the same file without either edit: it accepts a `role`
column and identifies a pending row by its email address.

### The upload says a row can't be imported

The web app's **Upload** reads every row before changing anything, and if any row
carries a value it can't use, it lists those rows and imports none of them. Each
line in the report names the file line and the offending value, so one editing
pass fixes the file. Re-uploading is safe: students already in the classroom are
left alone, so nothing is duplicated by importing the corrected file.

It blocks rather than importing the rows it understood because a bad value usually
means the file isn't what the app thinks it is — a column shifted by one, an
export from another system, or the wrong format selected above the preview. In
that situation "import the good rows" would enroll a handful of people and quietly
drop the rest.

One case is reported but does **not** block: a row with no `github_id`, `username`,
or `email` at all — commonly a student who hasn't given you a GitHub account yet.
There's nothing to correct in that row, so the upload names it and imports everyone
else.

A leading title line is fine. If the first line of a one-column file is a caption
your spreadsheet added (`GitHub Username`, `student_email`), it's recognized as a
heading and skipped rather than treated as a student.

### A row can't be imported because its `github_id` doesn't match an account

The web app's **Upload** reads a `github_id` column as the row's identity and
looks up that account's current username, which is what lets a re-uploaded export
still find a student who renamed their GitHub account. When an id matches no
account, the upload reports that row and stops rather than falling back to the
`username` next to it — a wrong id plus a stale username could invite a stranger
into your organization, so it refuses to guess.

Usually the id was mangled by a spreadsheet: opening `roster.csv` in Excel can
turn `583231` into `5.83231E+05`. Re-export without reformatting that column, or
delete the `github_id` column entirely and let the `username` column identify
each row.

If instead the message says GitHub couldn't be reached to look up the id, your file
is fine — that's a rate limit or a transient error. Wait a moment and upload again.

If it says there were too many `github_id` values to check at once, uploading again
won't help: delete the `github_id` column and let `username` identify each row, or
split the file. This only comes up for a large roster whose students aren't in the
organization yet, since ids for current members are checked for free.

If the id is right but the username beside it is out of date, nothing is blocked:
the upload uses the account the id belongs to, shows both values in the preview,
asks you to confirm, and corrects the stored username.

### "Couldn't prepare the invite … so no invite was sent"

Before emailing an invitation, Classroom 50 sets up the invite team that retains
the address. **No invitation was sent** and nothing was written to the roster, so
there is nothing to cancel. If the message mentions a rate limit or a server
error, wait a moment and invite the student again.

If it repeats, the setup is refusing on purpose, and retrying won't help. Two
causes: a same-named team already exists and can't be made `secret`, or one still
has a member from an interrupted run. Both name the team in the message. Delete
that team on github.com, then invite again. A bulk email upload reports the same
failure per address in its **failed** list rather than with this wording.

### `invite-…` teams you didn't create

Each email invitation gets a `secret` team named `invite-` plus a short hash,
which holds the invited address until that person joins. Seeing one is expected
while an invitation is outstanding. Classroom 50 deletes it once the invitation
has been accepted or cancelled, and clears one left by an expired invitation on a
later roster sync.

To clear them early, use **Clean up invite data** on the classroom's
**Settings** page, which writes anything still recoverable onto the roster
first. `gh teacher teardown <org>` removes every invite team in the
organization. A team whose description reads `classroom50: preparing invite` is
the leftover of an interrupted invitation: it holds no address, and deleting it
on github.com is safe.

### A student's `role` flipped to `teacher` after `roster add`

Expected when the account is on **both** a staff team and the student team.
Classroom 50 doesn't currently disallow dual roles (usually a teacher adding
themselves as a student), and the classroom's GitHub teams — not the `role`
column — are the enrollment authority. The automatic sync refreshes that column
to the account's **highest** role (`teacher > hta > ta > student`), so you'll
see a commit like `[Classroom 50] Sync 0 members into roster: <classroom>`
rewrite an empty/`""` role to `teacher`.

The student enrollment is unchanged: the account still shows a student badge
(alongside the staff one), is graded as a student, and can be unenrolled from
the student side. `roster add` prints a note when the target is already staff.
See [Dual roles](gh-teacher#dual-roles-staff-who-are-also-students). For a
"pure" student, use a separate GitHub account.

## Creating and accepting assignments

### `template … has no commits` on `gh teacher assignment add`

Students generate their repositories from the template, and GitHub can't
generate from an empty repository. The CLI refuses with:

```text
template `<owner>/<repo>` has no commits — add at least one commit (e.g. a README) so students can generate from it, then re-run
```

Push at least one commit (a README is enough) and re-run. If the template does
have commits and an older CLI still reports this, update the CLI: earlier
releases relied on a repository size field that GitHub computes asynchronously,
which misreported freshly pushed repositories.

### Common `gh student accept` errors

| Message | What it means |
| --- | --- |
| "the classroom may not exist yet, or `publish-pages.yaml` may not have run" | Setup isn't finished or Pages hasn't deployed. Wait a few minutes, or ask your teacher. |
| "assignment X is not registered" | A typo, or your teacher hasn't added the assignment yet. |
| "autograder `<name>` not published yet" / "is malformed YAML" | The autograder's YAML is missing or broken; see [below](#autograder-name-not-published-yet-on-gh-student-accept). |
| "template `<owner>/<repo>` is not accessible to you" | The template is private and not shared with you; see ["Template not found"](#template-not-found--404-on-gh-student-accept). |
| "assignment `<X>` has unsupported mode `<mode>`" | The manifest's `mode` is neither `individual` nor `group` (likely hand-edited). Ask your teacher. |
| "Assignment already accepted" | Not an error — your repository already exists and your work is untouched. |

### "Assignment already accepted" on `gh student accept`

You've already accepted; the repo is at
`<org>/<classroom>-<assignment>-<username>`. The CLI short-circuits to protect
your work. Clone it with the URL from `gh repo view <org>/<repo>` if you don't
have it locally.

### The accept page loads forever, or reports "not published yet"

Assignment data reaches students through GitHub Pages, and a Pages deployment
takes at least 20 seconds after every change (longer when GitHub Actions is
queued). The web app's message is "…is not published yet. Ask your teacher to
confirm the file exists in the classroom50 repository and that the publish
workflow has been run." Check in order:

1. Wait a minute and reload the accept link.
2. The teacher confirms the publish workflow succeeded, under the **Actions**
   tab of `<org>/classroom50`.
3. The student has accepted their organization invitation — an unaccepted
   invite also blocks the accept flow (see the
   [accept error table](#common-gh-student-accept-errors)).

### "Template not found" / 404 on `gh student accept`

Only applies to assignments with a template. Check, in order:

1. **The template is readable by the student.** Public always works; a
   private template must be inside your org (see
   [Template visibility](Assignment-Templates#template-visibility)). If it's
   outside, re-add the assignment with an in-org copy or a public template.
   If a student still 404s, confirm they're on the roster (so they're in the
   team).
2. **The repo is flagged as a template** in Settings → Template repository.
3. **The `<assignment>` argument matches the registered slug** (case is
   normalized; spelling must be exact).

### "Couldn't copy the template": OAuth App access restrictions

GitHub's raw 403 says the upstream "organization has enabled OAuth App access
restrictions", and the CLI reports:

```text
couldn't copy the template `<owner>/<repo>`: it is a fork of a repository in the `<upstream-org>` organization, and copying a fork is governed by that organization's third-party app restrictions
```

The template is a **fork** whose upstream lives in another organization, and
GitHub applies the *upstream* organization's app restrictions when copying a
fork, so approving Classroom 50 for your classroom organization can't fix it.
Either ask an owner of the upstream organization to approve the Classroom 50
app there, or (usually better) replace the template with a non-fork copy:
import the repository into your organization as a fresh repository, mark it as
a template, and re-add the assignment.

### "You need admin access to the organization before adding a repository to it."

A 403 when a student's repository is created. Despite the wording, the student
does **not** need admin access, and this is usually **not** a problem with the
template or the assignment. The classroom organization is refusing to let its
members create repositories, so re-running *assignment* setup can't fix it.

Fix it in the org, under Settings → Member privileges → Repository creation:

1. Tick **Repository creation** so members may create repositories.
2. Tick **Private**, and leave **Public** unchecked: students' coursework and any
   reference solutions should not be publicly visible.
3. Have the student accept again.

Re-running **organization setup** in Classroom 50 (Organization settings →
Re-run setup) applies this along with the rest of the audited lockdown, so it's
the better fix if other settings have changed too.

If an enterprise policy pins repository creation at the enterprise level, the
org-level toggle is ignored and only an enterprise owner can change it. In that
case the re-run reports success but the setting stays off.

Other causes produce the same message, so if repository creation is already
enabled, check that the student's org invitation was accepted (a pending invitee
can't create a repository) and that they're a member rather than an outside
collaborator.

### "autograder `<name>` not published yet" on `gh student accept`

The assignment references an autograder workflow whose YAML isn't on Pages. Two
causes:

1. **The file doesn't exist.** This fires only for non-default `--autograder
   <name>` values; `<classroom>/autograders/<name>.yaml` must exist in the
   `classroom50` repository. Ask your teacher to confirm.
2. **`publish-pages.yaml` hasn't run.** A fresh classroom needs one Pages
   deployment. Wait a minute and retry.

("autograder `<name>` is malformed YAML" means the workflow has a syntax error —
`gh student` validates before writing, so a broken file never lands. Ask the
teacher to fix it.)

## Submitting and grading

### `read .../.classroom50.yaml: ... no such file or directory` on `gh student submit`

`submit` reads `.classroom50.yaml` at the repo root to identify the assignment.
Two causes:

- You're running submit from outside the cloned assignment repo, or from a
  clone not created by `gh student accept`. `cd` into the directory the
  `git clone` command created.
- The assignment is an **empty-repository assignment**, whose repos carry no
  marker file. As the error's hint says, autograding is disabled there and
  `gh student submit` is not used: commit and `git push` directly.

### Submit pushed a commit but the teacher sees no new work

`submit` pushes to the repo's actual default branch (`main`, `master`, or
`develop`), and autograding triggers on that branch. If a submission still isn't
graded, confirm the push landed on the default branch and that the autograde
workflow ran under the repo's Actions tab.

### My push didn't grade / the check says "push not graded"

The assignment is in **submit-only mode** (`submission_mode: tag`): plain
pushes don't trigger the autograder there — that's the point (they cost no
Actions minutes). The `classroom50/autograde-skipped` commit status
`tag-mode assignment — push not graded; run gh student submit` is the runner
telling you exactly that (graded commits report under `classroom50/autograde`
instead — a not-graded commit never shows green there). To be graded, submit explicitly:

- `gh student submit` (it pushes the `submit/…` tag that triggers grading), or
- tag a commit yourself: `git tag submit/final && git push origin
  submit/final` — any tag under `submit/` grades, plus any milestone tag
  your teacher named (e.g. `git tag phase1 && git push origin phase1`).

If a push shows NO workflow run at all, that's normal for tag mode too: the
repo's workflow only fires on submission tags.

### My tag ran but the check says "tag is not a submission trigger"

The tag you pushed matches neither `submit/*` nor any milestone tag the
teacher configured for this assignment, so nothing was graded. Check the
milestone names with your teacher (they're case-sensitive), or use
`gh student submit` / a `submit/*` tag, which always grade.

Teachers: if a repo you *expected* to grade on push shows that status, the
repo's shim is still on the every-push trigger while the assignment is
tag-mode (or vice versa) — run
`gh teacher assignment submission-mode <org> <classroom> <slug> --tag` (or
`--every-push`) or the web bulk action to update the repositories, and have students
`git pull` afterward.

### `pytest: not found` or exit code 127 in the grading log

Exit code 127 means the shell couldn't find a command. For Python assignments
this used to mean a missing `pytest`; the built-in autograder now installs
`pytest` and `pytest-json-report` automatically. If a grading run still exits
127:

- The classroom's workflow files predate the fix: refresh them by re-running
  `gh teacher init <org>` and accepting the refresh prompt.
- A custom setup command replaced the Python environment: install the tools
  your tests import there. See the
  [Python recipe](Autograder-Recipes#python).

## Collecting scores and downloading submissions

### `collect-scores` warns "collected 0 submissions"

Almost always means the `CLASSROOM50_SERVICE_TOKEN` can't read the student repos
— not that no one submitted. (A fine-grained PAT returns 404 for
out-of-scope repos, indistinguishable from "no release yet".)

- Confirm the token has **Contents: Read and write on all org repos** (not "Only
  select repositories" — student repos are created on demand) **and Organization
  Members: Read**.
- Re-scope and rotate with `gh teacher rotate-service-token <org>`.
- A `401`/`403` (rather than the `0 submissions` warning) means a bad/expired
  token or a missing `Members: Read` scope.

Also check the assignment itself: with autograding paused or a tag-mode
assignment no one has submitted to, there are no results to collect.

See the [service-token setup](GitHub-Integration#4-fine-grained-pat-for-score-collection).

### "The collection run did not complete successfully."

The submissions page shows this when the latest score-collection workflow
failed outright. Open the failing run under the **Actions** tab of
`<org>/classroom50` (the `collect-scores.yaml` workflow); the log names the
cause. The most common one is an expired or under-scoped service token; see
[`collect-scores` warns "collected 0 submissions"](#collect-scores-warns-collected-0-submissions)
for the token requirements and how to rotate it.

### `gh teacher download` clones nothing

By default `download` is team-driven. If you get zero clones:

- Confirm `<org>/classroom50` exists and the classroom team has members (add them
  with `gh teacher roster add` / `import`).
- Confirm `<assignment>` is registered (`gh teacher assignment list`).
- Verify a few student repos exist under
  `https://github.com/orgs/<org>/repositories?q=<classroom>-<assignment>`.
- Re-run with `-v` to see which members were probed.

If the `classroom50` repository isn't bootstrapped, or you want every matching repo regardless
of the roster, pass `--by-pattern`.

## Building the CLIs from source

### Build fails after a `git pull`

`gh extension install .` registers the binary only the first time. After pulling
new commits, rebuild:

```sh
(cd cli/gh-teacher && go build .)
(cd cli/gh-student && go build .)
```

If `go build` itself fails, run `go mod tidy` first.

## Filing an issue

If none of the above helps, open an issue at
<https://github.com/foundation50/classroom50/issues>. Include:

- The exact command you ran.
- The full output, ideally with `-v` and/or `GH_DEBUG=api`.
- Your `gh --version` and `go version`.
- Your OS and shell.
