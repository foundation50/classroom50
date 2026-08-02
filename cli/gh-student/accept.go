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
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/ghui"
	"github.com/foundation50/classroom50-cli-shared/ghutil"
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
			"If the classroom uses an unlisted URL, your teacher will give\n" +
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

	cmd.Flags().StringVar(&key, "key", "", "Access key for a classroom that uses an unlisted URL (provided by your teacher); omit for normal classrooms")
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

// isActiveTeamMember reports whether the authed user is an active member of the
// team. 2xx + active => true, a definitive 404 => false; any other error (e.g.
// transient) propagates so the caller fails OPEN rather than blocking a real
// student on a blip.
func isActiveTeamMember(client githubapi.Client, org, teamSlug, username string) (bool, error) {
	path := fmt.Sprintf("orgs/%s/teams/%s/memberships/%s",
		url.PathEscape(org), url.PathEscape(teamSlug), url.PathEscape(username))
	var resp struct {
		State string `json:"state"`
	}
	if err := client.Get(path, &resp); err != nil {
		if httpErr, ok := errors.AsType[*githubapi.HTTPError](err); ok {
			if httpErr.StatusCode == http.StatusNotFound {
				return false, nil
			}
		}
		return false, fmt.Errorf("GET %s: %w", path, err)
	}
	return resp.State == "active", nil
}

// assertEnrolledOrStaff enforces that the authed user is enrolled in the
// classroom — on its student team, or holding a staff role — before accept.
// The slug set is single-sourced from contract.ClassroomTeamSlugs (student
// first). A transient read propagates (fail-open); membership short-circuits to
// nil before any later probe can error, so an enrolled student is never blocked
// by an unrelated blip. Only a full set of definitive non-member answers blocks.
func assertEnrolledOrStaff(client githubapi.Client, org, classroom, username string) error {
	for _, slug := range contract.ClassroomTeamSlugs(classroom) {
		member, err := isActiveTeamMember(client, org, slug, username)
		if err != nil {
			return err
		}
		if member {
			return nil
		}
	}
	return fmt.Errorf("%s/%s: this assignment isn't available to you; ask your teacher if you think this is a mistake", org, classroom)
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
		return fmt.Errorf("assignment %q has max_group_size %d but mode %q (want %q) — its published metadata is inconsistent; ask your teacher to re-run `gh teacher assignment add`",
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

	// Enrollment gate: a plain org member who isn't on this classroom's student
	// team (and holds no staff role) can't accept. Mirrors the web accept gate
	// and the student list; org owners bypass (they administer every classroom).
	// Advisory like every client-side gate — GitHub's private-template
	// permission is the hard boundary — but it fails early with a clear message.
	if !isOwner {
		if err := assertEnrolledOrStaff(client, org, classroom, username); err != nil {
			return err
		}
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
	// A locked assignment is closed to every student, including a re-run on an
	// already-accepted repo. For a private-template assignment the student
	// team's template read is also gone, so the repo generation would fail
	// anyway; this gate makes the refusal explicit and fast.
	if entry.Locked {
		return fmt.Errorf("assignment %q is locked by your teacher and can't be accepted right now — ask them to unlock it", assignment)
	}
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
		return fmt.Errorf("assignment %q has an incomplete template ref (owner=%q repo=%q branch=%q) — ask your teacher to re-run `gh teacher assignment add`",
			assignment, entry.Template.Owner, entry.Template.Repo, entry.Template.Branch)
	}
	// empty_repo and template are mutually exclusive at write time, but
	// publish-pages publishes assignments.json verbatim, so a hand-edited
	// entry can carry both. Fail closed rather than half-apply (the template
	// fork would generate starter content, then the bare fork would skip every
	// control file — a templated repo the grading pipeline ignores).
	if entry.EmptyRepo && entry.Template != nil {
		return fmt.Errorf("assignment %q sets both empty_repo and a template — the entry is invalid; ask your teacher to re-run `gh teacher assignment add`", assignment)
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
		htmlURL, fullName, genBranch, alreadyExisted, err = createTemplatedPrivateAssignmentRepoInOrg(client, u, verbose, username, classroom, assignment, org, *entry.Template, entry.RepoFeatures)
		// The generated repo's own default branch — not the template's branch —
		// is where control files land and what the shim must trigger on.
		commitBranch = genBranch
		// Resolve the template owner's immutable id best-effort so a rename
		// of the template org/user doesn't break submit's teacher-file
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
		htmlURL, fullName, defaultBranch, alreadyExisted, err = createEmptyPrivateAssignmentRepoInOrg(client, u, verbose, username, classroom, assignment, org, !entry.EmptyRepo, entry.RepoFeatures)
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
		org:               org,
		classroom:         classroom,
		assignment:        assignment,
		mode:              entry.Mode,
		maxGroupSize:      entry.MaxGroupSize,
		studentPermission: entry.StudentPermission,
		secret:            secret,
		username:          username,
		ownerID:           &ownerID,
		acceptedAt:        acceptedAt,
		repoName:          repoName,
		branch:            commitBranch,
		source:            cfgSource,
		shim:              shim,
		autograderName:    autograderName,
		emptyRepo:         entry.EmptyRepo,
		feedbackPR:        entry.FeedbackPR,
		fullName:          fullName,
		htmlURL:           htmlURL,
		alreadyExisted:    alreadyExisted,
		createSp:          createSp,
		createMsg:         createMsg,
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
	// studentPermission is the assignment's optional student_permission (the
	// accept-time role the student gets on their own repo); empty means the
	// mode default. See founderPermission.
	studentPermission string
	// emptyRepo selects the bare path: no control files are committed and no
	// marker probe runs — the only provisioning is the idempotent admin grant.
	emptyRepo bool
	// feedbackPR opts into opening the Feedback PR at accept time (issue
	// #228) — best-effort, after provisioning succeeds. Never set together
	// with emptyRepo (the entry validation fails closed on that combination).
	feedbackPR        bool
	fullName, htmlURL string
	alreadyExisted    bool
	createSp          *ghui.Spinner
	createMsg         string
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
			if err := inviteFounder(client, u, verbose, p.username, p.org, p.repoName, founderPermission(p.mode, p.studentPermission)); err != nil && verbose {
				u.Detail("could not reconcile %s's role on %s/%s (repo already accepted; leaving as-is): %v", p.username, p.org, p.repoName, err)
			}
			p.createSp.Stop(fmt.Sprintf("Repo already exists: %s", p.fullName))
			// Ensure the Feedback PR exists even on the healthy path: repos
			// accepted before the accept-time-PR feature (issue #228) get
			// their PR by re-accepting — the only Actions-free route. The
			// accept SHA isn't in hand here (no DropFiles ran), so recover it
			// from the marker's commit history; existing PRs short-circuit
			// inside, keeping repeat re-accepts read-only.
			if p.feedbackPR {
				openFeedbackPRStep(client, u, verbose, p, func() (string, error) {
					return acceptCommitSHA(client, p.org, p.repoName)
				})
			}
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
		if err := inviteFounder(client, u, verbose, p.username, p.org, p.repoName, founderPermission(p.mode, p.studentPermission)); err != nil && verbose {
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

	if err := inviteFounder(client, u, verbose, p.username, p.org, p.repoName, founderPermission(p.mode, p.studentPermission)); err != nil {
		return err
	}

	return reportBareAccepted(u, out, p.fullName, p.htmlURL)
}

// provisionAcceptedRepo brings a just-created (or partially-provisioned)
// student repo to a healthy, autogradable state and is safe to re-run:
//
//  1. Land .classroom50.yaml + the autograde shim in one Tree commit,
//     riding out GitHub's post-create git-data lag.
//  2. Verify the accept marker is readable before declaring success, so
//     "accepted" always means "will autograde".
//  3. Open the accept-time Feedback PR (best-effort; defers to the runner).
//  4. Grant the founder their repo role LAST (PUT collaborators is an upsert):
//     `push` for an individual assignment, `admin` for group, or a configured
//     student_permission. Last so a self-downgrade GitHub won't apply fails
//     loudly without stranding the student on a half-provisioned repo.
//
// The single caller (acceptIntoRepo) covers both the fresh-create and heal
// paths. Mirrors the GUI's provisionAcceptedRepo so CLI and GUI heal a
// half-finished accept identically.
func provisionAcceptedRepo(client githubapi.Client, u *ui.UI, verbose bool, p acceptRepoParams, cfg classroomcfg.Config) error {
	// DropFiles lands both control files in one Tree commit, waiting out
	// GitHub's post-create replication lag; the spinner animates throughout
	// (no numeric counter — the wait has no guaranteed bound).
	const setupMsg = "Setting up autograder and metadata"
	setupSp := u.Spinner(setupMsg)
	setupSp.Start()
	acceptSHA, err := classroomcfg.DropFiles(client, p.org, p.repoName, p.branch, cfg, p.shim)
	if err != nil {
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

	// Feedback PR is best-effort (a failure only defers to the runner). Run it
	// before the founder grant so the repo is fully set up before we (possibly)
	// narrow the student's own access.
	if p.feedbackPR {
		openFeedbackPRStep(client, u, verbose, p, func() (string, error) {
			return feedbackBaseSHA(client, p.org, p.repoName, acceptSHA), nil
		})
	}

	// The founder grant is LAST: individual founders get least-privilege `push`
	// (enough to push and trigger autograding); group founders get `admin`
	// (needed to manage collaborators for `gh student invite`); a configured
	// student_permission can narrow it further. See founderPermission. Running
	// it after setup + feedback means a below-default self-downgrade GitHub
	// won't apply (which inviteFounder verifies with a member-exact read-back)
	// fails loudly without stranding the student on a half-provisioned repo —
	// the control files and Feedback PR are already in place.
	if err := inviteFounder(client, u, verbose, p.username, p.org, p.repoName, founderPermission(p.mode, p.studentPermission)); err != nil {
		return err
	}
	return nil
}

// feedbackBaseSHA resolves the commit to freeze `feedback` at, preferring the
// marker's earliest commit over the SHA DropFiles just wrote. On the HEAL path
// the marker already exists, so the repair commit is NOT the baseline the
// runner resolves — freezing there would make the runner refuse to maintain the
// PR for the repo's whole life. On a fresh accept the lookup returns the commit
// just written (or fails on read lag), so falling back to it is correct.
func feedbackBaseSHA(client githubapi.Client, org, repoName, committedSHA string) string {
	if sha, err := acceptCommitSHA(client, org, repoName); err == nil && sha != "" {
		return sha
	}
	return committedSHA
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

// is422AlreadyExists matches GitHub's "already exists" 422 (duplicate ref,
// duplicate label, existing repo).
func is422AlreadyExists(httpErr *githubapi.HTTPError) bool {
	return has422Message(httpErr, "already exists")
}

// has422Message gates httpErrorMentions on a 422 status, so a caller that isn't
// already switching on the status can't accept the same wording arriving from an
// unrelated failure.
func has422Message(httpErr *githubapi.HTTPError, needle string) bool {
	return httpErr.StatusCode == http.StatusUnprocessableEntity &&
		httpErrorMentions(httpErr, needle)
}

// httpErrorMentions reports whether needle (lower-case) appears in the error's
// top-level message or in any Errors[] item. GitHub puts the reason in either
// slot depending on the endpoint.
func httpErrorMentions(httpErr *githubapi.HTTPError, needle string) bool {
	if strings.Contains(strings.ToLower(httpErr.Message), needle) {
		return true
	}
	for _, item := range httpErr.Errors {
		if strings.Contains(strings.ToLower(item.Message), needle) {
			return true
		}
	}
	return false
}

// The one 403 message GitHub was observed to return when the destination org
// refuses the create (issue #413). Add a variant only alongside a cited GitHub
// response showing the same cause, since the plausible alternatives (enterprise
// or ruleset blocks) are ones this remedy cannot fix.
const orgRepoCreationDeniedSignature = "admin access to the organization"

// is403OrgRepoCreationDenied reports whether err is the destination org refusing
// to let a member create the repo. Owns its own exclusions (mirroring the web's
// isOrgRepoCreationDenied) so no call site can forget one: a rate limit also
// surfaces as 403, and rendering a throttle as "your org blocks repo creation" is
// the mislabeling #413 exists to remove.
func is403OrgRepoCreationDenied(err error) bool {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	if !ok || httpErr.StatusCode != http.StatusForbidden {
		return false
	}
	if ghutil.IsRateLimited(err) {
		return false
	}
	return httpErrorMentions(httpErr, orgRepoCreationDeniedSignature)
}

// orgRepoCreationDeniedError is the shared remedy, kept in step with the web copy
// at accept.templateErrors.orgRepoCreationDenied (see that key's factory for why
// it hedges and stays a diagnosis rather than a how-to). Unlike the web alert this
// lets the wrapped cause trail GitHub's raw text: a terminal reader expects the
// API detail after the colon, and it keeps the error chain intact.
func orgRepoCreationDeniedError(org string, cause error) error {
	return fmt.Errorf("`%s` may not allow members to create private repositories, so your "+
		"assignment repository couldn't be created. Ask your teacher to enable it, "+
		"then run accept again: %w", org, cause)
}

// oauthRestrictionOrg matches the org GitHub names in its OAuth-App-restriction
// 403 body: "...the `some-org` organization has enabled OAuth App access
// restrictions...". For a cross-org fork template the restriction is anchored to
// the fork's UPSTREAM org, so the named org is the parent — and this signal
// survives even when a follow-up repo read is itself blocked (issue #468).
var oauthRestrictionOrg = regexp.MustCompile("(?i)`([^`]+)`\\s+organization has enabled OAuth App")

// forkParentOwnerFromRestriction returns the org named in GitHub's OAuth-App
// restriction 403, when it differs from the classroom org (a match with the
// classroom org is an ordinary same-org restriction, not the cross-org-fork
// case). Empty string when the body doesn't carry the pattern.
func forkParentOwnerFromRestriction(err error, classroomOrg string) string {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	if !ok {
		return ""
	}
	m := oauthRestrictionOrg.FindStringSubmatch(httpErr.Message)
	if m == nil {
		return ""
	}
	named := m[1]
	if strings.EqualFold(named, classroomOrg) {
		return ""
	}
	return named
}

// crossOrgForkParentOwner probes the template repo for a cross-org fork parent
// as a fallback when GitHub's 403 body didn't name the org. Best-effort: any
// read failure (including the same restriction re-blocking this read) yields "".
func crossOrgForkParentOwner(client githubapi.Client, owner, repo, classroomOrg string) string {
	var resp struct {
		Fork   bool `json:"fork"`
		Parent struct {
			FullName string `json:"full_name"`
		} `json:"parent"`
	}
	if err := client.Get(fmt.Sprintf("repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo)), &resp); err != nil {
		return ""
	}
	if !resp.Fork {
		return ""
	}
	parentOwner, _, found := strings.Cut(resp.Parent.FullName, "/")
	if !found || parentOwner == "" || strings.EqualFold(parentOwner, classroomOrg) {
		return ""
	}
	return parentOwner
}

// forkParentRestrictedError is the student-facing remedy for a cross-org fork
// template blocked by its upstream org's OAuth-App restriction (issue #468).
// Names the PARENT org, mirroring the web accept.templateErrors.forkParentRestricted
// copy: "re-run setup" (the ordinary in-org remedy) can never fix this.
func forkParentRestrictedError(parentOwner string, tmpl assignments.TemplateRef, cause error) error {
	return fmt.Errorf("couldn't copy the template `%s/%s`: it is a fork of a repository in the `%s` "+
		"organization, and copying a fork is governed by that organization's third-party app "+
		"restrictions. Ask your teacher to approve the Classroom 50 app for `%s` (or use a "+
		"non-fork template), then accept again: %w", tmpl.Owner, tmpl.Repo, parentOwner, parentOwner, cause)
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
	// GitHub's repository object does NOT expose a has_pull_requests toggle, so
	// a GET /repos response omits it. A pointer keeps "absent" (nil) distinct
	// from "explicitly false": on templated-inherit an absent template field is
	// omitted from the PATCH, matching the web resolveRepoFeaturesPatch (which
	// omits an undefined key) — a non-pointer bool would decode the omitted
	// field to false and force has_pull_requests:false, diverging from web.
	HasPullRequests *bool `json:"has_pull_requests"`
}

// resolveRepoFeaturePatchBody builds the accept-time repo-feature PATCH body
// from an assignment's tri-state repo_features, using the same per-key rule as
// the web accept client (permissions.ts resolveRepoFeaturesPatch):
//
//   - explicit true/false -> that value is sent.
//   - nil + templated       -> the TEMPLATE's current has_<key> (from
//     templateFeatures), because GitHub's POST /generate does NOT copy the
//     template's feature settings — a generated repo gets GitHub defaults, so
//     "inherit" must actively re-apply the template's value. When the template
//     read is unavailable (templateFeatures nil), the key is omitted (fall back
//     to the generated repo's GitHub default).
//   - nil + template-less   -> omitted (the "Default" choice: leave GitHub's
//     own create default in place rather than force the feature off).
//
// It returns two bodies: `full` (every resolved key) and `explicit` (only the
// keys the teacher forced via a non-nil features.*). The caller sends `full`
// first, then falls back to `explicit` if that PATCH is rejected — an org that
// bans one INHERITED key (e.g. org-wide projects disabled) must not drop the
// teacher's co-resolved forced value in the same all-or-nothing body.
//
// templateFeatures is the template repo's current settings (from a GET on the
// template after generate), or nil when there's no template / the read failed.
func resolveRepoFeaturePatchBody(features *assignments.RepoFeatures, templated bool, templateFeatures *GeneratedRepo) (full, explicit map[string]any) {
	var issues, wiki, projects, pullRequests *bool
	if features != nil {
		issues, wiki, projects, pullRequests = features.Issues, features.Wiki, features.Projects, features.PullRequests
	}
	full = map[string]any{}
	explicit = map[string]any{}
	// resolve returns (value, send?). An explicit override wins; a template-less
	// absent key is omitted (the "Default" choice: leave GitHub's own create
	// default in place rather than force it off); a templated absent key inherits
	// the template's live value (omitted when the template read is unavailable,
	// and for has_pull_requests always omitted since GitHub's repo object has no
	// such field). templateValue returns (value, present?) so a nil template
	// pointer omits rather than forcing false.
	resolve := func(value *bool, templateValue func(*GeneratedRepo) (bool, bool)) (val bool, send, isExplicit bool) {
		if value != nil {
			return *value, true, true
		}
		if !templated {
			return false, false, false // template-less: leave GitHub default
		}
		if templateFeatures == nil {
			return false, false, false // inherit but no template read: omit
		}
		tv, present := templateValue(templateFeatures)
		return tv, present, false
	}
	apply := func(key string, value *bool, templateValue func(*GeneratedRepo) (bool, bool)) {
		v, send, isExplicit := resolve(value, templateValue)
		if send {
			full[key] = v
		}
		if isExplicit {
			explicit[key] = v
		}
	}
	apply("has_issues", issues, func(g *GeneratedRepo) (bool, bool) { return g.HasIssues, true })
	apply("has_wiki", wiki, func(g *GeneratedRepo) (bool, bool) { return g.HasWiki, true })
	apply("has_projects", projects, func(g *GeneratedRepo) (bool, bool) { return g.HasProjects, true })
	apply("has_pull_requests", pullRequests, func(g *GeneratedRepo) (bool, bool) {
		if g.HasPullRequests == nil {
			return false, false // GitHub omits it -> nothing to inherit
		}
		return *g.HasPullRequests, true
	})
	return full, explicit
}

// patchRepoFeatures applies the resolved repo-feature PATCH best-effort. It
// sends `full` (all resolved keys); if that is rejected it retries with
// `explicit` (teacher-forced keys only) so an org that bans one inherited key
// can't silently drop a forced override. Returns the successful PATCH echo's
// GeneratedRepo (or nil when nothing was sent / both attempts failed). Fail-open
// by contract — the caller keeps the create/generate echo on a nil return.
func patchRepoFeatures(client githubapi.Client, u *ui.UI, verbose bool, org, repo string, full, explicit map[string]any) *GeneratedRepo {
	patchPath := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(repo))
	attempt := func(body map[string]any) (*GeneratedRepo, error) {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("patch body encode error: %w", err)
		}
		var updated GeneratedRepo
		if err := client.Patch(patchPath, bytes.NewReader(encoded), &updated); err != nil {
			return nil, err
		}
		return &updated, nil
	}
	if len(full) == 0 {
		return nil
	}
	updated, err := attempt(full)
	if err == nil {
		return updated
	}
	// Fail-open: a repo-feature PATCH is best-effort (an org that disables a
	// feature org-wide rejects forcing it on), so a failure must not fail an
	// otherwise-successful accept. Before giving up, retry with just the
	// teacher-forced keys so a rejected INHERITED key doesn't drop a forced one.
	if len(explicit) > 0 && len(explicit) < len(full) {
		if verbose {
			u.Detail("repo-feature PATCH for %s/%s failed; retrying with forced keys only: %v", org, repo, err)
		}
		if updated, retryErr := attempt(explicit); retryErr == nil {
			return updated
		} else {
			err = retryErr
		}
	}
	u.Warn("created %s/%s but could not apply repo features (non-fatal): %v", org, repo, err)
	return nil
}

// createTemplatedPrivateAssignmentRepoInOrg generates a private repo from the
// entry's template and applies the assignment's tri-state repo_features
// (issues/wiki/projects/pull_requests) best-effort via PATCH: an absent
// ("inherit") key re-applies the template's live setting (GitHub's /generate
// does NOT copy feature flags), an explicit true/false forces it. Fail-open —
// a rejected feature PATCH never fails accept. 404 on generate →
// cross-org visibility message (template not readable by the student).
// 422-already-exists → alreadyExisted=true and the PATCH is skipped so
// re-runs don't disturb an existing repo.
func createTemplatedPrivateAssignmentRepoInOrg(client githubapi.Client, u *ui.UI, verbose bool, username, classroom, assignment, org string, tmpl assignments.TemplateRef, features *assignments.RepoFeatures) (htmlURL, fullName, defaultBranch string, alreadyExisted bool, err error) {
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
				// An in-org fork template whose cross-org upstream restricts the
				// app 403s here (or 404s), not because the student lacks access.
				// Name the parent org when we can identify it; else fall back to
				// the generic visibility message.
				if strings.EqualFold(tmpl.Owner, org) {
					if parent := forkParentOwnerFromRestriction(err, org); parent != "" {
						return "", "", "", false, forkParentRestrictedError(parent, tmpl, err)
					}
					if parent := crossOrgForkParentOwner(client, tmpl.Owner, tmpl.Repo, org); parent != "" {
						return "", "", "", false, forkParentRestrictedError(parent, tmpl, err)
					}
				}
				return "", "", "", false, fmt.Errorf("template `%s/%s` is not accessible to you — ask your teacher to make it public or grant your account access",
					tmpl.Owner, tmpl.Repo)
			case http.StatusForbidden:
				// The refusal is about the destination org, not the template, so
				// it is classified here rather than blamed on `tmpl`.
				if is403OrgRepoCreationDenied(err) {
					return "", "", "", false, orgRepoCreationDeniedError(org, err)
				}
				// An in-org fork template whose cross-org upstream org has revoked
				// the app 403s here; name the parent org from GitHub's body (which
				// survives the blocked follow-up read), else probe the fork.
				if strings.EqualFold(tmpl.Owner, org) {
					if parent := forkParentOwnerFromRestriction(err, org); parent != "" {
						return "", "", "", false, forkParentRestrictedError(parent, tmpl, err)
					}
					if parent := crossOrgForkParentOwner(client, tmpl.Owner, tmpl.Repo, org); parent != "" {
						return "", "", "", false, forkParentRestrictedError(parent, tmpl, err)
					}
				}
			}
		}
		return "", "", "", false, fmt.Errorf("POST %s: %w", createPath, err)
	}

	// Resolve the repo-feature override (issues/wiki/projects/pull_requests). An
	// "inherit" (nil) key on a templated assignment must re-apply the TEMPLATE's
	// live setting — GitHub's /generate does NOT copy them — so read the template
	// repo's current features first (best-effort; a failed read leaves inherited
	// keys unset = GitHub default). Explicit on/off always win. Skip the read
	// when every key is forced explicitly: resolveRepoFeaturePatchBody never
	// consults the template then, so the GET would be pure waste.
	var templateFeatures *GeneratedRepo
	if features.HasAnyInherit() {
		var tmplRepo GeneratedRepo
		if err := client.Get(fmt.Sprintf("repos/%s/%s", url.PathEscape(tmpl.Owner), url.PathEscape(tmpl.Repo)), &tmplRepo); err == nil {
			templateFeatures = &tmplRepo
		} else if verbose {
			u.Detail("could not read template %s/%s features; inherited keys fall back to GitHub defaults: %v", tmpl.Owner, tmpl.Repo, err)
		}
	}
	fullBody, explicitBody := resolveRepoFeaturePatchBody(features, true /* templated */, templateFeatures)

	// The generate echo's default_branch anchors the shim/commit ref. When the
	// PATCH is skipped there is no PATCH echo, so start from the generate
	// response; a PATCH echo (when we send one) overrides it below.
	genBranch := created.DefaultBranch

	if updated := patchRepoFeatures(client, u, verbose, org, newRepoName, fullBody, explicitBody); updated != nil {
		if verbose {
			u.Detail("created private repo %s, applied repo features: %s",
				updated.FullName, updated.HTMLURL)
		}
		// Prefer the PATCH response's default_branch — a template generated
		// into a `master`-defaulting org yields a `master` repo regardless of
		// the template's own branch name.
		if updated.DefaultBranch != "" {
			genBranch = updated.DefaultBranch
		}
	} else if len(fullBody) == 0 && verbose {
		u.Detail("created private repo %s, inheriting template repo features: %s",
			created.FullName, created.HTMLURL)
	}

	// The generate/PATCH echoes (and an immediate GET) can report a stale
	// default_branch: right after generate GitHub reports the org default
	// (`main`) while the template's real branch (e.g., `master`) hasn't been
	// copied yet. Wait for the branch to actually materialize and use that, so a
	// `master`-default template doesn't pin the shim + commit at a `heads/main`
	// ref that never exists.
	genBranch = githubapi.ResolveSettledDefaultBranch(client, org, newRepoName, defaultBranchOrMain(genBranch))
	return created.HTMLURL, created.FullName, defaultBranchOrMain(genBranch), false, nil
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
// materializes on the student's first push). Applies the assignment's tri-state
// repo_features best-effort via PATCH (a template-less assignment leaves an
// absent key at GitHub's own create default; an explicit true/false forces it),
// fail-open like the templated path. 422-already-exists → alreadyExisted=true
// and the PATCH is skipped so re-runs don't disturb an existing repo.
func createEmptyPrivateAssignmentRepoInOrg(client githubapi.Client, u *ui.UI, verbose bool, username, classroom, assignment, org string, autoInit bool, features *assignments.RepoFeatures) (htmlURL, fullName, defaultBranch string, alreadyExisted bool, err error) {
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
			case http.StatusForbidden:
				// Serves both the template-less shim path and empty_repo, which
				// previously wrapped this 403 raw.
				if is403OrgRepoCreationDenied(err) {
					return "", "", "", false, orgRepoCreationDeniedError(org, err)
				}
			}
		}
		return "", "", "", false, fmt.Errorf("POST %s: %w", createPath, err)
	}

	// Template-less: absent keys resolve to explicit false (code-only default),
	// so the full body always carries a key for every feature unless the teacher
	// forced some on.
	fullBody, explicitBody := resolveRepoFeaturePatchBody(features, false /* templated */, nil)

	// Default to the create response; a successful PATCH echo overrides it.
	htmlURL, fullName, defaultBranch = created.HTMLURL, created.FullName, defaultBranchOrMain(created.DefaultBranch)

	if updated := patchRepoFeatures(client, u, verbose, org, newRepoName, fullBody, explicitBody); updated != nil {
		htmlURL, fullName, defaultBranch = updated.HTMLURL, updated.FullName, defaultBranchOrMain(updated.DefaultBranch)
		if verbose {
			kind := "empty private repo (template-less)"
			if !autoInit {
				kind = "bare private repo (empty_repo, no initial commit)"
			}
			u.Detail("created %s %s, applied repo features: %s",
				kind, updated.FullName, updated.HTMLURL)
		}
	}

	return htmlURL, fullName, defaultBranch, false, nil
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

// founderPermission maps an assignment to the founder's accept-time repo role:
// the configured student_permission when set, else the mode default
// (least-privilege push for individual, admin for group, which needs to manage
// collaborators for `gh student invite`). A group founder must hold at least
// admin, so a group value below admin is clamped up. Mirrors the web
// founderPermission.
func founderPermission(mode, studentPermission string) string {
	want := studentPermission
	if want == "" {
		want = contract.DefaultStudentPermission(mode)
	}
	if mode == contract.ModeGroup && want != contract.PermissionAdmin {
		return contract.PermissionAdmin
	}
	return want
}

// inviteFounder sets username's collaborator role on their OWN repo. The
// accepting student is the repo creator (they ran the generate/create), so this
// is a self-directed collaborator change — including a self-downgrade below the
// default (a teacher can set student_permission to e.g. `pull`). We trust the
// PUT: it is the authenticated actor changing their own access, so a success
// means it took.
//
// We deliberately do NOT read the effective permission back. The
// /repos/{org}/{repo}/collaborators/{self}/permission sub-resource lags the PUT
// by a long, unbounded window right after a self-downgrade on a freshly created
// repo — it 404s ("no readable collaborator record yet") well past any
// reasonable accept-run poll, even though the downgrade already applied, which
// produced false accept failures for the exact legitimate case. The
// silently-ignored-downgrade guard belongs on the teacher write paths (the web
// gradebook per-repo / bulk access editors), where a DIFFERENT actor changes a
// student's role and a read-back can meaningfully confirm it. Mirrors the web
// addFounderCollaborator.
func inviteFounder(client githubapi.Client, u *ui.UI, verbose bool, username, org, repoName, permission string) error {
	if _, err := githubapi.SetCollaborator(client, org, repoName, username, permission); err != nil {
		return err
	}

	if verbose {
		u.Detail("set %s to %s on %s/%s", username, permission, org, repoName)
	}

	return nil
}
