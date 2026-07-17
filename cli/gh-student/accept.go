package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/ghui"
	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/localgit"
	"github.com/foundation50/gh-student/internal/reponame"
	"github.com/foundation50/gh-student/internal/ui"
)

// embeddedShimContent is the universal autograder shim — the same body for
// every student repo across every org. The `{{ORG}}` placeholder is
// substituted at accept time so the reusable-workflow `uses:` line points at
// the calling org's classroom50 repo.
//
// Source-of-truth lives at cli/gh-student/embed/autograde-shim.yaml so it's a
// real, lintable YAML file rather than a Go string literal.
//
// NOTE: this asset is filesystem-pinned. //go:embed can't cross directories
// (no ../) and package main is unimportable, so the accept command (which
// embeds and writes this shim) must stay at the module root — the principled
// terminus of the package extraction, not unfinished work. Do NOT "finish"
// the refactor by moving the embed tree into internal/*. See
// docs/solutions/architecture-patterns/embed-terminus-and-build-as-oracle-in-go-package-extraction.md
//
//go:embed embed/autograde-shim.yaml
var embeddedShimContent string

// shimOrgPlaceholder is substituted in embeddedShimContent at accept time so
// each student repo's shim references the correct org's reusable
// autograde-runner workflow. shimBranchPlaceholder is the student repo's
// default branch (the shim's push trigger); shimConfigBranchPlaceholder is the
// config repo's default branch (the reusable-workflow ref), which may not be
// `main` if a config-repo rename could not land.
const (
	shimOrgPlaceholder          = "{{ORG}}"
	shimBranchPlaceholder       = "{{BRANCH}}"
	shimConfigBranchPlaceholder = "{{CONFIG_BRANCH}}"
	defaultConfigRepoBranch     = "main"
)

// renderEmbeddedShim returns the embedded shim with the org, submission-branch,
// and config-branch placeholders substituted. The shim never changes after
// accept — runtime customization, runner edits, and teacher overrides all flow
// through the runner workflow + assignments.json on the teacher's side.
func renderEmbeddedShim(org, branch, configBranch string) string {
	if branch == "" {
		branch = defaultConfigRepoBranch
	}
	if configBranch == "" {
		configBranch = defaultConfigRepoBranch
	}
	out := strings.ReplaceAll(embeddedShimContent, shimOrgPlaceholder, org)
	out = strings.ReplaceAll(out, shimBranchPlaceholder, branch)
	out = strings.ReplaceAll(out, shimConfigBranchPlaceholder, configBranch)
	return out
}

func acceptCmd() *cobra.Command {
	var key string
	cmd := &cobra.Command{
		Use:   "accept <org> <classroom> <assignment>",
		Short: "Accept an assignment from an organization's classroom",
		Long: "Accept an assignment by creating a private repo at\n" +
			"<org>/<classroom>-<assignment>-<username> (lowercased). The\n" +
			"assignment is looked up in the published assignments.json on the\n" +
			"classroom's GitHub Pages site (no token required).\n\n" +
			"If the classroom uses an unlisted URL, your instructor will give\n" +
			"you an access key; pass it with `--key <key>`. The key is part\n" +
			"of the published URL (`<classroom>/<key>/...`); without it the\n" +
			"classroom's assignments can't be found. Normal classrooms need\n" +
			"no key.\n\n" +
			"If the assignment has a template repo (which may live outside\n" +
			"<org>), the new repo is a private copy generated from it. If it\n" +
			"has no template, an empty private repo is created carrying only\n" +
			"the autograder workflow shim.\n\n" +
			"The autograder workflow shim is dropped at\n" +
			"`.github/workflows/autograde.yaml` in the new repo. For the\n" +
			"default autograder it's the universal shim embedded in this\n" +
			"CLI; for a non-default `--autograder <name>` (registered via\n" +
			"`gh teacher assignment add --autograder <name>`) the shim is\n" +
			"fetched from Pages instead. The shim is intentionally inert —\n" +
			"it `uses:` the reusable autograde-runner workflow in the\n" +
			"teacher's config repo, and that workflow fetches the\n" +
			"runner-side bootstrap and the autograder at workflow runtime.\n" +
			"Teacher edits to runtime, dependencies, or grading logic\n" +
			"propagate on the next submission without ever touching the\n" +
			"student repo.\n\n" +
			"If the student has a pending org invite it is auto-accepted first.\n" +
			"After creating the repo, the student is added as a collaborator on\n" +
			"their own repo (`push` for an individual assignment; `admin` for a\n" +
			"group assignment, so the founder can add teammates), and\n" +
			"`.classroom50.yaml` and the autograde workflow are written in a\n" +
			"single Tree commit, then verified.\n\n" +
			"Re-running is safe and self-healing: an already-accepted repo\n" +
			"that is fully provisioned is left in place (its founder role is\n" +
			"reconciled best-effort), but one whose setup never finished (a\n" +
			"prior run interrupted after the repo was created but before the\n" +
			"control files landed) is repaired by re-running the idempotent\n" +
			"provisioning. accept only reports\n" +
			"success once both control files are confirmed present, so an\n" +
			"\"accepted\" repo always autogrades.",
		Example: "  gh student accept cs50 cs50-fall-2026 hello\n" +
			"  gh student accept cs50 cs50-fall-2026 hello --key dhkrm4ih\n",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true

			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			assignment := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || assignment == "" {
				return fmt.Errorf("invalid arguments: org, classroom, and assignment must all be non-empty")
			}

			// The --key access key is the classroom's optional capability-URL
			// secret. Validate before any network call so a typo fails fast
			// instead of surfacing as a confusing 404.
			secret := strings.TrimSpace(key)
			if secret != "" {
				if err := classroomcfg.ValidateSecret(secret); err != nil {
					return err
				}
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}

			out := cmd.OutOrStdout()
			u := ui.New(cmd.ErrOrStderr())

			status, err := checkOrgStatus(client, org)
			if err != nil {
				return err
			}

			// An org owner who creates the repo holds admin and can't
			// self-downgrade to the push we grant; tolerate that residual admin
			// at the founder read-back so an owner can still accept.
			isOwner := status.Role == "admin"

			switch status.StatusCode {
			case http.StatusOK:
				// Auto-accept a pending org invite first.
				if status.State == "pending" {
					acceptStatus, err := acceptOrgInvite(client, org)
					if err != nil {
						return err
					}
					switch acceptStatus.StatusCode {
					case http.StatusOK:
						return acceptAssignment(cmd, client, u, out, org, classroom, assignment, secret, isOwner)
					case http.StatusNotFound:
						return fmt.Errorf("%s: no membership found for accept", org)
					case http.StatusForbidden:
						return fmt.Errorf("%s: blocked from accepting invite", org)
					case http.StatusUnprocessableEntity:
						return fmt.Errorf("%s: spam detection (422) triggered for accept", org)
					default:
						return fmt.Errorf("%s: unknown accept status received (%d)", org, acceptStatus.StatusCode)
					}
				}
			case http.StatusNotFound:
				return fmt.Errorf("%s: no membership found", org)
			case http.StatusForbidden:
				return fmt.Errorf("%s: forbidden", org)
			default:
				return fmt.Errorf("%s: unknown status received (%d)", org, status.StatusCode)
			}

			return acceptAssignment(cmd, client, u, out, org, classroom, assignment, secret, isOwner)
		},
	}

	cmd.Flags().StringVar(&key, "key", "", "Access key for a classroom that uses an unlisted URL (provided by your instructor); omit for normal classrooms")
	return cmd
}

type OrgStatus struct {
	State      string
	Role       string
	StatusCode int
}

// checkOrgStatus returns the authed user's membership in org.
func checkOrgStatus(client githubapi.Client, org string) (OrgStatus, error) {
	path := fmt.Sprintf("user/memberships/orgs/%s", url.PathEscape(org))
	var resp struct {
		State string `json:"state"`
		Role  string `json:"role"`
	}
	if err := client.Get(path, &resp); err != nil {
		if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); ok {
			return OrgStatus{
				StatusCode: httpErr.StatusCode,
			}, nil
		}

		return OrgStatus{}, fmt.Errorf("GET %s: %w", path, err)
	}

	return OrgStatus{
		State:      resp.State,
		Role:       resp.Role,
		StatusCode: http.StatusOK,
	}, nil
}

type AcceptStatus struct {
	StatusCode int
}

// acceptOrgInvite PATCHes the user's pending org membership to "active".
func acceptOrgInvite(client githubapi.Client, org string) (AcceptStatus, error) {
	body, err := json.Marshal(map[string]string{"state": "active"})
	if err != nil {
		return AcceptStatus{}, fmt.Errorf("encode body: %w", err)
	}

	path := fmt.Sprintf("user/memberships/orgs/%s", url.PathEscape(org))
	if err := client.Patch(path, bytes.NewReader(body), nil); err != nil {
		if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); ok {
			return AcceptStatus{
				StatusCode: httpErr.StatusCode,
			}, nil
		}

		return AcceptStatus{}, fmt.Errorf("PATCH %s: %w", path, err)
	}

	return AcceptStatus{StatusCode: http.StatusOK}, nil
}

// checkAcceptableMode rejects an unrecognized mode (which can't map to a repo
// role). Group-shape coherence is a separate check (assertModeCoherentForCreate).
func checkAcceptableMode(assignment, mode string) error {
	if mode != "" && mode != contract.ModeIndividual && mode != contract.ModeGroup {
		return fmt.Errorf("assignment %q has unsupported mode %q", assignment, mode)
	}
	return nil
}

// assertModeCoherentForCreate rejects a group-shaped entry (max_group_size >= 2)
// whose mode isn't `group`: fresh-founding it would under-privilege the founder
// and break `gh student invite`. Only on fresh create — a healthy repo must
// still reconcile even if a later-published entry drifted incoherent.
func assertModeCoherentForCreate(assignment, mode string, maxGroupSize int) error {
	if maxGroupSize > 0 && mode != contract.ModeGroup {
		return fmt.Errorf("assignment %q has max_group_size %d but mode %q (want %q) — its published metadata is inconsistent; ask your instructor to re-run `gh teacher assignment add`",
			assignment, maxGroupSize, mode, contract.ModeGroup)
	}
	return nil
}

func acceptAssignment(cmd *cobra.Command, client githubapi.Client, u *ui.UI, out io.Writer, org, classroom, assignment, secret string, isOwner bool) error {
	verbose, _ := cmd.Flags().GetBool("verbose")

	// The acceptor owns the repo, so capture their immutable id and the
	// accept time alongside the login (rename-safe github_id identity).
	username, ownerID, err := githubapi.CurrentUser(client)
	if err != nil {
		return fmt.Errorf("retrieving authed user: %w", err)
	}
	acceptedAt := time.Now().UTC().Format(time.RFC3339)

	// 1) Look up the assignment entry on the public Pages site (no token).
	//    The entry carries the template ref, mode, and autograder ref.
	//    `secret` (the --key value) selects the `<classroom>/<secret>/...`
	//    path for a protected classroom, else "" — it must arrive via --key
	//    since students can't read the config repo.
	lookup := u.Spinner(fmt.Sprintf("Looking up %s in %s/%s", assignment, org, classroom))
	lookup.Start()
	entry, err := assignments.FetchEntry(cmd.Context(), org, classroom, secret, assignment)
	if err != nil {
		lookup.Fail(fmt.Sprintf("Looking up %s", assignment))
		return err
	}
	lookup.Stop(fmt.Sprintf("Found assignment %s", assignment))
	// The first accepter accepts a group assignment normally: the repo is
	// created under their name and they add teammates via
	// `gh student invite <org>/<repo> <teammate>`. Only an unknown mode errors.
	if err := checkAcceptableMode(assignment, entry.Mode); err != nil {
		return err
	}
	// A template, when present, must be complete. A template-less assignment
	// (no template block) is accepted as an empty repo carrying only the
	// autograder shim — see the hasTemplate fork below.
	hasTemplate := entry.HasTemplate()
	if entry.Template != nil && !hasTemplate {
		return fmt.Errorf("assignment %q has an incomplete template ref (owner=%q repo=%q branch=%q) — ask your instructor to re-run `gh teacher assignment add`",
			assignment, entry.Template.Owner, entry.Template.Repo, entry.Template.Branch)
	}
	// empty_repo and template are mutually exclusive at write time, but
	// publish-pages publishes assignments.json verbatim, so a hand-edited
	// entry can carry both. Fail closed rather than half-apply (the template
	// fork would generate starter content, then the bare fork would skip every
	// control file — a templated repo the grading pipeline ignores).
	if entry.EmptyRepo && entry.Template != nil {
		return fmt.Errorf("assignment %q sets both empty_repo and a template — the entry is invalid; ask your instructor to re-run `gh teacher assignment add`", assignment)
	}

	// 2) Resolve the autograder shim. A non-default (Pages-fetched) autograder
	//    is teacher-authored and resolved up front so a fetch failure doesn't
	//    leave a half-baked repo. The default (embedded) shim is rendered AFTER
	//    the repo is created, because its `on: push: branches` must match the
	//    assignment repo's actual default branch (which GitHub, not the template,
	//    decides) and its `uses:` ref must match the config repo's branch. An
	//    empty_repo assignment never carries the shim (nothing is committed at
	//    all), so skip resolution entirely.
	autograderName := entry.ResolveAutograder()
	useDefaultShim := autograderName == contract.DefaultAutograderName
	var shim string
	if !useDefaultShim && !entry.EmptyRepo {
		workflow, err := assignments.FetchAutograderWorkflow(cmd.Context(), org, classroom, secret, autograderName)
		if err != nil {
			return err
		}
		shim = workflow.Content
	}

	// 3) Create the assignment repo (templated → generate; template-less →
	//    empty auto-init'd; empty_repo → bare, no initial commit).
	//    Already-exists is NOT a terminal short-circuit: a prior accept may
	//    have created the repo but died before landing the control files
	//    (seeding lag, transient 5xx, Ctrl-C), leaving a repo that looks
	//    accepted but never autogrades. The probe below heals that. Mirrors
	//    the GUI's accept.
	var (
		htmlURL        string
		fullName       string
		alreadyExisted bool
		commitBranch   string
		cfgSource      *classroomcfg.Source
	)
	createMsg := fmt.Sprintf("Creating private repo for %s", assignment)
	createSp := u.Spinner(createMsg)
	createSp.Start()
	if hasTemplate {
		var genBranch string
		htmlURL, fullName, genBranch, alreadyExisted, err = createTemplatedPrivateAssignmentRepoInOrg(client, u, verbose, username, classroom, assignment, org, *entry.Template)
		// The generated repo's own default branch — not the template's branch —
		// is where control files land and what the shim must trigger on.
		commitBranch = genBranch
		// Resolve the template owner's immutable id best-effort so a rename
		// of the template org/user doesn't break submit's instructor-file
		// re-fetch. A failed lookup is non-fatal — leave owner_id null.
		templateOwnerID := lookupUserID(client, entry.Template.Owner)
		if templateOwnerID == nil && verbose {
			u.Detail("could not resolve template owner id for %q; recording source.owner_id as null", entry.Template.Owner)
		}
		cfgSource = &classroomcfg.Source{
			Owner:   entry.Template.Owner,
			OwnerID: templateOwnerID,
			Repo:    entry.Template.Repo,
			Branch:  entry.Template.Branch,
		}
	} else {
		var defaultBranch string
		htmlURL, fullName, defaultBranch, alreadyExisted, err = createEmptyPrivateAssignmentRepoInOrg(client, u, verbose, username, classroom, assignment, org, !entry.EmptyRepo)
		commitBranch = defaultBranch
	}
	if err != nil {
		createSp.Fail(createMsg)
		return err
	}

	// Render the default shim now that the assignment repo's default branch is
	// known: `on: push: branches` targets commitBranch, and the reusable-workflow
	// `uses:` ref targets the config repo's actual default branch. On a read
	// failure, fall back to the assignment repo's own branch (commitBranch), not
	// a hardcoded `main` — a wrong `@main` ref would 404 the runner and silently
	// skip grading on a master-default org. An empty_repo assignment commits no
	// shim at all, so skip the render (and its config-branch read).
	if useDefaultShim && !entry.EmptyRepo {
		configBranch, cbErr := resolveConfigRepoBranch(client, org)
		if cbErr != nil {
			if verbose {
				u.Detail("could not read %s/classroom50 default branch (%v); pinning shim to %q", org, cbErr, commitBranch)
			}
			configBranch = commitBranch
		}
		shim = renderEmbeddedShim(org, commitBranch, configBranch)
	}

	repoName := reponame.Name(classroom, assignment, username)
	return acceptIntoRepo(client, u, verbose, out, acceptRepoParams{
		org:            org,
		classroom:      classroom,
		assignment:     assignment,
		mode:           entry.Mode,
		maxGroupSize:   entry.MaxGroupSize,
		secret:         secret,
		username:       username,
		ownerID:        &ownerID,
		acceptedAt:     acceptedAt,
		repoName:       repoName,
		branch:         commitBranch,
		source:         cfgSource,
		shim:           shim,
		autograderName: autograderName,
		emptyRepo:      entry.EmptyRepo,
		fullName:       fullName,
		htmlURL:        htmlURL,
		alreadyExisted: alreadyExisted,
		isOwner:        isOwner,
		createSp:       createSp,
		createMsg:      createMsg,
	})
}

// acceptRepoParams carries the post-create inputs acceptIntoRepo needs.
// Splitting this tail out of acceptAssignment makes the self-heal fork
// testable end-to-end against an httptest GitHub server, without the up-front
// Pages fetch.
type acceptRepoParams struct {
	org, classroom, assignment string
	mode                       string
	maxGroupSize               int
	secret                     string
	username, repoName, branch string
	ownerID                    *int64
	acceptedAt                 string
	source                     *classroomcfg.Source
	shim, autograderName       string
	// emptyRepo selects the bare path: no control files are committed and no
	// marker probe runs — the only provisioning is the idempotent admin grant.
	emptyRepo         bool
	fullName, htmlURL string
	alreadyExisted    bool
	// isOwner tolerates an org owner's unavoidable residual admin at the
	// founder read-back (they can't self-downgrade to push).
	isOwner   bool
	createSp  *ghui.Spinner
	createMsg string
}

// acceptIntoRepo decides whether a just-created-or-existing repo needs
// provisioning, runs the idempotent provisioning when it does, and emits the
// final report. It is the self-healing fork:
//
//   - alreadyExisted + marker present → already accepted; best-effort reconcile
//     of the founder's role (heals a stale admin grant down), then report.
//   - alreadyExisted + marker missing → half-finished prior accept; re-run
//     the idempotent provisioning to repair it.
//   - freshly created → provision normally.
func acceptIntoRepo(client githubapi.Client, u *ui.UI, verbose bool, out io.Writer, p acceptRepoParams) error {
	// The bare (empty_repo) path never commits control files, so the marker
	// probe below is meaningless: an existing repo IS an accepted repo. The
	// only provisioning is the founder grant — an idempotent upsert, so re-run
	// it unconditionally to heal a prior accept that died between create and
	// grant.
	if p.emptyRepo {
		return acceptIntoBareRepo(client, u, verbose, out, p)
	}
	if p.alreadyExisted {
		provisioned, perr := repoFileExists(client, p.org, p.repoName, classroomcfg.MetadataPath)
		if perr != nil {
			p.createSp.Fail(p.createMsg)
			return perr
		}
		if provisioned {
			// Already accepted: reconcile the role best-effort. The repo is
			// already healthy, so a transient/SSO-403/left-org failure must not
			// fail a re-run that previously always succeeded — warn and report.
			if err := inviteFounder(client, u, verbose, p.username, p.org, p.repoName, founderPermission(p.mode), p.isOwner); err != nil && verbose {
				u.Detail("could not reconcile %s's role on %s/%s (repo already accepted; leaving as-is): %v", p.username, p.org, p.repoName, err)
			}
			p.createSp.Stop(fmt.Sprintf("Repo already exists: %s", p.fullName))
			return reportAlreadyAccepted(u, out, p.fullName, p.htmlURL)
		}
		// The ✓ here marks the completed probe (setup found incomplete), not
		// the repair — the following setup spinner reports that with its own
		// ✓/✗, so a failed re-provision isn't preceded by a success glyph.
		p.createSp.Stop(fmt.Sprintf("Found incomplete setup: %s", p.fullName))
	} else {
		p.createSp.Stop(fmt.Sprintf("Created %s", p.fullName))
	}

	// Fresh create (or heal of a never-finished accept): a group-shaped entry
	// whose mode isn't group would found the repo under-privileged, so reject
	// incoherent metadata here — not on the already-accepted path above.
	if err := assertModeCoherentForCreate(p.assignment, p.mode, p.maxGroupSize); err != nil {
		return err
	}

	// Provision (or repair) the repo. Every step is idempotent, so this is
	// safe whether the repo was just created or is being healed.
	cfg := classroomcfg.Config{
		Schema:     classroomcfg.SchemaRepoConfigV1,
		Classroom:  p.classroom,
		Assignment: p.assignment,
		Secret:     p.secret,
		Owner: &classroomcfg.Identity{
			Username:   p.username,
			ID:         p.ownerID,
			AcceptedAt: p.acceptedAt,
		},
		Source: p.source,
	}
	if err := provisionAcceptedRepo(client, u, verbose, p, cfg); err != nil {
		return err
	}

	if p.alreadyExisted {
		return reportAlreadyAccepted(u, out, p.fullName, p.htmlURL)
	}
	return reportAccepted(u, out, p.fullName, p.htmlURL)
}

// acceptIntoBareRepo is acceptIntoRepo's empty_repo twin: no control files, no
// marker probe, no read-back of a marker. The repo has no commits (auto_init
// false), so the sole provisioning step is the founder role grant — the same
// least-privilege rule as the normal path (`push` for individual, `admin` for
// group). It splits on alreadyExisted like the templated path: a healthy
// already-accepted repo reconciles the grant best-effort (a transient failure
// must not fail a re-run), while a fresh create hard-fails the grant and first
// asserts mode/size coherence.
func acceptIntoBareRepo(client githubapi.Client, u *ui.UI, verbose bool, out io.Writer, p acceptRepoParams) error {
	if p.alreadyExisted {
		p.createSp.Stop(fmt.Sprintf("Repo already exists: %s", p.fullName))

		// Already accepted: reconcile the role best-effort, matching the
		// templated already-accepted path. The bare repo is already healthy
		// (its only provisioning is this grant), so a transient/SSO-403/
		// left-org failure must not fail a re-run that previously succeeded.
		if err := inviteFounder(client, u, verbose, p.username, p.org, p.repoName, founderPermission(p.mode), p.isOwner); err != nil && verbose {
			u.Detail("could not reconcile %s's role on %s/%s (repo already accepted; leaving as-is): %v", p.username, p.org, p.repoName, err)
		}
		return reportAlreadyAccepted(u, out, p.fullName, p.htmlURL)
	}
	p.createSp.Stop(fmt.Sprintf("Created %s", p.fullName))

	// Fresh create: a group-shaped entry whose mode isn't group would found
	// the repo under-privileged, so reject incoherent metadata before the
	// grant — same guard the templated fresh-create path runs.
	if err := assertModeCoherentForCreate(p.assignment, p.mode, p.maxGroupSize); err != nil {
		return err
	}

	if err := inviteFounder(client, u, verbose, p.username, p.org, p.repoName, founderPermission(p.mode), p.isOwner); err != nil {
		return err
	}

	return reportBareAccepted(u, out, p.fullName, p.htmlURL)
}

// provisionAcceptedRepo brings a just-created (or partially-provisioned)
// student repo to a healthy, autogradable state and is safe to re-run:
//
//  1. Grant the founder their repo role (PUT collaborators is an upsert):
//     `push` for an individual assignment, `admin` for group.
//  2. Land .classroom50.yaml + the autograde shim in one Tree commit,
//     riding out GitHub's post-create git-data lag.
//  3. Verify the accept marker is readable before declaring success, so
//     "accepted" always means "will autograde".
//
// The single caller (acceptIntoRepo) covers both the fresh-create and heal
// paths. Mirrors the GUI's provisionAcceptedRepo so CLI and GUI heal a
// half-finished accept identically.
func provisionAcceptedRepo(client githubapi.Client, u *ui.UI, verbose bool, p acceptRepoParams, cfg classroomcfg.Config) error {
	// Individual founders get least-privilege `push` (enough to push and
	// trigger autograding); group founders get `admin` (needed to manage
	// collaborators for `gh student invite`). See founderPermission.
	if err := inviteFounder(client, u, verbose, p.username, p.org, p.repoName, founderPermission(p.mode), p.isOwner); err != nil {
		return err
	}

	// DropFiles lands both control files in one Tree commit, waiting out
	// GitHub's post-create replication lag; the spinner animates throughout
	// (no numeric counter — the wait has no guaranteed bound).
	const setupMsg = "Setting up autograder and metadata"
	setupSp := u.Spinner(setupMsg)
	setupSp.Start()
	if err := classroomcfg.DropFiles(client, p.org, p.repoName, p.branch, cfg, p.shim); err != nil {
		setupSp.Fail(setupMsg)
		return err
	}
	setupSp.Stop("Autograder and metadata configured")
	if verbose {
		u.Detail("wrote %s and %s in %s/%s (autograder %q)",
			classroomcfg.MetadataPath, classroomcfg.AutogradeWorkflowPath, p.org, p.repoName, p.autograderName)
	}

	// Read-back: a successful commit PATCH isn't proof the repo is readable
	// yet, so confirm the marker before reporting accepted.
	if err := verifyProvisioned(client, p.org, p.repoName); err != nil {
		return err
	}
	return nil
}

// verifyProvisioned confirms the repo is autogradable before accept reports
// success. DropFiles lands both control files in ONE atomic Tree commit, so
// checking the accept marker (.classroom50.yaml) alone is sufficient.
//
// The read-back uses the CONTENTS API, which can briefly lag the just-landed
// git-data commit (the eventual-consistency window WaitForStableBranch
// absorbs on the branches API). So a single 404 isn't definitive: poll with a
// short backoff and only fail — with an actionable re-run hint — when the
// marker is still missing.
func verifyProvisioned(client githubapi.Client, org, repoName string) error {
	var lastErr error
	for attempt := range verifyProvisionAttempts {
		ok, err := repoFileExists(client, org, repoName, classroomcfg.MetadataPath)
		if err != nil {
			return fmt.Errorf("verifying %s/%s/%s after setup: %w", org, repoName, classroomcfg.MetadataPath, err)
		}
		if ok {
			return nil
		}
		lastErr = fmt.Errorf("%s/%s was created but %s is missing after setup — re-run `gh student accept %s %s %s` to finish provisioning (it is safe to re-run)",
			org, repoName, classroomcfg.MetadataPath, org, classroomFromRepo(repoName), repoName)
		if attempt < verifyProvisionAttempts-1 {
			time.Sleep(time.Duration(attempt+1) * verifyProvisionBackoff)
		}
	}
	return lastErr
}

// verifyProvisionAttempts / verifyProvisionBackoff bound the read-back poll
// (~4s total). Vars, not consts, so tests can shrink the backoff.
var (
	verifyProvisionAttempts = 5
	verifyProvisionBackoff  = 400 * time.Millisecond
)

// repoFileExists reports whether `path` is readable on org/repoName via the
// contents API. 404 → false; other errors propagate so a transient failure
// isn't misread as "missing".
func repoFileExists(client githubapi.Client, org, repoName, path string) (bool, error) {
	apiPath := fmt.Sprintf("repos/%s/%s/contents/%s",
		url.PathEscape(org), url.PathEscape(repoName), classroomcfg.EscapeContentPath(path))
	if err := client.Get(apiPath, nil); err != nil {
		if classroomcfg.IsHTTPNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("GET %s: %w", apiPath, err)
	}
	return true, nil
}

// classroomFromRepo recovers the classroom slug from a derived repo name
// (<classroom>-<assignment>-<username>) for the re-run hint. Best-effort: the
// hint is advisory, so a non-conforming name yields the leading segment.
func classroomFromRepo(repoName string) string {
	if i := strings.IndexByte(repoName, '-'); i > 0 {
		return repoName[:i]
	}
	return repoName
}

// is422AlreadyExists matches "already exists" (case-insensitive) in
// the 422 message or any Errors[] item.
func is422AlreadyExists(httpErr *githubapi.HTTPError) bool {
	if strings.Contains(strings.ToLower(httpErr.Message), "already exists") {
		return true
	}
	for _, item := range httpErr.Errors {
		if strings.Contains(strings.ToLower(item.Message), "already exists") {
			return true
		}
	}
	return false
}

// reportAccepted writes the success header + clone instructions on stdout
// (machine-stable, scriptable). The per-step spinners already rendered
// human-channel progress, so this doesn't duplicate the headline onto stderr.
func reportAccepted(u *ui.UI, out io.Writer, fullName, htmlURL string) error {
	_, _ = fmt.Fprintf(out, "Assignment accepted: %s\n\n", fullName)
	return printCloneInstructions(u, out, htmlURL)
}

// reportBareAccepted is reportAccepted's empty_repo variant: the repo has no
// commits, so cloning yields an empty checkout and there is no autograding to
// mention. Says so explicitly, since a student expecting starter code (or a
// grade) would otherwise read the emptiness as a broken accept.
func reportBareAccepted(u *ui.UI, out io.Writer, fullName, htmlURL string) error {
	_, _ = fmt.Fprintf(out, "Assignment accepted: %s\n\n", fullName)
	_, _ = fmt.Fprintln(out, "This assignment uses an empty repository: it has no starter files, and")
	_, _ = fmt.Fprintln(out, "autograding is disabled. Clone it, then create and push your own work.")
	_, _ = fmt.Fprintln(out)
	return printCloneInstructions(u, out, htmlURL)
}

// reportAlreadyAccepted writes the re-run message; the existing repo is never
// touched.
func reportAlreadyAccepted(u *ui.UI, out io.Writer, fullName, htmlURL string) error {
	_, _ = fmt.Fprintf(out, "Assignment already accepted: %s\n\n", fullName)
	_, _ = fmt.Fprintln(out, "Your existing repository contains your latest submissions and commits.")
	_, _ = fmt.Fprintln(out)
	return printCloneInstructions(u, out, htmlURL)
}

// printCloneInstructions writes the clone block on stdout (scriptable) and
// warns on the human channel if cwd is inside a Git repo (nested clones are
// confusing).
func printCloneInstructions(u *ui.UI, out io.Writer, htmlURL string) error {
	root, insideRepo, err := localgit.CurrentGitRoot()
	if err != nil {
		return err
	}
	if insideRepo {
		u.Warn("you are currently inside a Git repository (%s) — clone from a parent/workspace directory to avoid nesting repositories", root)
		_, _ = fmt.Fprintln(out, "Clone from a parent/workspace directory to avoid nesting repositories:")
	} else {
		_, _ = fmt.Fprintln(out, "Clone it with:")
	}
	_, _ = fmt.Fprintln(out)
	_, _ = fmt.Fprintf(out, "  git clone %s.git\n\n", htmlURL)
	return nil
}

// lookupUserID resolves a GitHub login to its immutable numeric id via
// GET /users/{username}, best-effort: any failure (404, transient 5xx,
// rate-limit) returns nil so the caller records owner_id as null rather than
// aborting the accept.
func lookupUserID(client githubapi.Client, username string) *int64 {
	var user struct {
		ID int64 `json:"id"`
	}
	if err := client.Get(fmt.Sprintf("users/%s", url.PathEscape(username)), &user); err != nil {
		return nil
	}
	return &user.ID
}

type GeneratedRepo struct {
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	HTMLURL       string `json:"html_url"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`

	HasIssues   bool `json:"has_issues"`
	HasProjects bool `json:"has_projects"`
	HasWiki     bool `json:"has_wiki"`
}

// createTemplatedPrivateAssignmentRepoInOrg generates a private repo from the
// entry's template and disables issues/projects/wiki. 404 on generate →
// cross-org visibility message (template not readable by the student).
// 422-already-exists → alreadyExisted=true and the PATCH is skipped so
// re-runs don't disturb an existing repo.
func createTemplatedPrivateAssignmentRepoInOrg(client githubapi.Client, u *ui.UI, verbose bool, username, classroom, assignment, org string, tmpl assignments.TemplateRef) (htmlURL, fullName, defaultBranch string, alreadyExisted bool, err error) {
	newRepoName := reponame.Name(classroom, assignment, username)
	createBody, err := json.Marshal(map[string]any{
		"owner":   org,
		"name":    newRepoName,
		"private": true,
	})
	if err != nil {
		return "", "", "", false, fmt.Errorf("error encoding json for template: %w", err)
	}

	createPath := fmt.Sprintf("repos/%s/%s/generate", url.PathEscape(tmpl.Owner), url.PathEscape(tmpl.Repo))

	var created GeneratedRepo
	if err := client.Post(createPath, bytes.NewReader(createBody), &created); err != nil {
		if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); ok {
			switch httpErr.StatusCode {
			case http.StatusUnprocessableEntity:
				if is422AlreadyExists(httpErr) {
					getPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(newRepoName))
					if getErr := client.Get(getPath, &created); getErr != nil {
						return "", "", "", false, fmt.Errorf("POST %s returned 422 and follow-up GET %s failed: %w", createPath, getPath, getErr)
					}
					return created.HTMLURL, created.FullName, defaultBranchOrMain(created.DefaultBranch), true, nil
				}
			case http.StatusNotFound:
				return "", "", "", false, fmt.Errorf("template `%s/%s` is not accessible to you — ask your instructor to make it public or grant your account access",
					tmpl.Owner, tmpl.Repo)
			}
		}
		return "", "", "", false, fmt.Errorf("POST %s: %w", createPath, err)
	}

	patchBody, err := json.Marshal(map[string]any{
		"has_issues":   false,
		"has_projects": false,
		"has_wiki":     false,
	})
	if err != nil {
		return "", "", "", false, fmt.Errorf("patch body encode error: %w", err)
	}

	patchPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(newRepoName))

	var updated GeneratedRepo
	if err := client.Patch(patchPath, bytes.NewReader(patchBody), &updated); err != nil {
		return "", "", "", false, fmt.Errorf("created %s/%s, but failed to disable issues/projects/wiki: %w", org, newRepoName, err)
	}

	if verbose {
		u.Detail("created private repo %s, with issues/projects/wiki disabled: %s",
			updated.FullName, updated.HTMLURL)
	}

	// Prefer the PATCH response's default_branch, falling back to the generate
	// response — a template generated into a `master`-defaulting org yields a
	// `master` repo regardless of the template's own branch name.
	genBranch := updated.DefaultBranch
	if genBranch == "" {
		genBranch = created.DefaultBranch
	}
	// The generate/PATCH echoes (and an immediate GET) can report a stale
	// default_branch: right after generate GitHub reports the org default
	// (`main`) while the template's real branch (e.g. `master`) hasn't been
	// copied yet. Wait for the branch to actually materialize and use that, so a
	// `master`-default template doesn't pin the shim + commit at a `heads/main`
	// ref that never exists.
	genBranch = githubapi.ResolveSettledDefaultBranch(client, org, newRepoName, defaultBranchOrMain(genBranch))
	return updated.HTMLURL, updated.FullName, defaultBranchOrMain(genBranch), false, nil
}

// createEmptyPrivateAssignmentRepoInOrg creates an empty private repo for a
// template-less assignment via POST /orgs/{org}/repos (mirroring gh-teacher's
// ensureConfigRepo). autoInit true (the shim-only path) is load-bearing: it
// gives the repo an initial commit + default branch so the shared
// WaitForStableBranch poll and the fresh-repo Tree-commit retry both work
// unchanged. autoInit false (the empty_repo path) leaves the repo with no
// commits and no branches at all — the caller must not attempt any commit.
// Returns the repo's default_branch so the shim caller commits onto the right
// ref (for a no-auto_init repo it is only GitHub's configured default, which
// materializes on the student's first push). issues/projects/wiki are disabled
// like the templated path. 422-already-exists → alreadyExisted=true and the
// PATCH is skipped so re-runs don't disturb an existing repo.
func createEmptyPrivateAssignmentRepoInOrg(client githubapi.Client, u *ui.UI, verbose bool, username, classroom, assignment, org string, autoInit bool) (htmlURL, fullName, defaultBranch string, alreadyExisted bool, err error) {
	newRepoName := reponame.Name(classroom, assignment, username)
	createBody, err := json.Marshal(map[string]any{
		"name":      newRepoName,
		"private":   true,
		"auto_init": autoInit,
	})
	if err != nil {
		return "", "", "", false, fmt.Errorf("error encoding json for empty repo: %w", err)
	}

	createPath := fmt.Sprintf("orgs/%s/repos", url.PathEscape(org))

	var created GeneratedRepo
	if err := client.Post(createPath, bytes.NewReader(createBody), &created); err != nil {
		if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); ok && httpErr.StatusCode == http.StatusUnprocessableEntity && is422AlreadyExists(httpErr) {
			getPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(newRepoName))
			if getErr := client.Get(getPath, &created); getErr != nil {
				return "", "", "", false, fmt.Errorf("POST %s returned 422 and follow-up GET %s failed: %w", createPath, getPath, getErr)
			}
			return created.HTMLURL, created.FullName, defaultBranchOrMain(created.DefaultBranch), true, nil
		}
		return "", "", "", false, fmt.Errorf("POST %s: %w", createPath, err)
	}

	patchBody, err := json.Marshal(map[string]any{
		"has_issues":   false,
		"has_projects": false,
		"has_wiki":     false,
	})
	if err != nil {
		return "", "", "", false, fmt.Errorf("patch body encode error: %w", err)
	}

	patchPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(newRepoName))

	var updated GeneratedRepo
	if err := client.Patch(patchPath, bytes.NewReader(patchBody), &updated); err != nil {
		return "", "", "", false, fmt.Errorf("created %s/%s, but failed to disable issues/projects/wiki: %w", org, newRepoName, err)
	}

	if verbose {
		kind := "empty private repo (template-less)"
		if !autoInit {
			kind = "bare private repo (empty_repo, no initial commit)"
		}
		u.Detail("created %s %s, with issues/projects/wiki disabled: %s",
			kind, updated.FullName, updated.HTMLURL)
	}

	return updated.HTMLURL, updated.FullName, defaultBranchOrMain(updated.DefaultBranch), false, nil
}

// resolveConfigRepoBranch returns the org's classroom50 config repo default
// branch for the shim's reusable-workflow `uses:` ref. A read failure is
// returned as an error so the caller can fall back to the assignment repo's own
// branch rather than a wrong `@main` ref that would 404 the runner; an empty
// value falls back to "main" (an auto_init repo's default).
func resolveConfigRepoBranch(client githubapi.Client, org string) (string, error) {
	var repo struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := client.Get(fmt.Sprintf("repos/%s/classroom50", url.PathEscape(org)), &repo); err != nil {
		return "", err
	}
	return defaultBranchOrMain(repo.DefaultBranch), nil
}

// defaultBranchOrMain guards against an empty default_branch in a create/GET
// response: an empty value flowing into WaitForStableBranch("") would 404-loop
// to an opaque "did not stabilize" failure, leaving a created-but-shimless
// repo. "main" is GitHub's default for an auto_init repo and matches what
// `gh student submit` pushes to.
func defaultBranchOrMain(branch string) string {
	if branch == "" {
		return "main"
	}
	return branch
}

// founderPermission maps an assignment mode to the founder's accept-time repo
// role: least-privilege `push` for individual, `admin` for group (which needs
// to manage collaborators for `gh student invite`).
func founderPermission(mode string) string {
	if mode == contract.ModeGroup {
		return "admin"
	}
	return "push"
}

// inviteFounder sets username's collaborator role and verifies it took effect.
// A repo creator holds admin, so an individual self-downgrade GitHub silently
// ignores would otherwise look identical to success. isOwner tolerates an
// org owner's unavoidable residual admin (admin already covers push).
func inviteFounder(client githubapi.Client, u *ui.UI, verbose bool, username, org, repoName, permission string, isOwner bool) error {
	if _, err := githubapi.SetCollaborator(client, org, repoName, username, permission); err != nil {
		return err
	}

	if err := verifyFounderPermission(client, org, repoName, username, permission, isOwner); err != nil {
		return err
	}

	if verbose {
		u.Detail("set %s to %s on %s/%s", username, permission, org, repoName)
	}

	return nil
}

// verifyFounderPermission reads the effective permission back and errors if it
// doesn't match the role we set (permissionSatisfies handles GitHub's legacy
// role collapse), so a silently-ignored downgrade fails loud instead.
func verifyFounderPermission(client githubapi.Client, org, repoName, username, want string, isOwner bool) error {
	path := fmt.Sprintf("repos/%s/%s/collaborators/%s/permission",
		url.PathEscape(org), url.PathEscape(repoName), url.PathEscape(username))
	var got struct {
		Permission string `json:"permission"`
		RoleName   string `json:"role_name"`
	}
	if err := client.Get(path, &got); err != nil {
		return fmt.Errorf("verifying %s's permission on %s/%s: %w", username, org, repoName, err)
	}
	if permissionSatisfies(got.Permission, got.RoleName, want, isOwner) {
		return nil
	}
	return fmt.Errorf("expected %s to have %q access on %s/%s after setup, but GitHub reports %q (role %q) — a repo creator holds admin and a self-downgrade may be blocked by org policy; ask your instructor to set your access to %q",
		username, want, org, repoName, got.Permission, got.RoleName, want)
}

// permissionSatisfies reports whether the read-back matches the role we set.
// role_name is authoritative when present: a push target accepts push/write
// but must reject the more-privileged maintain/admin, which the legacy field
// would otherwise hide (GitHub collapses maintain→write, admin→admin). isOwner
// relaxes a push want to also accept admin: an org owner who created the repo
// can't self-downgrade, and admin is a superset of push.
func permissionSatisfies(legacy, roleName, want string, isOwner bool) bool {
	if roleName != "" {
		switch want {
		case "admin":
			return roleName == "admin"
		case "push":
			if isOwner && roleName == "admin" {
				return true
			}
			return roleName == "push" || roleName == "write"
		default:
			return roleName == want
		}
	}
	switch want {
	case "admin":
		return legacy == "admin"
	case "push":
		if isOwner && legacy == "admin" {
			return true
		}
		return legacy == "write"
	default:
		return legacy == want
	}
}
