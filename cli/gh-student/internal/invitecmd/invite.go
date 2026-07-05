// Package invitecmd implements `gh student invite <org>/<repo> <username>`:
// add a push collaborator, and (when run from inside a group repo) enforce the
// assignment's advisory max-group-size cap. Extracted command package; only
// NewCmd is exported. Consumes the internal/* seams (githubapi, assignments,
// classroomcfg, localgit, reponame) + contract, never main.
package invitecmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/localgit"
	"github.com/foundation50/gh-student/internal/reponame"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "invite <org>/<repo> <username>",
		Short: "Invite a classmate or TA to push to your assignment repo",
		Long: "Add <username> as a `push`-level collaborator on <org>/<repo>. The\n" +
			"invitee receives a GitHub invitation they must accept before they can\n" +
			"push. Re-running on an existing collaborator is a no-op (GitHub upserts\n" +
			"the permission).\n\n" +
			"When run from inside a group-assignment repo (one with a\n" +
			".classroom50.yaml for a `mode: group` assignment), invite checks the\n" +
			"assignment's --max-group-size (read from the teacher's published\n" +
			"assignments.json) and refuses to add a new teammate once the group is\n" +
			"full. This is an advisory guardrail for the honest case — it can be\n" +
			"bypassed (e.g. via the GitHub UI), and the authoritative size/credit\n" +
			"boundary is collection time. Run outside such a repo (or for an\n" +
			"individual assignment / a TA invite), it just adds the collaborator.",
		Example: "  gh student invite cs50/cs50-fall-2026-hello-alice cs50-duck\n",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			target := strings.TrimSpace(args[0])
			username := strings.TrimSpace(args[1])
			if target == "" {
				return errors.New("target must not be empty")
			}
			if username == "" {
				return errors.New("username must not be empty")
			}

			// Exactly two non-empty components.
			parts := strings.SplitN(target, "/", 3)
			if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
				return fmt.Errorf("invalid target %q: expected <org>/<repo>", target)
			}
			org, repo := parts[0], parts[1]

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}

			out := cmd.OutOrStdout()

			// Enforce max_group_size when invite runs from inside the group
			// repo (the founder's tree carries the .classroom50.yaml that
			// identifies the assignment). Failing to resolve the group context
			// is non-fatal — a TA invite or an invite run outside a repo just
			// adds the collaborator.
			if err := enforceGroupSize(cmd, client, org, repo, username); err != nil {
				return err
			}

			return inviteUserToPush(client, out, org, repo, username)
		},
	}

	return cmd
}

// enforceGroupSize applies the assignment's max_group_size cap before an
// invite when (and only when) invite runs from inside the *target*
// group-assignment repo. It reads the local .classroom50.yaml to identify the
// classroom + assignment, fetches the published entry, and — if the assignment
// is `mode: group` — refuses to add `invitee` past the cap.
//
// TRUST MODEL — advisory guardrail, not a security control:
//   - The cap VALUE is trusted: max_group_size comes from the teacher's
//     published Pages assignments.json, never from the student-writable
//     .classroom50.yaml.
//   - The assignment POINTER is NOT trusted: a student could edit
//     `classroom`/`assignment` in .classroom50.yaml to point at a more
//     permissive (or individual) entry and dodge the check. That's acceptable
//     because invite-time enforcement is bypassable anyway (add via the GitHub
//     UI, or don't run the CLI). The real attribution boundary is
//     collection-time: collect-scores intersects collaborators with the
//     teacher's roster. This just keeps an honest founder from overfilling.
//
// Deliberately best-effort on *context*: not in a repo, a missing/unreadable
// .classroom50.yaml, a config describing a DIFFERENT repo than the target, or
// a non-group assignment all mean "no cap applies" and invite proceeds as a
// plain push-invite (keeps TA, cross-repo, and individual invites working). A
// transient failure to read the published entry warns but doesn't block. Only
// a genuine "group is full" (or an API error counting members) blocks.
func enforceGroupSize(cmd *cobra.Command, client githubapi.Client, org, repo, invitee string) error {
	root, inside, err := localgit.CurrentGitRoot()
	if err != nil || !inside {
		return nil // not in a repo → no group context to enforce
	}
	cfg, err := classroomcfg.ReadConfig(filepath.Join(root, classroomcfg.MetadataPath))
	if err != nil {
		return nil // no/!readable .classroom50.yaml → not a classroom repo
	}

	// Only enforce when the local config provably describes the invite TARGET:
	// the target repo must be the founder's own group repo for this assignment
	// (`<classroom>-<assignment>-<owner>`). A founder standing in repo A while
	// inviting into repo B would otherwise have A's cap applied to B — so
	// require the repo-name prefix match and take the owner from it.
	owner := groupRepoOwner(repo, cfg)
	if owner == "" {
		return nil // target repo isn't this assignment's group repo → skip
	}

	entry, err := assignments.FetchEntry(cmd.Context(), org, cfg.Classroom, cfg.Secret, cfg.Assignment)
	if err != nil {
		// Config points at an unresolvable assignment. If it's genuinely not
		// published, that's a "not a group repo we can check" case — skip
		// silently. Any other (transient/network) failure warns but proceeds:
		// the advisory cap must not block on a blip.
		var nf *assignments.NotFoundError
		if !errors.As(err, &nf) {
			_, _ = fmt.Fprintf(cmd.ErrOrStderr(),
				"Warning: couldn't check the group size for %s/%s (%v); proceeding with the invite — the size limit is advisory and enforced again at collection time.\n",
				org, repo, err)
		}
		return nil
	}
	if entry.Mode != contract.ModeGroup {
		return nil // individual assignment → no cap
	}

	// Bound the collaborator count with the same deadline the Pages fetch uses
	// — go-gh's REST client has no default HTTP timeout, so an unbounded count
	// could hang the invite.
	ctx, cancel := context.WithTimeout(cmd.Context(), assignments.PagesFetchTimeout)
	defer cancel()
	return checkGroupSizeBeforeInvite(ctx, client, org, repo, owner, invitee, entry.MaxGroupSize)
}

// groupRepoOwner returns the founder login for a group repo, or "" when `repo`
// isn't this assignment's group repo. The repo is named
// `<classroom>-<assignment>-<owner>` (lowercased), so the owner is the suffix
// after the prefix. A "" return signals enforceGroupSize to skip the cap (the
// target isn't the founder's group repo for the local config's assignment), so
// the member count is only ever taken with a real, matched owner.
//
// The prefix comes from reponame.Prefix — the same source reponame.Name builds
// from — so this consumer can't drift from the producer's shape.
func groupRepoOwner(repo string, cfg *classroomcfg.Config) string {
	prefix := reponame.Prefix(cfg.Classroom, cfg.Assignment)
	lower := strings.ToLower(repo)
	if strings.HasPrefix(lower, prefix) {
		return lower[len(prefix):]
	}
	return ""
}

// inviteUserToPush adds username as a push collaborator on org/repo.
func inviteUserToPush(client githubapi.Client, out io.Writer, org, repo, username string) error {
	if _, err := githubapi.SetCollaborator(client, org, repo, username, "push"); err != nil {
		return err
	}

	_, _ = fmt.Fprintf(out, "invited %s to %s/%s with push permission\n", username, org, repo)

	return nil
}
