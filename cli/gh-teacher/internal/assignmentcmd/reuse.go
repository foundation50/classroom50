package assignmentcmd

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// assignmentReuseCmd copies an assignment record from one classroom's
// assignments.json into another's in the SAME org, changing only slug/name.
// The record is copied verbatim through the typed AssignmentEntry, and
// unknown/future top-level fields survive via Extra.
//
// In-org only (v1): a private template can only be team-granted within its own
// org, so cross-org reuse of a private template is out of scope. The only
// network re-derivation is re-applying the private in-org template team grant
// for the TARGET classroom.
func assignmentReuseCmd() *cobra.Command {
	var (
		from    string
		to      string
		newSlug string
		newName string
		asJSON  bool
	)
	cmd := &cobra.Command{
		Use:   "reuse <org> <source-slug> --from <source-classroom> --to <target-classroom>",
		Short: "Copy an assignment from one classroom into another (same org)",
		Long: "Duplicate an existing assignment record from one classroom's\n" +
			"assignments.json into another classroom's, within the same org —\n" +
			"the scriptable counterpart to the web's assignment reuse, ideal\n" +
			"for rebuilding last term's assignments in a new classroom.\n\n" +
			"The source record is copied verbatim (template, due/due_meta,\n" +
			"mode, autograder, max_group_size, feedback_pr, runtime,\n" +
			"allowed_files, release_assets, pass_threshold, tests, description);\n" +
			"only the slug and name change. By default the source slug/name are\n" +
			"reused; pass --slug and/or --name to override.\n\n" +
			"In-org only (v1): a private template can only be shared with the\n" +
			"target classroom's team inside its own org, so cross-org reuse of\n" +
			"a private template is out of scope. When the copied assignment\n" +
			"references a private, org-owned template, the target classroom's\n" +
			"team is re-granted read on it (the same grant `assignment add`\n" +
			"performs) so rostered students can generate from it.\n\n" +
			"Slug collisions are refused case-insensitively (slugs become\n" +
			"GitHub repo path segments). Pass --slug to choose a free name, or\n" +
			"omit it to auto-suffix `-2`, `-3`, … off a colliding slug.\n\n" +
			"Refuses to write into an archived (active:false) target classroom,\n" +
			"mirroring `assignment add`.\n\n" +
			"Pass --json to emit the resolved copy ({org, classroom, slug,\n" +
			"source_slug, auto_suffixed, template}) on stdout — scripts and\n" +
			"agents should read the chosen slug from there rather than parsing\n" +
			"the human summary, since an auto-suffixed slug isn't known until\n" +
			"the write resolves the collision.",
		Example: "  gh teacher assignment reuse cs50-fall-2026 hello --from cs-principles-2025 --to cs-principles-2026\n" +
			"  gh teacher assignment reuse cs50-fall-2026 hello --from old --to new --slug hello-redux --name \"Hello (Redux)\"\n" +
			"  gh teacher assignment reuse cs50-fall-2026 hello --from old --to new --json",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			sourceSlug := strings.TrimSpace(args[1])
			fromClassroom := strings.TrimSpace(from)
			toClassroom := strings.TrimSpace(to)
			if org == "" || sourceSlug == "" {
				return errors.New("org and source-slug must both be non-empty")
			}
			if fromClassroom == "" {
				return errors.New("--from <source-classroom> is required")
			}
			if toClassroom == "" {
				return errors.New("--to <target-classroom> is required")
			}
			if err := validate.ShortName(fromClassroom, "--from classroom"); err != nil {
				return err
			}
			if err := validate.ShortName(toClassroom, "--to classroom"); err != nil {
				return err
			}
			if err := validate.ShortName(sourceSlug, "source-slug"); err != nil {
				return err
			}
			slugOverride := strings.TrimSpace(newSlug)
			if cmd.Flags().Changed("slug") {
				if err := validate.ShortName(slugOverride, "--slug"); err != nil {
					return err
				}
			}
			if fromClassroom == toClassroom && slugOverride == "" {
				return errors.New("source and target classroom are the same — pass --slug to give the copy a distinct slug (an in-place reuse must rename)")
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAssignmentReuse(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), reuseAssignmentParams{
				Org:          org,
				From:         fromClassroom,
				To:           toClassroom,
				SourceSlug:   sourceSlug,
				SlugOverride: slugOverride,
				SlugWasSet:   cmd.Flags().Changed("slug"),
				NameOverride: strings.TrimSpace(newName),
				NameWasSet:   cmd.Flags().Changed("name"),
				AsJSON:       asJSON,
			})
		},
	}
	cmd.Flags().StringVar(&from, "from", "", "Source classroom short-name to copy the assignment from (required)")
	cmd.Flags().StringVar(&to, "to", "", "Target classroom short-name to copy the assignment into, same org (required)")
	cmd.Flags().StringVar(&newSlug, "slug", "", "Slug for the copy in the target classroom (default: the source slug, auto-suffixed -2/-3/… on a case-insensitive collision)")
	cmd.Flags().StringVar(&newName, "name", "", "Display name for the copy (default: the source name)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the resolved copy as JSON ({org, classroom, slug, source_slug, auto_suffixed, template}) on stdout instead of the human summary")
	return cmd
}

// reuseAssignmentParams carries runAssignmentReuse's inputs. The *WasSet flags
// distinguish "flag omitted (use source / auto-suffix)" from an explicit value.
type reuseAssignmentParams struct {
	Org          string
	From         string
	To           string
	SourceSlug   string
	SlugOverride string
	SlugWasSet   bool
	NameOverride string
	NameWasSet   bool
	AsJSON       bool
}

// reuseResult is the --json shape. `slug` is the FINAL slug (after any
// auto-suffix), which is why --json exists — the suffix isn't knowable ahead.
type reuseResult struct {
	Org          string                  `json:"org"`
	Classroom    string                  `json:"classroom"`
	Slug         string                  `json:"slug"`
	SourceSlug   string                  `json:"source_slug"`
	AutoSuffixed bool                    `json:"auto_suffixed"`
	Template     *assignment.TemplateRef `json:"template,omitempty"`
}

// runAssignmentReuse reads the source entry and upserts a copy into the target
// classroom inside one build callback, so the source read, collision check, and
// target write all see the same parent SHA. The private-in-org template grant
// for the TARGET runs after the commit, mirroring runAssignmentAdd.
func runAssignmentReuse(client githubapi.Client, out, errOut io.Writer, p reuseAssignmentParams) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, p.Org)
	if err != nil {
		return err
	}

	// Captured by the closure for the post-commit summary + grant.
	var (
		finalSlug    string
		copied       assignment.AssignmentEntry
		autoSuffixed bool
	)
	build := func(parentSHA string) (map[string]string, error) {
		// Refuse on an archived target classroom (mirrors add).
		if err := ensureClassroomActive(client, p.Org, p.To, parentSHA); err != nil {
			return nil, err
		}

		srcFile, err := loadAssignments(client, p.Org, p.From, parentSHA)
		if err != nil {
			return nil, err
		}
		idx, ok := assignment.FindAssignment(srcFile.Assignments, p.SourceSlug)
		if !ok {
			return nil, fmt.Errorf("assignment %q not found in source classroom %q (%s/%s/%s) — run `gh teacher assignment list %s %s` to see available slugs",
				p.SourceSlug, p.Org, configrepo.ConfigRepoName, p.From, assignmentsFilePath(p.From), p.Org, p.From)
		}
		// Copy verbatim through the typed entry; only slug/name are overridable.
		copied = srcFile.Assignments[idx]

		dstFile, err := loadAssignments(client, p.Org, p.To, parentSHA)
		if err != nil {
			return nil, err
		}

		// Resolve the target slug: an explicit --slug must not collide
		// (case-insensitive); else auto-suffix off the source slug. Reset each
		// attempt since build re-runs on a rebase retry.
		autoSuffixed = false
		if p.SlugWasSet {
			if assignment.SlugExistsFold(dstFile.Assignments, p.SlugOverride) {
				return nil, fmt.Errorf("slug %q already exists in target classroom %q (case-insensitive) — choose a different --slug",
					p.SlugOverride, p.To)
			}
			finalSlug = p.SlugOverride
		} else {
			finalSlug, err = assignment.NextAvailableSlug(dstFile.Assignments, p.SourceSlug)
			if err != nil {
				return nil, err
			}
			autoSuffixed = finalSlug != p.SourceSlug
		}
		copied.Slug = finalSlug
		if p.NameWasSet {
			copied.Name = p.NameOverride
		}

		if err := assignment.ValidateAssignmentEntry(copied); err != nil {
			return nil, fmt.Errorf("copied assignment is invalid: %w", err)
		}

		updated, _ := assignment.UpsertAssignment(dstFile.Assignments, copied)
		dstFile.Assignments = updated
		data, err := assignment.EncodeAssignments(dstFile)
		if err != nil {
			return nil, err
		}
		return map[string]string{assignmentsFilePath(p.To): string(data)}, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("assignment: reuse %s from %s into %s (gh teacher assignment reuse)", p.SourceSlug, p.From, p.To))
	if _, err := configwrite.CommitTree(client, p.Org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	// Emit the machine-readable result (--json) or human summary on stdout;
	// advisory notes go to stderr so stdout stays a clean single value.
	if p.AsJSON {
		data, err := output.JSONPretty(reuseResult{
			Org:          p.Org,
			Classroom:    p.To,
			Slug:         finalSlug,
			SourceSlug:   p.SourceSlug,
			AutoSuffixed: autoSuffixed,
			Template:     copied.Template,
		})
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
	} else {
		templateDesc := "no template"
		if copied.EmptyRepo {
			templateDesc = "empty repo, autograding disabled"
		}
		if copied.Template != nil {
			templateDesc = fmt.Sprintf("template %s/%s@%s", copied.Template.Owner, copied.Template.Repo, copied.Template.Branch)
		}
		_, _ = fmt.Fprintf(out, "%s/%s/%s: reused %s as %s (%s, autograder %s)\n",
			p.Org, configrepo.ConfigRepoName, assignmentsFilePath(p.To), p.SourceSlug, finalSlug, templateDesc, copied.Autograder)
	}
	if autoSuffixed {
		_, _ = fmt.Fprintf(errOut, "Note: slug %q already existed in %q, so the copy was named %q.\n", p.SourceSlug, p.To, finalSlug)
	}

	// Re-apply the target classroom's private in-org template team grant. In
	// --json mode the "granted" line goes to stderr so stdout stays parseable.
	grantOut := out
	if p.AsJSON {
		grantOut = errOut
	}
	if err := grantReusedTemplateAccess(client, grantOut, errOut, p.Org, p.To, branch, finalSlug, copied.Template); err != nil {
		return err
	}

	_, _ = fmt.Fprintf(errOut, "Students can now run: gh student accept %s %s %s\n", p.Org, p.To, finalSlug)
	return nil
}

// grantReusedTemplateAccess re-applies the TARGET classroom team's read grant
// on a reused assignment's private, org-owned template. Public/absent/out-of-org
// templates are no-ops (out-of-org with a warning). A 404 is a warning since
// the copy already landed.
func grantReusedTemplateAccess(client githubapi.Client, out, errOut io.Writer, org, classroom, branch, slug string, tmpl *assignment.TemplateRef) error {
	if tmpl == nil {
		return nil
	}
	private, ok, err := templateVisibility(client, tmpl.Owner, tmpl.Repo)
	if err != nil {
		return fmt.Errorf("assignment reused, but checking the template %s/%s failed: %w", tmpl.Owner, tmpl.Repo, err)
	}
	if !ok {
		_, _ = fmt.Fprintf(errOut, "Warning: reused %q references template %s/%s, which is not visible to your account (deleted or private-out-of-org). Students won't be able to accept until it's reachable.\n",
			slug, tmpl.Owner, tmpl.Repo)
		return nil
	}
	if !private {
		return nil // public template needs no grant
	}
	if !templateInOrg(tmpl.Owner, org) {
		_, _ = fmt.Fprintf(errOut, "Warning: reused %q references the private out-of-org template %s/%s — it can't be team-granted to classroom %q (reuse is in-org only for private templates). Students won't be able to accept; copy the template into %s and re-add.\n",
			slug, tmpl.Owner, tmpl.Repo, classroom, org)
		return nil
	}
	return grantClassroomTeamTemplateRead(client, out, errOut, org, classroom, branch, slug, tmpl.Owner, tmpl.Repo, grantContext{verb: "reused", classroomNoun: "target classroom"})
}

// grantContext carries per-caller wording for grantClassroomTeamTemplateRead's
// errors, so add and reuse share the grant core with distinct phrasing.
type grantContext struct {
	verb          string // past-tense action: "committed" / "reused"
	classroomNoun string // "classroom" / "target classroom"
	rerunHint     string // optional clause appended to the no-team error
}

// grantClassroomTeamTemplateRead resolves the classroom's persisted team and
// grants it read on a private, org-owned template (idempotent). Shared by add
// and reuse; the caller decides WHEN and supplies the wording. A classroom with
// no team yields an actionable error, not a 404 on a guessed slug.
//
// The student-team grant is org-owner-only. A non-owner author (head-TA) gets a
// 403; since the commit already landed, that is NOT fatal — it warns with
// owner-required guidance and returns nil. A rate-limit/abuse 403 stays fatal
// (transient, not a permission denial); any other error is fatal too.
//
// After the student grant it best-effort grants the classroom's non-owner staff
// teams (head-TA, TA) the same read, so a base-permission-`none` head-TA/TA can
// read the private template without waiting for collect-scores. That grant is
// non-blocking: its failure warns to errOut but never fails an operation that
// already succeeded for students.
func grantClassroomTeamTemplateRead(client githubapi.Client, out, errOut io.Writer, org, classroom, branch, slug, tmplOwner, tmplRepo string, ctx grantContext) error {
	team, ok, err := configrepo.ResolveClassroomTeam(client, org, classroom, branch)
	if err != nil {
		return fmt.Errorf("assignment %s, but reading the %s team failed: %w", ctx.verb, ctx.classroomNoun, err)
	}
	if !ok {
		return fmt.Errorf("assignment %q %s, but %s %q has no team to grant read on the private template %s/%s — run `gh teacher classroom add %s %s` to create the team%s (students can't accept until the team can read the template)",
			slug, ctx.verb, ctx.classroomNoun, classroom, tmplOwner, tmplRepo, org, classroom, ctx.rerunHint)
	}
	granted, err := configrepo.GrantTeamRepoRead(client, org, team.Slug, tmplOwner, tmplRepo)
	if err != nil {
		// A 403 is the expected non-owner-author case (see the doc comment): warn
		// with owner-required guidance and return nil. But a rate-limit/abuse 403
		// (Retry-After / x-ratelimit-remaining) is transient, not a permission
		// denial — keep it fatal so a throttle stays a loud, non-zero-exit failure
		// rather than misleading owner guidance. Only a non-rate-limited 403 is benign.
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) && !cliutil.IsRateLimited(err) {
			_, _ = fmt.Fprintf(errOut, "Warning: assignment %s, but granting the %s team read on the private template %s/%s needs an organization owner (a non-owner can't grant repo access at GitHub). Students can't `gh student accept` until an owner grants it — re-run this command as an owner%s, open the classroom in the web app (which grants it automatically), or grant the %s team read on %s/%s directly in GitHub (Settings -> Collaborators and teams).\n",
				ctx.verb, ctx.classroomNoun, tmplOwner, tmplRepo, ctx.rerunHint, team.Slug, tmplOwner, tmplRepo)
			return nil
		}
		return fmt.Errorf("assignment %s, but granting the %s team read on the private template %s/%s failed: %w", ctx.verb, ctx.classroomNoun, tmplOwner, tmplRepo, err)
	}
	if granted {
		_, _ = fmt.Fprintf(out, "%s: granted classroom team %s read on private template %s/%s\n", org, team.Slug, tmplOwner, tmplRepo)
	}
	grantStaffTeamTemplateRead(client, out, errOut, org, classroom, branch, tmplOwner, tmplRepo)
	return nil
}

// grantStaffTeamTemplateRead best-effort grants the classroom's non-owner staff
// teams (TemplateReadStaffRoles: head-TA, TA) read on a private, org-owned
// template — see grantClassroomTeamTemplateRead for the non-blocking rationale
// and TemplateReadStaffRoles for why the teacher team is omitted.
func grantStaffTeamTemplateRead(client githubapi.Client, out, errOut io.Writer, org, classroom, branch, tmplOwner, tmplRepo string) {
	for _, role := range configrepo.TemplateReadStaffRoles {
		// StaffTeamRepoPermissions is a presence gate: grant read only for a role
		// mapped to a student-repo/template permission.
		if _, ok := configrepo.StaffTeamRepoPermissions[role]; !ok {
			continue
		}
		team, ok, err := configrepo.ResolveClassroomStaffTeam(client, org, classroom, branch, role)
		if err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: could not read the %s staff team to grant read on private template %s/%s (%v); staff get read at the next collect-scores run.\n", role, tmplOwner, tmplRepo, err)
			continue
		}
		if !ok {
			continue // no team recorded (older classroom) — clean skip
		}
		granted, err := configrepo.GrantTeamRepoRead(client, org, team.Slug, tmplOwner, tmplRepo)
		if err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: could not grant %s staff team %s read on private template %s/%s (%v); staff get read at the next collect-scores run.\n", role, team.Slug, tmplOwner, tmplRepo, err)
			continue
		}
		if granted {
			_, _ = fmt.Fprintf(out, "%s: granted %s staff team %s read on private template %s/%s\n", org, role, team.Slug, tmplOwner, tmplRepo)
		}
	}
}

// templateVisibility probes a template repo for the reuse grant decision:
// returns (private, visible, err). A 404 is the "not visible" case; other
// transport errors propagate.
func templateVisibility(client githubapi.Client, owner, repo string) (private bool, visible bool, err error) {
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo))
	var resp struct {
		Private bool `json:"private"`
	}
	if err := client.Get(path, &resp); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return false, false, nil
		}
		return false, false, fmt.Errorf("GET %s: %w", path, err)
	}
	return resp.Private, true, nil
}
