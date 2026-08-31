package assignmentcmd

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// assignmentLockCmd flips an assignment's `locked` flag and, for a private
// in-org template, revokes (lock) or re-grants (unlock) the classroom STUDENT
// team's read on that template. Staff (teacher/head-TA/TA) teams are never
// touched. `--unlock` reverses the operation.
func assignmentLockCmd() *cobra.Command {
	var unlock bool
	cmd := &cobra.Command{
		Use:   "lock <org> <classroom> <slug>",
		Short: "Lock (or --unlock) an assignment against student access",
		Long: "Lock an assignment so students can no longer access it: the web\n" +
			"accept page, the student assignments list, the submission view, and\n" +
			"`gh student accept` all refuse a locked assignment for every student,\n" +
			"including ones who already accepted.\n\n" +
			"Because assignments.json is published publicly to GitHub Pages, the\n" +
			"client-side gates are best-effort UX. The enforceable boundary applies\n" +
			"only to a private, in-org template: locking also removes the classroom\n" +
			"student team's read on that template repository, so no new student can\n" +
			"generate a repo from it while locked. The teacher, head-TA, and TA\n" +
			"teams are left untouched. Existing student repos are not deleted.\n\n" +
			"Pass --unlock to reverse it: the flag is cleared and, for a private\n" +
			"in-org template, the student team's read is re-granted so students\n" +
			"can accept again.",
		Example: "  gh teacher assignment lock cs50-fall-2026 cs-principles hello\n" +
			"  gh teacher assignment lock cs50-fall-2026 cs-principles hello --unlock",
		Args: cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			slug := strings.TrimSpace(args[2])
			if org == "" || classroom == "" || slug == "" {
				return errors.New("org, classroom, and slug must all be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			if err := validate.ShortName(slug, "slug"); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAssignmentLock(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, slug, !unlock)
		},
	}
	cmd.Flags().BoolVar(&unlock, "unlock", false, "Unlock the assignment instead of locking it (re-grants the student team's private-template read)")
	return cmd
}

// runAssignmentLock sets `locked` to `lock` on the entry, commits, then applies
// the template-access side effect for a private in-org template: revoke the
// student team's read when locking, re-grant it when unlocking. The template
// grant/revoke is best-effort (the flag flip is the source of truth) so a
// non-owner author's 403 warns rather than fails.
func runAssignmentLock(client githubapi.Client, out, errOut io.Writer, org, classroom, slug string, lock bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	var (
		found    bool
		changed  bool
		template *assignment.TemplateRef
	)
	build := func(parentSHA string) (map[string]string, error) {
		file, err := loadAssignments(client, org, classroom, parentSHA)
		if err != nil {
			return nil, err
		}
		idx, ok := assignment.FindAssignment(file.Assignments, slug)
		found = ok
		if !ok {
			// Nothing to write; CommitTree treats nil as a no-op.
			return nil, nil
		}
		entry := file.Assignments[idx]
		template = entry.Template
		if entry.Locked == lock {
			// Already in the desired state — no commit, but still reconcile the
			// template grant below (a prior run may have flipped the flag but
			// failed the grant/revoke).
			changed = false
			return nil, nil
		}
		entry.Locked = lock
		file.Assignments[idx] = entry
		changed = true
		data, err := assignment.EncodeAssignments(file)
		if err != nil {
			return nil, err
		}
		return map[string]string{assignmentsFilePath(classroom): string(data)}, nil
	}

	verb := "lock"
	if !lock {
		verb = "unlock"
	}
	message := contract.PrefixCommit(fmt.Sprintf("assignment: %s %s in %s (gh teacher assignment %s)", verb, slug, classroom, verb))
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}

	if !found {
		return fmt.Errorf("assignment %q not found in %s/%s/%s: nothing to %s",
			slug, org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), verb)
	}

	if changed {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: %sed %s\n",
			org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), verb, slug)
	} else {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: %s was already %sed, re-checking template access\n",
			org, configrepo.ConfigRepoName, assignmentsFilePath(classroom), slug, verb)
	}

	// Template side effect: only a private in-org template has a student-team
	// grant to revoke or re-grant. Public/absent/out-of-org templates are a
	// UX-gate-only lock, so there is nothing to change on GitHub.
	if template == nil {
		return nil
	}
	private, ok, err := templateVisibility(client, template.Owner, template.Repo)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %sed %q, but checking the template %s/%s failed (%v); its student-team access was not updated.\n",
			verb, slug, template.Owner, template.Repo, err)
		return nil
	}
	if !ok || !private || !templateInOrg(template.Owner, org) {
		return nil // public / not-visible / out-of-org: no student-team grant exists
	}

	if lock {
		return revokeClassroomTeamTemplateRead(client, out, errOut, org, classroom, branch, slug, template.Owner, template.Repo)
	}
	// Unlock: re-grant the student team (and, per that path, the staff teams)
	// read on the private template so students can accept again.
	return grantClassroomTeamTemplateRead(client, out, errOut, org, classroom, branch, slug, template.Owner, template.Repo,
		grantContext{verb: "unlocked", classroomNoun: "classroom", rerunHint: ", then re-run `gh teacher assignment lock ... --unlock`"})
}

// revokeClassroomTeamTemplateRead removes ONLY the classroom student team's
// read on a private, org-owned template (the mirror of the student half of
// grantClassroomTeamTemplateRead). Staff teams are deliberately left untouched.
// Best-effort: the flag flip already landed, so a non-owner author's 403 warns
// with owner-required guidance rather than failing.
func revokeClassroomTeamTemplateRead(client githubapi.Client, out, errOut io.Writer, org, classroom, branch, slug, tmplOwner, tmplRepo string) error {
	team, ok, err := configrepo.ResolveClassroomTeam(client, org, classroom, branch)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: locked %q, but reading the classroom team failed (%v); the student team's read on %s/%s was not removed.\n",
			slug, err, tmplOwner, tmplRepo)
		return nil
	}
	if !ok {
		// No team recorded — nothing was ever granted to a student team.
		return nil
	}
	// Fail-closed namespace guard, mirroring the destructive team ops: never
	// touch a team outside the classroom50-<short> namespace.
	if !configrepo.IsDeletableClassroomTeamRef(team) {
		_, _ = fmt.Fprintf(errOut, "Warning: locked %q, but the recorded classroom team %q is outside the classroom50- namespace; refusing to change its access to %s/%s. Remove it by hand if intended.\n",
			slug, team.Slug, tmplOwner, tmplRepo)
		return nil
	}
	if err := configrepo.RemoveTeamRepo(client, org, team.Slug, tmplOwner, tmplRepo); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) && !cliutil.IsRateLimited(err) {
			_, _ = fmt.Fprintf(errOut, "Warning: locked %q, but removing the student team %s read on the private template %s/%s needs an organization owner. Students may still be able to accept until an owner revokes it: re-run as an owner, use the web app, or remove the %s team from %s/%s in GitHub (Settings -> Collaborators and teams).\n",
				slug, team.Slug, tmplOwner, tmplRepo, team.Slug, tmplOwner, tmplRepo)
			return nil
		}
		return fmt.Errorf("locked %q, but removing the student team read on the private template %s/%s failed: %w", slug, tmplOwner, tmplRepo, err)
	}
	_, _ = fmt.Fprintf(out, "%s: removed classroom team %s read on private template %s/%s (locked)\n", org, team.Slug, tmplOwner, tmplRepo)
	return nil
}
